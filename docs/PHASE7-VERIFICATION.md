# Life RPG Phase 7 · 운영 인증·백업·전환 준비

2026-10-14 KST. DESIGN/SPEC 및 Phase 1~6 기록, 특히 [Phase 6](PHASE6-VERIFICATION.md)와 기존 [전환 절차](OPERATIONS-TRANSITION.md)를 확인하고 진행했다. 운영 Neon은 READ ONLY로만 접근했고 운영 migration, Vercel 배포/alias/환경변수 변경, Git push, 실제 게임 생성은 하지 않았다.

## 판정

**Phase 8의 승인·전환 준비에 진입할 수 있다. 실행 승인은 아직 없다.** 운영 이메일 인증, DNS/TLS, 실제 암호화 백업과 격리 복구, 앱 유지보수 차단, 로컬 릴리스 검증을 완료했다. 실제 Vercel Firewall 강제 적용, 새 sin1 배포의 라우팅/Clerk 세션/긴 finalize 및 기존 ChatGPT 연결 smoke는 승인된 Phase 8 전환 창에서 확인해야 한다. 이 검증 전에는 쓰기를 재개하지 않는다.

## Clerk · 사용자 결정 반영

- 기존 Life RPG 개발 인스턴스 `ins_3Kfz2N1VuPbS4sCaTkz8zoni8NC`와 개발 소유자 설정을 확인했다. 개발 인스턴스는 유지했다.
- 동일 앱 `app_3Kfz2MmXrvo1SfCEVEjULKMQA3U`의 **운영 인스턴스 `ins_3KgHQpUdWBwxfzGUrj4QjQpr2zs`**를 기존 Hobby 조직에서 생성했다. 유료 업그레이드나 별도 결제는 하지 않았다.
- 작업 중 형이 Google 대신 **이메일 로그인**을 선택했다. 운영 Google 연결을 비활성화했다. Frontend 환경 조회에서 `oauth_google.enabled=false`, 이메일 `first_factors=[email_code]`, 가입 시 이메일 검증 활성화를 확인했다. Google 자격증명·Google Cloud 설정은 더 이상 전환 선행 조건이 아니다.
- 형이 전달한 운영 ID `user_3KgIDVcWqpwsHxVotXgNxOv15mF`가 실제 운영 사용자와 일치했다. 읽기 전용 Backend API에서 검증된 이메일과 **2026-10-14 19:11:04 KST** 로그인 기록, 외부 소셜 계정 없음까지 확인했다. 새 사용자를 대신 생성하거나 개발 ID를 복사하지 않았다.
- `pk_live`/`sk_live`와 운영 소유자 ID·웹 origin은 비공개 `.env.clerk.production.local`에 개발 설정과 분리해 저장했다. 키를 로그·Git·문서에 출력하지 않았고 Vercel 변수는 변경하지 않았다. 키 복사 뒤 브라우저 클립보드를 원래 값으로 복원했다.
- Clerk primary/home/로그인 후 redirect는 `https://liferpg.spiritflag.work`, 로그인/가입 URL은 `https://accounts.liferpg.spiritflag.work/sign-in` 및 `/sign-up`이다. 앱은 `WEB_PUBLIC_BASE_URL`로 이 웹 origin을 지정하고 Clerk `authorizedParties`와 웹 Origin을 정확히 제한한다. MCP origin/issuer/resource와 OAuth callback은 그대로 둔다. 다른 alias의 azp를 허용하지 않는다.

Clerk CLI는 미인증·프로젝트 미연결이었다. 기존 로그인된 대시보드로 준비했으며 CLI 로그인이나 권한 확장으로 우회하지 않았다. 공식 [Clerk 운영 인스턴스](https://clerk.com/docs/guides/development/deployment/production) 절차를 따랐다. **Clerk 계정 포털 로그인 확인과 새 Life RPG 웹 API의 실제 배포 검증은 구분한다.** 후자는 Phase 8에 남아 있다.

## 도메인 · DNS · TLS

웹 canonical은 형이 지정한 `liferpg.spiritflag.work`, MCP는 `liferpg-mcp-experiment.vercel.app`을 유지한다. Vercel의 두 도메인은 verified였다. authoritative DNS는 Cloudflare `pete.ns.cloudflare.com` / `vera.ns.cloudflare.com`이다.

다음 레코드가 **이미 존재하는 것을 조회로 확인**했다. 이번 작업에서 DNS·nameserver·Vercel 도메인 설정을 변경하지 않았다.

| 이름 · spiritflag.work 기준 | CNAME 대상 |
| --- | --- |
| liferpg | 1354e89d55d2739d.vercel-dns-016.com |
| clerk.liferpg | frontend-api.clerk.services |
| accounts.liferpg | accounts.clerk.services |
| clkmail.liferpg | mail.u7i1bjfrb3w6.clerk.services |
| clk._domainkey.liferpg | dkim1.u7i1bjfrb3w6.clerk.services |
| clk2._domainkey.liferpg | dkim2.u7i1bjfrb3w6.clerk.services |

Clerk에서 Frontend API/Account portal/Email DNS가 verified였고, 이후 Node HTTPS의 인증서 검증을 켠 상태에서 세 호스트 모두 authorized=true/TLSv1.3을 확인했다. 인증서는 웹 2027-01-12 02:40:32 UTC, Clerk 10:09:06 UTC, 계정 포털 10:10:36 UTC까지 유효했다. 웹 `/`의 HTTP 404는 아직 기존 MCP 버전이 배포되어 웹 페이지가 없는 상태다. 계정 포털 루트의 비브라우저 GET 403은 TLS 실패와 구분하며, 실제 소유자 로그인은 위 기록으로 확인했다.

## 백업 · 격리 복구

형이 **위치·AES-256-GCM·DPAPI·보존 기간을 명시적으로 승인**한 뒤 실행했다.

| 항목 | 확인 결과 |
| --- | --- |
| Neon project | cool-waterfall-23850161 / LifeRPG-MCP-Experiment / PG 18.6 |
| 운영 source | experiment / br-spring-night-a1jbloxd / ep-soft-sky-a1kxmx2q / liferpg_experiment |
| dump 접속 | 검증된 direct hostname, liferpg_owner, verify-full, default_transaction_read_only=on |
| 복구 target | 기존 격리 br-soft-art-a1xx9a51 / ep-young-flower-a115sf9a / **새 liferpg_phase7_restore DB** |
| 암호화 백업 | `C:\Users\singi\LifeRPG\.local\backups\phase7\2026-10-14T10-10-28-320Z.pgdump.aesgcm` · 10,283 bytes |
| 키 | 프로젝트 밖 `C:\Users\singi\.codex\secrets`의 별도 파일, Windows DPAPI CurrentUser 보호, 현재 사용자/SYSTEM ACL |
| 보존 | Phase 8 전환 완료 후 7일. 삭제는 자동 수행하지 않고 형 확인 후 진행 |

EDB 공식 [PostgreSQL 바이너리](https://www.enterprisedb.com/download-postgresql-binaries)의 Windows x86-64 18.6 아카이브에서 pg_dump/pg_restore와 필요한 DLL만 추출했다. Windows 서비스나 DB 서버를 설치하지 않았다. 다운로드 아카이브 SHA256은 `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2`다. 실행 파일은 Authenticode NotSigned이며 별도 vendor 서명/독립 게시 checksum 대조는 하지 않았다.

dump는 READ ONLY/REPEATABLE READ에서 `pg_export_snapshot()`을 발급하고 pg_dump `--snapshot`에 전달하여 데이터 지문과 **동일 snapshot**을 사용했다. `--format=custom --no-owner --no-acl` 백업을 디스크 평문 파일 없이 AES 암호화 스트림으로 저장했다. IV·tag·AAD·암호문 SHA256·snapshot·schema/행 지문을 manifest에 기록했다. DPAPI 키도 평문으로 저장하지 않았다.

복구는 AES 인증과 custom-format 서명을 **DB 쓰기 전에** 확인하고, 별도 빈 DB에서 `pg_restore --single-transaction --exit-on-error`로 완료했다. schema 목록·컬럼·제약·인덱스·public 함수·전체 행 지문이 원본과 동일했다. pg_restore의 archive 목록 16개를 읽었으며, 메모리에서 암호문을 변조한 실험은 인증 오류로 거부되고 DB 연결을 만들지 않았다. 원본 암호문은 수정하지 않았다.

| 원본 및 복구 행 | 수 | 전후/복구 hash |
| --- | ---: | --- |
| auth_attempts | 1 | 동일 |
| life_events | 6 | 동일 |
| oauth_grants | 5 | 동일 |
| tool_calls | 28 | 동일 |

현재 운영은 001의 4개 테이블이다. 아직 운영에 없는 신규 revision/receipt 모델의 보존은 [Phase 6 격리 migration 검증](PHASE6-VERIFICATION.md)을 따른다. 실제 운영 UUID·근거·감사·OAuth 값은 출력하지 않았다. `--no-owner --no-acl`이므로 역할 생성/권한 재구성은 이 DB archive의 범위가 아니며, 복구 target의 기존 동일 역할을 사용했다.

초기 준비에서 Windows script 실행 정책 및 자식 PowerShell module 경로, libpq의 root certificate 부재/기본 system trust 실패를 발견했다. 실행 정책이나 TLS 검증을 낮추지 않았다. DPAPI는 정상 콘솔 명령과 .NET API로 수행했고 libpq에는 설치된 Node runtime의 공개 CA 목록을 지정하여 **verify-full을 유지**했다. 실패 시도에는 완료 manifest가 없으므로 `latest.json`이 지정한 성공 백업만 유효하다. 실패 시도의 암호화 조각/키도 자동 삭제하지 않았다.

이 백업은 현재 Windows 사용자/프로필의 DPAPI에 의존하는 승인된 로컬 백업이다. 다른 PC로의 키 복구·외부 사본은 준비하지 않았으며 새 저장소로 전송하지 않았다. 전환 직전에는 쓰기 차단 후 새 백업을 다시 만들어야 한다. 격리 복구 DB는 **2026-10-15 18:20 KST**에 Phase 6 branch와 함께 만료하는 일시 연습 자원이며 장기 백업이 아니다. 운영 branch의 restore/reset은 하지 않았다.

## 쓰기 차단 · 기존 writer

1. **프로젝트 전체 유지보수 WAF 후보**: [phase7-maintenance-rule.json](phase7-maintenance-rule.json). `/mcp*` 또는 `/oauth*`를 모든 method·host·environment에서 deny(403)한다. 특정 alias만 막지 않으며 health/discovery는 유지한다. 실제 적용은 첫 우선순위에 두고 기존 bypass/draft를 재확인한 뒤 승인된 창에서 publish한다.
2. **새 코드의 보조 차단**: `MAINTENANCE_WRITES=true`이면 app과 Vercel entry가 인증·OAuth·DB 초기화 전에 503/no-store/Retry-After를 반환한다. 기본값 false이고 기존 OAuth 계약은 그대로다. **구버전 코드는 이 flag를 읽지 않으므로 flag만으로 전환하지 않는다.** Vercel env 변경에는 새 배포가 필요하다.
3. **전환 후 구버전 writer 차단 후보**: [phase7-retired-writer-rule.json](phase7-retired-writer-rule.json). MCP/OAuth 경로에서 host가 기존 canonical MCP origin과 다르면 deny한다. 전체 유지보수 해제 후에도 과거 unique deployment URL의 구버전 writer가 다시 열리지 않도록 유지한다. 웹 API/정적 페이지/health/discovery는 이 조건에 해당하지 않는다. 실제 강제 여부는 Phase 8에서 반드시 확인한다.

읽기 전용 Vercel Firewall 조회는 active=null/draft=null/bypass=[]/attackMode=false였다. 이번 단계에서는 원격 draft 생성도 publish도 하지 않았다. 규칙은 현재 프로젝트에 대한 검토 가능한 로컬 후보다. [Vercel Firewall CLI](https://vercel.com/docs/cli/firewall).

PGlite에서 정상 인증 MCP 사건 쓰기·OAuth refresh/revoke/authorize를 차단하고 grant/로그인 시도/감사/사건의 지문 불변 및 차단 해제 후 원래 refresh 사용 가능을 확인했다. 3개 host × 5개 path × 6개 method를 검사했고, Vercel entry는 구성/DB 초기화 전에 거부했다. 공개 discovery는 기존 issuer/resource를 유지했다.

실제 Neon **합성 DB `liferpg_phase6_synthetic`**에서도 정상 합성 토큰의 변경 요청 4개가 503으로 거부되었고 DB 호출 0회, 사건/revision/게임/GM receipt/감사/grant/로그인 시도 해시가 동일했다. 해제 뒤 동일 refresh가 정상 사용되었다. WAF JSON의 **로컬 정책 해석 72개**, 구버전 host 차단 **21개**를 확인했다. 복구 DB에 보존된 실제 grant를 테스트에 소비하지 않았다. 이 검사는 Vercel edge WAF의 실제 HTTP 강제 검증을 대신하지 않는다.

## 릴리스 후보 · Vercel

현재 운영은 여전히 `dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ`, commit `06abadd44cfb64a14b9b2803c2f0322b740c9697`, READY/source=git다. GitHub `SpiritFlag/LifeRPG`의 main이 production branch다. 로컬 Phase 1~7은 미커밋 상태이며 기존 변경을 보존했다. commit/push/deploy하지 않았다.

- `.local/phase7/release-manifest.json`에 **릴리스 소스 87개 파일과 실제 업로드 후보 39개 파일의 SHA256**을 기록했다. `.local/phase7/vercel-dry.json`은 공식 CLI 64.0.2의 `deploy --dry --json` 결과다. 업로드·deployment 생성은 없다. 빈 `.local/docs/test` directory marker와 실제 파일을 구분해 검사했다.
- `.vercelignore`에 Phase 7 관리 도구와 DESIGN/SPEC, migration, client/setup/smoke 도구 제외를 추가했다. 합성 사건 예제를 가진 client/smoke가 업로드 후보였던 문제를 최소 패키징 수정으로 해결했다. 소스 release에는 설계·명세·migration·검증·테스트를 포함하고, 배포에는 필요한 runtime/build/web 파일만 포함한다.
- 운영/개발 DB password, MCP client secret·owner key, 개발/운영 Clerk secret의 실제 값이 업로드 파일에 없는지 비교했다. 암호화 백업·DPAPI 키·비공개 env·합성 fixture·검증 helpers는 배포하지 않는다. 브라우저 build의 server/fixture import 차단도 통과했다.
- 정적 `/`, `/index.html`, `/assets/*`; `/api/player`, `/api/web-config`→api/web; MCP/OAuth/discovery→api/server 라우팅을 확인했다. 클라이언트 디자인은 변경하지 않았다.
- 로컬 설정은 sin1, MCP Function 120초, web 30초, Node 24, `npm run build`, output=public이다. 현재 실제 운영 MCP는 기존 30초 버전이다. 새 deployment의 resource/라우팅을 아직 측정하지 않았다.
- 현재 production 변수는 기존 6개뿐이다. Phase 8에 웹 origin·Clerk 운영 3개 변수를 추가하고 MCP 기존 값은 유지한다. DB runtime은 기존 pooler/verify-full, local migration/dump는 검증된 direct 주소를 사용한다. 관리용 direct URL은 배포하지 않는다.
- `vercel deploy --help`에서 **`--prod --skip-domain`**을 확인했다. 승인 후 production 환경의 staged deployment를 만들고 추후 promote할 수 있다. main push는 별도 자동 배포를 만들 수 있으므로 push/deploy/promote 순서를 승인 범위에 명시해야 한다. [Vercel deploy](https://vercel.com/docs/cli/deploy).

## 검증 합계 · 남은 항목

이번 최종 코드의 build/check, 서버 **101개**, 웹 **11개**, Edge OAuth/초기 생성 브라우저 **2개**가 통과했다. 새 유지보수 검증 3개는 서버 101개에 포함하며 **자동 회귀 총 114개**다. 추가로 실제 Neon 유지보수, 암호화 archive/변조 거부, 격리 restore/보존 대조, Clerk 운영 사용자·이메일·TLS, Vercel readonly inventory 및 dry run을 수행했다. Phase 6의 31개 Neon 검증을 이번에 다시 수행한 것으로 합산하지 않는다.

남은 실행/검증은 [OPERATIONS-TRANSITION.md](OPERATIONS-TRANSITION.md)의 A~F 승인 지점에 따른다. remote WAF 강제·구버전 host 영구 차단, 전환 직전 백업/복구 지점, 정확한 release commit 공개 범위, 운영 env/migration/deploy/promote, 실제 canonical 웹 Clerk azp/Cookie/API, sin1 긴 finalize와 ChatGPT timeout, 연결 유지 smoke를 확인한 뒤 쓰기를 재개한다. 최초 실제 캐릭터·세계 생성은 운영 전환과 별도 승인이다.

마지막 READ ONLY 대조에서도 운영 4개 테이블과 schema가 백업 시점과 같았다. 실제 Vercel도 기존 deployment/6개 변수/비활성 Firewall 상태였다. 격리 endpoint ep-young-flower-a115sf9a는 검증 종료 뒤 **2026-10-14 19:28:31 KST에 suspend**했다. 운영 endpoint는 변경하지 않았다.

비공개 `.local/phase7/`에는 테스트 로그·Clerk/TLS 최소 요약·Vercel 요약·release/dry manifest·화면 증거를 보관한다. 백업 manifest/복구 대조는 승인한 `.local/backups/phase7/`에 있다. 수다방 프로젝트 지침·LLM API·스케줄러·README는 변경하지 않았다.
