# Life RPG Phase 8-B · 운영 Clerk·웹 환경변수 적용

2026-10-14 KST. 형의 B 승인에 따라 [OPERATIONS-TRANSITION.md](OPERATIONS-TRANSITION.md), [PHASE7-VERIFICATION.md](PHASE7-VERIFICATION.md), [PHASE8A-VERIFICATION.md](PHASE8A-VERIFICATION.md)를 확인하고 production 변수 4개만 추가했다.

**B 완료. A의 유지보수 WAF는 그대로 활성 상태다. C 이후의 commit/push/deployment/migration/alias 전환은 별도 지시를 기다린다.** 운영 Neon에 연결하지 않았고 Clerk 인스턴스·DNS·로그인 방식·OAuth 계약을 변경하지 않았다.

## 대상 · 실제 적용

연결 파일과 API에서 Vercel team `team_wDLsRTkkRjvKKqQKnE8B9jEJ`, project `prj_v5gMi1veBor2Oa2DPmzHi9uJjHvk` / liferpg-mcp-experiment를 확인했다. production branch는 main이다. 기존 운영 변수는 6개였으며 이번 4개는 사전에 존재하지 않았다. 기존 값을 overwrite하거나 다른 환경의 변수를 공유하지 않았다.

| 추가한 변수 이름 | 대상 | 저장 유형 | 검증 |
| --- | --- | --- | --- |
| CLERK_PUBLISHABLE_KEY | production만 | Config (`encrypted`, visibility=config) | 운영 원본과 메모리에서 정확히 비교·일치 |
| CLERK_SECRET_KEY | production만 | Secret (`sensitive`, visibility=secret) | live 원본과 Clerk API 소유자 검증, 정확한 stdin 전달, 생성 성공 및 평문 미반환 확인 |
| CLERK_OWNER_USER_ID | production만 | Config | 운영 원본과 메모리에서 정확히 비교·일치 |
| WEB_PUBLIC_BASE_URL | production만 | Config | 승인된 운영 원본/Clerk primary home 설정과 정확히 비교·일치 |

실제 생성 시간은 **22:27:24~22:27:35 KST**, 최종 검증 시간은 **22:34:59 KST**다. preview/development/custom 환경 및 git branch override는 없다. 이 문서와 새 검증 보고서에는 변수 값을 기록하지 않는다.

Phase 7 비공개 `.env.clerk.production.local`을 사용했다. publishable/secret의 live prefix, 개발 키와 값이 다름, 개발/운영 소유자 구분, 준비된 운영 소유자 일치, publishable key의 Frontend API domain과 canonical 웹의 일치를 확인했다. 실제 live secret과 소유자 조합을 읽기 전용 Clerk Backend API로 다시 검사했고 이메일 검증된 운영 사용자가 일치했다. 사용자·세션을 생성하거나 로그인 방식을 변경하지 않았다.

Vercel CLI 64.0.2 `env add`에 명시적으로 이름·production·type·project·team을 전달했다. 값은 Node 자식 프로세스 **표준입력**으로만 보내고 `--value`, shell history/process 인수, 추가 평문 임시 파일을 사용하지 않았다. 원문 stdout/stderr는 메모리에서만 처리하고 저장·출력하지 않았다. 오류에 값이 포함될 수 있어 진단도 분류/단계만 기록했다. `env pull`로 기존 비공개 설정을 덮지 않았다.

Config 3개는 공식 [개별 변수 조회 API](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id)로 읽어 메모리에서 원본과 비교했고 즉시 값 없는 결과만 남겼다. Secret은 조회 응답에 value가 없고 Secret 유형으로 저장됨을 확인했으며, 평문을 다시 꺼내려고 시도하지 않았다. Secret 검증은 유효한 원본·정확한 요청 입력·생성 성공·저장 메타데이터를 근거로 하며 runtime에서 키를 사용한 검증은 C 이후다.

## 기존 설정·차단 보존

- 기존 **DATABASE_URL, PUBLIC_BASE_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OWNER_LOGIN_KEY, OAUTH_REDIRECT_URIS**의 ID/type/target/생성·수정 시각은 B 전후 동일했다. A에서 보관한 API 반환 값 표현의 지문도 일치했다. 원래부터 읽을 수 없는 Secret의 평문을 다시 조회했다고 주장하지 않는다. 변경 명령은 새 4개에만 실행했다.
- **DATABASE_DIRECT_URL은 없다. ALLOW_SYNTHETIC_GAME도 없다.** 운영 합성 게임을 활성화하지 않았다.
- WAF active config version=1, rule_life_rpg_transition_maintenance_L748fV의 active deny·조건·draft·bypass·Attack Mode 설정이 B 전과 구조적으로 동일했다. WAF 변경 명령은 실행하지 않았다. 웹 호스트의 `/mcp` GET도 실제 HTTP 403 + x-vercel-mitigated=deny였다.
- production은 **dpl_4rj8NTC4GsRVTNLn87UAVaSHeNaJ** 그대로다. 전체 deployment ID/state/URL 목록과 alias 목록도 B 전후 같았고 새 deployment는 없다. Git HEAD도 동일하다. commit/push·alias 변경을 하지 않았다.
- Clerk·DNS·Neon의 관리 변경, 새 비용/유료 플랜/권한 확장은 하지 않았다. B 검증은 Vercel 설정 조회/추가, 읽기 전용 Clerk 확인과 차단 HTTP 관측만 사용했다.

## 관측기 보정 · 비노출 범위

최초 추가 명령 4개는 모두 성공했지만 후속 assertion에서 관측기가 중단됐다. 원문 오류가 값에 접근할 수 있어 출력하지 않았고, 변수 재설정 없이 **읽기 전용 검증기를 분리**했다. 저장 JSON이 생략하는 optional undefined 필드와 live 메타데이터의 비교를 같은 JSON 표현으로 정규화한 뒤, 기존 설정·Config 원본·Secret 메타데이터·WAF·deployment/alias/Git 보존의 모든 검사를 통과했다. 실패/진행 기록도 비공개 폴더에 유지했다. 관측기 중단을 설정 성공의 증거로 대신 사용하지 않았다.

비밀 키 값은 적용·검증 출력과 새 기록에 남기지 않았다. 다만 시작 시 기존 문서를 읽는 도구 출력에는 **기존 문서에 이미 있던 공개 도메인과 운영 소유자 ID**가 포함됐다. 이후 적용/검증/새 보고서는 값 없이 처리했다. 이 차이를 숨기고 모든 값이 한 번도 출력되지 않았다고 보고하지 않는다.

비공개 source/도구/증거는 `.env.clerk.production.local`, `.local/phase8b/`에 있으며 Git/Vercel 제외 규칙을 확인했다. 새 문서·verification 보고서는 실제 4개 값이 포함되지 않았음을 메모리 비교로 확인한다. Secret을 숨기기 위해 인증키를 회전하거나 권한을 바꾸지는 않았다.

## C 진입 판정

**Phase 8-C 진입 가능, 실행 승인 대기.** 변수는 Vercel production의 다음 deployment용으로 준비됐다. 환경변수 추가만으로 기존 deployment에 새 값이 주입되었다고 가정하지 않는다. 기존 서비스는 유지보수 차단 중인 이전 코드이며 새 웹의 Clerk Cookie/azp/API/소유자 거부 및 실제 runtime 키 사용은 배포 이후 확인 대상이다. [Vercel 환경변수 적용](https://vercel.com/docs/environment-variables/managing-environment-variables).

유지보수 규칙을 유지한 채 멈췄다. release commit/push, staged deployment, 운영 migration, promote/alias 전환, smoke/쓰기 재개는 이번 B 승인 범위 밖이다. 값 없는 세부 증거는 `.local/phase8b/before.json`, `progress.json`, `verification.json`에 보관한다. 관련 없는 runtime 코드·README·수다방 지침은 변경하지 않았다.
