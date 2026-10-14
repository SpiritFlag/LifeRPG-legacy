# Life RPG Phase 8-A · 유지보수 차단과 전환 직전 백업

2026-10-14 KST. 형이 A의 운영 유지보수 WAF publish와 최신 암호화 백업을 명시적으로 승인했다. [OPERATIONS-TRANSITION.md](OPERATIONS-TRANSITION.md), [PHASE7-VERIFICATION.md](PHASE7-VERIFICATION.md)를 기준으로 실행했다.

**A 완료. 프로젝트 전체 유지보수 차단을 활성 상태로 유지한다. B~E는 실행하지 않았고 별도 지시를 기다린다.** 운영 DB는 읽기 전용 관측/dump만 수행했다. 운영 migration·데이터 변경·reset/delete, Vercel 신규 코드 배포·환경변수·alias 변경, Git push, 실제 게임 생성, OAuth client/issuer/resource/secret 변경은 하지 않았다.

## 대상과 진행 요청 종료 확인

| 대상 | 재확인 결과 |
| --- | --- |
| Neon project | cool-waterfall-23850161 / LifeRPG-MCP-Experiment / PG 18 |
| 운영 branch | experiment / br-spring-night-a1jbloxd / primary=true, default=true |
| 운영 endpoint / DB / role | ep-soft-sky-a1kxmx2q / liferpg_experiment / liferpg_owner |
| 기존 격리 branch | br-soft-art-a1xx9a51 / ep-young-flower-a115sf9a, 운영과 다른 hostname |
| Vercel | team_wDLsRTkkRjvKKqQKnE8B9jEJ / prj_v5gMi1veBor2Oa2DPmzHi9uJjHvk |
| current production | dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ / READY / commit 06abadd44cfb64a14b9b2803c2f0322b740c9697 |

프로젝트 deployment 목록을 pagination 끝까지 확인했다. READY deployment 6개(현재 1개+과거 5개)의 `api/server.js` maxDuration은 모두 30초였다. 프로젝트/branch alias 2개도 검증 대상에 포함했다. production branch=main과 기존 운영 변수 6개는 유지되었다.

운영 연결은 verified direct hostname·DB명을 확인하고 startup default_transaction_read_only=on과 READ ONLY/REPEATABLE READ 트랜잭션을 사용했다. 차단 전 **21:59:18 KST**에 관측자 외 DB client 연결/진행 트랜잭션이 없었다. WAF publish 이후 기존 Function 한도보다 긴 **약 56초**를 두고 **22:02:36 KST**에 다시 확인했다. 이후 HTTP 검증 후와 백업/복구 후에도 연결·진행 트랜잭션이 없었고 전체 행 지문이 동일했다.

Vercel의 순간별 진행 HTTP 개수를 직접 조회한 것은 아니다. 기존 코드의 요청 한도, 신규 유입 차단, 종료 대기, 독립 DB 관측과 안정된 데이터 지문으로 진행 writer의 종료를 확인했다. SQL/개인 사건 본문/토큰을 pg_stat_activity 로그에 출력하지 않았다.

## 실제 WAF 적용

- 적용 후보: [phase7-maintenance-rule.json](phase7-maintenance-rule.json).
- 적용 전 active=null/draft=null/bypass=[]를 다시 확인했다. 다른 draft나 custom bypass는 없었다.
- stage 후 diff와 rule inspect에서 **활성 deny 규칙 1개, valid=true, validationErrors=null**, `/mcp*` OR `/oauth*`만 대상으로 하는 것을 확인했다. host/method/environment 제한과 persistent client ban duration은 없다.
- **2026-10-14 22:01:39.567 KST**에 publish되었다. active config `waf_APLJPngAk7j1`, version=1, firewallEnabled=true.
- rule ID는 **rule_life_rpg_transition_maintenance_L748fV**다. 마지막 조회에도 동일 rule active=true, deny, draft=null, bypass=[]였다.
- 새 코드의 MAINTENANCE_WRITES 변수나 Vercel Protection/Trusted Sources 설정을 변경하지 않았다. 이번 단계는 프로젝트 전체 유지보수 규칙만 적용했고, 전환 후 canonical-only 규칙의 publish는 아직이다.

형의 이번 직접 지시는 rule 검토 및 실제 적용까지 승인한 것이다. 일반적인 Firewall 스킬의 사용자 직접 publish 안내와 구분하여 이번 승인 범위에서 실행했다. DDoS 보호/Attack Mode/system bypass/팀 전체 규칙은 변경하지 않았다.

## canonical·과거 URL 검증

| 경로/호스트 범위 | 실제 검사 | 결과 |
| --- | --- | --- |
| liferpg-mcp-experiment.vercel.app 및 liferpg.spiritflag.work | `/mcp`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` × GET/POST/OPTIONS/DELETE/PUT/PATCH × 2호스트 = **48개** | 모두 HTTP 403 + x-vercel-mitigated=deny |
| READY unique URL 6개, 프로젝트/branch alias 2개 | 기존 로그인 브라우저로 동일 4경로 GET = **32개** | 모두 해당 URL에서 `This request was blocked`, `403 FORBIDDEN`, Vercel request ID 확인 |
| canonical 공개 discovery | health + authorization-server + protected-resource/mcp | 모두 200, 기존 issuer/resource/scopes 유지 |

검증한 unique URL의 project suffix는 `-jeong-sin-gis-projects.vercel.app`이며 식별 부분은 `dr42gwv2d`, `9qzly3vo5`, `gtmf7feix`, `a7pcpn74t`, `99049qk5y`, `e5wqnsli1`이다. 추가 alias는 `liferpg-mcp-experiment-jeong-sin-gis-projects.vercel.app`과 `liferpg-mcp-experiment-git-main-jeong-sin-gis-projects.vercel.app`이다. 전체 URL·request ID는 비공개 증거 파일에 있다.

첫 관측기에서는 WAF의 x-vercel-error=FORBIDDEN을 예상했지만 실제 header는 **x-vercel-mitigated=deny**였다. 실제 응답과 rule traffic을 확인한 뒤 관측기를 수정했다. WAF가 차단하지 않은 실패로 숨기지 않았으며 첫 관측도 보존했다.

보호된 unique URL의 익명 요청은 기존 Vercel Authentication의 302 login으로 먼저 갔다. 이것을 WAF 성공으로 세지 않았다. 기존 인증된 브라우저 세션에서 해당 URL의 403을 별도로 검증했다. CLI 64.0.2의 `vercel curl`은 없던 automation bypass secret을 생성할 수 있음을 로컬 코드에서 확인했으므로 실행하지 않았다. 새 bypass credential·share link·Trusted Sources 권한을 만들지 않았다.

보호 URL마다 인증된 POST를 별도로 전송한 검사는 하지 않았다. 대신 같은 프로젝트의 실제 활성 WAF가 method/host 제한 없이 적용됨을 대조하고, 공개 호스트의 POST를 포함한 6개 method 및 보호 호스트의 인증된 4경로 deny를 함께 확인했다. 이 직접 검사 범위와 정책 대조를 구분한다. POST payload는 합성 invalid client/ticket/token 또는 무인증 사건 요청으로, 실제 OAuth grant나 사용자 비밀을 소비하지 않았다.

Vercel rule traffic의 추가 조회에서 해당 rule의 **deny 131건**을 확인했다. 이는 초기/재검사/브라우저 요청 및 관측 시점의 트래픽을 포함하는 집계이며 위 80개 검증과 별도다. 단순 Vercel 로그인이나 앱의 권한 거부를 WAF deny로 합산하지 않았다.

## 운영 데이터 전후 대조

Phase 7 이후 정상 사용으로 grant 5→6행, audit 28→30행이 이미 바뀐 상태였다. 이번 작업은 A 시작 시점의 최신 상태를 기준으로 삼았다. 아래 **차단 전 → 종료 대기 후 → HTTP 검증 후 → dump 후 → restore 후 → 최종 관측**의 count와 전체 행 hash가 모두 같았다.

| 테이블 | 행 수 | 전체 행 지문 |
| --- | ---: | --- |
| auth_attempts | 1 | ac33bb76c71be273deb3ca9cf10e8fb6 |
| life_events | 6 | a9b65faf6c8e4f75c948736be8250efe |
| oauth_grants | 6 | d6bbf5c121a1d1d91793b2e9d44d1f8b |
| tool_calls | 30 | 35e69854da9abb740e5d1afeede7f252 |

life_events 전체 컬럼 지문으로 기존 UUID·근거·발생일·기록 시각·summary를 포함해 보존을 확인했다. OAuth payload/expiry와 감사 arguments/result/시각도 전체 행 지문에 포함한다. 값 자체는 출력하지 않았다. 현재 운영 schema는 001의 4개 테이블이며 migration과 실제 게임 생성은 수행하지 않았다.

## 최신 snapshot·백업·복구

쓰기 차단과 데이터 불변을 확인한 후에만 백업을 시작했다. READ ONLY/REPEATABLE READ에서 `pg_export_snapshot()`을 발급하고 pg_dump `--snapshot`으로 동일 snapshot을 사용했다. 이 snapshot ID는 dump 중 열린 트랜잭션의 일관성을 위한 것으로, 별도 영구 Neon PITR 지점/backup branch라고 표현하지 않는다. 보존되는 복구 원본은 아래 암호화 archive다.

| 항목 | 결과 |
| --- | --- |
| snapshot 시각 | **2026-10-14 22:11:29.775 KST** |
| 승인된 저장 위치 | `C:\Users\singi\LifeRPG\.local\backups\phase7` |
| 새 파일 | `2026-10-14T13-11-25-256Z.pgdump.aesgcm` · **10,426 bytes** |
| ciphertext SHA256 | `60199a6307186dbea667f0bc3d9dbcba4b5ed1a5cd31faf0b044c9add0177216` |
| 보호 | AES-256-GCM · random IV · tag/AAD · 별도 CurrentUser DPAPI 키 |
| 키 위치 | 프로젝트 밖 `C:\Users\singi\.codex\secrets` · 현재 사용자/SYSTEM ACL |
| 보존 | Phase 8 완료 후 7일, 삭제는 형 확인 후. 기존 Phase 7 archive/키도 유지 |
| 도구 | 기존 PG 18.6 pg_dump/pg_restore · verify-full 유지 · 평문 dump 파일 없음 |
| 복구 target | 기존 격리 br-soft-art-a1xx9a51 / ep-young-flower-a115sf9a의 **새 liferpg_phase8a_restore** |

SHA256, DPAPI 복호화, AES tag/AAD, custom-format PGDMP 서명과 pg_restore --list 16개 항목을 확인했다. 메모리에서 암호문을 변조한 검사는 인증 오류로 거부되었고 DB 연결 0회였다. 원본 archive는 변경하지 않았다.

복구는 인증을 완료한 평문을 메모리에서만 사용하고 **빈 별도 DB**에 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`로 진행했다. 테이블·컬럼·제약·인덱스·public 함수·전체 행 hash가 manifest와 같았고, 운영 원본도 그대로였다. 복구 성공 시각은 **22:12:40.762 KST**다. 기존 Phase 7 복구 DB를 덮거나 운영에 restore하지 않았다.

기존 승인된 백업 helper에 `--phase8a`를 추가하여 새로운 고정 복구 DB를 선택하고 이전 report를 덮지 않도록 분리했다. 임의 host/branch/DB 연결 인수를 허용하지 않았다. runtime 게임 코드와 OAuth 계약은 변경하지 않았다. helper는 기존 `.vercelignore`의 scripts/phase7-* 패턴에 해당하고 `.local`, `.env*`, docs와 키는 Git/배포 산출물에서 제외된다.

## 비용·한계·다음 단계

Neon 조직 plan=free/free_v3, branches limit=10과 기존 branch 2개, compute 0.25 CU를 다시 확인했다. 새 branch/endpoint·유료 자원을 만들지 않고 같은 격리 branch에 DB 1개만 추가했다. Vercel은 기존 Pro 프로젝트의 custom WAF를 사용했다. 추가 결제·업그레이드·compute 크기·신규 권한·bypass secret 변경은 없다. 기존 quota/요청 사용량은 소모하며 별도 청구서 금액을 검증한 것은 아니다.

복구 연습 branch는 **2026-10-15 18:20 KST**에 만료한다. 영구 백업 branch를 새로 만들지 않았고 일시 연습 DB를 장기 백업으로 취급하지 않는다. 승인한 암호화 파일은 로컬에 보존되며 다른 PC의 DPAPI 복구/외부 사본·역할/ACL 재생성은 기존 Phase 7과 같은 미검증 범위다. 격리 compute는 검증 종료 후 suspend했다.

**Phase 8-B의 인증·환경 적용 준비에 진입 가능하다. 실행에는 별도 지시가 필요하다.** WAF를 해제하지 않고 다음 지시를 기다린다. 운영 schema는 아직 001이고 current deployment/기존 운영 변수 6개도 그대로다. canonical-only 구버전 writer 규칙, migration, staged deploy, alias promote, 기존 연결 smoke/쓰기 재개와 실제 게임 생성은 이번 A 범위 밖이다.

증거는 비공개 `.local/phase8a/`의 inventory/stage/diff/publish/rule traffic/HTTP/인증 브라우저/DB 관측/completion과 승인된 백업 폴더의 timestamp manifest, `phase8a-archive-verification.json`, `phase8a-restore-verification.json`에 보관한다. README·수다방 지침은 변경하지 않았다.
