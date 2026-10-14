# Phase 5 · 정식 캐릭터·세계 초기 생성

2026-10-14 · Asia/Seoul · 로컬 구현 및 격리 검증

DESIGN.md, SPEC.md와 Phase 1~4 구현·검증 기록을 확인하고 기존 MCP 9개 도구·OAuth·Clerk 인증·성장 규칙 위에 정식 초기 생성 계약을 구현했다. 실제 사용자 캐릭터·세계는 생성하지 않았다. 이전 단계의 미커밋 변경을 보존했으며 README·DESIGN·수다방 지침은 변경하지 않았다.

## 구현 결과

`apply_gm_update`의 begin_initialization → prepare_initialization → finalize_initialization으로 GM이 작성한 캐릭터·세계를 준비하고 최초 확정한다. 초안은 DB에 입력 chunk와 영수증만 저장하며 확정 이전에는 live games/characters/퀘스트/콘텐츠/세계에 행이 없다. 확정은 기존 Phase 3A~3C 검증기, 성장 계산, 판정 근거·불변 이력·영수증·호출 감사를 한 트랜잭션에서 저장한다.

real/test 구분·초안 버전·동일 요청 재생·중복 초기화 거부·취소 후 재작성·다른 소유자 접근 차단을 지원한다. 기존 synthetic-only initialize 입력과 이전 hash·영수증도 유지한다. 초기 생성 결과는 get_gm_update로 복구하며 완료 이후에는 기존 advance와 get_game_context로 운영한다. 서버가 AI API를 호출하거나 내용을 자동 창작하지 않는다.

GM의 이름·종족·출생·배경·운명·서사 설정을 현재 character_profile과 불변 character_births로 나눈다. 이후 character_change는 지정한 필드만 수정하고 최초 탄생·전후 원문·이유를 보존한다. 초기 XP·6대 스탯, 7종 정의·고정 버전 취득·직업·장착·인벤토리와 세계·관계·퀘스트·기억·일지는 기존 모델을 재사용한다. 세계 전체 규모나 초기 NPC 수는 고정하지 않는다.

birth_sources는 기존 사건 UUID·현재 버전·탄생 적용 이유를 기존 base 판정으로 보존한다. 초기 수치에 이미 반영된 경험이므로 base의 추가 증감은 0이고 초기 성장 전체를 한 번만 기록한다. 같은 근거에 최초 보상을 반복하면 거부하며 새 사건·보강은 일반 GM 후속 판정으로 이어진다. 현실 사건 원본·alias·근거·이력은 변경하지 않는다.

웹은 미시작·준비 중·시작 완료를 구별하고 공개 탄생·배경·운명을 표시한다. 기존 디자인·Clerk 단일 소유자 인증·읽기 전용 API를 유지하며 초안 원문·GM 전기·세계 비밀·중첩 gm_* 필드·GM 이유는 공개 결과에서 제외한다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run build` | TypeScript checkJs와 웹 번들 생성 통과. 서버·fixture·비밀값의 클라이언트 번들 유입 검사 유지 |
| `npm test` | 기존 Phase 1~3C **83개** + 신규 초기 생성 **14개**, 합계 **97개 통과** |
| `npm run test:web` | 기존 Clerk/API 회귀 **10개 통과** |
| `npm run test:browser` | 기존 Edge OAuth 승인·Origin·303 callback·token 교환 **1개 통과** |
| `npm run test:initialization:browser` | 메모리 합성 DB와 실제 headless Edge에서 초기 생성 웹 흐름 **1개 통과** |
| 006→007 이관 | 합성 기존 사건·게임·성장·영수증·OAuth·감사 snapshot 보존, 자동 탄생 생성 없음, 기존 초기화 재시도 유지, 중복 migration 오류 rollback |
| 정식 real 경로 | 격리 DB의 합성 fixture를 kind=real로 저장하여 실제 정식 코드 경로 검증. 초기 650 XP/레벨 4, 6종 스탯, 7종 정의, 직업·스킬·특성·칭호·업적·장비·아이템·장착 보정 확인 |
| 초기 세계·NPC·퀘스트 | 공개 세계/시작 지역·국가/세력·NPC 소속·멘토 관계, 세계 역사·GM 비밀/복선·장기 기억·최초 일지·라인/장/퀘스트·현실 사건 연결과 실제 UUID 영수증 확인 |
| 여러 호출 | 여러 chunk에서 60 NPC + 세계/지역, 합계 62개 세계 엔터티 생성. chunk 간 부모·NPC·퀘스트 참조와 50개 목록 pagination 확인. 확정 전 live 테이블은 모두 비어 있음 |
| 재시도·경쟁 | begin/prepare/finalize/cancel 정확한 재시도, 다른 입력의 같은 키, 중복 begin·완료 후 재초기화 거부. 초안 동일 버전 경쟁·최종 확정 경쟁은 각각 한 번만 성공 |
| 과거 사건 | 최초 base 예약, 같은 근거 추가 최초 XP 거부·0 증감 검토 unchanged, 보강 후 previous_id 추가 증감·새 과거 사건 일반 보상, 최초 탄생 XP 보존, 원본 사건 전체 조회 불변 |
| 근거·참조 오류 | real/test 혼용·stale 사건 버전·chunk 전체 중복 근거·누락 직업/시작 지역·잘못된 퀘스트 임시 참조에서 live 상태 전부 rollback. 취소 후 수정된 새 초안 확정 |
| 저장 실패 주입 | 게임·캐릭터·퀘스트 노드·정의 버전·인벤토리·세계 이력·판정 근거·성장 이력·현재 전기·전기 이력·탄생·GM 영수증·초안 완료·초안 영수증·호출 감사의 **15개 경계**에서 실패 후 live 행 0, 초안 직전 버전 유지, 같은 finalize 요청 재시도 성공 |
| 준비 실패 | begin/prepare의 영수증·감사 실패에 초안 생성·버전 증가 rollback, 성공 영수증 없는 요청은 정확한 입력으로 재시도 가능 |
| 진행 중 조회 | 캐릭터 INSERT 직후 확정을 일시 정지하고 웹/GM 읽기를 함께 요청. 성공 후 완성 상태 또는 실패 후 preparing만 반환, 중간 live 행 반환 없음. PGlite의 직렬 처리라는 한계는 아래에 명시 |
| 불변 기록·전기 수정 | 탄생/전기 이력/초안 영수증 DELETE 차단, 이름·운명 수정 후 탄생 원본 보존, 이력 pagination·GM 원문·공개 투영. 생략한 narrative/gm_state 보존, 빈 patch 거부 |
| 접근·비공개 | 익명·life.read 쓰기·소유자 입력·다른 소유자 초안 조회/확정 차단, 합성 gate, 요청 키 namespace 충돌, 비공개 전기·세계 sentinel의 player context/영수증/웹/감사 제외, MCP 9개 유지 |
| 실제 브라우저 | 미시작→준비 중→완료, 준비 중 캐릭터 숨김, 공개 탄생·운명·초기 성장·직업 표시. 입력 script 문자열의 HTML escape와 실행 차단, pageerror 0, **390 CSS px 실측**에서 가로 넘침 없음 |

자동 테스트 합계 **109개 통과**. 모든 DB는 PGlite 메모리 인스턴스이며 테스트 자격증명·합성 사건·합성 캐릭터·합성 세계만 사용했다. kind=real 테스트도 정식 경로를 확인하기 위한 허구 fixture이며 실제 사용자 데이터가 아니다. `.env.local`, `.env.clerk.local`, 운영 DB URL을 테스트에 사용하지 않았다. 실제 Clerk 로그인은 이번 단계에서 새로 수행하지 않았으며 기존 실제 SDK의 합성 서명 JWT 회귀를 실행했다.

최종 점검에서는 Zod 기본값이 부분 전기 수정의 생략 필드까지 초기화하는 동작을 발견하고 생성 입력과 수정 patch 스키마를 분리했다. 지정하지 않은 서사·GM 설정을 보존하는 assertion과 빈 patch 거부 검증을 추가했다. 성장 규칙과 기존 정의/세계 patch는 변경하지 않았다.

## 미검증 사항과 운영 전 조건

- 실제 Neon branch의 migration·다중 PostgreSQL 세션 MVCC/잠금 경합·timeout·Vercel 인스턴스 간 경쟁·대규모 확정 지연은 미검증이다. PGlite는 같은 인스턴스 트랜잭션을 직렬화하므로 읽기 차단·완성 상태 결과 확인을 실제 다중 연결 검증으로 표현하지 않는다.
- 실제 ChatGPT GM의 새 schema 소비·chunk 구성·도구 자율 선택·장기 서사 품질·발표, 운영 도메인의 Clerk/Cookie 조합은 미검증이다. 서버·브라우저 자동 테스트로 실제 사용자의 초기 생성 성공을 주장하지 않는다.
- 초안 schema는 저장 시 확인하지만 참조·최종 상태·근거 freshness는 finalize에서 검사한다. 잘못 작성된 불변 chunk는 취소 후 새 초안으로 다시 작성한다. 저장 장애는 기존 초안을 그대로 두고 정확한 finalize 재시도로 복구한다.
- 초기 XP 전체에서 사건별 기여 XP를 자동 분해하지 않는다. 탄생 근거에는 GM의 짧은 적용 이유와 정확한 사건 버전을 저장하고 base를 예약한다. 다른 aspect_key의 의미 중복과 공개 자연어에 직접 작성된 비밀은 GM이 판단해야 한다.
- 최신 코드의 게임 맥락·정식 생성에는 001~007 schema가 필요하다. 007은 추가형이고 자체적으로 게임을 생성하지 않는다. 실제 적용은 별도 승인 뒤 격리 Neon 검증·기존 데이터 백업·코드/schema 전환 계획이 필요하다.

운영 Neon 접속·migration, 원격 smoke, Vercel 운영 배포, 실제 사용자 캐릭터/세계 생성, 수다방 프로젝트 지침 변경, 별도 LLM API·AI 스케줄러 도입은 수행하지 않았다. 작업은 로컬 구현·격리 검증·명세 기록에서 종료했다.

## 검증 산출물

Git/Vercel 제외 대상 `.local/phase5/`에 서버 전체·웹 API·OAuth·초기 생성 브라우저 테스트 로그와 빌드 로그, unstarted/preparing/character-birth/character-birth-mobile PNG를 저장했다. 브라우저 전기는 XSS 방어를 확인하기 위한 의도적인 script 문자열을 포함한 합성 fixture다.

구현 계약: [SPEC.md의 Phase 5](../SPEC.md#phase-5-정식-캐릭터세계-초기-생성). 새 migration: [007-game-initialization.sql](../migrations/007-game-initialization.sql). 서버 검증: [initialization.test.js](../test/initialization.test.js). 브라우저 검증: [initialization-browser.test.js](../test/initialization-browser.test.js).
