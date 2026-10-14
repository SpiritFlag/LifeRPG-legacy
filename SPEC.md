# LifeRPG MCP 사건·성장·퀘스트·콘텐츠·세계·개인 웹사이트 명세

ChatGPT가 유일한 GM 역할을 한다. 서버는 현실 사건·GM 판정·연속 퀘스트·캐릭터 콘텐츠·세계/NPC/역사/기억/일지의 저장·조회, 참조·상태 검증, 고정 레벨과 스탯 보정 계산을 수행하며 LLM을 호출하지 않는다. Phase 4의 개인 웹사이트는 Clerk 소유자 인증 뒤 공개 게임 상태를 읽기 전용으로 표시한다. Phase 5는 GM이 작성한 최초 캐릭터·세계를 초안으로 준비하고 한 번에 확정하는 계약을 제공한다. 일일 정산·예약 실행은 없다. 실제 사용자 세계나 캐릭터는 생성하지 않았다.

로컬 코드에는 Phase 1 현실 사건, Phase 2 GM 판정·성장, Phase 3A 연속 퀘스트라인, Phase 3B 캐릭터 콘텐츠, Phase 3C 세계·NPC·GM 기억·일지·연대기, Phase 4 개인 웹사이트, Phase 5 정식 초기 생성이 구현되어 있다. Phase 6에서는 실제 Neon 격리 branch에서 001~007 이관·다중 연결·MVCC·timeout·재시도를 검증했다. 운영 서비스는 기존 실험 버전이며 운영 DB의 002~007 migration과 새 코드의 운영 배포는 실행하지 않았다. 전체 설계는 [DESIGN.md](DESIGN.md), 단계별 결과는 [1단계 검증](docs/PHASE1-VERIFICATION.md), [2단계 검증](docs/PHASE2-VERIFICATION.md), [Phase 3A 검증](docs/PHASE3A-VERIFICATION.md), [Phase 3B 검증](docs/PHASE3B-VERIFICATION.md), [Phase 3C 검증](docs/PHASE3C-VERIFICATION.md), [Phase 4 검증](docs/PHASE4-VERIFICATION.md), [Phase 5 검증](docs/PHASE5-VERIFICATION.md), [Phase 6 검증](docs/PHASE6-VERIFICATION.md)을 따른다.

## Phase 4 개인 웹 조회

`/`는 정적 RPG 화면이며 캐릭터·소지품·퀘스트라인·세계·모험 일지를 hash navigation으로 탐색한다. `GET /api/web-config`는 Clerk publishable key만 반환한다. 게임 데이터는 `GET /api/player?q=<JSON>`로 읽는다. 브라우저는 DB나 MCP에 직접 연결하지 않는다.

서버는 공식 Clerk SDK로 세션 서명·만료·authorizedParties를 검증하고 `CLERK_OWNER_USER_ID`와 일치할 때만 내부 고정 소유자로 매핑한다. `PUBLIC_BASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_OWNER_USER_ID`가 필요하며 `CLERK_JWT_KEY`는 선택적 공개 키다. 웹은 선택적 `WEB_PUBLIC_BASE_URL`을 우선 사용하고 생략 시 PUBLIC_BASE_URL로 동작한다. 따라서 웹의 Clerk custom domain을 지정해도 MCP issuer/resource·기존 grant의 origin은 변경하지 않는다. 설정 누락은 503, 익명/무효 세션은 401, 다른 소유자/Origin은 403이다. 인증은 DB 연결보다 먼저 수행한다. 기존 MCP OAuth 인증은 변경하지 않는다.

`q`는 4,000자 이내의 엄격한 JSON 객체다. 기존 context 조회의 공개 ID·필터·cursor를 재사용하되 `view`, GM memory, world 변경 영수증 입력은 허용하지 않는다. `dashboard`와 `after_growth_sequence`를 추가한다. 잘못된 입력은 400, 공개되지 않은 상세 대상은 404, GET 외 method는 405, 저장소 오류는 상세를 숨긴 503이다. 응답은 `private, no-store`와 `Vary: Cookie, Authorization`을 사용한다.

READ ONLY·REPEATABLE READ 트랜잭션에서 기존 `getGameContext(view:player)` 및 제한된 SELECT를 실행한다. 공개 projection과 웹 필드 허용 목록을 함께 적용하여 GM 기억·판정 이유·원본 근거·해시·예약된 `gm_*` 필드를 제외한다. 기본/장비/기타 활성 보정/최종 스탯을 구분하고, 초기 성장 snapshot 및 이후 판정 변화, 최신 장비·보상·현재 퀘스트·세계 소식을 반환한다. 공개 텍스트 자체의 의미상 비밀 여부를 자동 판별하지는 않는다.

게임이 없으면 `initialized:false`를 표시하며 조회가 게임을 만들지 않는다. 새로고침은 최신 revision을 다시 읽는다. 합성 데이터는 메모리 PGlite 전용 preview script에만 있으며 운영 API에 인증 우회나 합성 생성 경로는 없다. 실제 Clerk 개발 계정으로 합성 화면 접근을 확인했고, 운영 Neon과 배포 환경 검증은 수행하지 않았다. 실행법과 상세 결과는 [Phase 4 검증](docs/PHASE4-VERIFICATION.md)에 기록한다.

## 구현

- Node.js 24, 공식 `@modelcontextprotocol/sdk`, Zod, `pg` 서버. Phase 4는 `@clerk/backend`, `@clerk/clerk-js`, esbuild와 프레임워크 없는 JavaScript/CSS 화면을 추가한다. ORM·별도 백엔드·LLM API 없음.
- 기존 `api/server.js` Web Request/Response 핸들러는 MCP/OAuth를 유지한다. 웹 읽기는 별도 `api/web.js` 핸들러다. `/mcp`는 세션을 서버 메모리에 저장하지 않는 Streamable HTTP + JSON 응답이다. GET SSE와 DELETE 세션은 제공하지 않는다.
- 모든 데이터와 OAuth grant는 독립 Postgres에 저장한다. 프로세스 재시작이나 함수 인스턴스 변경으로 기록이 사라지지 않는다.
- `get_gm_status`: 인증된 상태 확인, 사건 수, 최근 10개 호출의 시작·완료 시각, 제한된 입력, 처리 결과, 사건 ID.
- `record_life_event`: 날짜·표준 사건 키·분류·요약·짧은 근거를 수신. `real`, `test`만 저장. `joke`, `fiction`, `hypothetical`은 `skipped`.
- `list_life_events`: 날짜별 조회와 페이지 나눔. 기본 20개, 최대 50개, `next_offset` 반환. 중복 후보를 찾고 저장 여부를 확인할 때 사용.
- `update_life_events`: 요청 키와 최대 10개 create/enrich/correct operation으로 독립 사건 등록·보강·정정을 원자적으로 처리한다. GM 판정·보상을 수행하지 않는다.
- `get_life_event`: UUID로 현재 사건, 과거 식별 alias, 버전별 변경 전후·근거·보고·기록 시각을 조회한다. 이력 기본 20개·최대 50개, `after_version`/`next_after_version`으로 페이지를 넘긴다.
- `get_game_context`: 소유자의 게임 버전·캐릭터·콘텐츠·퀘스트와 세계·NPC 관계·설정·기억·일지·세계 진행 시점을 조회한다. 관련 ID·검색·cursor로 상세를 좁힌다. world는 공개 투영이고 view=gm 기본값은 gm_private.world를 추가한다. view=player에는 비공개 세계 데이터가 없다. 게임이 없으면 initialized=false다.
- `list_gm_adjudications`: 사건·판정 주제·항목으로 과거 판정과 사건 UUID·버전·원본 근거를 조회한다. 기본 20개·최대 50개, after_sequence/next_after_sequence로 페이지를 넘긴다.
- `apply_gm_update`: 요청 키와 게임 버전으로 판정 최대 10개와 퀘스트/콘텐츠/세계 변경 각각 최대 40개, 합계 최대 100개를 원자적으로 적용한다. 판정당 근거 사건은 최대 20개다. 각 종류를 단독으로 또는 함께 변경할 수 있다. 기존 합성 초기 생성은 별도 initialize 입력과 테스트 설정이 필요하다. 정식 초기 생성은 Phase 5의 begin/prepare/finalize mode로 준비하고 확정한다.
- `get_gm_update`: update_id 또는 request_key 중 하나로 저장 당시 전후·실제 증감·레벨·판정·퀘스트/콘텐츠/세계 변화와 임시 참조를 조회한다. 기본 view=gm은 GM 전체 영수증, view=player는 공개 결과만 반환한다. 현재 상태는 get_game_context로 확인한다.
- 기존 3개 도구의 입력·기본 응답과 scope는 유지한다. `list_life_events`에 선택적 `event_key` 필터를 추가했고 발생일·키의 과거 alias도 조회한다. 결과 필드는 추가되었다.
- 모든 도구는 기존 OAuth의 life.read/life.write scope를 요구한다. 읽기는 `readOnlyHint: true`; 쓰기는 `false`. 기존 기록 도구는 `destructiveHint: false`, 사실 정정·손실을 지원하는 `update_life_events`와 `apply_gm_update`는 `true`다. 모두 `idempotentHint: true`, `openWorldHint: false`다.

## 최소 데이터

`life_events`: 기존 UUID·발생일·키·분류·요약(300자)·근거(500자)·최초 서버 기록 시각을 보존한다. 사건 버전, 발생 시간 범위·정밀도·시간대, 최초 보고 시각, 확인 사실·미확인 항목, 마지막 변경 시각을 추가한다. 신규 계약에서는 발생일도 null일 수 있다. DATE는 SQL에서 문자열로 반환해 서버의 로컬 시간대에 따른 날짜 이동을 방지한다.

`life_event_revisions`: `(event_id, version)`별 최초 등록·보강·정정의 전후 snapshot, 근거·이유, 보고 시각, 선택적 대화 출처, 요청 키와 서버 기록 시각. 기존 행은 기존 서버 시각을 보존한 `import` 버전 1로 가져오며 알 수 없는 보고 시각은 null이다. `reported_at`은 실제 메시지 시각이 제공될 때만 저장하고 `report_time_source=message`, 없으면 null과 `unknown`이다. 서버 시각을 대화 시각으로 대신 넣지 않는다. 현재 사건의 reported_at은 최초 보고 시각이며 후속 보고는 해당 revision에서 확인한다.

`life_event_aliases`: 현재와 과거 `(kind, occurred_on, event_key)` 식별값을 UUID에 연결한다. `UNIQUE NULLS NOT DISTINCT`로 날짜를 모르는 동일 키도 중복 방지한다. 정정한 옛 식별값을 다시 사용해도 기존 사건으로 조회된다. alias는 재사용·변경하지 않는다.

`life_event_requests`: 성공한 batch의 요청 키·정규화한 입력 hash·결과 영수증. 동일 요청 재시도는 저장 당시 결과를 반환하고 입력이 다르면 거부한다. 현재 단일 OAuth 소유자 범위의 키다. 변경 이력·alias·영수증은 UPDATE/DELETE 방지 트리거로 보호한다.

`tool_calls`: UUID, 호출 시작·완료 시각, 도구, 허용 필드만 포함한 입력, 결과 상태, 사건 ID, 최소 결과. 기록과 정상 호출 감사 로그는 같은 트랜잭션으로 커밋한다. 입력 오류·skip·중복도 기록한다. DB 장애 때 결과는 오류로 반환하고 런타임 로그에도 남기며, DB가 복구되어 있으면 실패 감사 로그도 저장한다. 미인증 요청의 본문은 DB에 보존하지 않는다.

`oauth_grants`: 해시된 로그인 ticket/authorization code/access token/refresh token, 유효기간, client·resource·scope·고정 소유자에 결합한 payload. 원문 토큰은 저장하지 않는다. `auth_attempts`는 시간당 소유자 로그인 시도를 제한한다. 연결 시작 때 만료 인증 데이터를 정리하며 예약 작업은 없다.

## 중복 방지의 보장과 한계

기존 DB unique constraint `(kind, occurred_on, event_key)`는 유지하고 alias 테이블에서도 같은 식별값을 유일하게 예약한다. 키는 Unicode NFKC·소문자·공백 정규화 후 저장한다. 모든 사건 쓰기는 같은 트랜잭션 advisory lock을 사용한다. 현재 단일 소유자의 짧은 쓰기를 DB에서 직렬화하며, 별도 프로세스·함수 인스턴스에도 같은 잠금이 적용된다. 기존 등록은 중복 시 현재 원본 UUID를 반환하고 내용을 덮어쓰지 않는다. `real`과 `test`는 서로 다른 범위다.

GPT가 동일 사건에 **같은 표준 키**를 사용하면 중복 방지가 보장된다. 표현이 달라져 다른 키를 생성하면 별도 사건으로 저장될 수 있다. 이를 줄이기 위해 GPT가 먼저 날짜별 기록을 조회하고 기존 키를 재사용하도록 도구 설명과 프로젝트 지침에서 안내한다. 의미 판단은 서버가 수행하지 않는다.

서버는 사실 여부를 판별하지 않는다. 농담을 GPT가 `real`로 오분류하면 저장될 수 있다. 자동 테스트의 `joke` skip 통과는 ChatGPT의 농담 판별 성공을 의미하지 않는다.

## 신규 사건 도구 계약

`update_life_events` 입력은 `{request_key, operations}`다. `operations`는 1~10개이고 같은 batch에서 한 사건에는 하나의 operation만 허용한다. HTTP 본문 한도 16 KiB를 유지한다. 초과 batch는 호출을 나누되 각 호출의 원자성만 보장한다.

- `create`: `{operation:"create", event:{occurred_on,event_key,kind,summary,evidence,...}}`. kind는 `real` 또는 명시적 `test`. 발생일을 모르면 null. 선택 필드는 occurred_start/end, time_precision, timezone, facts, unknowns, reported_at, source_ref다. facts·unknowns는 각각 최대 20개·항목당 300자다. 기본 시간대는 Asia/Seoul, 정밀도는 발생일 유무에 따라 date/unknown, 발생 시각·보고 시각 기본값은 null이다. 동일 식별값·동일 현재 사실은 duplicate이며, 기존 사실과 다르면 identity_conflict와 기존 UUID·버전을 반환한다.
- `enrich`: `{operation:"enrich",event_id,expected_version,reason,evidence,changes,reported_at?,source_ref?}`. facts는 기존 목록에 중복 없이 추가한다. summary는 보강된 현재 요약, unknowns는 현재 미확인 목록으로 갱신한다. 미상인 발생일·시각은 채울 수 있지만 이미 알려진 날짜·시각·시간대·키·분류를 교체하려면 correct가 필요하다.
- `correct`: enrich와 같은 입력 구조로 정정 이유를 필수로 받고 지정한 현재 사실·정체성·시간 필드를 교체한다. facts도 지정 목록으로 교체한다. 이전 snapshot·근거와 alias는 남긴다. 보고 시각·근거·출처는 과거 revision을 수정하지 않고 이번 revision에 기록한다.

정밀도 unknown은 발생일·시각 모두 null, date는 발생일만, exact는 발생일과 시작 시각, range는 발생일과 시작·종료 시각을 요구한다. timestamp는 UTC 또는 명시적인 offset이 필요하다. 시작 시각의 현지 날짜가 occurred_on과 일치하고 범위의 종료가 시작보다 빠르지 않아야 한다. 여러 날에 걸친 범위의 occurred_on은 시작일이다. 메시지 보고 시각의 진위는 서버가 판단하지 않으므로 GM이 제공된 시각만 보내야 한다.

성공은 `committed`, 재시도는 `replayed`, operation 결과는 `recorded`, `duplicate`, `enriched`, `corrected`, `unchanged`다. 변화 없는 반복은 사건 버전·revision을 늘리지 않는다. 새로운 근거 문구나 대화 출처만으로 별도 사건·revision을 만들지 않는다. `version_conflict`, `identity_conflict`, `idempotency_conflict`, `correction_required`, `not_found`, `invalid_input`을 구분하며 실패한 batch는 전체 rollback한다. 성공 영수증과 호출 감사도 같은 트랜잭션이다. 실패 영수증은 예약하지 않으므로 저장 오류 뒤 같은 입력으로 재시도할 수 있다.

## 마이그레이션과 적용 상태

`migrations/002-life-event-history.sql`은 001 이후 한 번 적용하는 트랜잭션 migration이다. 기존 UUID·근거·서버 시각·호출 감사·OAuth 데이터는 유지한다. 재실행 시 오류로 전체 rollback하며 자동 중복 적용하지 않는다. `scripts/setup-db.js`는 인수가 없으면 기존 001만 적용하고, 명시적인 001~007 파일명만 선택한다. 실행 대상은 기존 liferpg_experiment DB명 검증을 유지하며 pooler hostname은 접속 전에 거부한다. migration 파일이 자체 BEGIN/COMMIT을 관리하므로 전용 direct pg.Client를 사용한다. 격리 branch에서도 먼저 프로젝트·branch·endpoint를 확인해야 하며 DB명만으로 격리를 보장하지 않는다.

새 코드의 사건 도구에는 002 schema가 필요하다. 운영 적용은 별도 승인 후 백업·격리 검증·전환 계획을 확인해서 진행한다. migration과 코드 전환 사이에는 사건 쓰기를 중단해야 한다. 구버전 코드는 새 alias·revision에 참여하지 않으므로 두 코드 버전의 쓰기를 섞지 않는다. 이번 작업에서는 운영 migration·원격 smoke·배포를 실행하지 않았다.

`migrations/003-gm-growth.sql`은 002 이후 한 번 적용한다. 게임·캐릭터·GM 이력 테이블과 사건 변경에 따른 게임 버전 갱신 트리거를 추가하고, 기존 사건·버전·근거·alias·감사·OAuth 데이터를 보존한다. migration 자체는 게임이나 캐릭터를 만들지 않는다. 003도 setup 스크립트에 파일명을 명시할 때만 선택하며 기본값은 001이다. 운영 적용은 계속 별도 승인 대상이다.

`migrations/004-questlines.sql`은 003 이후 한 번 적용한다. 퀘스트라인·장/퀘스트·관계·퀘스트 변경 이력을 추가하고 기존 테이블·영수증·입력 hash를 변경하지 않는다. migration 자체는 이야기를 생성하지 않는다. 파일명을 명시해서만 실행하며 새 맥락 조회와 퀘스트 변경은 004 schema를 요구한다.

`migrations/005-character-content.sql`은 004 이후 한 번 적용한다. 정의와 불변 버전·캐릭터 취득 항목·인벤토리·콘텐츠 변경 이력을 추가한다. 기존 사건·캐릭터·퀘스트·영수증·OAuth 행을 수정하지 않고 캐릭터나 콘텐츠를 자동 생성하지 않는다. setup 스크립트에 파일명을 명시해야 하며 기본 migration은 계속 001이다. Phase 3B 코드의 초기화된 게임 맥락 조회와 콘텐츠/스탯 변경에는 005까지 적용된 schema가 필요하다. 이전 입력의 재시도는 기존 영수증과 hash를 유지한다. 운영 적용·배포는 수행하지 않았다.

`migrations/006-world-memory.sql`은 005 이후 한 번 적용한다. 세계 엔터티·NPC 관계·세계 사실·GM 기억·일지·구체적 FK 연결·세계 시계·불변 변경 이력을 추가한다. 기존 테이블 행·영수증·입력 hash를 수정하지 않고 세계를 자동 생성하지 않는다. Phase 3C/4 코드의 초기화된 게임 맥락 조회는 006까지 적용된 schema를 요구하며 최신 Phase 5 코드는 007도 필요하다. 명시적 파일명만 선택하며 기본 setup은 계속 001이다. 중복 적용 오류는 전체 rollback한다. 운영 적용·배포는 별도 승인 대상이며 이번 작업에서 수행하지 않았다.

## GM 판정과 성장 계약

`games`는 인증된 고정 소유자 experiment-owner와 연결하고 owner_id별 게임 하나를 허용한다. 소유자 ID는 MCP 입력으로 받지 않는다. games에는 revision·kind·growth-v1 규칙 버전·초기 시각을 보관하고 characters는 게임별 XP 잔액과 STR·DEX·VIT·INT·CHA·LUK를 보관한다. 레벨은 중복 저장하지 않고 XP로 계산한다.

레벨 L→L+1은 100×L XP, 레벨 L의 누적 문턱은 50×L×(L−1)다. 서버는 정확한 정수 문턱 비교로 레벨, 현재 레벨 내 XP, 다음 레벨까지 XP를 반환한다. XP 손실로 문턱 아래가 되면 레벨도 내려간다. 자동 스탯 보상은 없다. XP와 각 기본 스탯의 잔액은 0~Number.MAX_SAFE_INTEGER 정수, 증감은 같은 안전 정수 범위의 부호 있는 정수다. BigInt로 계산하고 검증한 뒤 JSON 숫자로 반환한다. 음수 잔액·범위 초과·소수·알 수 없는 스탯은 자동 보정하지 않고 거부한다.

`apply_gm_update`의 진행 입력은 다음 필드만 허용한다. 현실 사건 저장은 1단계 도구로 먼저 수행한다. 근거 없는 직접 XP·기본 스탯 patch는 받지 않는다.

| 필드 | 계약 |
| --- | --- |
| mode | advance |
| request_key | 소유자의 게임 내 안정된 재시도 키. 입력이 같은 성공 재시도는 저장 결과를 반환한다. 다른 입력으로 재사용하면 idempotency_conflict다. |
| expected_revision | get_game_context로 읽은 게임 버전. 불일치하면 revision_conflict와 현재 버전을 반환한다. |
| reason | 이번 변경의 짧은 이유, 최대 500자 |
| adjudications | 선택적 0~10개. 같은 주제·항목은 한 요청에 하나만 허용한다. |
| quest_changes | 선택적 1~40개 |
| content_changes | 선택적 1~40개 |
| world_changes | 선택적 1~40개. 변경 배열과 character_change의 합계가 1~100개여야 한다. |
| character_change | 선택적 `{changes,reason}`. Phase 5의 현재 캐릭터 전기를 수정하고 탄생 원본을 보존한다. |

각 판정은 subject, aspect_key, sources, previous_id, correction_of, reason, xp_delta, stats_delta로 구성한다. subject는 `{type:"event",event_id}` 또는 `{type:"event_group",key}`다. 사건 주제는 본인 사건을 근거에 포함해야 하고 사건 그룹은 서로 다른 사건 두 개 이상을 요구한다. 그룹 키는 여러 사건을 묶은 판정의 안정된 이름이며 퀘스트나 세계 엔터티를 생성하지 않는다. aspect_key 기본값은 base다. 키는 NFKC·소문자·공백 정규화하고 UUID도 소문자로 정규화한다.

sources는 `{event_id,event_version}` 목록이며 실제 life_event_revisions에 FK로 연결된다. 사건 순서는 판정 정체성에 영향을 주지 않고 같은 사건을 두 번 포함할 수 없다. 신규 판정은 현재 사건 버전을 요구한다. 합성 게임에는 현재와 근거 당시 모두 kind=test인 사건만 허용한다. 기존 real 사건은 그대로 보존하며 테스트 보상에 사용하지 않는다.

첫 판정은 previous_id=null이다. 같은 주제·항목의 추가 판정은 최신 판정 ID를 previous_id로 연결하고 이전 근거를 유지하면서 사건 버전이 증가하거나 새 독립 사건이 추가되어야 한다. 같은 근거를 다른 보상으로 다시 판정하려면 같은 판정 계열의 correction_of를 명시한다. 정정도 최신 previous_id에 연결하고 GM이 정한 추가 증감만 적용한다. 서버가 전체 보상을 재계산하거나 자동으로 과거 지급량을 취소하지 않는다.

`gm_adjudications`는 주제·항목·근거 버전 집합·정정 대상의 유일성과 판정 계열의 단일 후속 연결을 보장한다. 같은 판정을 다른 request_key나 다른 근거 순서·UUID 대소문자로 보내도 실제 증감 0의 duplicate 결과다. 이유 문구만 바뀌어도 원래 판정을 유지한다. 같은 정체성에 보상량이 다르면 adjudication_conflict로 거부한다. 새로운 항목 키가 의미상 기존 판정과 같은지는 GM이 판단해야 한다.

xp_delta와 stats_delta의 생략 값은 0이다. 새 사실에 보상을 주지 않기로 결정하면 0 증감 판정을 저장한다. 이는 검토가 완료된 새 판정이므로 게임 버전은 올라가고 캐릭터 수치는 유지된다. 이미 저장된 판정만 반복한 요청은 outcome=unchanged, 실제 증감 0이며 게임 버전을 올리지 않는다. 그 요청의 재시도 영수증은 저장한다.

`gm_updates`에는 요청 hash·이유와 저장 결과를, `gm_adjudication_sources`에는 정확한 사건 버전 참조를, `gm_change_entries`에는 초기 상태 또는 신규 판정별 중간 전후 값·실제 증감·레벨 변화를 저장한다. 이력은 UPDATE/DELETE 방지 트리거로 보호한다. 요청 결과에는 판정 ID·주제·근거·이전/정정 관계도 포함한다. 실패 뒤 보상만 남거나 성공 영수증 없이 판정이 남지 않도록 캐릭터·판정·근거·변경 이력·영수증·호출 감사를 같은 트랜잭션으로 커밋한다.

GM 변경은 1단계 사건 쓰기와 같은 transaction advisory lock을 먼저 얻고 게임 행을 잠근다. 성공 재시도는 버전 검증 전에 영수증을 반환하므로 이후 게임·사건이 변해도 같은 요청을 복구할 수 있다. 신규 변경만 게임 버전을 확인한다. 003의 트리거는 기존 record_life_event와 update_life_events의 성공 사건 생성·버전 변경도 게임 revision에 반영한다. 중복·무변경·rollback에는 변화가 없다. 게임 맥락은 동일 DB snapshot에서 반환한다.

기존 합성 초기 생성 입력은 `{mode:"initialize",request_key,expected_revision:0,reason,synthetic:true,character:{label,xp_total,stats}}`다. ALLOW_SYNTHETIC_GAME=true인 격리 테스트 설정에서만 허용하며 기본은 비활성이다. game kind는 항상 test다. 이 경로와 기존 입력 hash·재시도 영수증을 유지한다. 정식 초기 생성과 전체 합성 탄생 검증은 아래 Phase 5 계약을 사용한다. 기존 test 게임을 real 게임으로 자동 전환하거나 덮어쓰지 않으며 .env.local·운영 환경 설정은 변경하지 않았다.

## Phase 5 정식 캐릭터·세계 초기 생성

MCP 도구는 기존 9개를 유지한다. `apply_gm_update`에 초기 생성 전용 mode를 추가하고 `get_game_context`, `get_gm_update`로 준비 상태·저장 결과를 읽는다. MCP의 기존 단일 소유자 OAuth와 웹의 Clerk 소유자 매핑을 그대로 사용하며 입력으로 owner를 받지 않는다. 서버는 AI API를 호출하거나 GM이 작성할 세계 내용을 자동 생성하지 않는다.

| mode | 입력 및 동작 |
| --- | --- |
| begin_initialization | `request_key`, `expected_revision:0`, `reason`, `synthetic`, `character:{profile,xp_total,stats}`, `starting_location`, 선택적 초기 변경 배열·근거. 게임이 없을 때 초안을 만들고 `prepared` 영수증을 반환한다. |
| prepare_initialization | 새로운 `request_key`, `initialization_id`, `expected_initialization_revision`, `reason`, 하나 이상의 초기 변경 배열·근거. 원본 입력을 불변 chunk로 추가하고 초안 revision을 한 번 증가시킨다. |
| finalize_initialization | 새로운 `request_key`, `initialization_id`, 최신 `expected_initialization_revision`, `reason`. 준비된 모든 chunk를 검증하고 정식 게임·캐릭터·콘텐츠·퀘스트·세계·근거·이력·영수증·감사를 한 트랜잭션에서 확정한다. |
| cancel_initialization | 새로운 `request_key`, `initialization_id`, 최신 `expected_initialization_revision`, `reason`. 미확정 초안을 취소하고 입력·영수증을 보존한다. 게임은 생성하지 않는다. 잘못 작성된 초안은 취소한 뒤 새 키로 다시 준비한다. |

`synthetic:false`가 기본이며 game.kind=real이다. 합성 테스트는 `synthetic:true`와 명시적인 ALLOW_SYNTHETIC_GAME=true 설정이 모두 필요하고 kind=test만 생성한다. 동일 소유자에게 이미 real 또는 test 게임이 있으면 새로운 초기 생성은 `already_initialized`로 거부한다. 성공 요청의 정확한 재시도는 초안이 완료·취소되거나 후속 게임 변경이 있어도 저장 당시 영수증과 `replayed`를 반환한다. 같은 키의 다른 입력은 `idempotency_conflict`다. 초기 생성·일반 GM 변경의 요청 키 충돌도 거부한다.

초안 revision은 게임 revision과 독립이다. 다른 요청으로 중복 준비를 시작하면 `initialization_in_progress`, 이전 초안 버전의 변경은 `initialization_revision_conflict`, 이미 취소한 초안 변경은 `initialization_closed`다. 소유하지 않은 초안은 `not_found`다. 모든 쓰기는 기존 사건/게임 advisory lock을 먼저 얻고 초안 또는 게임 행 잠금을 사용한다. 프로세스 메모리나 하나의 Vercel 인스턴스에 준비 상태를 의존하지 않는다.

### 탄생 입력과 불변 기록

`profile`은 name(100자), species(160자), birth/background/destiny(각 2000자), 선택적 narrative, gm_notes(2000자), gm_state다. 필수 문자열은 비어 있을 수 없다. 종족·출생·배경·운명·서사 설정과 초기 XP·스탯은 GM이 정한다. narrative/gm_state는 기존 bounded JSON(4096 bytes·깊이 4) 계약이다. 공개 필드에는 공개 가능한 창작만 넣고 비공개 설정은 gm_notes/gm_state에 저장한다. 현실 사실 원본에 창작을 저장하지 않는다.

초기 XP와 STR/DEX/VIT/INT/CHA/LUK는 기존 growth-v1의 0 이상 안전 정수이며 레벨은 XP로 계산한다. 직접 level 지정·자동 레벨업 스탯 지급·새 성장 규칙은 없다. 직업·스킬·특성·칭호·업적·장비·인벤토리는 Phase 3B 정의/버전/취득/장착 operation으로 구성하고 현재 직업은 기존 change_profession으로 지정한다.

`character_births`는 최초 profile·XP·스탯, 초기 생성 ID, 최초 확정 update ID, 시작 지역 UUID를 보존하고 UPDATE/DELETE를 차단한다. 당시 장비·세계·퀘스트 상태는 같은 확정 영수증과 기존 불변 변경 이력으로 조회한다. `character_profiles`는 현재 profile이며 `mode:advance`의 `character_change:{changes,reason}`으로 명시적으로 발전·수정한다. 이름 변경은 기존 character.label도 갱신한다. 전후 원문·이유·update ID는 불변 `character_profile_changes`에 남는다. 합성 legacy 게임에는 탄생 profile을 임의로 생성하지 않는다.

### 세계 구성·chunk 참조·확정

quest_changes/content_changes/world_changes는 기존 Phase 3A~3C operation·상태·정의 버전·참조 검증을 재사용한다. 세계 루트·시작 지역·세력·NPC·NPC↔캐릭터 관계·역사·확정 설정·비밀·복선·퀘스트라인·장/퀘스트·GM 기억·일지를 필요한 만큼 작성할 수 있다. 세계 전체 크기·NPC 수·초기 스킬 수를 고정하지 않는다.

chunk마다 각 변경 배열 최대 40개, birth_sources 최대 20개, 총 100개 이하와 HTTP 16 KiB를 유지한다. 여러 chunk의 전체 엔터티 수에는 별도 제한이 없다. chunk는 서버 sequence 순서로 합치며 최종 적용 순서는 퀘스트→콘텐츠→세계→탄생 근거다. 각 subsystem의 @ref는 **전체 초기 생성 동안 유일**해야 하며 앞선 chunk 참조를 이후 chunk에서 재사용할 수 있다. 퀘스트 ref를 세계의 questline link에서 사용하는 기존 규칙도 유지한다. 부모·정의·source fact를 먼저 작성하고 잘못된 유형·다른 게임 UUID·계층 순환·슬롯 충돌은 기존 검증기로 거부한다.

`starting_location`은 세계 place의 UUID 또는 @ref다. 확정 시 같은 게임의 공개·활성 세계 루트, 공개·활성 시작 place, 활성 현재 직업이 필요하다. 다른 콘텐츠·NPC·퀘스트·근거 사건의 최소 개수는 강제하지 않는다. 필수 구성 누락은 `incomplete_initialization`이다. 작성 입력의 schema는 준비 시 검증하지만 객체 간 최종 참조·상태·수치 합산은 확정 시 검증한다.

준비·추가·취소는 `game_initializations`, 불변 `initialization_requests`만 저장한다. 확정 전에는 games·characters·기존 게임 상태 테이블에 행이 없으므로 웹·GM 맥락·일반 변경에 미완성 게임을 노출하지 않는다. 확정 중에도 하나의 트랜잭션의 이전 또는 이후 상태만 읽는다. 참조 오류·성장 overflow·이력·영수증·감사 실패는 모든 신규 게임 상태를 rollback하고 준비 초안은 직전 성공 revision에 남는다. 저장 장애는 정확한 요청 재시도로 복구하며 잘못된 초안 자체는 취소 후 다시 작성한다. 운영 DB의 statement timeout·대규모 확정 지연은 별도 환경 검증 대상이다.

### 과거 사건의 반영과 보상 중복

선택적 `birth_sources:[{event_id,event_version,reason}]`는 탄생에 반영한 과거 경험과 적용 이유를 정확한 기존 사건 revision에 연결한다. 같은 사건은 전체 chunk에 한 번만 포함한다. real 게임은 현재/당시 모두 real 사건, test 게임은 모두 test 사건을 요구하며 확정 순간의 현재 버전만 허용한다. 원본 사건·근거·alias·변경 이력을 삭제하거나 수정하지 않는다. 아직 저장하지 않은 과거 사건은 기존 사건 도구로 먼저 저장하고 UUID·버전을 사용한다.

이 사건들은 **이미 초기 XP·스탯에 포함된 경험**이다. 초기 수치는 한 번만 초기 성장 이력에 기록하고, 사건별 base 판정은 증감 0으로 저장하여 검토·반영이 끝났음을 예약한다. 탄생 영수증의 birth_sources와 list_gm_adjudications에서 적용 이유·원본 근거를 추적한다. 같은 근거를 0 증감으로 다시 검토하면 unchanged, 추가 최초 보상을 요청하면 adjudication_conflict다. 성장 변화 없는 base 예약은 별도 성장 보상을 기록하지 않는다.

나중에 발견한 새 사건은 일반 GM 판정으로, 같은 사건의 새 정보는 기존 base 판정의 previous_id를 연결한 추가 증감으로 다룬다. 명시적 correction_of 보정도 기존 규칙을 따른다. 사건 연결만으로 보상하거나 새로운 과거 정보로 게임을 초기화하지 않는다. 다른 aspect_key로 의미상 같은 보상을 요청하는 행위의 자동 판별은 기존과 같이 GM 책임이다. 사건이 전혀 없어도 초기 생성이 가능하다.

### 상태·영수증·공개 웹 조회

get_game_context의 initialization.status는 unstarted/preparing/completed다. 준비 중에는 initialized=false와 초기 생성 ID·초안 revision·kind만 반환하고 캐릭터·세계·GM 원문을 반환하지 않는다. 게임 완료 후에는 기존 revision·성장·퀘스트·콘텐츠·세계 조회로 이어진다. 단계별 get_gm_update(view=gm)는 gm_private.preparation_input으로 그 chunk의 원본 입력을 읽을 수 있어 응답 유실 후 준비를 복원할 수 있다. player view와 준비 영수증의 player_result에는 상태 메타데이터만 있다.

완료 게임의 character_profile은 현재 공개 전기다. include_birth=true는 최초 기록을, include_character_history=true는 history_limit(기본 20·최대 50)과 after_character_change_sequence/next_after_sequence로 전후 이력을 반환한다. GM 원문은 gm_private.character_profile/birth/character_history 및 변경 영수증의 gm_private.character_change로 분리한다. 공개 전기·탄생 snapshot·이력·영수증은 중첩 gm_* 키까지 제거한다. 세계 비공개 투영은 기존 Phase 3C를 그대로 따른다.

웹은 기존 Clerk 소유자 인증과 읽기 전용 API를 유지한다. 미시작/준비 중/시작 완료를 구별하고 캐릭터 화면에서 공개 종족·출생·배경·운명을 표시한다. 준비 중 웹 응답에는 초기 생성 ID·초안 revision·작성 원문을 넣지 않는다. 디자인과 나머지 탐색 구조는 유지한다.

`007-game-initialization.sql`은 006 이후 명시적으로 한 번 적용하는 추가형 migration이다. 기존 행을 변경하거나 게임을 생성하지 않는다. 최신 get_game_context와 정식 초기 생성에는 001~007 schema가 필요하다. 이전 단계의 합성 초기화·진행 입력은 007 적용 전에도 기존 계약으로 실행할 수 있지만 새 기능은 007을 요구한다. setup 기본값은 계속 001이고 운영 migration·배포·실제 초기 생성은 수행하지 않았다.

## 연속 퀘스트라인 계약

퀘스트는 현실의 할 일 목록이 아니라 GM이 작성하는 이세계 이야기다. `questlines`와 `quest_nodes`에 고유 UUID·안정된 생성 키·제목·설명·목표·진행 내용·결말·상태·버전을 저장한다. 수치 진행률은 받지 않는다. 여러 라인을 동시에 active로 운영할 수 있고 개별 퀘스트는 같은 라인의 장을 선택적으로 부모로 참조한다. 장은 다른 장의 자식이 될 수 없고 부모와 소속 라인은 생성 후 고정이다.

quest_changes는 아래 operation을 지원한다. 각 operation의 reason은 필수이며 이야기는 GM이 결정한다. create 제목 최대 160자, 설명·진행·결말 최대 1000자, 목표 최대 500자다. status 기본은 available이며 생성 시 available/active만 허용한다.

| operation | 주요 입력 |
| --- | --- |
| create_line | ref, line_key, title, 선택적 description/goal/progress/ending/status |
| create_node | ref, questline, node_key, kind=chapter 또는 quest, 선택적 parent와 이야기 필드 |
| update_line | questline, changes, 선택적 reopen/retain_children |
| update_node | node, changes, 선택적 reopen/retain_children |
| link_nodes | from, to, kind=prerequisite 또는 branch, label, active |
| link_lines | from, to, label, active |
| link_event | questline, 선택적 node, event_id, event_version, label, active |

ref는 `@sea`, `@chapter` 같은 요청 내 이름이다. 부모를 먼저 생성한 뒤 장·퀘스트·연결에서 그 ref를 사용한다. 기존 UUID도 같은 참조 필드에 사용할 수 있다. ref는 요청 안에서 유일해야 하고 다른 유형으로 사용할 수 없다. line_key는 게임 내, node_key는 라인 내 유일하다. 같은 생성 키와 같은 현재 내용은 기존 UUID를 재사용하며, 다른 내용이면 quest_identity_conflict로 명시적 수정이 필요하다. 기존 Phase 2 입력에 생략된 quest_changes를 기본 배열로 삽입하지 않아 저장된 재시도 hash를 유지한다.

상태는 available, active, paused, completed, failed, abandoned다. available→active 또는 종료, active↔paused, active/paused→종료를 허용한다. 종료 상태에서 active로 돌아갈 때 reopen=true와 reason을 요구하며 과거 결말과 상태를 이력에 남긴다. 라인 종료가 자식 성공을 자동 결정하지 않는다.

라인·장을 paused 또는 종료 상태로 바꾸면 모든 미해결 자식을 같은 요청에서 명시적으로 상태 처리하거나 retain_children에 ID/ref로 열거해야 한다. 라인은 모든 장·퀘스트, 장은 직속 퀘스트를 대상으로 한다. 유지된 자식의 현재 상태는 그대로 남지만 비활성 부모 아래에서는 진행·결말 변경·활성화·완료를 따로 진행할 수 없다. 부모를 같은 요청에서 활성화하면 자식을 이어갈 수 있다. 부모 종료 요청에서 자식을 paused/종료로 처리하는 정리는 허용한다. retain_children 최대 100개, 각 요청의 원자성만 보장한다.

prerequisite는 선행 노드→후속 노드다. 순환·자기 연결을 거부하고 후속 노드를 active/completed로 진행할 때 선행 노드가 모두 completed인지 검증한다. 같은 요청의 최종 상태를 기준으로 검증하므로 선행 완료와 후속 시작을 함께 처리할 수 있다. branch의 label은 GM이 정하는 선택 조건·장면이며 서버가 선택하거나 다른 분기를 자동 실패시키지 않는다. 노드 연결은 같은 라인만 허용하고 라인 간 교차 이야기는 link_lines로 표현한다.

현실 사건 연결은 라인·선택적 노드·사건 UUID를 기준으로 N:M 관계를 유지하며 실제 event_version에 FK로 연결된다. 과거 버전도 연결 가능하고 새 버전으로 연결을 보강하면 이전 버전은 퀘스트 변경 이력에 남는다. 합성 게임에는 test 사건만 연결한다. 같은 날 반복 활동은 각 사건 UUID로 연결한다. 연결은 사건의 사실·보강 이력을 수정하지 않고 퀘스트를 자동 완료하거나 성장 보상을 지급하지 않는다.

관계 변경은 동일 endpoint의 ID를 유지하면서 label·버전·active를 바꾼다. active=false로 연결을 중단할 수 있고 행을 삭제하지 않는다. 모든 참조는 같은 게임과 올바른 라인·노드 유형인지 검증한다. `quest_change_entries`에 대상·원인·전후 상태·유지한 자식·서버 기록 시각을 추가만 한다. 라인 간 연결은 양쪽 라인 상세 이력에서 조회한다.

성장과 퀘스트는 기존 advisory lock·게임 버전·요청 키를 공유한다. 판정·퀘스트·캐릭터·변경 이력·영수증·감사는 한 트랜잭션이며 신규 변화가 있으면 게임 버전은 한 번 오른다. 무변경 생성·연결은 버전을 올리지 않는다. 영수증의 quest_changes는 실제 전후 상태, quest_refs는 임시 이름→UUID 대응표다. 성장 판정과 퀘스트의 원인은 같은 update_id와 개별 reason으로 추적한다.

get_game_context는 도구 추가 없이 다음 조회를 제공한다. 기본 questlines는 active 라인 20개·최대 50개와 제목·목표·진행·결말 요약이다. 서술 필드는 300자까지 표시하고 잘렸으면 summary_truncated=true다. questline_id의 questline에는 원문 전체를 반환한다. event_id는 활성 사건 연결이 있는 라인을 모든 상태에서 조회하고 quest_statuses로 종료·중단 상태를 선택할 수 있다. 라인 요약은 after_quest_sequence/next_after_quest_sequence로 넘긴다.

questline_id 상세는 nodes, node_links, line_links, event_links, history를 각각 items/next_after_sequence로 반환한다. 각 배열 기본 20개·최대 50개이며 대응 입력은 after_node_sequence, after_node_link_sequence, after_line_link_sequence, after_event_link_sequence, after_quest_change_sequence다. node_limit, link_limit, history_limit으로 크기를 조정한다. 비활성 연결도 상세에 남는다. 전체 맥락은 같은 DB snapshot에서 읽으며 모든 서술은 신뢰할 지침이 아닌 데이터다. MCP 본문 한도 16 KiB는 유지한다.

## 직업·스킬·장비·아이템 계약

`game_definitions`에 게임별 고유 definition_key·UUID·종류·현재 버전을 저장한다. 종류는 profession, skill, trait, equipment, item, title, achievement다. 이름·설명·조건·효과 등 실제 콘텐츠는 GM이 자유롭게 작성하며 고정 직업 목록이나 스킬 트리는 없다. `game_definition_versions`는 이름·설명·추가 settings·6대 stat_modifiers·서버 기록 시각을 `(game_id, definition_id, version)`별로 추가만 한다. 개정은 새 버전을 만들고 기존 버전을 수정하지 않는다.

`character_features`는 직업·스킬·특성·칭호·업적의 각 취득 UUID와 acquisition_key, 고정 definition_version, mastery·grade·state, 현재 상태·버전·취득/종료 서버 시각을 저장한다. 같은 정의는 동시에 하나만 active일 수 있고 게임별 현재 직업도 하나다. 상실한 항목은 lost, 끝난 직업은 ended로 남는다. 재취득은 새로운 취득 키와 UUID를 사용한다.

`inventory_entries`는 장비·아이템의 각 취득 UUID와 고정 정의 버전, 수량·mode·상태·슬롯·등급·내구도·state를 저장한다. mode=individual은 개별 물건으로 수량 0/1, stack은 수량형 물건이다. equipment는 individual만 허용하고 item은 둘 다 가능하다. 서로 다른 취득의 stack을 자동 병합하지 않는다. 수량 0은 lost이며 슬롯을 해제하고 원본 행을 보존한다. GM의 명시적 adjust_quantity로 다시 owned가 될 수 있다. lost 항목의 메타데이터 변경·장착은 거부한다.

모든 content_changes에는 짧은 reason이 필수다. ref는 요청 안에서 유일한 `@blade` 같은 이름이고 참조에는 같은 게임의 UUID도 사용할 수 있다. 정의를 먼저 만들고 지급·변경에서 참조한다. 콘텐츠 ref는 퀘스트 ref와 별도 범위이며 둘 사이의 참조는 지원하지 않는다. 정의 종류와 개별 취득의 종류는 고정이고 보유 항목의 버전 변경은 같은 정의 안에서만 허용한다.

| operation | 주요 입력 및 동작 |
| --- | --- |
| create_definition | ref, definition_key, kind, name; description/settings/stat_modifiers 선택. 새 정의 버전 1 생성 |
| revise_definition | definition, expected_version, changes. 최신 버전 검사 후 새 불변 버전 생성 |
| change_profession | ref, acquisition_key, definition, definition_version; mastery/grade/state 선택. 현재 직업 종료와 새 직업 취득을 함께 기록 |
| grant_feature | 직업 외 feature 취득. 위 취득 필드와 동일 |
| update_feature | feature, changes={mastery?,grade?,state?,definition_version?}. active 항목만 변경 |
| lose_feature | feature. 상실/직업 종료, 과거 이력 유지 |
| grant_inventory | ref, acquisition_key, definition, definition_version, mode; quantity 기본 1, grade/state/durability/max_durability 선택 |
| adjust_quantity | entry, quantity_delta. 부호 있는 수량 증감, 잔액·개별 장비 수량 검증 |
| update_inventory | entry, changes={grade?,state?,durability?,max_durability?,definition_version?} |
| equip | entry, slot. 보유 개별 장비만 장착, GM이 새 슬롯 이름을 사용 가능 |
| unequip / lose_inventory | entry. 슬롯 해제 / 수량 0과 상실 상태 |

예를 들어 같은 요청의 content_changes에 create_definition(ref=@blade, kind=equipment)를 넣은 뒤 grant_inventory(definition=@blade, definition_version=1, ref=@owned, mode=individual), equip(entry=@owned, slot=GM이 정한 이름)을 순서대로 넣는다. 정의를 수정해도 보유품은 원래 버전의 이름·효과·보정을 유지하며 update_feature/update_inventory의 definition_version을 명시해야 새 버전을 사용한다. 그 변경도 전후 이력을 남긴다.

definition_key·acquisition_key·슬롯은 NFKC·소문자·공백 정규화한다. 같은 정의 키와 같은 현재 정의는 기존 UUID를 재사용하고 다른 내용은 definition_identity_conflict다. 같은 취득 키와 같은 최초 지급 내용은 현재 보유 행을 반환하고 변화가 없다. 이미 상실·소모·전직한 취득을 재호출해도 복원·재전직하지 않는다. 지급 내용이 다르면 acquisition_conflict다. active feature에 다른 키로 중복 지급하려 하면 feature_already_owned이며 update_feature를 사용해야 한다. 새로운 키로 의미상 같은 보상을 만드는지는 GM이 판단한다.

quantity·mastery·durability·max_durability는 0~Number.MAX_SAFE_INTEGER 정수이고 최초 수량은 양수다. 수량 증감과 각 stat_modifiers는 부호 있는 안전 정수다. 내구도의 미상 값은 null이며 둘 다 알려졌을 때 durability≤max_durability를 요구한다. grade는 최대 80자, 이름 160자, 설명 1000자다. settings/state는 UTF-8 4096 bytes 이하 JSON 객체이며 깊이 4 이하, 객체/배열 항목 30개 이하, 키 80자·문자열 1000자 이하와 안전 범위의 유한 숫자만 허용한다. 자유 JSON을 실행하거나 효과 문구를 해석하지 않는다.

게임별 한 슬롯에는 하나만 장착한다. 점유 슬롯을 교체하려면 같은 요청에서 기존 장비를 먼저 unequip하고 새 장비를 equip한다. 장비를 다른 빈 슬롯으로 옮길 수 있다. 장착·해제·상실·수량 변화는 기본 스탯을 수정하지 않는다. 내구도 0의 자동 파괴/효과 제거, 등급별 계산, 조건부 효과는 제공하지 않으며 GM이 명시적으로 처리한다.

`character.stats`는 기존 계약대로 기본 스탯이다. 맥락 루트의 base_stats도 같은 값이다. stat_modifiers는 모든 active feature와 장착된 owned equipment가 참조한 불변 정의 버전의 6개 보정 합계다. 가방 속 장비·일반 아이템·상실 항목은 보정하지 않고 수량으로 보정을 곱하지 않는다. display_stats는 `max(0, base_stats + stat_modifiers)`다. BigInt로 합산하며 보정 합계나 표시 수치가 안전 정수 범위를 넘으면 전체 변경을 거부한다. 배율·코드·자연어 효과·전투 판정은 서버 계산에 포함하지 않는다.

성장·퀘스트·콘텐츠는 같은 advisory lock·게임 행 잠금·expected_revision·request_key를 공유한다. 신규 변화가 있으면 게임 버전은 요청당 한 번만 증가한다. 완전 무변경 요청도 영수증을 저장하며 게임 버전은 유지한다. 생략한 content_changes에 기본 배열을 추가하지 않아 이전 Phase 2/3A 입력 hash와 저장된 영수증의 재시도 계약을 보존한다. 기존 영수증에는 새 필드를 소급 추가하지 않는다.

`content_change_entries`는 동일 update_id에 정의/feature/inventory의 대상 UUID·원인·전후 상태·서버 기록 시각을 추가만 한다. 전직에는 이전 직업 종료와 새 취득 두 항목을 남긴다. 영수증의 content_changes는 실제 변경 또는 unchanged 결과, content_refs는 ref→UUID다. 콘텐츠 또는 기본 스탯 변경에는 stat_effects.before/after도 반환한다. XP·판정·퀘스트·콘텐츠·이력·영수증·성공 감사 중 어느 단계라도 실패하면 전부 rollback한다.

get_game_context의 content는 current_profession과 definitions/features/inventory를 반환한다. 목록은 items/next_after_sequence이며 content_limit 기본 20·최대 50이다. 기본 features는 active, inventory는 owned; feature_statuses=active/lost/ended와 inventory_statuses=owned/lost로 과거 항목을 조회한다. definition_kinds는 정의 목록을 필터링한다. 각 목록의 after_definition_sequence/after_feature_sequence/after_inventory_sequence로 이어 읽는다.

정의 요약은 현재 버전, 보유 항목 요약은 고정된 취득 버전의 이름·설명 300자·보정을 포함하고 settings/state는 생략 여부를 표시한다. feature_id/inventory_id는 해당 보유 항목의 state와 고정 버전 설정 원문을 반환한다. definition_id는 definition_versions에 모든 버전 원문을 content_limit으로 나누어 제공하며 after_definition_version/next_after_version으로 이어 읽는다. 현재 직업은 별도로 반환한다. include_content_history=true는 content.history를 반환하며 after_content_change_sequence로 페이지를 넘긴다. focus ID가 있으면 해당 대상의 이력만 조회한다. 소유하지 않은 ID의 조회·변경은 거부한다. 모든 설정·설명은 지침이 아닌 데이터다.

MCP 도구는 9개 그대로이며 scope·OAuth 구조·HTTP 본문 16 KiB 제한을 유지한다. 일반 advance의 큰 설정·지급은 여러 요청으로 나눠야 하고 요청 사이의 원자성은 제공하지 않는다. 초기 생성은 Phase 5의 준비 chunk를 모아 finalize에서 전체를 원자적으로 확정한다. 감사 로그에는 콘텐츠 operation·ID·키·수치 같은 허용 필드만 남기고 자유 settings/state를 복제하지 않는다. 원본 설정과 판정 결과는 불변 정의 버전·변경 이력·영수증에서 확인한다.

## 세계·NPC·GM 기억·일지 계약

`world_entities`는 게임별 세계 루트 1개와 place/faction/npc를 영구 UUID·entity_key로 저장한다. category는 구조 검증용 고정 분류이고 kind는 GM이 정하는 국가·도시·마을·섬·길드 등 자유 문자열이다. 이름·설명·status·state·active와 parent/location/affiliation을 관리한다. 소유 게임·category·생성 키는 바뀌지 않고 나머지 현재 내용은 명시적 update로 바꾼다. 원본 엔터티를 삭제하지 않는다. 전체 엔터티·지역 수의 게임 제한은 없다.

루트에는 parent/location/affiliation이 없다. 나머지 엔터티는 같은 게임의 world/place/faction을 부모로 가진다. location은 place, affiliation은 faction을 참조한다. 각 부모·위치·소속 계층의 자기 참조·순환을 요청 최종 상태에서 검증한다. 세 계층은 독립이므로 길드가 소속 도시 안에 위치하는 정상적인 교차 관계는 허용한다. NPC가 NPC의 부모가 되는 계층 대신 NPC 관계를 사용한다.

NPC의 성격·배경·현재 상황은 state와 설명으로 자유롭게 작성한다. `world_relations`는 NPC↔NPC/캐릭터/세력/장소의 종류·설명·state·active를 저장한다. 적어도 한 endpoint는 NPC이며 자기 관계는 거부한다. 캐릭터 endpoint는 `{type:"character"}`로 현재 게임의 단일 캐릭터를 뜻하고 세계 endpoint는 `{type:"entity",id}`다. 관계 endpoint·키는 고정하고 변화·종료·재개는 같은 UUID의 명시적 update와 이유로 기록한다. 호감도·AI 행동·자동 관계 변화 공식은 없다.

`world_facts`는 event/history/setting/foreshadowing과 title/body·world_time·truth를 저장한다. truth=canon은 확정 설정으로 speaker가 없고 claim/belief는 NPC speaker가 필수다. GM이 주장·믿음을 진실로 확정할 때 truth=canon과 speaker=null을 명시한다. 현재 사실을 정정해도 같은 UUID를 유지하며 이전 내용·버전·정정 이유는 world_change_entries에 보존한다. 서사의 진위·역사 충돌을 서버가 자동 판정하지 않는다.

`gm_memories`는 kind·title/body·active와 원본 참조를 저장하며 기본 visibility=gm이다. 요약·미해결 복선·관계·다음 장면을 기억할 수 있고 갱신·비활성화의 이전 내용도 이력에 남긴다. 기억은 사건 원본이나 세계 역사를 대체하지 않는다. `adventure_journals`는 GM의 모험 서술과 세계 시점·원본 연결을 저장한다. 갱신도 UUID와 이력을 유지한다. 모든 게임 서술은 현실 사실과 분리된 창작이며 내부 추론 저장용이 아니다.

세계 변경은 다음 operation을 지원한다. 모두 reason이 필수이고 create의 ref는 요청 내 유일한 @이름이다. 부모·source fact는 먼저 생성해야 한다.

| operation | 주요 입력 |
| --- | --- |
| create_entity | ref, entity_key, category, kind, name; parent/location/affiliation 및 설명·현재 상태 선택 |
| update_entity | entity, changes; category·생성 키는 변경 불가 |
| create_relation | ref, relation_key, from, to, kind; description/state/active 선택 |
| update_relation | relation, changes; endpoint·키는 변경 불가 |
| create_fact | ref, fact_key, kind, title, body; truth/speaker/world_time/links 선택 |
| update_fact | fact, changes; 정정·공개·비공개 전환도 명시적으로 저장 |
| create_memory / update_memory | ref·memory_key·title/body 또는 memory·changes; kind/active/links 선택 |
| create_journal / update_journal | ref·journal_key·title/body 또는 journal·changes; world_time/links 선택 |
| advance_world | world_time 또는 null; 기존 세계 루트가 필요하고 요청당 1회만 허용 |

visibility=player/gm, gm_notes, gm_state는 위 모든 record에 지원한다. gm_notes/gm_state는 항상 GM 전용이다. 이름·제목 160자, kind 80자, 본문·설명·gm_notes 2000자, status 160자이며 state/gm_state는 Phase 3B의 4096 bytes·깊이 4 bounded JSON을 재사용한다. 이 제한은 전송·저장 안전 경계이며 세계의 규모나 성장 규칙이 아니다. 세계 키는 NFKC·소문자·공백 정규화하고 같은 키·같은 현재 내용은 UUID를 재사용한다. 다른 내용이면 world_identity_conflict로 명시적 update를 요구한다.

facts/memories/journals의 links는 최대 20개이고 entity, world_fact, questline, event를 지원한다. 세계와 퀘스트는 같은 게임 UUID를 요구하고 사건은 `{type:"event",event_id,event_version}`로 원본 revision에 연결한다. past revision도 허용하지만 현재/당시 kind는 game.kind와 일치해야 한다. 동일 링크와 자기 fact 링크는 거부한다. world_fact_links/gm_memory_links/adventure_journal_links의 구체적 FK로 현재 참조를 보장하고, 링크 교체 전후는 불변 변경 snapshot에 보존한다.

같은 요청의 세계 ref로 지역→NPC→관계/세계 사건→기억/일지를 연결할 수 있다. world links의 questline은 앞서 같은 요청에서 생성한 quest ref도 사용할 수 있다. 퀘스트·콘텐츠·세계 ref는 유형별로 해석하며 잘못된 유형은 거부한다. 현실 사건은 기존 사건 도구로 먼저 저장한다. 현실 사건 연결만으로 XP·퀘스트 완료·NPC 행동을 만들지 않는다.

### 세계 시간과 연대기

world_time은 `{label,order}` 또는 null이다. label은 GM이 정하는 세계 내 시점(최대 160자), order는 비교 가능한 세계 시점의 부호 있는 안전 정수 또는 null이다. 세계 시각을 실제 UTC timestamp로 변환하지 않고 알 수 없는 값은 null이다. GM이 확정된 시간축을 유지하고 정정 이유를 기록한다. 서버가 경과 시간을 세계 시간으로 환산하지 않는다.

`world_clocks`는 explicit advance_world의 world_time과 서버 last_world_advanced_at를 보존한다. get_game_context의 world.clock/gm_private.world.clock은 서버 현재 UTC와 elapsed_real_ms도 반환하며 아직 진행 기록이 없으면 last/elapsed는 null이다. 읽기·시간 경과·일반 NPC 편집은 시계를 자동 진행시키지 않는다. 같은 요청 키의 재시도도 last timestamp를 갱신하지 않는다. GM이 다음 실행에서 실제 경과를 참고해 변화와 보상을 따로 결정한다. AI 스케줄러·정기 보상은 없다.

include_chronicle=true는 현실 사건·세계 event/history·모험 일지를 합친 현재 기록의 연대기를 제공한다. chronicle_order=recorded 기본값은 최초 서버 기록순, occurred는 알려진 현실 발생순, world는 GM이 준 세계 order순이다. 다른 시간축이나 미상 order를 실제 세계 시각으로 추정하지 않고 알려진 축 뒤에 기록순으로 배치한다. 날짜만 아는 현실 사건은 date_helper 정렬 기준을 표시하며 정렬용 자정 키를 실제 발생 시각 필드에 저장하지 않는다. 현실 발생/보고/서버 시각과 세계 label/order는 각각 원본 필드로 남는다.

연대기는 world_limit과 after_chronicle/next_cursor의 keyset 페이지를 사용한다. 같은 날짜·시각은 type/UUID로 정렬을 안정화하고 microsecond 정밀도를 보존한다. cursor의 정렬 종류를 바꾸면 거부하며 같은 필터를 유지해야 한다. 기록이 정정되어 정렬 위치가 바뀌면 새 조회를 시작한다. event_id/questline_id로 관련 연대기를 좁힌다. 이전 버전의 정정 과정은 원본 사건 revision·world history·GM 영수증에서 조회한다. 별도 연대기 원본이나 일일 정산 테이블은 만들지 않는다.

### 공개 결과·GM 전용 결과·맥락 조회

get_game_context의 world는 공개 엔터티/관계/사실/기억/일지/시계다. view=gm 기본값은 gm_private.world에 원문을 추가하고, view=player는 gm_private를 반환하지 않는다. visibility=gm row, gm_notes/gm_state, 비공개 source 링크·parent/location/affiliation ID는 공개 결과에서 제외한다. 비공개 NPC endpoint·speaker가 필요한 관계/주장도 공개 투영에서 숨긴다. 공개 필드의 state/body는 GM이 공개 가능한 내용만 넣어야 하며 서버가 자연어 비밀을 추정하지 않는다.

세계 영수증의 world_changes/world_refs는 공개 투영이고 gm_private.world_changes/world_refs에는 모든 실제 전후·원인·ID가 있다. 별도의 player_result는 성장·퀘스트·콘텐츠·공개 세계 변화만 담고 GM reason을 제외한다. 공개→비공개는 이전 공개 내용과 after=null, 비공개→공개는 before=null과 새로운 공개 내용으로 발표한다. 공개 엔터티의 gm_notes/gm_state만 바뀐 경우 공개 변화 목록에서 생략한다. 공개 projection은 과거 snapshot에도 적용하여 이전 비공개 본문을 공개 이력에 끼워 넣지 않는다. 공개 refs·중첩 JSON·일지·검색·연대기도 같은 경계를 따른다.

get_gm_update(view=player)는 저장 당시 player_result를 반환한다. 이전 단계 영수증에 없으면 읽기 시 기존 공개 필드로 투영하며 원본을 수정하지 않는다. default gm과 성공 재시도는 저장 영수증 원문을 유지한다. 공개 당시 저장된 영수증은 나중에 비공개로 전환해도 과거의 공개 결과로 남는다. 새 context 조회는 현재 공개 상태를 따른다. MCP GM 원문·감사 진단은 같은 계정의 도구 기록에서 볼 수 있으므로 이 구분은 스포일러/표현 경계이며 별도 보안 주체를 도입한 것이 아니다.

world sections는 entities/relations/facts/memories/journals와 각 items/next_after_sequence다. world_limit 기본 20·최대 50이며 after_world_entity_sequence/after_world_relation_sequence/after_world_fact_sequence/after_memory_sequence/after_journal_sequence로 이어 읽는다. 기본 기억은 active이고 memory_active=false로 비활성 기억을 조회한다. 기본 본문·설명·GM 메모는 300자 요약과 잘림 표시, state/gm_state는 생략 표시다. focus ID가 있으면 설정 원문을 반환한다.

world_entity_id는 본체·직접 부모/위치/소속 자식과 NPC 관계, 관련 사실·기억·일지를 조회한다. world_fact_id는 해당 사실과 연결된 기억·일지를 좁힌다. memory_id/journal_id는 개별 원문을 조회한다. world_query는 이름·제목·본문·설명을 문자 검색하며 GM query는 GM 메모도 검색한다. 공개 검색은 비공개 본문으로 공개 후보를 만들지 않는다. event_id/questline_id는 사실·기억·일지의 관련 원본 필터를 적용한다. 없는·다른 게임·player view의 비공개 focus는 world_not_found다.

include_world_history=true는 world.history의 전후·버전·기록 시각을 world_limit으로 나누고 after_world_change_sequence로 이어 읽는다. focus가 있으면 해당 대상 이력이며 원문·reason은 GM 조회에만 있다. 공개에서 숨긴 snapshot 때문에 페이지가 비어도 next cursor가 있으면 계속 읽는다. 세계 이력은 UPDATE/DELETE 방지 트리거로 보호한다. 전체 맥락은 기존 repeatable-read snapshot을 공유한다.

world_changes는 기존 게임 잠금·request_key·expected_revision·단일 revision 증가를 공유한다. 성장·퀘스트·인벤토리·세계·기억·일지·이력·영수증·감사 실패는 모두 rollback한다. 생략한 world_changes에 기본값을 넣지 않아 이전 입력 hash와 재시도 계약을 유지한다. 기존 OAuth와 9개 MCP 도구, HTTP 본문 16 KiB를 유지하며 일반 advance의 여러 요청 사이의 원자성은 없다. 초기 생성의 여러 준비 chunk는 Phase 5 finalize에서 함께 검증·확정한다. 감사 입력에는 세계 operation과 대상/임시 ID만 요약하고 비공개 본문·JSON은 복제하지 않는다.

## 인증

이 실험은 단일 소유자와 정적 OAuth client 하나를 대상으로 한다. OAuth authorization code + PKCE S256, 정확한 redirect allowlist, issuer 응답(`iss`), resource 결합, 읽기/쓰기 scope, 1시간 access token과 30일 refresh token을 제공한다. `offline_access` 요청 시 refresh token을 발급하고 매번 회전한다. code와 refresh token은 DB 트랜잭션에서 한 번만 소비한다. token endpoint는 `client_secret_post`, `client_secret_basic` 지원. DCR/CIMD는 구현하지 않으므로 ChatGPT에 정적 client ID/secret을 설정한다.

소유자는 OAuth 페이지에서 별도 무작위 연결 키를 입력해 승인한다. 폼은 동일 origin 검증과 5분 일회용 ticket으로 보호한다. 승인 code는 2분간 유효하다. 입력 비밀값은 감사 로그나 console에 출력하지 않는다. `life.read`와 `life.write`는 개별 도구에서 검증한다. 없는·만료된·위조된·다른 resource의 토큰은 거부한다.

`initialize`, `tools/list`, `ping`, 초기화 notification은 공개 discovery다. 실제 사건·상태 조회와 기록은 인증이 필요하다. `/health`는 공개 프로세스 상태만 반환하며 DB 준비 상태는 보장하지 않는다. OAuth discovery는 `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`에서 제공한다.

개별 토큰 폐기는 `/oauth/revoke`로 한다. refresh 폐기는 이미 발급된 access token을 함께 취소하지 않는다. 전체 연결을 즉시 취소하려면 전용 DB에서 해당 client의 access/refresh grant를 제거해야 한다. 정식 계정 관리 제품으로 확대하지 않는다.

## 검증 기준

Phase 7 운영 준비 결과는 [검증 기록](docs/PHASE7-VERIFICATION.md)에 있다. `MAINTENANCE_WRITES=true`이면 `/mcp*`·`/oauth*`의 모든 method를 인증·OAuth·DB 접근 전에 503, `Cache-Control:no-store`, `Retry-After:300`으로 거부한다. Vercel entry에서도 config/DB 초기화 전에 검사하며 기본값은 false다. health/discovery는 유지한다. 기존 deployment의 코드는 이 flag를 읽지 않으므로 운영 전환에는 프로젝트 전체 WAF 차단이 필요하다. **Phase 8-A에서 프로젝트 전체 WAF를 실제 적용해 유지 중**이며 결과는 [A 검증 기록](docs/PHASE8A-VERIFICATION.md)에 있다. 전환 후에도 과거 deployment의 구버전 writer를 열지 않도록 canonical MCP host 제한 규칙을 유지하는 계획이며 그 별도 규칙은 아직 적용하지 않았다.

Phase 6의 실제 Neon 검증 결과와 승인 지점은 [검증 기록](docs/PHASE6-VERIFICATION.md), [운영 전환 절차](docs/OPERATIONS-TRANSITION.md)에 기록한다. 운영 DB에는 READ ONLY 조회만 수행했고 전후 schema·행 해시가 동일했다. 현재 운영 schema는 001이며 최신 코드와 혼용하지 않는다.

`connectDatabase`는 프로세스별 max=3 pg pool, 10초 연결 대기·statement timeout을 사용한다. Neon pooler에서 startup statement_timeout이 0으로 관측되어, 앱의 단독 query와 transaction 모두 BEGIN 후 SET LOCAL statement_timeout='10s'를 적용하고 동일 client에서 COMMIT/ROLLBACK한다. SET LOCAL은 트랜잭션 끝에 해제된다. 이는 개별 SQL 제한이며 전체 GM 변경의 시간 제한은 아니다. 웹의 READ ONLY/REPEATABLE READ와 기존 advisory lock 순서는 유지한다.

로컬 Vercel 설정은 MCP api/server.js의 maxDuration을 120초, 웹 api/web.js는 30초로 준비한다. 운영 배포에는 아직 MCP 30초 설정이 있다. Windows→격리 Neon direct 측정에서 62개 세계 엔터티 finalize는 약 53.3초였다. 이 값은 sin1의 실제 배포 지연을 의미하지 않으며 무제한 세계가 120초 안에 완료됨을 보장하지 않는다. 실제 배포 환경·클라이언트 timeout 검증이 필요하며 응답 유실은 기존 request_key/영수증으로 복구한다. 큰 SQL이 모두 10초보다 짧아도 전체 트랜잭션은 그보다 길 수 있다.

- `npm run check`: JavaScript에 대한 TypeScript 정적 검사.
- `npm test`: PGlite(Postgres) 기반, 공식 MCP client 연결과 실제 HTTP 메시지 검증. 인증, scope, audience, PKCE, replay, refresh, revoke, 중복, skip, 입력 오류, 감사 로그, rollback 포함.
- `npm run test:browser`: 설치된 Edge 또는 `BROWSER_EXECUTABLE_PATH`의 Chromium으로 로그인 페이지에서 승인 버튼을 실제 클릭하고 Origin 전달·303 callback·토큰 교환을 검증한다. Postgres는 별도 메모리 DB이고 ChatGPT callback은 브라우저에서 가로채 외부 계정에 접근하지 않는다. 로그인 페이지는 `strict-origin` 정책으로 URL/query를 노출하지 않으면서 form POST의 Origin을 보존한다. 원본·null·미지정·타 도메인의 Origin 검사를 느슨하게 하지 않는다.
- `npm run smoke`: 지정한 서버에 공식 MCP SDK로 연결. 실제 Postgres에서 합성 사건을 동시 등록해 1건 생성·1건 duplicate, 조회·audit·joke skip·미인증 쓰기 차단 확인. 매 실행 합성 사건 한 건이 남는다. 정상 완료 후 테스트 토큰을 폐기한다.
- ChatGPT 연결·도구 표시·프로젝트 내 도구 사용·자율 감지·확인창 여부·의미 중복·농담 판별은 [연결 및 실험 안내](docs/CHATGPT-TEST.md)에서 사용자 관찰로 판정한다. 서버 테스트만으로 통과 판정하지 않는다.
