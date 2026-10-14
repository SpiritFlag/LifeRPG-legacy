# Life RPG 운영 전환 절차 · A·B 완료, C 이후 승인 대기

2026-10-14 · Phase 8-A 차단·백업 및 Phase 8-B 운영 웹/Clerk 변수 적용 완료 · 운영 migration/배포는 실행하지 않았다.

**현재 프로젝트 전체 유지보수 WAF가 활성이다.** 22:01 KST에 publish한 rule_life_rpg_transition_maintenance_L748fV를 유지한다. canonical/과거 deployment 차단과 운영 데이터 불변, 22:11 KST 암호화 snapshot 백업·격리 복구가 통과했다. [PHASE8A-VERIFICATION.md](PHASE8A-VERIFICATION.md)의 실제 검증 범위와 한계를 따른다. **B에서 production Clerk/웹 변수 4개를 추가했고 기존 설정·WAF·deployment/alias 보존을 확인했다.** [PHASE8B-VERIFICATION.md](PHASE8B-VERIFICATION.md)를 따르며 **C~E는 별도 지시 전 실행하지 않는다.**

현재 운영 DB는 001이고 서비스는 기존 MCP 실험 버전이다. 새 코드는 001~007 schema와 Clerk 웹 설정을 요구한다. DB 전환과 새 코드 배포 사이에 쓰기를 재개하지 않는다. 검증 결과와 한계는 [PHASE6-VERIFICATION.md](PHASE6-VERIFICATION.md), [PHASE7-VERIFICATION.md](PHASE7-VERIFICATION.md)를 따른다. Phase 7에서 운영 이메일 인증·DNS/TLS·암호화 백업/격리 복구·로컬 차단/릴리스 검증을 완료했다. 아래 승인 범위를 확정한 뒤 Phase 8을 실행한다.

## 승인 지점

| 승인 | 형이 승인할 구체적 범위 |
| --- | --- |
| A · 전환 창과 백업 | 전환 시간, 프로젝트 전체 유지보수 및 구버전 host 차단 규칙의 실제 publish/검증, 전환 직전 새 백업과 별도 복구 branch/필요 비용. **로컬 AES/DPAPI 백업의 위치·기간은 이미 승인됨** |
| B · 인증·환경 | 준비된 Clerk 운영 이메일 인증의 웹 origin·운영 소유자/키를 Vercel production 변수에 적용. 별도 direct 관리 설정 준비. 유료 기능·새 비용은 별도 승인 |
| C · 코드 공개/운영 배포 | 검토한 정확한 commit, main push의 자동 deployment 또는 명시적 staged production deployment, MCP maxDuration 120초의 운영 적용과 사용량 영향 |
| D · 운영 migration | 백업·쓰기 차단·격리 검증 확인 후 운영 br-spring-night-a1jbloxd/liferpg_experiment의 **002→003→004→005→006→007** 적용 |
| E · 전환 완료/복구 | 라우팅·인증·데이터 대조를 확인한 새 코드 공개와 쓰기 재개. 실패 시 복구 대상·복구 시점·손실 가능 변경을 확인하고 별도 승인 |
| F · 실제 최초 게임 | 운영 전환 검증과 별개로 ChatGPT GM의 실제 사용자 캐릭터·세계 최초 생성. smoke에서 실행하지 않는다 |

형은 Phase 7 백업 방식/위치/기간과 운영 이메일 인증을 승인했고 실제 로그인 ID를 전달했다. 이후 Phase 8-A의 차단·백업과 Phase 8-B의 production 환경변수를 각각 승인하여 실행했다. **이 승인은 C~F의 코드 배포·migration·쓰기 재개·실제 게임을 승인한 것이 아니다.** Phase 6 검증 branch는 일시 자원이며 자동 운영 전환/복구의 근거로 사용하지 않는다. 수다방 프로젝트 지침 변경은 별도 요청 대상이다.

## 1. 대상과 변경물 확정

1. Neon project cool-waterfall-23850161, branch experiment/br-spring-night-a1jbloxd, endpoint ep-soft-sky-a1kxmx2q, DB liferpg_experiment, role liferpg_owner를 API와 URL 양쪽에서 다시 확인한다. DB 이름만 비교하지 않는다.
2. Vercel team team_wDLsRTkkRjvKKqQKnE8B9jEJ/project prj_v5gMi1veBor2Oa2DPmzHi9uJjHvk를 확인한다. 기존 deployment ID·alias·commit·환경변수 이름·공개 OAuth metadata를 비밀값 없이 기록한다.
3. 지금 확인한 rollback code baseline은 production commit 06abadd44cfb64a14b9b2803c2f0322b740c9697이다. 실제 전환 당일 current production을 다시 확인하며 오래된 문서 ID로 rollback하지 않는다.
4. Phase 1~7 변경을 하나의 검토 가능한 release commit으로 정리한다. Phase 7의 로컬 source/deployment SHA256 manifest와 dry run을 기준으로 최종 diff·공개 범위를 검토하고 commit 이후 다시 대조한다. build/check 및 회귀 114개는 통과했다. 기존 미커밋 변경을 무심코 덮거나 섞지 않는다. main이 자동 production deploy에 연결되어 있으므로 **승인 C 이전에는 main에 push하지 않는다**. non-main push도 preview 배포를 만들 수 있으므로 push 자체를 이번 준비에서 실행하지 않았다.
5. migration 파일의 hash·실행 순서·실제 적용 상태를 기록한다. 현재는 migration ledger가 없으므로 schema/제약 대조로 001을 확인한다. 001은 다시 생성할 필요가 없다.

## 2. Clerk와 도메인 준비 · 승인 B

MCP origin은 **https://liferpg-mcp-experiment.vercel.app**으로 유지한다. PUBLIC_BASE_URL·OAuth client ID/secret·owner 연결 키·정확한 callback allowlist를 그대로 사용한다. issuer/resource를 custom website origin으로 바꾸지 않는다.

웹 canonical origin은 형이 결정한 **https://liferpg.spiritflag.work**이다. 승인 B에서 WEB_PUBLIC_BASE_URL에 지정한다. 새 변수는 웹의 Origin/authorizedParties에만 적용하고 MCP의 token resource에는 적용하지 않는다. 웹은 이 canonical origin에서 사용하며 다른 alias의 token azp를 무작정 허용하지 않는다.

Phase 8-B에서 Vercel production에 CLERK_PUBLISHABLE_KEY(Config), CLERK_SECRET_KEY(Secret), CLERK_OWNER_USER_ID(Config), WEB_PUBLIC_BASE_URL(Config)를 추가했다. 다른 환경에는 적용하지 않았다. 기존 6개 변수는 보존했으며 DATABASE_DIRECT_URL과 ALLOW_SYNTHETIC_GAME은 없다. 변수 값은 이 적용 결과에 기록하지 않는다. 새 deployment가 아직 없어 현재 배포에 이 설정이 반영됐다고 가정하지 않는다. Phase 7의 준비 근거는 다음과 같다.

- 운영 Clerk 인스턴스 ins_3KgHQpUdWBwxfzGUrj4QjQpr2zs, primary/home/로그인 후 redirect는 canonical 웹이다. Cloudflare의 기존 CNAME·Clerk DNS verified 및 웹/Clerk/계정 포털 TLS를 확인했다. 이번에 DNS를 변경하지 않았다.
- 형의 최신 선택은 **이메일 코드 인증**이다. Google 운영 연결은 Disabled, 별도 Google OAuth 자격증명은 필요 없다. live publishable/secret key는 개발 키와 분리한 비공개 `.env.clerk.production.local`에 있다. 키를 대화·명령 인수·Git에 넣지 않고 기존 Secret/Config 변수 체계로 설정한다.
- 실제 운영 로그인·검증된 이메일을 확인한 소유자 ID는 비공개 운영 설정을 근거로 production의 CLERK_OWNER_USER_ID에 적용했다. 개발 사용자 ID를 복사하지 않았고 실제 값은 현재 절차 문서에 적지 않는다.
- DATABASE_URL은 기존 운영 pooler 주소와 verify-full을 유지한다. ALLOW_SYNTHETIC_GAME은 운영에서 비활성이다. DATABASE_DIRECT_URL은 로컬 관리 작업용이고 Vercel에 배포하지 않는다.

Clerk·DNS의 신규 권한/자원/비용이 필요하면 보고하고 승인 후 처리한다. Clerk 계정 포털의 실제 소유자 로그인은 확인했지만 새 Life RPG 웹의 custom domain Cookie/azp/API 검증은 아직이다. 이 검사까지 완료되기 전 웹 전환을 완료했다고 판정하지 않는다. [Clerk 운영 배포](https://clerk.com/docs/guides/development/deployment/production).

## 3. 쓰기 중단과 백업 · 승인 A

형과 합의한 전환 창을 시작한다. 진행 중인 GM 쓰기와 OAuth grant 회전이 끝났는지 확인하고 **서버 측 유지보수 차단**을 먼저 적용한다. 전환 중 MCP 자체 사용 불가를 감수하는 좁은 창으로 계획한다.

차단은 프로젝트 전체 `/mcp` 호출 및 `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`를 포함해야 한다. canonical·custom·이전 deployment URL에서도 기존 writer가 DB에 접근하지 못하는지 테스트한다. `/health`, 공개 `/.well-known/*` 등 무변경 discovery는 허용할 수 있다. ChatGPT에 단순히 잠시 호출하지 말라고 안내하는 것만으로 차단을 완료했다고 판정하지 않는다.

프로젝트 전체 [유지보수 WAF 후보](phase7-maintenance-rule.json)를 승인 A에서 검토한다. 원격 draft/active/bypass를 다시 읽고 후보를 첫 우선순위에 stage한 뒤 diff를 검토해 publish한다. 현재 조사에서는 모두 비어 있었다. canonical/custom/과거 unique deployment URL의 모든 method가 실제 403으로 차단되고 DB 행·grant·감사가 변하지 않는지 확인한다. health/discovery는 계속 허용한다. 활성 요청이 끝나는 시간을 둔 뒤 snapshot을 잡는다. 이 규칙은 Phase 7에서 **로컬 정책과 실제 Neon 합성 DB로만 검증**했고 원격 적용하지 않았다. 필요한 권한·플랜 기능이 없거나 과거 URL을 막지 못하면 migration 전에 중단한다.

새 release의 `MAINTENANCE_WRITES=true`는 인증/DB 전에 503을 반환하는 보조 수단이다. flag 적용/해제에는 새 deployment가 필요하며 기존 deployment를 보호하지 않는다. 프로젝트 WAF를 필수 경계로 삼는다. staged release는 WAF 차단 아래 기본 flag=false로 준비할 수 있고, flag=true로 배포했다면 smoke/재개 전에 해당 flag를 해제한 새 배포도 승인 C 범위에 포함한다.

전체 차단을 풀기 전에 [구버전 writer 차단 후보](phase7-retired-writer-rule.json)를 publish한다. MCP/OAuth는 기존 canonical host만 허용하고 과거 deployment URL·다른 alias에서는 거부한다. 웹 API/정적/health/discovery는 유지한다. **전환 후에도 이 규칙을 유지**하고 과거 URL 403·canonical 새 코드 접근을 실제 검증한다. 전체 유지보수 규칙만 삭제하면 구버전 writer가 다시 열릴 수 있다.

차단 이후 READ ONLY/REPEATABLE READ snapshot에서 schema·행 수·원본 column hash·OAuth grant·감사·현재 deployment를 기록한다. 이후 hash가 달라지면 원인을 확인할 때까지 중단한다.

백업은 두 수단을 함께 준비한다.

1. 변경 전 시점을 고정한 별도 Neon backup branch/snapshot. 이번 검증 child branch처럼 짧은 자동 만료를 운영 복구 백업에 쓰지 않는다. 원본 branch를 reset하지 않는다.
2. PostgreSQL 18 이상과 호환되는 pg_dump의 custom-format 전체 DB 백업. schema·events·aliases/revisions·requests/receipts·audit·OAuth·확장/함수를 포함한다. 인증값이 있으므로 암호화된 비공개 저장소에 두고 보존/삭제 권한을 지정한다.

형이 승인한 백업은 `C:\Users\singi\LifeRPG\.local\backups\phase7`의 AES-256-GCM 파일과 프로젝트 밖 `C:\Users\singi\.codex\secrets`의 CurrentUser DPAPI 키다. 보존은 Phase 8 완료 후 7일, 삭제는 형 확인 후다. Phase 7에서 PG 18.6 custom dump를 암호화 스트림으로 저장했고 새 격리 liferpg_phase7_restore에서 단일 트랜잭션 restore/전체 데이터·schema 대조를 통과했다. 전환 창의 쓰기 차단 뒤에는 **새 snapshot 백업**을 다시 생성하고 검증한다. 이번 백업 시점의 파일을 전환 당일 최신 백업으로 간주하지 않는다.

관리 helper는 검증된 direct host·DB·role·verify-full을 사용하고 password는 자식 환경에만 전달한다. 명령줄에 URL/비밀번호를 넣지 않는다. 성공 백업은 완료 manifest와 `latest.json`으로 구분하며 불완전 조각을 복구 대상으로 사용하지 않는다. 아래 명령은 승인된 위치로의 백업과 **고정된 별도 빈 격리 DB** 복구만 지원한다. 현재 연습 DB는 이미 복구되어 있어 재복구는 nonempty target 거부로 중단한다.

```powershell
node scripts/phase7-backup.js backup
node scripts/phase7-backup.js verify
# Only a reviewed, empty isolated liferpg_phase7_restore target:
node scripts/phase7-backup.js restore
```

복구 후 UUID·근거·버전·영수증·OAuth hash·감사를 대조한다. 역할 생성/ACL은 `--no-owner --no-acl` archive 밖의 관리 설정이므로 target 역할·권한도 따로 확인한다. DPAPI 복호화는 현재 Windows 사용자/프로필에 의존하며 다른 PC 복구/외부 저장은 별도 준비·승인 대상이다. 실제 branch·DB가 고정된 helper를 만료 이후 새 격리 자원에 사용하려면 확인한 mapping으로 최소 수정하고 다시 검증한다. 연습 branch 만료는 2026-10-15 18:20 KST다. 프로젝트의 6시간 history window나 이 일시 branch만을 장기 백업으로 의존하지 않는다. [Neon 백업/복구](https://neon.com/docs/postgres/backup-restore/backups).

## 4. 새 코드의 배포 준비 · 승인 C

공식 CLI의 `vercel deploy --prod --skip-domain`을 승인 C 이후 사용하면 production 환경의 staged deployment를 만들며 alias 자동 전환을 생략한다. 이번에는 help와 `deploy --dry --json`만 실행했다. staged URL도 실제 운영 DB를 바라보므로 WAF 차단·승인된 읽기 검증을 지키고 schema 이전에는 새 게임 API를 사용하지 않는다. migration 이후 승인 E에서 정확한 production deployment를 promote한다. main push의 자동 alias 변경과 이 수동 경로를 섞지 않으며 Git 동기화 시 자동 배포 정책도 승인 범위에 포함한다. [Vercel deploy](https://vercel.com/docs/cli/deploy).

로컬 vercel.json의 예정 계약:

- buildCommand=npm run build / outputDirectory=public.
- `/`, `/index.html`, `/assets/*`는 웹 정적 파일. `/api/player`, `/api/web-config`는 api/web, MCP/OAuth/discovery는 api/server.
- api/server.js maxDuration=120, api/web.js maxDuration=30, code region sin1. 실제 배포 function metadata로 확인한다.
- `.local`, `.env*`, test/docs/DESIGN/SPEC, migration, Phase 6~7/preview/serve/client/setup/smoke scripts는 배포에서 제외. 설계·migration·테스트는 release 소스에 포함하되 runtime 업로드와 구분한다. final manifest와 브라우저 번들에서 실제 credential·합성 fixture가 없는지 확인.

DB migration 전 최신 MCP/웹 데이터 경로를 공개하지 않는다. 새 코드의 get_game_context는 007이 필요하므로 001 DB에서 성공을 기대하지 않는다. staged deployment를 실제로 만들고 테스트할 수 없는 경우 안전한 유지보수 창 안에서만 순차 전환한다.

## 5. 운영 migration · 승인 D

백업 복구 대조와 쓰기 차단이 통과한 뒤, 기존 운영의 direct URL과 branch mapping을 재확인한다. 로컬 DATABASE_DIRECT_URL은 Phase 6 조사에서 pooler로 확인되었으므로 **확인된 direct URL로 준비한 별도 비공개 관리 설정**을 사용한다. Phase 6 child endpoint나 synthetic DB를 운영 대상에 넣지 않는다.

002→003→004→005→006→007을 파일별로 적용한다. 각 파일의 BEGIN/COMMIT을 존중하고, 실패 시 같은 connection에서 ROLLBACK한 뒤 중단한다. 성공 파일명·hash·시각·schema 확인 결과를 기록한다. 중복 오류를 무시해 다음으로 진행하지 않는다.

각 단계에서 원본 column hash·사건 UUID/근거/시각·audit/OAuth를 대조하고 games/characters/world가 자동 생성되지 않았는지 확인한다. 002는 기존 사건을 version=1 import/alias로 확장하고, 003~007은 새 게임 모델을 추가한다. 기존 데이터를 삭제하거나 테스트 grant를 운영에 넣지 않는다.

모든 단계가 통과할 때까지 구버전 writer를 다시 열지 않는다. 특정 단계가 이미 적용된 상태에서 재시도하려면 적용 상태를 먼저 확정하고 미적용 파일부터 진행한다. 파일마다 원자적이지만 전체 002~007 체인은 하나의 트랜잭션이 아니다.

## 6. 코드 전환·최소 smoke · 승인 E

유지보수 차단을 유지한 채 검토한 새 production deployment로 alias를 전환한다. 실제 function region/duration·정적 파일·API rewrites와 exact release commit을 확인한다.

최소 smoke는 다음 순서로 수행한다.

1. health·공개 OAuth discovery의 issuer/resource·callback·scopes가 기존과 같은지 확인한다.
2. Clerk canonical web에서 익명 거부·소유자 로그인 허용·다른 계정 거부·잘못된 Origin/azp 거부를 확인한다. API는 private,no-store이고 웹 응답에 비공개 전기/기억/이력/근거가 없어야 한다.
3. 구버전 host 차단을 유지하고, 승인 E의 제한된 smoke 창에서 canonical MCP/OAuth를 열어 기존 연결로 tools/list 및 get_game_context를 호출한다. 경로 WAF는 JSON-RPC body의 읽기/쓰기 tool을 구분하지 못하므로 **조회만 기술적으로 열었다고 표현하지 않는다**. smoke 동안 형/GM의 일반 쓰기 중단을 유지하며 승인된 조회·refresh만 실행한다. 실패하면 즉시 전체 유지보수 규칙을 다시 활성화한다. MCP 조회도 감사 행, refresh도 grant 변경이 있으므로 승인된 smoke 변화로 명시한다. 게임은 initialized=false/unstarted여야 하며 조회가 탄생을 만들지 않는다.
4. 9개 tool schema의 노출과 기존 grant의 읽기/refresh 호환성을 확인한다. root 연결이 달라졌으면 writes를 열기 전에 중단한다.
5. **이번 단계의 기존 npm run smoke는 운영에서 실행하지 않는다.** 그 스크립트는 test 사건을 실제 DB에 추가한다. 최소 운영 smoke는 위 읽기/인증 흐름으로 제한하고 사건·보상·초기 생성을 쓰지 않는다.
6. 긴 finalize의 실제 sin1/Neon 및 ChatGPT client 동작은 승인된 격리 배포 또는 별도 합성 DB에서 먼저 측정한다. 120초 Function 한도나 60초 SDK 기본값만으로 성공을 보장하지 않는다. 이 검증이 필요하면 배포/자원 범위를 별도로 승인한다.

검증 후에만 전체 유지보수 차단을 해제하고 기존 사건 쓰기를 최신 canonical 코드로 재개한다. 구버전 host 차단은 유지한다. 그 뒤 첫 정상 실제 사건의 새 alias·revision·audit 참여를 확인한다. 허구의 real 사건을 smoke용으로 만들어 넣지 않는다. 실제 탄생은 승인 F와 별도 GM 작업에서 수행한다.

## 7. 중단·복구 기준

아래 중 하나라도 발생하면 writes를 차단한 채 전환을 중단한다.

- branch/endpoint/DB/commit이 승인 대상과 다름, 백업 또는 복구 대조 실패.
- 원본 UUID·근거·시각·OAuth·감사 hash의 설명되지 않는 변화, 자동 게임/세계 생성.
- migration 오류/partial schema/중복 적용 상태 불명, 이전 writer의 계속된 접근.
- 기존 issuer/resource/client/callback 변경, 기존 OAuth 거부, Clerk 소유자 판정 오류, GM 정보 공개.
- Function/client timeout 또는 성공 여부가 불명확한 생성 요청. 같은 요청 키의 영수증부터 확인하고 새 키로 중복 생성하지 않는다.

DB migration 전의 코드 실패는 기존 deployment/alias로 복귀할 수 있다. **002 이후에는 코드만 구버전으로 돌리고 writes를 여는 단순 rollback이 안전하지 않다.** 구버전이 revision/alias를 누락할 수 있으므로 차단을 유지하고 새 코드 수정 또는 승인된 DB 복구를 결정한다.

복구는 변경 전 backup을 새 격리 branch/DB로 복원하고 대조한 뒤, 별도 승인 E에서 운영 DB 연결/alias를 전환하는 방식을 우선 검토한다. 기존 원본을 바로 reset/삭제하지 않는다. 쓰기 재개 이후라면 이후 사건·OAuth refresh/grant 변경을 함께 평가하고 보존/재반영 계획을 세운다. 자동 과거 snapshot 덮어쓰기·승인 없는 파괴적 restore를 수행하지 않는다.

## 8. 기존 수다방 연결과 종료

기존 MCP URL·issuer/resource·client ID/secret·callback·grant를 유지하므로 **프로토콜상 일괄 재연결은 필수가 아니다**. 실제 ChatGPT 도구 목록 cache가 새 9개 schema를 반영하지 않으면 앱의 연결/도구 목록 갱신을 확인하고 필요한 경우 형이 재연결한다. 만료·폐기된 token은 정상 OAuth 재승인이 필요할 수 있다. 검증 없이 모든 grant를 지우거나 client secret을 회전하지 않는다.

운영 전환 결과·마지막 schema·release commit·승인 범위·남은 제약을 기록한다. backup/검증 branch의 보존·삭제는 승인된 정책을 따른다. 운영 전환 승인과 실제 캐릭터·세계 생성 승인을 혼동하지 않으며, 수다방 지침 변경은 별도 합의 때 진행한다.
