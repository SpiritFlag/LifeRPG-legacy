# LifeRPG MCP 자동 호출 실험 명세

ChatGPT가 GM 역할을 한다. 서버는 사건의 최소 저장·조회·호출 관찰만 수행하며 LLM을 호출하지 않는다. 정식 RPG 모델, 캐릭터, 경험치, 퀘스트, 세계관, 일일 정산, 예약 실행은 없다.

## 구현

- Node.js 24, 공식 `@modelcontextprotocol/sdk`, Zod, `pg`만 사용하는 서버. 웹 프레임워크·ORM 없음.
- `api/server.js`의 Web Request/Response 핸들러 하나로 Vercel Function을 구성한다. `/mcp`는 세션을 서버 메모리에 저장하지 않는 Streamable HTTP + JSON 응답이다. GET SSE와 DELETE 세션은 제공하지 않는다.
- 모든 데이터와 OAuth grant는 독립 Postgres에 저장한다. 프로세스 재시작이나 함수 인스턴스 변경으로 기록이 사라지지 않는다.
- `get_gm_status`: 인증된 상태 확인, 사건 수, 최근 10개 호출의 시작·완료 시각, 제한된 입력, 처리 결과, 사건 ID.
- `record_life_event`: 날짜·표준 사건 키·분류·요약·짧은 근거를 수신. `real`, `test`만 저장. `joke`, `fiction`, `hypothetical`은 `skipped`.
- `list_life_events`: 날짜별 조회와 페이지 나눔. 기본 20개, 최대 50개, `next_offset` 반환. 중복 후보를 찾고 저장 여부를 확인할 때 사용.
- 모든 도구는 OAuth 필요. 읽기 도구는 `readOnlyHint: true`; 기록은 `false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

## 최소 데이터

`life_events`: UUID, 사건 발생일(Asia/Seoul 기준 YYYY-MM-DD), 표준 사건 키, `real`/`test`, 요약(300자), 사용자 근거(500자), 서버 기록 시각.

`tool_calls`: UUID, 호출 시작·완료 시각, 도구, 허용 필드만 포함한 입력, 결과 상태, 사건 ID, 최소 결과. 기록과 정상 호출 감사 로그는 같은 트랜잭션으로 커밋한다. 입력 오류·skip·중복도 기록한다. DB 장애 때 결과는 오류로 반환하고 런타임 로그에도 남기며, DB가 복구되어 있으면 실패 감사 로그도 저장한다. 미인증 요청의 본문은 DB에 보존하지 않는다.

`oauth_grants`: 해시된 로그인 ticket/authorization code/access token/refresh token, 유효기간, client·resource·scope·고정 소유자에 결합한 payload. 원문 토큰은 저장하지 않는다. `auth_attempts`는 시간당 소유자 로그인 시도를 제한한다. 연결 시작 때 만료 인증 데이터를 정리하며 예약 작업은 없다.

## 중복 방지의 보장과 한계

DB unique constraint는 `(kind, occurred_on, event_key)`에 걸린다. 키는 Unicode NFKC·소문자·공백 정규화 후 저장한다. `INSERT ... ON CONFLICT DO NOTHING`과 후속 조회를 사용해 동시 요청에서도 원본 ID를 반환하며 기존 내용은 덮어쓰지 않는다. `real`과 `test`는 서로 다른 실험 범위다.

GPT가 동일 사건에 **같은 표준 키**를 사용하면 중복 방지가 보장된다. 표현이 달라져 다른 키를 생성하면 별도 사건으로 저장될 수 있다. 이를 줄이기 위해 GPT가 먼저 날짜별 기록을 조회하고 기존 키를 재사용하도록 도구 설명과 프로젝트 지침에서 안내한다. 의미 판단은 서버가 수행하지 않는다.

서버는 사실 여부를 판별하지 않는다. 농담을 GPT가 `real`로 오분류하면 저장될 수 있다. 자동 테스트의 `joke` skip 통과는 ChatGPT의 농담 판별 성공을 의미하지 않는다.

## 인증

이 실험은 단일 소유자와 정적 OAuth client 하나를 대상으로 한다. OAuth authorization code + PKCE S256, 정확한 redirect allowlist, issuer 응답(`iss`), resource 결합, 읽기/쓰기 scope, 1시간 access token과 30일 refresh token을 제공한다. `offline_access` 요청 시 refresh token을 발급하고 매번 회전한다. code와 refresh token은 DB 트랜잭션에서 한 번만 소비한다. token endpoint는 `client_secret_post`, `client_secret_basic` 지원. DCR/CIMD는 구현하지 않으므로 ChatGPT에 정적 client ID/secret을 설정한다.

소유자는 OAuth 페이지에서 별도 무작위 연결 키를 입력해 승인한다. 폼은 동일 origin 검증과 5분 일회용 ticket으로 보호한다. 승인 code는 2분간 유효하다. 입력 비밀값은 감사 로그나 console에 출력하지 않는다. `life.read`와 `life.write`는 개별 도구에서 검증한다. 없는·만료된·위조된·다른 resource의 토큰은 거부한다.

`initialize`, `tools/list`, `ping`, 초기화 notification은 공개 discovery다. 실제 사건·상태 조회와 기록은 인증이 필요하다. `/health`는 공개 프로세스 상태만 반환하며 DB 준비 상태는 보장하지 않는다. OAuth discovery는 `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`에서 제공한다.

개별 토큰 폐기는 `/oauth/revoke`로 한다. refresh 폐기는 이미 발급된 access token을 함께 취소하지 않는다. 전체 연결을 즉시 취소하려면 전용 DB에서 해당 client의 access/refresh grant를 제거해야 한다. 정식 계정 관리 제품으로 확대하지 않는다.

## 검증 기준

- `npm run check`: JavaScript에 대한 TypeScript 정적 검사.
- `npm test`: PGlite(Postgres) 기반, 공식 MCP client 연결과 실제 HTTP 메시지 검증. 인증, scope, audience, PKCE, replay, refresh, revoke, 중복, skip, 입력 오류, 감사 로그, rollback 포함.
- `npm run test:browser`: 설치된 Edge 또는 `BROWSER_EXECUTABLE_PATH`의 Chromium으로 로그인 페이지에서 승인 버튼을 실제 클릭하고 Origin 전달·303 callback·토큰 교환을 검증한다. Postgres는 별도 메모리 DB이고 ChatGPT callback은 브라우저에서 가로채 외부 계정에 접근하지 않는다. 로그인 페이지는 `strict-origin` 정책으로 URL/query를 노출하지 않으면서 form POST의 Origin을 보존한다. 원본·null·미지정·타 도메인의 Origin 검사를 느슨하게 하지 않는다.
- `npm run smoke`: 지정한 서버에 공식 MCP SDK로 연결. 실제 Postgres에서 합성 사건을 동시 등록해 1건 생성·1건 duplicate, 조회·audit·joke skip·미인증 쓰기 차단 확인. 매 실행 합성 사건 한 건이 남는다. 정상 완료 후 테스트 토큰을 폐기한다.
- ChatGPT 연결·도구 표시·프로젝트 내 도구 사용·자율 감지·확인창 여부·의미 중복·농담 판별은 [연결 및 실험 안내](docs/CHATGPT-TEST.md)에서 사용자 관찰로 판정한다. 서버 테스트만으로 통과 판정하지 않는다.
