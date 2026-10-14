# 검증 기록 — 2026-10-14 (Asia/Seoul)

## 확인된 결과

| 대상 | 방법 | 결과 |
| --- | --- | --- |
| 기존 저장소 | SSH clone 및 GitHub repository metadata | 공개 빈 저장소, 기존 코드/스택/운영 데이터 없음 |
| 전용 DB | Neon org/project API, migration 실행 | free 플랜 독립 DB 준비, 기존 프로젝트 변경 없음 |
| 정적 검사 | `npm run check` | 통과 |
| 자동 테스트 | `npm test`, 공식 MCP SDK client + PGlite(Postgres) | 10개 통과 |
| 실제 DB 연결 | 로컬 Node HTTP 서버 + 실제 전용 Neon DB, `npm run smoke` | OAuth→MCP 초기화→도구 목록→상태→쓰기→조회 통과 |
| 동시 중복 | 실제 DB에 같은 합성 사건 동시 2회 등록 | recorded 1회, duplicate 1회, event ID 동일 |
| 미인증 쓰기 | 실제 HTTP POST | 401, 기록 없음 |
| 농담 분류 입력 | kind=joke 도구 호출 | skipped, 사건 수 변화 없음 |
| Vercel production | CLI 배포 및 inspect | READY, Node.js 24, API Function sin1 |
| 원격 Vercel→Neon | 공개 production URL에 SDK smoke | OAuth→MCP→DB 등록·조회·감사 로그 통과 |
| 원격 동시 중복·미인증·skip | 원격 SDK smoke | 한 건 저장, duplicate 같은 ID, 미인증 401, joke skipped |
| 원격 OAuth discovery | 공개 HTTP GET | issuer/resource/scopes/PKCE/refresh metadata 200 |
| 비밀/소스 파일 제공 차단 | 배포 URL의 /.env.local, /src/config.js | 둘 다 404 |

실제 DB smoke 합성 사건 ID: `5bd2b63a-8f34-496c-ad80-ac5f33073de9`. 실사용자 현실 사건이 아니다. 테스트 access/refresh token은 정상 종료 후 폐기했다. 자동 테스트는 별도 메모리 DB에서만 실행했다.

원격 smoke 합성 사건 ID: `6abd95c8-adff-423d-a95e-307a8474b28d`. 합성 사건만 전용 DB에 저장했고 테스트 토큰을 폐기했다. 원격 MCP URL: `https://liferpg-mcp-experiment.vercel.app/mcp`. 배포 ID `dpl_GWYzPrMFoJ43XNrRn5gWLmSTjMLT`, 배포 source commit `f3b9ab5`.

자동 테스트 범위: 공개 discovery·OAuth metadata·도구 annotation, 익명/위조/만료 토큰, scope·audience 제한, 정확한 redirect, S256 요구·틀린 PKCE, code/refresh 재사용 방지, refresh 회전·토큰 폐기, canonical key 중복과 원본 보존, 가상 사건 skip, 입력 제한과 비밀 필드 미기록, 페이지 나눔·감사 로그, 감사 기록 실패 때 사건 rollback, origin·body 크기·JSON 검증.

## 남아 있는 판정

| 항목 | 상태 |
| --- | --- |
| 계정의 ChatGPT MCP 연결·쓰기 도구 사용 가능 여부 | 사용자 계정 UI에서 미검증 |
| ‘수다방’ 프로젝트 내 MCP 사용 | 미검증 |
| 명시적 ChatGPT 상태 조회 및 테스트 쓰기 | 미검증 |
| 일반 대화의 자율 감지·도구 호출·확인 없이 저장 여부 | 미검증 |
| 재언급의 의미 중복 처리 | 미검증 |
| ChatGPT의 농담·가상 사건 판별 | 미검증 |

조건과 판정은 [테스트 시나리오](CHATGPT-TEST.md)를 따른다. 서버가 GPT가 보낸 `kind`를 처리하는 테스트는 실제 대화에서의 GPT 판단 검증을 대체하지 않는다.

## OAuth 브라우저 결함 수정 — 같은 날 후속 검증

사용자가 소유자 연결 키 입력 후 승인 버튼에서 `invalid_origin`을 보고했다. 실제 Edge/Chromium form POST로 재현한 결과 로그인 페이지의 `Referrer-Policy: no-referrer`가 `Origin: null`을 만들고 서버가 403으로 거부했다. 최초 SDK 검증은 Origin 헤더를 직접 설정했으므로 이 브라우저 경로를 검증하지 못했다.

로그인 페이지 정책을 `strict-origin`으로 수정해 authorization URL/query는 보내지 않으면서 Origin을 보존했다. 이어 발견한 Chromium의 CSP form-action redirect 차단도 수정: 정확한 redirect allowlist를 통과한 callback origin만 CSP에 포함한다. 서버는 여전히 null·미지정·타 도메인의 Origin을 거부한다.

- `npm run test:browser`: 실제 Edge에서 승인 버튼→303→callback 이동→토큰 교환 통과. 메모리 DB와 테스트 자격증명 사용, ChatGPT callback은 intercept.
- `npm test`: 10개 통과. null/미지정 Origin 차단도 확인.
- `npm run check`: 통과.
- 수정 source commit `f2ab06c`; production 배포 `dpl_69r2CnH3RhtKk8ViESBtrvMcyKK7`, READY.
- 실제 원격 서버에서 Edge로 폼을 제출해 Origin=`https://liferpg-mcp-experiment.vercel.app`, 승인 303, callback 이동, 토큰 교환 200, 인증된 MCP 상태 ready 확인. 테스트 토큰 폐기. 실제 사건은 추가하지 않았다.

원격 브라우저 검증 역시 ChatGPT callback을 브라우저 내부에서 가로챘으므로 사용자 계정의 연결 완료나 자율 호출 성공을 의미하지 않는다. 재현 근거: [Fetch의 Origin 처리 규칙](https://fetch.spec.whatwg.org/#append-a-request-origin-header).
