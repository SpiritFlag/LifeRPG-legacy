# LifeRPG v2 — 실제 Sol 합성 캠페인 평가

2026-10-15 · **첫 탄생 요청이 HTTP 400으로 거부되어 1회 호출 후 중단했다.** GM 출력이 없어 RPG 창작·기억 품질 평가는 진행하지 못했다. 실패 후 재시도, 게임 규칙/GM 프롬프트 변경, 예약 해제, 운영 DB 변경, 배포를 하지 않았다.

## 승인 범위와 실행 조건

- 모델 `gpt-6.1-sol`, reasoning `medium`, 입력 상한 16,384 / 출력 상한 2,048 유지.
- 최대 실제 API 요청 5회, 누적 예약 합계 최대 500,000 microUSD ($0.50).
- 기존 가격표 `gpt-6.1-sol-standard-2026-10-15` 유지. 호출당 최대 예약 61,440 microUSD, 계획한 5회 합계 307,200 microUSD ($0.30720).
- 기존 `.env.openai.local`에서 키를 프로세스에 로드했다. 키의 존재 여부만 점검했고 키나 파일 내용을 출력하지 않았다. 환경변수 파일도 수정하지 않았다.
- 별도 `.local/v2-campaign-20261015/db`에 새 PGlite DB를 만들고 001~004 migration을 적용했다. 이 평가 DB에만 서버 lifetime/daily/monthly 및 소유자 한도 $0.50를 설정했다.
- 기존 `.local/v2-openai-synthetic` DB는 열지 않았다. 전체 DB 파일, 삭제 저널, 과거 예약 정리 기록의 SHA-256이 실행 전후 동일했다. 기존 운영 한도와 유료 기록을 초기화하지 않았다.
- 기준 소스 HEAD `0640775`. 실제 동결 기준은 실행 전 저장한 `src/v2`, `migrations/v2`, 평가 실행기 파일의 SHA-256이다. 호출 전과 종료 시 모두 일치했다.

공식 모델 문서에서도 `medium`과 Structured Outputs 지원을 확인했다. 모델명이나 reasoning 미지원으로 단정할 근거는 없다. [GPT-6.1 Sol 공식 문서](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

## 미리 고정한 시나리오

| 순서 | 합성 입력 | 확인하려던 내용 | 실행 |
| --- | --- | --- | --- |
| 1 | 아린의 강가 등불 마을 탄생, 직업/스킬/작은 퀘스트/안내자, 비공개 복선과 초기 판단 철학 | RPG 초기 생성, 공개/비공개 분리 | HTTP 400, 중단 |
| 2 | 쉬고 싶었지만 속도를 낮춰 20분 산책 완료 | 현실 보고의 게임상 의미와 성장 | 미실행 |
| 3 | 처음 안내자에게 돌아가 퀘스트를 맡고 첫 단서 조사 | 기존 NPC·퀘스트 회수, 주장과 사실 구분 | 미실행 |
| 4 | 15분 낱말 학습, 미숙한 세 단어를 복습 대상으로 남김 | 과장 없는 성장 해석 | 미실행 |
| 5 | 처음 안내자·마을 재방문, 미해결 일을 잇고 필요할 때만 GM 성찰 | 정설·복선 회수, 근거 있는 정체성 변화 | 미실행 |

실행 도중 입력을 바꾸거나 보상을 직접 주입하지 않았다. 전체 입력은 실행기와 로컬 `plan.json`에 보존했다. 게임 엔진과 기억 선택기는 기존 것을 그대로 호출했다.

## 실제 결과와 비용

| 항목 | 관측 결과 |
| --- | --- |
| 요청 예약 시각 | 2026-10-15 12:31:37 KST |
| 실제 API 요청 | **1/5회**, 재시도 0회 |
| HTTP 결과 | **400** |
| 서버 요청 결과 | `failed` / `gm_provider_rejected` |
| GM/HTTP 계측 시간 | **2,037ms** (아래 계측 범위 참고) |
| 서비스 접수→worker→결과 조회 | **2,140ms** |
| GM 판정·공개 장면 | 반환되지 않음 |
| 성공적으로 받은 구조화 판정 | 요청 기준 **0/1** |
| 생성 응답의 schema 준수율 | **평가 불가**, 생성 응답 0건 |
| 서버 확정 | 전체 요청 기준 **0/1**, 유효 판정 입력 기준 평가 불가 |
| 실제 입력/출력/캐시/reasoning/총 토큰 | **미확인**, provider usage가 없음 |
| 확인된 사용량 기반 정산 합계 | **$0.000000**, 실제 무료임을 뜻하지 않음 |
| 해제하지 않은 예약 | **$0.061440**, attempt `unknown` / actual_cost `null` |
| 이번 평가 누적 예약 합계 | **$0.061440 / $0.50** |
| 최종 게임 | initialized=false, XP=0, 엔티티·기억·현실 기록 0건 |

`usage` 조회의 토큰 합계 `0`은 SQL이 미확인 NULL을 합산할 때 반환하는 숫자다. 실제 사용량이 0이라는 증거로 해석하지 않는다. 확정 토큰이 없으므로 이번 호출의 실제 토큰 기반 비용 추정도 불가능하다. 가격표를 적용한 추정 정산과 provider 청구액은 원래 별개이며, 이번에는 그 추정 정산 자체가 없다.

HTTP 계측은 평가 transport wrapper 전체를 감싼다. 따라서 요청 전 소스 해시 검사·감사 파일 저장, fetch, 응답 파일 저장을 포함한다. 순수 네트워크 왕복이나 모델 생성 지연으로 해석할 수 없다. 성공 생성이 없으므로 생성 latency 평가는 불가능하다.

## 무과금 점검과 실패 진단

실행 전 `test/v2-campaign-eval.test.js`의 3개 테스트를 통과했다. 가짜 전송으로 실제 OpenAI 어댑터의 출력 파싱, worker, DB 확정·정산을 5턴 연결했고, 503 실패 뒤 1회에서 멈추며 미확인 예약을 보존하는 것도 확인했다. 누적 예약/5회 제한과 같은 평가 폴더 재실행 거부를 검증했다. 이 가짜 전송은 OpenAI 서버의 JSON Schema 지원 범위를 검사하지 않는다. **따라서 사전 점검 통과는 실제 API schema 접수 가능성까지 입증하지 못했다.**

실패 후 추가 API 호출 없이 소스와 실제 첫 문맥을 검사했다.

1. 문맥 JSON 814바이트, 전체 요청 JSON 10,105바이트. 기존 보수적 크기 검사 값은 14,201로 상한 16,384 이내였다. 로컬 `context_limit`으로 멈춘 경우가 아니다.
2. Zod의 discriminated union 변환 결과에 `oneOf`가 두 군데 남아 있다.
   - `#/$defs/__schema3/oneOf` — RPG operation 6종
   - `#/$defs/__schema3/oneOf/0/properties/body/oneOf` — RPG entity body 6종
3. 공식 Structured Outputs의 지원 schema 문서는 `anyOf`를 명시하고, 지원하지 않는 schema를 strict 모드로 보내면 오류가 발생한다고 설명한다. 현재 `oneOf`가 그대로 전송되는 부분이 **요청 계약 비호환의 유력한 원인**이다. [공식 지원 schema 설명](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)
4. 기존 live adapter는 비정상 HTTP 응답 본문을 읽지 않고 폐기한다. 이번 기록에도 `{status:400, body:null}`만 남았다. 따라서 provider가 반환한 `error.code`, `param`, 구체적인 schema 경로는 확인할 수 없고, **이번 400의 직접 원인을 provider 메시지로 확정하지는 못했다.**

평가 도중 수정 금지 및 실패 시 중단 조건에 따라 이 schema와 오류 계측을 바꾸지 않았다. GM의 비밀 누설, 기억 회수, 성찰과 정체성의 품질은 성공도 실패도 판정할 자료가 없다. 이번 결과를 모델의 RPG 능력 평가 점수로 해석하면 안 된다.

## 보존된 산출물과 재개 전 작업

- 실행기: `scripts/evaluate-v2-campaign.mjs`
- 무과금 테스트: `test/v2-campaign-eval.test.js` — **3/3 통과**
- TypeScript: `npm run check` 통과
- 로컬 감사 폴더: `.local/v2-campaign-20261015`
  - `plan.json`: 시나리오, 설정, 동결 소스 해시, 기존 DB 해시
  - `dispatch.jsonl`: 전송 전 영속 호출/누적 예약 장부
  - `context-1.json`, `response-1.json`, `reply-1.json`: 합성 문맥, HTTP 상태, 어댑터 실패
  - `report.json`: 실제 시도, 미확인 사용량, 확정 결과, 최종 상태
  - `preservation.json`: 기존 합성 자료/소스 불변 확인
  - `offline-diagnosis.json`: schema 위치와 요청 크기 계산

사전 점검 명령은 `node --env-file-if-exists=.env.openai.local scripts/evaluate-v2-campaign.mjs`, 무과금 테스트는 `node --test test/v2-campaign-eval.test.js`다. `--execute`는 이번 승인으로 이미 한 번 실행했다. 기존 평가 폴더를 지우거나 이름을 바꾸어 반복 실행하지 않는다. 실행기는 기존 폴더를 발견하면 중단하며, 남은 4회도 자동으로 진행하지 않는다.

다음 작업은 게임 규칙/프롬프트를 유지한 채 wire schema 호환성을 수정하고, 전송 전 지원 키워드 검사와 오류 진단을 보완하는 것이다. 각 분기의 `op`/`kind`가 서로 배타적인지 확인한 뒤 해당 union을 지원 표현으로 변환하고, 로컬 Zod/게임 정합성 검증은 그대로 유지하는 접근을 검토한다. 오류 진단은 원문 전체 대신 제한된 오류 코드·파라미터·request ID 등 안전한 필드만 수집하도록 해야 한다. 수정 후 유료 재평가 재개는 별도 승인 범위와 누적 횟수/예약 장부를 명시해야 하며, 이번 미확인 예약은 근거 없이 해제하지 않는다.
