# Life RPG Phase 8-C · 릴리스·staged 배포 검증 완료

2026-10-14 KST. **23:06 KST Phase 8-C 완료.** 형의 추가 승인으로 변경된 팀 기본 alias 하나를 이전 deployment로 복원하고, 기존 staged deployment의 산출물·라우팅·함수 설정 검증을 완료했다. canonical MCP·웹·main alias와 production target, 유지보수 WAF는 기존 상태를 유지한다. 운영 DB 001의 새 게임 API는 호출하지 않았다. 아래 최초 중단 기록은 이력을 보존하며, 최종 상태는 마지막 완료 기록을 따른다. Phase 8-D 이후는 별도 승인 대기다.

## 확정한 릴리스

| 항목 | 결과 |
| --- | --- |
| 로컬 branch | codex/phase8-release |
| release commit | 2e8b1b8d0650cc9b912b5fa14b6f681d0fda6616 |
| parent / 기존 운영 commit | 06abadd44cfb64a14b9b2803c2f0322b740c9697 |
| commit 제목 | Implement Life RPG initial generation and production transition preparation |
| 포함한 변경 파일 | 79개, 전체 source tree 89개 |
| runtime/build 업로드 후보 | 39개, Phase 7 업로드 manifest와 완전히 동일 |
| Git 원격 push | 없음. main은 이전 commit을 유지 |

Phase 7 source manifest 대비 추가는 PHASE8A/PHASE8B 검증 문서 2개, 변경은 SPEC.md·OPERATIONS-TRANSITION.md·phase7-backup.js 3개였으며 삭제는 없었다. A에서 추가한 백업 helper의 고정 복구 DB 지원 외에 새 runtime 수정은 없다. 승인된 source 파일을 정확히 stage했고 Git diff --check와 staged diff --check가 통과했다. README는 변경하지 않았다. commit 직후 working tree는 깨끗했다.

정확한 79개 변경 파일·89개 source 파일·39개 업로드 파일의 목록 및 SHA256은 [PHASE8C-RELEASE-MANIFEST.json](PHASE8C-RELEASE-MANIFEST.json)에 기록한다. 실제 운영/개발 DB URL과 password, MCP secret·owner 연결 키, Clerk secret이 source/upload 후보에 포함되지 않았음을 실제 비공개 값과 비교하여 확인했다. `.env*`, `.local`의 백업/키/검증 산출물, 테스트/fixture·migration·운영 문서·관리 helpers는 실제 배포 파일에서 제외했다. `.env.example`만 source에 포함하며 배포하지 않는다.

## 로컬 검증

- npm run build: TypeScript check와 브라우저 assets 생성 통과. server/fixture import 방지 검사 통과.
- npm test: 서버 101개 통과, 실패/skip 0개.
- npm run test:web: 웹 11개 통과, 실패/skip 0개.
- Edge Chromium OAuth 승인·초기 생성 화면 회귀: 2개 통과, 실패/skip 0개.
- 합계 **114개**. 합성 PGlite/로컬 브라우저 검사이며 운영 DB에 접속하거나 실제 OAuth grant를 소비하지 않았다. Phase 6의 Neon 검증을 이번에 재실행한 것으로 합산하지 않는다.

## 실제 staged 생성

공식 Vercel CLI **64.0.2**, 기존 team/project를 명시하여 `deploy --prod --skip-domain --yes --no-wait --json`을 한 번 실행했다. production 환경변수의 기존 설정을 사용하며 env/build-env override, Turbo, Git push, promote, alias set은 실행하지 않았다. stdout JSON과 stderr는 비공개 메모리/필터링 도구로 처리했고 키 값을 출력하지 않았다.

| 항목 | 실제 API 관측 |
| --- | --- |
| deployment | dpl_51oiGLcHWdW3p1BQR4nRfPRuDb1w |
| URL | https://liferpg-mcp-experiment-4i49jsxmo-jeong-sin-gis-projects.vercel.app |
| 생성 / READY | 22:51:35.479 / 22:51:57.103 KST |
| state / substate / target | READY / STAGED / production |
| release metadata / Git SHA | 둘 다 2e8b1b8d0650cc9b912b5fa14b6f681d0fda6616 |
| Git branch metadata | codex/phase8-release |
| regions / Node | sin1 / 24.x |
| function 설정 | api/server.js 120초, api/web.js 30초 |
| buildCommand / outputDirectory | npm run build / public |
| build machine | 기존 plan-default standard, 4 cores / 8192 MB |
| autoAssignCustomDomains | false |
| aliasAssigned / automaticAliases | true / 기존 팀 기본 alias 1개 |

READY는 원격 빌드 성공의 증거다. region/duration은 deployment API 설정 관측이며 함수 실행 시간 측정이라고 주장하지 않는다. alias 불변 검사 실패 뒤 후속 배포 파일/생성 route 확인, HTTP 라우팅, 실제 Clerk runtime 검증은 수행하지 않았다.

## 안전 조건 위반 · alias의 정확한 상태

기존 serving deployment는 `dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ`, 새 staged는 `dpl_51oiGLcHWdW3p1BQR4nRfPRuDb1w`다. 최종 읽기 전용 확인은 **22:55:12 KST**다.

| 기존 alias | C 전 | C 후 |
| --- | --- | --- |
| liferpg-mcp-experiment.vercel.app | 기존 serving | 기존 serving · 보존 |
| liferpg.spiritflag.work | 기존 serving | 기존 serving · 보존 |
| liferpg-mcp-experiment-git-main-jeong-sin-gis-projects.vercel.app | 기존 serving | 기존 serving · 보존 |
| liferpg-mcp-experiment-jeong-sin-gis-projects.vercel.app | 기존 serving | **새 staged로 변경됨** |

project의 production target도 기존 serving deployment다. canonical MCP 연결을 새 배포로 promote하지 않았지만, **모든 기존 alias를 보존했다는 완료 조건은 실패했다.** API가 READY/STAGED와 autoAssignCustomDomains=false를 반환해도 자동 team alias가 옮겨진 실제 관측을 우선한다. `--skip-domain`의 CLI help를 전체 alias 보존의 보장으로 해석한 준비 가정이 틀렸다. 같은 명령으로 재배포하지 않았다.

최초 후속 assertion은 이 팀 기본 alias의 기존 mapping 비교에서 실패했다. 순서상 기존 환경변수, WAF, canonical 웹·MCP mapping은 이미 통과했다. alias 실패를 단순 검증기 표현 문제로 취급하지 않았고, 읽기 전용으로 전체 alias를 확정하여 변경을 확인했다. remote alias 복원/삭제·추가 deployment·WAF 수정은 수행하지 않았다.

## 설정·데이터·차단 보존과 미검증

- 기존 6개 MCP/DB/OAuth 변수와 B의 4개 Clerk/웹 변수 모두 ID/type/target/visibility/생성·수정 시각 및 API 반환 값 표현의 SHA256이 C 전후 같았다. Secret의 평문을 꺼내 비교했다고 주장하지 않는다. DATABASE_DIRECT_URL/ALLOW_SYNTHETIC_GAME은 없으며 새 변수도 추가하지 않았다.
- WAF active version=1과 rule_life_rpg_transition_maintenance_L748fV의 전체 구조, draft=null, bypass=[], attackMode=false가 동일했다. 규칙의 host/method/environment 제한 없는 MCP/OAuth deny가 유지된다. 이번 C에서는 staged URL의 실제 HTTP deny를 추가 측정하기 전에 중단했다.
- issuer/resource와 OAuth client·secret·owner 연결 키·callback 설정을 변경하지 않았다. canonical deployment와 해당 설정도 보존됐다. staged discovery/OAuth runtime 및 새 웹의 Clerk owner/azp/Cookie는 미검증이다.
- 운영 Neon에는 **접속 자체를 하지 않았다**. migration/쓰기/초기 생성, 새 게임 API/GM 요청을 하지 않았으며 A의 백업/복구 자료를 변경하지 않았다. 데이터 보존의 최신 직접 대조는 A 기록을 따른다. C에서 DB hash를 재측정했다고 주장하지 않는다.
- 기존 Pro 프로젝트의 승인된 standard staged build 1회만 실행했다. plan/권한/bypass/유료 추가 기능 변경은 없다. build/storage quota는 사용하며 최종 청구 금액을 검증한 것은 아니다.

## 최초 중단 당시 남은 조치 · 이력

**D 진입 보류.** 기존 팀 기본 alias를 이전 deployment에 복원할지 형의 지시를 받은 뒤 처리하고, C의 남은 배포 파일/route/안전한 runtime 검증을 마쳐야 한다. 전체 alias 보존 확인 전에는 운영 migration으로 넘어가지 않는다. 현재 staged URL과 옮겨진 팀 기본 alias에서 새 웹을 사용해 001 DB의 게임 API를 시험하지 않는다.

이 결과 문서·manifest와 운영 전환 절차의 현재 상태 보정은 **release commit 이후에 작성한 후속 로컬 미커밋 문서**다. 모두 기존 docs/ 제외 규칙에 해당한다. release commit을 amend하거나 추가 commit/deploy를 만들어 배포 SHA를 흐리지 않았다. private 증거는 `.local/phase8c/`의 before/release-manifest/release-commit/staged/stopped JSON과 테스트 로그에 보관한다.

유지보수 WAF를 유지한 채 멈췄다. alias 복원·C 재개·D migration·E promote/쓰기 재개·Git push·실제 게임 생성은 별도 지시를 기다린다.

## 추가 승인 후 완료 · 23:06 KST

- 변경된 `liferpg-mcp-experiment-jeong-sin-gis-projects.vercel.app` 하나만 `dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ`로 복원했다. 기존 alias 4개와 project production target이 모두 이전 deployment를 가리키는 것을 최종 확인했다.
- 기존 `dpl_51oiGLcHWdW3p1BQR4nRfPRuDb1w`를 재사용했다. READY/STAGED, production, release metadata SHA `2e8b1b8d0650cc9b912b5fa14b6f681d0fda6616`, sin1, Node 24.x, server 120초/web 30초, build/output 설정을 확인했다. 새 배포·릴리스 commit·push는 없다.
- 배포 source 파일 39개 전부가 기존 manifest 및 로컬 파일과 일치했다. 원격 파일 UID의 SHA1과 로컬 SHA256을 대조했다. `.local`·docs·test·migrations는 빈 directory 항목만 있고 배포 파일은 없다. 생성된 `api/server`·`api/web` lambda가 존재한다.
- staged `/`, app/style/Clerk assets, `/health`, OAuth discovery 2종, `/api/web-config`가 200이다. assets 3개는 로컬 산출물과 SHA256이 같다. 공개 Clerk production key 설정과 canonical issuer/resource 보존을 확인했다. deployment API의 routes는 null이므로 실제 HTTP와 배포 `vercel.json` 파일 대조로 라우팅을 검증했다.
- staged와 canonical MCP·웹 host의 `/mcp`, `/oauth/token` GET은 실제 403이며 canonical 두 host의 health는 200이다. WAF active/draft/bypass/attackMode 전체가 C 전과 일치한다. POST나 OAuth grant·refresh는 실행하지 않았다.
- staged의 Vercel Authentication 보호는 유지했다. 기존 인증의 `vercel curl`이 자동 생성한 접근용 automation bypass 하나는 검증 직후 revoke(regenerate=false)하여 최종 protection bypass 0개를 확인했다. WAF bypass는 계속 비어 있다.
- `/api/player`, MCP tool/새 게임 API 및 실제 게임 생성은 호출하지 않았다. 운영 DB 접속·migration, canonical promote, WAF 해제는 없다. Clerk owner/azp/Cookie의 실제 로그인 검증은 이번 범위에서 제외하고 기존 합성 검증 기록을 유지한다.

증거는 `.local/phase8c/resumed-inspection.json`, `resumed-verification.json`, `completed.json`에 저장했다. 기존 114개 로컬 검증을 불필요하게 재실행하지 않았다. 이 문서와 운영 절차의 완료 상태만 미커밋으로 갱신하며 배포 SHA와 manifest는 보존한다. **C 완료, D~F는 미실행·별도 승인 대기.**
