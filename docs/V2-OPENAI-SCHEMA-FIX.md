# LifeRPG v2 — Structured Outputs 호환성과 안전한 HTTP 오류 진단

2026-10-15 · [합성 캠페인의 HTTP 400 보고서](V2-OPENAI-CAMPAIGN-20261015.md)를 바탕으로 수정했다. **이번 작업의 실제 OpenAI API 요청은 0회**다. 과거 평가 DB를 열거나 예약을 해제하지 않았으며, 예산 초기화·운영 DB 변경·배포도 하지 않았다.

## 원인과 확정 범위

RPG 계약은 Zod `discriminatedUnion`을 사용한다. 기존 `z.toJSONSchema`는 operation과 entity body의 두 union을 `oneOf`로 만들었고, wire 압축 함수는 숫자/문자열 제한만 제거하여 `oneOf`를 그대로 전송했다. mock transport는 JSON Schema의 provider 지원 범위를 검증하지 않아 이 문제를 잡지 못했다.

공식 Structured Outputs 문서가 명시하는 지원 조합은 `anyOf`이며, strict 모드의 미지원 schema는 요청 오류를 발생시킨다. 현재 요청 계약에서 발견한 비호환 표현을 수정했다. 다만 과거 응답 본문이 폐기되어 HTTP 400의 구체적인 provider 코드/파라미터는 복구할 수 없다. 이번 수정으로 실제 API가 요청을 받는지는 별도 승인된 유료 재평가에서 확인해야 한다. [공식 지원 범위](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)

## union 의미 보존

`src/v2/openai-schema.ts`는 schema 트리를 구조적으로 변환한다. 문자열 치환을 사용하지 않는다.

- 각 `oneOf` 분기가 object이고, 공통의 **필수 string 판별 필드**가 있으며, 그 `const`/`enum` 값 집합이 분기 간 겹치지 않는지 확인한다. `$defs`의 로컬 참조도 해석한다.
- operation의 `op` 6개 분기와 body의 `kind` 6개 분기(직업/아이템 등 enum 묶음 포함)가 이를 만족한다. 동시에 두 분기를 만족할 수 없으므로 이 union에서는 `oneOf`와 `anyOf`의 허용 값이 같다.
- 판별 필드 누락/optional, 겹치는 enum, 배타성을 증명하지 못하는 union은 `gm_schema_ambiguous_union`으로 중단한다. 임의로 느슨한 union으로 바꾸지 않는다.
- 속성 이름으로 쓰인 `oneOf` 같은 문자열은 변경하지 않는다. 판별 상수, 필수 필드, 닫힌 객체, 참조 구조는 유지한다.
- 기존 `wireProposal`, Zod RPG/기억 계약과 서버 도메인 검증은 유지했다. 기존에 wire에서만 생략하던 길이·범위·패턴 등 제한도 계속 로컬 Zod에서 검사한다. 게임 보상·퀘스트 전이·참조/중복 검증은 바꾸지 않았다.

독립 JSON Schema 검증기 Ajv로 원본과 변환본의 정상 분기 및 누락·혼합·미지 판별 값·추가 속성의 허용 여부를 비교했다. Ajv는 기존에 MCP SDK의 의존성으로 설치되어 있었으며, 재현 가능한 테스트를 위해 같은 버전을 명시적 devDependency로 추가했다. 런타임 의존성은 추가하지 않았다.

## 전송 전 사전 점검

로컬 profile `liferpg-structured-outputs-v1`은 공식 지원 범위 중 현재 LifeRPG에 필요한 보수적인 부분집합이다.

- root object, 모든 속성 required, `additionalProperties:false` 검사.
- 허용 keyword/type/enum/const, `anyOf`, array items, `$defs`/로컬 `$ref`의 존재·형태 검사.
- `oneOf`, `allOf`, `not`, 조건부 schema, 알 수 없는 keyword, 열린/선택 속성 object, 외부/없는 참조를 거부.
- 총 속성 5,000, enum 값 1,000, 이름·enum·const 문자열 합계 120,000자, 큰 enum 문자열 15,000자, 최대 깊이 10 상한 검사. 깊이는 array/object를 모두 세어 보수적으로 검사한다.
- 현재 사용하지 않는 재귀 참조, type 배열, 일부 선택적 keyword는 이 로컬 profile에서 거부한다. 이는 OpenAI 전체 기능의 미지원 판정이 아니다.

현재 schema는 속성 **84**, enum 값 **34**, 문자열 합계 **1,006자**, 최대 깊이 **6**으로 통과한다. 모듈 초기화 때 검증하고 변환 결과를 깊게 동결하므로 잘못된 새 계약은 worker/DB 초기화 전에 실패한다. 어댑터 generate 및 실제 fetch 경계에서도 검사한다. generate에서 전송 전에 발견한 invalid schema는 비재시도 `gm_schema_invalid`와 사용량 0을 반환하며 transport를 호출하지 않는다. 과거에 전송된 미확인 예약을 해제하는 기능은 없다.

기존 두 합성 실행기의 dry-run에 schema 검사 결과를 포함했다. 키 없이 아래 명령으로 확인할 수 있으며 DB나 실제 API에 접근하지 않는다.

```powershell
node scripts/evaluate-v2-campaign.mjs
node src/v2/synthetic-openai.ts
```

이 검사는 로컬에서 알려진 비호환을 차단한다. provider의 실제 접수, 모델 접근 권한, 계정 상태까지 보장하지 않는다.

## HTTP 오류 기록

`src/v2/openai-errors.ts`는 JSON 오류 body를 최대 32KiB까지만 일시적으로 읽고 허용된 값만 반환한다. 원문·`message`·자유 텍스트·전체 headers·프롬프트·키는 로그나 결과로 넘기지 않는다.

| 필드 | 저장 조건 |
| --- | --- |
| `code` | `invalid_json_schema`, `invalid_api_key`, `rate_limit_exceeded` 등 소스에 정의한 정확한 허용 값 |
| `param` | `text.format.schema`, `reasoning.effort`, `model` 등 정확한 허용 경로 |
| `request_id` | `x-request-id`에서 `req_` + 소문자 hex 32자 형식만 허용 |
| 기타 | HTTP 상태와 고정 로그 종류만 추가 |

허용하지 않은 코드/경로/ID는 `null`이다. 자유로운 schema 속성명이나 입력 인덱스 경로도 그대로 보존하지 않는다. 향후 provider가 다른 요청 ID 형식을 사용하면 로그에 남지 않으므로 확인 후 허용 목록을 조정해야 한다. 공식 문서는 요청 문제 조사에 `x-request-id` 기록을 권장한다. [공식 요청 디버깅 문서](https://developers.openai.com/api/reference/overview#debugging-requests)

malformed JSON, HTML 오류, 초과 크기, 오류 stream에서도 안전한 header ID만 남기고 원래 HTTP 상태를 유지한다. 로깅 실패로 요청을 재시도하지 않는다. 내부 reply/합성 계측으로 전달할 때도 다시 허용 목록 검사를 한다.

안전한 진단은 서버 구조화 로그와 합성 평가의 response/reply/sample 파일에 남는다. 기존 DB schema를 변경하지 않았고 provider 진단을 버디 공개 영수증에 추가하지 않았다. HTTP 400의 공개 오류는 계속 `gm_provider_rejected`, 사용량 미수신 시 예약은 계속 `unknown`이다. 429/5xx의 기존 분류와 최대 시도 정책, 평가 실행기의 첫 실패 중단 정책도 유지한다.

## 무과금 검증

- OpenAI 전용 테스트: **24/24**. 새 schema/오류 검사 8개와 HTTP 400의 worker 예약 보호 테스트 포함.
- v2 전체 회귀: **74/74**. MCP 5개, RPG 원자성/중복 방지, 비용 정산, 기억 선택·정체성·삭제 보호 포함.
- 평가 실행기 테스트: **3/3**. 가짜 응답 5턴, 실패 시 1회 중단, 누적 예약/재실행 제한. 실제 API 요청 0회.
- TypeScript 검사 및 `git diff --check` 통과.
- 원본/변환본 union은 전체 RPG 종류의 정상 입력 및 200개 이상의 거부 사례를 독립 검증기로 비교. 모호한 union·지원 범위 밖 schema는 전송 전에 거부.
- 실제 transport 함수도 `fetch`를 가짜 Response로 치환하여 검증. 키/프롬프트/개인정보 표식을 오류 메시지·미허용 필드에 넣어도 로그·reply·계측에 남지 않음을 확인.
- 기존 유료 합성 DB와 캠페인 평가 폴더, 삭제 저널, 과거 예약 정리 기록 **2,132개 파일의 SHA-256이 작업 전후 동일**하다. GM 프롬프트 문자열도 수정 전과 동일하다.

검증 명령은 `npm run test:v2:openai`, `npm run test:v2`, `npm run test:v2:campaign`, `npm run check`다. API 대신 주입한 합성 전송/가짜 fetch/loopback HTTP만 사용했다. 모델 `gpt-6.1-sol`, reasoning `medium`, 입력 16,384 / 출력 2,048, 가격표와 호출당 예약 $0.06144는 유지했다.

유료 캠페인은 자동 재개하지 않는다. 기존 캠페인의 1회 전송과 $0.06144 미확인 예약을 보존한 상태이며, 재개 시 승인된 누적 횟수·예약 범위를 이어서 관리하는 절차를 먼저 확정해야 한다.
