# 전용 Vercel 배포

## v2 단일 함수 운영 전환 · 2026-10-15 13:58 KST

현재 MCP production은 `dpl_EoSWwi2wK4LmFNqFh5EHHJHspYQF`이며 정식 URL은 **https://liferpg-mcp-experiment.vercel.app/mcp**다. 두 canonical host의 /health=200, server=liferpg-v2-openai, tools/list=기존 v2 도구 5개를 확인했다. 실제 OAuth 인증 뒤 read_liferpg의 status/game/usage가 정상 응답하고 initialized=false였다. 유료 GM 호출과 캐릭터 생성은 검증에서 수행하지 않았다.

Vercel 진입점 api/server.ts는 Node.js에서 실행하며 maxDuration=300이다. TypeScript 진입점과 rewriteRelativeImportExtensions 설정으로 Vercel이 변환한 v2 모듈을 올바르게 로드한다. OpenAI 키와 기존 GM_MODEL/GM_REASONING_EFFORT/입출력 상한을 Production 환경변수에 등록했다. Neon liferpg_experiment의 새 liferpg_v2 스키마에 001~005 migration을 적용했다. 기존 v1 데이터와 유료 합성 자료를 이관하지 않았다. 서버 lifetime/UTC 일/UTC 월/owner 상한은 각각 $10이다. 월별 사용량은 기존 계산을 따르며 최초 lifetime/owner 상한 도달 시 운영자가 판단하여 조정한다.

MCP 도구 5개의 입력은 유지했다. 새 GM 요청만 단일 invocation에서 시작하고, 15초 후에는 operation_id/status=running을 정상 응답으로 반환한다. 동일 Promise의 GM 실행·Neon 저장은 waitUntil로 이어간다. 조회는 GM을 실행하지 않는다. 별도 Worker 서비스·Gate·Cron·큐·복구 시스템을 배포하지 않았다. 기존 jobs/attempts 테이블과 판정 엔진만 재사용한다. 구체적인 시간 기록과 실패 의미는 SPEC의 v2 운영 항목을 따른다.

ChatGPT에서 연결하는 방법:

1. 기존 LifeRPG 앱의 도구 목록을 새로고침하고 연결을 끊었다가 다시 인증한다. 기존 연결을 갱신할 수 없으면 같은 MCP URL로 앱을 다시 등록한다. 인증은 OAuth, client ID는 liferpg-chatgpt이고 기존 client secret을 사용한다.
2. 새 권한 life.read/life.write/life.delete/game.read/game.play/usage.read/offline_access를 승인한다. 소유자 키는 OAuth 연결 화면에 입력한다. 기존 비밀값은 Git에서 제외한 .local/CHATGPT-CONNECTION.txt에 있다.
3. 새 대화에서 앱을 선택하고 “LifeRPG v2를 시작해 줘. 캐릭터와 세계 생성은 서버 GM에게 맡기고, 처리 중이면 operation_id로 확정 결과를 조회해 줘.”라고 요청한다. interact_with_gm(kind=start)가 첫 실제 유료 GM 호출이다.
4. 이후 “오늘 실제로 30분 산책했어. 기록하고 게임 판정을 받아 줘.”처럼 확정된 사실을 전달한다. ChatGPT는 submit_observation을 사용한다. 허구 세계 행동은 interact_with_gm(kind=action), 추가 질문 답변은 kind=answer를 사용한다.
5. running은 완료가 아니다. read_liferpg(view=request,operation_id=반환값)로 확정 결과를 확인한다. 재전송 시 같은 request_id를 유지한다. 실패한 요청을 새 ID로 반복 실행하기 전에 오류 원인을 확인한다.

ChatGPT 프로젝트에 기존 v1 지침이 있으면 다음 문구로 교체한다: “너는 LifeRPG의 진행 창구다. 게임 판정은 서버 OpenAI GM에 맡긴다. 확정된 현실 사건만 submit_observation으로 전달한다. 매 요청에 고유 request_id를 쓰고 같은 요청의 재전송에는 같은 ID를 유지한다. running/queued를 완료로 말하지 않고 operation_id로 조회한다. committed/no_change/needs_input/failed를 구분하고 player_result.changes를 확정 결과로 전달한다. 서버가 질문하면 사용자의 답을 question_id와 함께 전달한다. 데이터 수정·삭제는 사용자의 요청에 따라 기존 전용 도구를 사용한다.”

검증은 v2-inline 및 기존 서비스/OpenAI 계약 34개, tsc/웹 빌드, 배포 전용 URL의 v2 health, 정식 호스트의 도구 목록 및 실제 OAuth 읽기 경로에 한정했다. 배포 전용 URL의 /mcp와 /oauth는 기존 canonical-host WAF 규칙 때문에 차단되므로 정식 도메인에서 검증했다. 최초 staged 빌드의 TS 경로 누락은 정식 도메인 반영 전에 수정했다. 배포 검증 비공개 자료는 .local/v2-release/에 있다. 아래 항목은 v1 당시 이력이다.

## submit_observation 운영 반영 · 2026-10-15 09:44 KST

사용자 승인으로 `submit_observation` 실험 도구를 production staged 빌드 후 promote했다. 현재 deployment는 `dpl_5Rnu3AXuMEoSbwVZnEy5jfEVw4cv`이며 READY/PROMOTED다. 이전 `dpl_6jfArqW1tNxAugbGpW6UJB1uVtpL` 업로드 원본과 대조한 39개 파일 중 실질 변경은 `src/tools.js`의 이번 실험 추가분 하나뿐이다. 로컬 미커밋 작업을 보존했고 Git push는 하지 않았다.

두 canonical host(liferpg-mcp-experiment.vercel.app, liferpg.spiritflag.work)가 새 deployment로 연결됐으며 `/health` 200/running, `tools/list` 10개 및 새 입력·OAuth scope·쓰기 annotation을 확인했다. 기존 9개 도구의 전체 등록 정보는 이전 응답과 동일했다. 읽기 전용 life.read 검증 grant로 두 host의 `get_gm_status` storage=ready를 확인하고 검증 grant만 폐기했다. 이에 따른 OAuth 처리와 상태 조회 감사 2건 외 게임 쓰기, migration, 합성 사건 생성, submit_observation 호출은 수행하지 않았다. 환경변수와 WAF active/draft/bypass/attackMode 설정은 배포 전후 동일하다.

로컬 build/type 검사와 서버 회귀 106/106이 통과했다. 운영 관측은 도구 등록과 서버 상태 확인 범위이며 실제 ChatGPT 실험은 사용자가 진행한다. 비공개 근거는 `.local/observation-deploy/`에 보존한다. 계약·최소 호출 절차는 [전달 실험](OBSERVATION-EXPERIMENT.md)을 따른다. 아래 이전 배포 항목은 당시 이력이다.

## 준비된 자원

- Git remote: `git@github.com:SpiritFlag/LifeRPG.git` (공개 저장소, 최초 수신 시 빈 저장소).
- Neon org `Singi` (`org-polished-tooth-53135716`), API에서 `plan=free` 확인.
- 독립 Neon project `LifeRPG-MCP-Experiment` (`cool-waterfall-23850161`), default branch `experiment`, DB `liferpg_experiment`, owner `liferpg_owner`.
- Vercel CLI에서 기존 팀 `jeong-sin-gis-projects` (`team_wDLsRTkkRjvKKqQKnE8B9jEJ`), `plan=pro` 확인. 기존 프로젝트에는 LifeRPG가 없다.
- 연결 URL·비밀값은 `.env.local`에 준비했다. `.gitignore`와 `.vercelignore`로 제외한다. README는 생성·수정하지 않았다.

공개 저장소 푸시와 전용 Vercel 배포는 2026-10-14 사용자 승인 후 완료했다. DB는 무료 플랜에 만들었고 업그레이드하지 않았다. Vercel Pro 사용량에 따른 추가 비용은 무료라고 단정할 수 없다.

배포 project ID: `prj_v5gMi1veBor2Oa2DPmzHi9uJjHvk`.
정식 MCP 연결 URL: **https://liferpg-mcp-experiment.vercel.app/mcp**.
추가 production alias: `https://liferpg.spiritflag.work`. OAuth issuer/resource는 정식 연결 URL의 origin을 사용한다. ChatGPT 설정에서는 정식 URL을 그대로 사용한다.
현재 배포: `dpl_6jfArqW1tNxAugbGpW6UJB1uVtpL`, Node.js 24, Function `sin1`, 상태 READY/PROMOTED. 2026-10-15 08:10 KST에 현실 할 일 퀘스트 기능을 운영 반영했다. Git HEAD `2e8b1b8` 이후 로컬 기능 변경을 CLI로 배포했으며 별도 Git push는 하지 않았다. Deployment Protection·WAF·OAuth 설정은 변경하지 않았다.

## 현실 할 일 퀘스트 운영 반영 · 2026-10-15

사용자의 운영 배포 요청으로 새 production 빌드를 skip-domain으로 준비한 뒤 008-real-task-quests.sql을 적용하고 promote했다. 실제 ChatGPT 프로젝트 지침은 사용자가 별도로 갱신했으므로 이번 배포에서 변경하지 않았다.

- 새 암호화 백업 생성·인증·pg_restore 목록 검사 통과. 기존 별도 Neon branch의 합성 DB에서 008을 먼저 적용하고 원래 행 지문 보존을 확인했다.
- 운영 migration 전후 39개 테이블의 원래 컬럼·행 지문이 같았다. smoke 후에도 인증·감사 테이블을 제외한 36개 게임 관련 테이블이 그대로였고 실제 게임 revision=3을 유지했다. 운영에 합성 사건·퀘스트·보상을 생성하지 않았다.
- 서버 회귀 105개 통과. 기능 구현 시 퀘스트/웹 API·migration·브라우저 검증 33개와 빌드·타입 검사도 통과했다.
- liferpg-mcp-experiment.vercel.app과 liferpg.spiritflag.work 모두 새 deployment로 연결됐다. 두 host의 인증된 tools/list가 도구 9개 및 real_task/recurrence/user_consent 입력을 반환하고 get_game_context(view=player)가 성공했다. health·웹·새 퀘스트 UI 자산은 200, 익명 player API는 401이었다.
- WAF active version=6, 기존 규칙 2개, draft 없음, bypass 없음을 유지했다. 이전 deployment `dpl_51oiGLcHWdW3p1BQR4nRfPRuDb1w`는 코드 rollback 후보이며 추가 컬럼은 이전 코드와 호환된다.
- 새 deployment의 08:01~08:11 KST 런타임 로그에서 level:error 조회 결과 0건, 추가 페이지·제외 구간 없음이었다. 이 결과는 해당 조회 구간에 한정한다.
- ChatGPT 연결에서는 도구 스키마·설명·서버 지침을 받도록 앱 상세의 Refresh가 필요하다. 사용자 프로젝트 지침 교체와 별개이며 OAuth 재등록은 필요하지 않다. 자연어 제안·동의·독려의 실제 대화 품질은 사용자 환경에서 확인한다.

비공개 증거는 `.local/real-task-quests/`의 production-migration.json, production-smoke.json, infrastructure-after.json, final-data-check.json, firewall-after.json과 테스트·백업 검증 로그에 보존했다. 비밀값과 실제 게임 본문은 공개 기록에 포함하지 않는다.

사용자용 client secret·소유자 연결 키는 Git/배포에서 제외한 로컬 `.local/CHATGPT-CONNECTION.txt`에 제공한다. 실제 secret 값을 Git이나 대화에 붙여넣지 않는다.

## 배포 설정

1. 전용 Vercel project `liferpg-mcp-experiment`를 위 팀에 새로 생성·연결한다. 기존 서비스 프로젝트를 선택하지 않는다.
2. 확정된 production 도메인 origin을 `PUBLIC_BASE_URL`에 설정한다. 예를 들어 `https://liferpg-mcp-experiment.vercel.app`을 실제 할당받았을 때 그 값만 사용한다. OAuth issuer/resource와 외부 URL이 같아야 한다.
3. production 환경에 `DATABASE_URL`, `PUBLIC_BASE_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OWNER_LOGIN_KEY`, `OAUTH_REDIRECT_URIS`를 설정한다. `DATABASE_DIRECT_URL`은 로컬 migration 전용이고 배포하지 않는다.
4. `npm run check`, `npm test`를 실행하고 `vercel project inspect --non-interactive`로 owner/project를 재확인한다. Node.js 24, `sin1`, 최대 30초 Function, 프레임워크 없음.
5. 승인된 범위에서 production 배포한다. ChatGPT가 MCP discovery와 OAuth endpoint에 접근할 수 있는 production URL이어야 한다. 기존 서비스의 Deployment Protection 설정을 변경하지 않는다. preview URL의 보호를 꺼서 우회하지 않는다.
6. 원격 URL을 대상으로 `npm run smoke`를 실행한다. `PUBLIC_BASE_URL`을 확정된 production origin으로 환경에서 지정하면 `.env.local`의 localhost보다 우선한다. 이 명령은 합성 사건 한 건과 호출 내역을 전용 DB에 추가한다.
7. [ChatGPT 테스트](CHATGPT-TEST.md)를 사용자와 진행한다. 서버 테스트 통과를 ChatGPT 자율 호출 성공으로 보고하지 않는다.

CLI 사용 시 secret 값을 명령 인수나 console에 출력하지 않는다. stdin을 지원하는 env 설정이나 보안 파일을 이용한다. `.vercel`, `.env.local`, auth token, DB 비밀번호를 Git에 넣지 않는다. 공개 source에는 실제 사용자의 사건이나 로그도 넣지 않는다. 정적 파일 출력은 빈 `public/`로 제한하며 source 파일과 비밀 파일은 HTTP로 제공하지 않는다.

## 로컬 실행

```powershell
npm ci
npm run db:setup
npm run dev
```

`PUBLIC_BASE_URL=http://localhost:3000` 상태에서 별도 terminal로 `npm run smoke`. migration 스크립트는 DB명이 `liferpg_experiment`가 아니면 실행을 거부한다. 새 DB에 `migrations/001-experiment.sql`을 적용하며 기존 테이블이나 운영 데이터를 삭제하지 않는다.

실험 종료 시 서버 연결·토큰을 폐기하고 자원을 유지할지 삭제할지 사용자와 결정한다. 자동 정리나 파괴적인 데이터 삭제 기능은 제공하지 않는다.
