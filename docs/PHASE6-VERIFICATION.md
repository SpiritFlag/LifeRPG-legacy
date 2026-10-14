# Phase 6 · Neon 격리 검증 및 운영 전환 준비

2026-10-14 · Asia/Seoul · 실제 Neon PostgreSQL 18.6 검증

DESIGN.md, SPEC.md와 Phase 1~5 기록·코드를 확인하고, 운영 DB는 READ ONLY로 조사했다. 운영 데이터 복제본과 합성 실험은 별도 Neon child branch에서 수행했다. 운영 migration·Vercel 배포·환경변수/도메인 변경·실제 사용자 탄생·수다방 지침 변경은 수행하지 않았다.

## 검증 대상과 경계

| 대상 | 확인된 값 |
| --- | --- |
| Neon 조직/플랜 | Singi / free, 업그레이드 없음 |
| 프로젝트 | LifeRPG-MCP-Experiment / cool-waterfall-23850161 |
| PostgreSQL / 지역 | 18.6 (653b019) / aws-ap-southeast-1 |
| 운영 branch | experiment / br-spring-night-a1jbloxd, default=true |
| 운영 endpoint | ep-soft-sky-a1kxmx2q, 읽기 전용 조사만 수행 |
| 격리 branch | phase6-validation-20261014 / br-soft-art-a1xx9a51, parent=운영 branch, default=false |
| 격리 endpoint | ep-young-flower-a115sf9a, 운영과 다른 direct/pooler hostname 확인 |
| 보존 검증 DB | 격리 branch의 liferpg_experiment, 운영 HEAD 복제본 |
| 합성 실험 DB | 같은 격리 branch의 liferpg_phase6_synthetic, 빈 DB에 001~007 적용 |
| branch 만료 | **2026-10-15 18:20 KST** / 2026-10-15T09:20:00Z |
| compute | 0.25 CU. suspend interval 변경은 무료 계정이 거부하여 기본값 유지 |

연결은 endpoint·branch 메타데이터와 hostname·DB명을 함께 확인했다. 운영 `.env.local` 및 Vercel 변수는 변경하지 않았다. 검증용 연결 설정은 Git/Vercel 제외 대상 `.local/phase6/connection.json`에만 보관했고 비밀번호·토큰·사건 내용은 로그나 문서에 출력하지 않았다. Neon CLI가 인증되지 않아 커넥터를 사용했다. CLI의 인증 대기는 중단했으며 신규 로그인·권한 변경을 완료하지 않았다.

운영 조회는 연결 startup의 default_transaction_read_only=on 및 READ ONLY/REPEATABLE READ 트랜잭션으로 수행했다. direct TLSv1.3의 encrypted=true/authorized=true를 확인했다. Neon backend pg_stat_ssl의 ssl=false와 클라이언트→proxy TLS를 구분하며 backend 값만으로 클라이언트 TLS 실패를 판정하지 않는다.

## 데이터·migration 검증

운영 schema는 **001의 4개 테이블**이었다. migration ledger는 없으므로 테이블·컬럼·제약으로 적용 상태를 확인했다. 조사 전후 모두 auth_attempts 1행, life_events 6행, oauth_grants 5행, tool_calls 28행이었다. UUID·근거·인증값을 직접 출력하지 않고 SQL row JSON의 정렬된 aggregate hash로 비교했다.

운영 원본은 작업 전후 schema 목록과 4개 테이블의 전체 행 hash가 동일했다. 격리 복제본도 migration 전 원본 hash와 같았다. 격리 복제본의 002~007 적용에서는 기존 컬럼만 투영하여 동일 hash를 확인했고, 사건 6건의 최초 revision·alias·UUID·근거·summary·기록 시각을 별도로 대조했다. 새 컬럼/이력이 생긴 것과 원본이 바뀐 것을 구분했다. 인증 grant·감사·로그인 시도 행은 그대로 보존되었다.

| 검증 | 결과 |
| --- | --- |
| 001 중복 적용 | IF NOT EXISTS 계약대로 기존 schema·행 유지 |
| 002 중간 실패 | DDL·import 다음, COMMIT 직전에 의도적 22012 오류 주입. ROLLBACK 후 컬럼·테이블·행이 이전 상태와 동일 |
| 002→007 순서 적용 | 실제 Neon 복제본에서 모두 성공, 기존 원본 컬럼 hash 보존 |
| 002~007 중복 적용 | 각 파일 재실행 오류 후 명시적 ROLLBACK, schema·전체 행 hash 불변 |
| 자동 게임 생성 | 각 migration 및 최종 보존 대조에서 games=0. 복제한 실제 사건으로 캐릭터·세계를 만들지 않음 |
| 최초 사건 import | 6건 모두 원본 UUID·근거·시각·summary와 revision/alias 일치 |
| 기존 요청/영수증 | 운영 001에는 신규 request_key/GM receipt 테이블이 없어 해당 실데이터는 없음. 합성 DB에서 002 사건 요청·003 초기화 영수증을 먼저 만든 뒤 004~007 적용, 동일 입력 재생·ID 유지 확인 |
| OAuth | 복제한 운영 grant hash 불변. 별도 합성 OAuth 자격증명으로 실제 Neon의 PKCE·refresh 회전/replay 거부·scope·MCP SDK discovery/조회 검증 |

migration이 BEGIN/COMMIT을 관리하므로 파일 실패 시 ROLLBACK이 필요하다. 중복 적용을 성공으로 숨기거나 적용된 DDL을 임의 삭제하지 않았다. 보존 복제본에는 합성 사건도 추가하지 않았으며, 합성 실험은 새 DB에서만 수행했다.

## 다중 연결·MVCC·timeout

실제 pg.Client/pg.Pool과 서버 서비스 코드를 사용했다. 처음 잠금 관측에서는 Neon frontend protocol의 client.processID를 실제 backend PID로 취급하여 대기 상태를 찾지 못했다. pg_backend_pid()로 관측기를 수정한 뒤 독립 backend 3190/3191의 Lock 대기를 확인했다. 앱 잠금 실패와 검증기 관측 실패를 구분하며 첫 시도의 보고서도 로컬에 보존했다.

| 검증 | 결과 |
| --- | --- |
| advisory lock | 독립 연결의 pg_advisory_xact_lock 경쟁, 실제 pg_stat_activity Lock 대기, holder COMMIT 후 waiter 획득 |
| 행 잠금 | 같은 games 행의 FOR UPDATE 경쟁, 대기 확인, holder ROLLBACK 후 waiter 진행 |
| 사건 동시 등록 | recorded 1건 + duplicate 1건, 동일 UUID, 최초 revision 1개 |
| GM 버전 경쟁 | 같은 expected_revision에서 committed 1개 + revision_conflict 1개, 성공 요청 재생 시 같은 update ID |
| begin 경쟁 | prepared 1개 + initialization_in_progress 1개, 원래 요청의 정확한 재시도 성공 |
| prepare 경쟁 | 같은 draft revision에서 prepared 1개 + initialization_revision_conflict 1개 |
| finalize 경쟁 | committed 1개 + already_initialized 1개 |
| 미완성 조회 | writer가 finalize의 모든 live 행을 작성하고 COMMIT 전 정지한 동안 다른 웹/GM 연결은 initialized=false/preparing만 반환. COMMIT 뒤 completed 조회 |
| 전체 롤백 | GM 영수증·초안 영수증·감사 저장 실패 주입 뒤 game=0/초안 유지/성공 영수증 없음. 동일 finalize 입력 재시도·성공 결과 재생 |
| lock_timeout | SET LOCAL 250ms에서 55P03, 실패 트랜잭션의 후속 SQL은 25P02, ROLLBACK 뒤 같은 사건 등록 성공 |
| statement_timeout | SET LOCAL 250ms와 pg_sleep으로 57014. 탄생 후반에도 주입하여 전체 롤백·동일 finalize 재시도 성공 |
| 공개 경계 | 실제 Neon에서 탄생·전기 이력·세계 사실·연대기·웹 대시보드의 GM sentinel 제외, GM 원문 유지 |
| pooler의 앱 경로 | 실제 connectDatabase 두 pool의 잠금 경쟁, READ ONLY/REPEATABLE READ 맥락·GM 변경·재시도·OAuth PKCE/MCP 조회 성공 |
| 앱 10초 제한 | 수정 후 단독 query와 transaction에서 10s 확인. pg_sleep(11) 및 잠금 대기가 57014로 취소되고 연결 재사용·동일 사건 재시도 성공 |

direct 검증 **25개**, 실제 앱 pooler 검증 **6개**가 통과했다. direct 결과에는 migration별 보존/중복 테스트 및 크기별 시간 측정이 포함된다. 운영의 grant를 테스트에 소비하거나 운영에서 MCP 도구를 호출하지 않았다. 공개 /health·OAuth discovery HTTP GET만 확인했고 모두 200으로 기존 issuer/resource/scopes를 유지했다.

## 발견한 문제와 최소 수정

1. **pooler에서 startup statement_timeout이 적용되지 않음**: 기존 pg pool 설정은 10000이지만 실제 SHOW 결과는 0이었다. connectDatabase의 transaction 시작에 SET LOCAL statement_timeout='10s'를 적용했고 단독 query도 같은 트랜잭션 경계를 사용한다. 역할·프로젝트의 서버 설정은 변경하지 않았다. 개별 SQL 제한이며 전체 트랜잭션 deadline은 아니다. [PostgreSQL SET LOCAL](https://www.postgresql.org/docs/current/sql-set.html), [Neon transaction pooling](https://neon.com/docs/connect/connection-pooling).
2. **로컬 DATABASE_DIRECT_URL이 pooled hostname**: 원본 env는 그대로 두고 검증용 direct endpoint를 확인하여 사용했다. setup-db는 pooled hostname을 연결 전에 거부하도록 수정했다. migration 자체 BEGIN/COMMIT을 앱 query wrapper에 중첩하지 않도록 전용 direct pg.Client를 사용한다. 미래 운영 실행 전 direct URL의 별도 준비가 필요하다.
3. **finalize 30초 한도 위험**: 기존 MCP Function maxDuration=30인데 Windows→Neon direct 실측이 아래와 같았다. 로컬 vercel.json의 api/server.js만 120초로 준비했고 웹은 30초를 유지했다. 운영 배포는 30초 그대로다. [Vercel duration 설정](https://vercel.com/docs/functions/configuring-functions/duration).
4. **웹/MCP origin 결합**: 기존 웹은 MCP PUBLIC_BASE_URL을 Clerk authorizedParties/Origin으로 사용했다. 선택적 WEB_PUBLIC_BASE_URL을 추가하여 커스텀 웹 도메인을 써도 기존 MCP issuer/resource·grant를 보존한다. 기본 동작은 이전과 같다. 실제 환경변수·도메인은 변경하지 않았다.
5. **원격 조회 접근 경로**: Vercel 커넥터는 팀 권한 403이었다. 같은 팀/프로젝트를 기존 CLI 자격증명으로 GET 조회하여 확인했다. 신규 자격증명 발급·권한 우회·팀 변경은 하지 않았다. 검증 도구의 frontend/backend PID 혼동과 단일 pg.Client 동시 query 경고도 수정했다.

| 최초 세계 엔터티 수 | finalize 실측 |
| --- | --- |
| 2 (루트·시작 지역) | 3,957 ms |
| 22 (NPC 20명 포함) | 20,216 ms |
| 62 (NPC 60명 포함) | 53,302 ms |

이는 로컬 Windows→Singapore Neon 네트워크에서 기존 순차 SQL 검증기를 실행한 값이다. sin1 Vercel 환경의 성능을 측정한 것이 아니며, 무제한 chunk/세계가 120초 안에 완료됨을 보장하지 않는다. 실제 SDK 기본 요청 timeout도 로컬 패키지에서 60초로 확인했다. ChatGPT의 실제 제한은 미확인이다. 응답 유실 시 기존 요청 키/영수증을 조회하고 정확히 재시도해야 한다. SQL 쿼리 수를 줄이는 대규모 리팩터링은 이번 범위에서 수행하지 않았다.

## 운영 배포 적합성 점검

읽기 전용 CLI GET에서 실제 현재 production은 **dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ / commit 06abadd44cfb64a14b9b2803c2f0322b740c9697 / READY / Node.js 24**로 확인했다. 과거 DEPLOYMENT.md 작성 시점의 ID와 구분한다. 프로젝트는 GitHub SpiritFlag/LifeRPG의 main을 production branch로 연결하므로 **main push도 자동 운영 배포를 유발할 수 있다**. 이번 작업은 commit/push/deploy하지 않았다.

- 기존 MCP origin은 https://liferpg-mcp-experiment.vercel.app, issuer와 resource /mcp 및 life.read/life.write/offline_access discovery가 그대로다. OAuth client·secret·owner 연결 키·정확한 callback·기존 grant를 유지해야 한다.
- 현재 verified 도메인은 liferpg-mcp-experiment.vercel.app 및 liferpg.spiritflag.work이며 변경하지 않았다. 원격 deployment에 web API는 아직 없고, 로컬은 npm run build/public 정적 파일·/api/player,/api/web-config→api/web·/mcp,/oauth,/.well-known→api/server rewrites를 준비한다. 새 Vercel 배포에서의 라우팅·클라이언트 번들 검증은 아직 수행하지 않았다.
- 현재 production 변수는 DATABASE_URL 및 기존 OAuth 5개뿐이고 **Clerk/WEB_PUBLIC_BASE_URL은 없다**. Clerk 운영 인스턴스의 존재·DNS·인증서는 이번에 확인하지 못했다. 개발 인스턴스 키/사용자 ID를 운영에 그대로 사용한다고 가정하지 않는다. 실제 운영 사용자 로그인 뒤 ID를 다시 확인하고 소유자로 지정한다. [Clerk 운영 절차](https://clerk.com/docs/guides/development/deployment/production), [환경별 사용자 분리](https://clerk.com/docs/guides/development/managing-environments).
- runtime DATABASE_URL은 pooled/verify-full, migration/pg_dump는 확인된 direct URL을 사용한다. api/server와 api/web 각각 max=3 pool이므로 동일 warm instance에 두 handler가 살아 있으면 최대 6개 client가 생길 수 있다. 전체 배포 인스턴스 수의 상한은 아니며 실제 부하·cold start·connectionTimeout/statementTimeout 대조가 필요하다.
- 원격 프로젝트 resourceConfig의 default region은 iad1이고 로컬 vercel.json은 sin1이다. 실제 새 deployment function region을 확인해야 하며 project 기본값만으로 코드의 region을 단정하지 않는다.
- 구버전 001 writer는 새 alias·revision 계약에 참여하지 않는다. schema만 올리고 기존 쓰기를 재개하면 이력을 우회한다. 구버전 deployment URL·OAuth mutation까지 포함한 유지보수 차단을 전환 전 검증해야 한다.

## 회귀·제약·전달 상태

로컬 build/check 통과, 서버 **98개**, 웹 **11개**, 기존 Edge OAuth **1개**, 초기 생성 Edge **1개** 통과. Neon direct 25 + pooler 6을 합쳐 **142개 검증 시나리오 통과**다. migration helper의 pooler/다른 DB/알 수 없는 파일명 거부와 웹/MCP origin 분리 회귀를 추가했다. 로컬 tests는 PGlite·합성 자격증명이고 실제 Neon 쓰기는 격리 branch만 사용했다.

운영 전환은 **조건부 준비 완료, 실행 승인 전 상태**다. DB 일관성과 실제 다중 연결은 확인했으나 운영 Clerk, 유지보수 차단, 승인된 복구 백업, 실제 sin1 배포 라우팅/시간 및 ChatGPT client의 긴 호출은 남아 있다. pg_dump/pg_restore는 로컬 실행 파일이 없어 실제 복구 연습을 하지 않았으며 기존 6시간 history window만 장기 백업으로 취급하지 않는다. 운영 migration·배포·실제 최초 탄생은 각각 다음 승인 범위다.

세부 운영 절차와 중단/복구 기준은 [OPERATIONS-TRANSITION.md](OPERATIONS-TRANSITION.md)에 기록한다. `.local/phase6/`에는 비공개 연결 설정, 전후 운영 schema/hash, clone/direct·pooler 테스트 결과, 첫 실패 관측 기록, Vercel GET 요약, 공개 discovery, 로컬 테스트·빌드 로그를 보관한다. `.local/`과 Phase 6 검증 scripts는 배포 산출물에서 제외한다.

검증 endpoint는 완료 후 suspend했고 child branch는 위 만료 시각까지 남긴다. 원본 branch·endpoint는 suspend/reset/delete하지 않았다. 만료 전에 검증 자원을 조기 삭제하려면 별도 승인이 필요하다. 만료 시 복제 데이터와 합성 실험 DB도 함께 제거되는 일시 검증 자원이며 운영 복구 백업으로 사용하지 않는다.
