# 검증 기록 — 2026-10-14 (Asia/Seoul)

## 확인된 결과

| 대상 | 방법 | 결과 |
| --- | --- | --- |
| 기존 저장소 | SSH clone 및 GitHub repository metadata | 공개 빈 저장소, 기존 코드/스택/운영 데이터 없음 |
| 전용 DB | Neon org/project API, migration 실행 | free 플랜 독립 DB 준비, 기존 프로젝트 변경 없음 |
| 정적 검사 | `npm run check` | 통과 |
| 자동 테스트 | `npm test`, 공식 MCP SDK client + PGlite(Postgres) | 10개 통과 |
| 실제 DB 연결 | 로컬 Node HTTP 서버 + 실제 전용 Neon DB, `npm run smoke` | OAuth→MCP 초기화→도구 목록→상태→쓰기→조회 통과 |
| 동시 중복 | 실제 DB에 같은 합성 사건 동시 2회 등록 | recorded 1회, duplicate 1회, event ID 동일 |
| 미인증 쓰기 | 실제 HTTP POST | 401, 기록 없음 |
| 농담 분류 입력 | kind=joke 도구 호출 | skipped, 사건 수 변화 없음 |

실제 DB smoke 합성 사건 ID: `5bd2b63a-8f34-496c-ad80-ac5f33073de9`. 실사용자 현실 사건이 아니다. 테스트 access/refresh token은 정상 종료 후 폐기했다. 자동 테스트는 별도 메모리 DB에서만 실행했다.

자동 테스트 범위: 공개 discovery·OAuth metadata·도구 annotation, 익명/위조/만료 토큰, scope·audience 제한, 정확한 redirect, S256 요구·틀린 PKCE, code/refresh 재사용 방지, refresh 회전·토큰 폐기, canonical key 중복과 원본 보존, 가상 사건 skip, 입력 제한과 비밀 필드 미기록, 페이지 나눔·감사 로그, 감사 기록 실패 때 사건 rollback, origin·body 크기·JSON 검증.

## 남아 있는 판정

| 항목 | 상태 |
| --- | --- |
| Vercel production 배포 및 원격 URL | 승인 확인 후 진행 예정 |
| 원격 Vercel→Neon smoke | 배포 전, 미검증 |
| 계정의 ChatGPT MCP 연결·쓰기 도구 사용 가능 여부 | 사용자 계정 UI에서 미검증 |
| ‘수다방’ 프로젝트 내 MCP 사용 | 미검증 |
| 명시적 ChatGPT 상태 조회 및 테스트 쓰기 | 미검증 |
| 일반 대화의 자율 감지·도구 호출·확인 없이 저장 여부 | 미검증 |
| 재언급의 의미 중복 처리 | 미검증 |
| ChatGPT의 농담·가상 사건 판별 | 미검증 |

조건과 판정은 [테스트 시나리오](CHATGPT-TEST.md)를 따른다. 서버가 GPT가 보낸 `kind`를 처리하는 테스트는 실제 대화에서의 GPT 판단 검증을 대체하지 않는다.
