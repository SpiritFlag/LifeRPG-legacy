# Phase 3C 세계·NPC·GM 장기 기억 검증

2026-10-14 · Asia/Seoul · 로컬 구현 검증

세계 루트와 장소·세력·NPC, 관계, 역사·설정·비밀, 장기 기억, 모험 일지·연대기, 명시적 세계 진행 시점을 구현했다. 기존 apply_gm_update/get_game_context/get_gm_update를 확장하고 MCP 도구는 9개로 유지했다. 계약은 [SPEC.md](../SPEC.md), 전체 방향은 [DESIGN.md](../DESIGN.md)를 따른다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| npm run check | 통과 |
| npm test | 83개 통과: 기존 67개 + 세계 시나리오 16개 |
| npm run test:browser | 실제 Edge OAuth 승인·Origin·303 callback·토큰 교환 1개 통과 |
| 005→006 이관 | 기존 사건·캐릭터·퀘스트·정의·인벤토리·영수증·OAuth 행을 먼저 저장하고 migration 전후 전체 snapshot 비교. 기존 요청 재시도 보존, 자동 세계 생성 없음. 중복 migration 오류 rollback |
| 세계와 NPC | 루트·국가·도시·길드·NPC 2명과 NPC↔NPC/캐릭터/세력 관계를 한 요청에 생성. 자유 kind·성격·배경·상황·부모/위치/소속·영구 ID 조회 |
| 현재 상태와 이력 | 이름·상태·관계 수정, 관계 종료와 이유·이전 내용 유지. 세계 이력 UPDATE/DELETE 차단 |
| 참조와 계층 | 잘못된/다른 게임 ID·유형·부모·위치·소속, 자기 관계·NPC 없는 관계, 중복 루트 거부. 부모/위치/소속의 개별 순환 차단; 다른 계층 간 정상 교차 허용 |
| 역사와 진실 | 세계 시각과 실제 기록 시각 분리, history 정정 전후·이유, canon/claim/belief·NPC speaker 검증, 주장→확정 설정 전환 |
| 비공개 경계 | 숨겨진 NPC/사실/기억/일지, 관계 endpoint, source links, gm_notes·중첩 gm_state, 이유를 player context/검색/이력/연대기/영수증에서 제외. GM 원문 보존 |
| 공개/비공개 전환 | 이전 비공개 snapshot은 before=null, 새 공개 본문과 공개 시각만 발표. 다시 비공개로 전환한 새 비밀·이유는 공개 결과에 포함되지 않음 |
| 장기 기억 | 원본 사건 UUID/revision·세계 사실·NPC 링크, 본문/링크 갱신·비활성화·과거 내용 유지, 활성/비활성/focus 조회. 원본 사건과 근거는 그대로 유지 |
| 일지와 연대기 | 독립 다이빙 UUID 3개·퀘스트 2개·새 장소/NPC/세계 사건과 같은 요청 일지 연결. 사건/퀘스트/세계 사실별 기억·일지 필터. 현실/기록/세계 시각 정렬과 keyset pagination, 중복 없음·날짜 helper 표시·미상 timestamp null |
| 세계 진행 | 명시적 advance_world만 서버 진행 시각 기록. 현재 서버 시각·실제 경과 ms 조회. 읽기·시간 경과·재시도에 자동 XP·NPC 행동·시계 변경 없음. 미상 세계 시각 null |
| 전체 게임 통합 | XP·기본 스탯·퀘스트·아이템·장소·NPC·역사·기억·일지 동시 저장, revision 1회 증가, GM/공개 실제 영수증 확인 |
| 중복·버전 | 동일 요청 재생, 다른 요청의 같은 생성 키는 기존 UUID 재사용/무변경, 다른 입력은 충돌. 같은 revision 경쟁 1회 committed·1회 revision_conflict |
| 전체 rollback | 후반 참조 오류와 엔터티/관계/사실/기억/일지/source link/이력/시계/캐릭터/영수증/감사 저장 실패에 성장·퀘스트·아이템·세계·revision 전체 rollback, 동일 입력 재시도 성공 |
| 기존 계약 | 공식 MCP SDK discovery, 기존 67개 회귀, OAuth scope·소유자 보호·감사 허용 필드, 페이지 크기·상태·문자 검색·source 종류/버전 검증 유지 |

검증은 PGlite 메모리 DB와 합성 세계·NPC·캐릭터·사건만 사용했다. 운영 Neon 연결·migration, 원격 smoke, Vercel 배포, 실제 사용자 캐릭터/세계 생성, 수다방 지침 변경은 수행하지 않았다. 웹 UI·인터랙티브 결과창·LLM API·AI 스케줄러·일일 정산은 추가하지 않았다. README와 기존 OAuth 구현을 변경하지 않았다.

## 미검증 사항과 제약

실제 다중 PostgreSQL 연결의 advisory/행 잠금 경합·timeout, Vercel 인스턴스 간 경쟁, 규모가 큰 세계의 실제 Neon 조회 지연은 미검증이다. PGlite는 단일 인스턴스 트랜잭션을 직렬화한다. 운영 반영 전 별도 승인 아래 격리 Neon 환경의 001→006 이관·경합 검증이 필요하다. 실제 ChatGPT의 도구 schema 소비·자율 호출·장기 서사 유지·공개 결과 발표도 로컬 SDK/브라우저 테스트만으로 검증했다고 주장하지 않는다.

GM이 서사의 진위·역사 충돌·공개 시점·NPC 행동을 결정한다. 서버는 참조·시각 입력·상태 저장을 검증하며 자연어 모순이나 다른 생성 키의 의미 중복을 자동 검출하지 않는다. 같은 계정의 GM MCP 원문과 진단 감사 기록은 계정 소유자가 볼 수 있다. player projection은 발표·표현을 위한 스포일러 구분이며 별도 사용자 인증 경계가 아니다. 공개 state/body에는 GM이 공개 가능한 내용만 넣어야 한다.

세계 전체 개수에는 제한이 없다. 요청당 world_changes 40개/모든 변경 합계 100개, HTTP 본문 16 KiB, 원본 links 20개, JSON 4096 bytes/깊이 4와 페이지 기본 20/최대 50개를 제한한다. 여러 요청의 원자성은 없다. 연대기는 현재 사건·세계 event/history·일지의 최초 기록/발생/세계 축으로 정렬하며 과거 수정 과정은 원본 revision·세계 이력·GM 영수증으로 조회한다. 세계 시각을 UTC로 환산하지 않는다.

006 migration은 추가형이며 기존 데이터를 수정하거나 캐릭터·세계를 생성하지 않는다. 최신 코드의 초기화된 게임 맥락 조회에는 006까지 적용된 schema가 필요하다. 운영 migration·배포는 이번 작업 범위 밖이다.
