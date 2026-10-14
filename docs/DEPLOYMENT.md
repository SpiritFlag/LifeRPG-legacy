# 전용 Vercel 배포

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
현재 배포: `dpl_69r2CnH3RhtKk8ViESBtrvMcyKK7`, source commit `f2ab06c`, Node.js 24, Function `sin1`, 상태 READY. 최초 원격 smoke와 수정 후 원격 브라우저 OAuth 검증 통과. Deployment Protection 설정은 변경하지 않았다.

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
