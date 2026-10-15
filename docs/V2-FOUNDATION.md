# LifeRPG v2 — 1~2단계 구현 명세와 검증

2026-10-15 · 승인된 [v2 설계](DESIGN-V2.md)의 기반·통신·영속 작업·삭제 가능한 기억 구현.

**이 문서는 1~2단계 완료 당시의 mock 기반 명세다.** 이후 구현한 OpenAI adapter·예산·합성 테스트 절차는 [3단계 명세](V2-OPENAI.md)를 따른다. `dev:v2` 실행은 계속 mock이며 운영 DB·배포는 변경하지 않았다. 기존 Vercel entry와 개인 웹은 v1을 유지한다. v2는 별도 로컬 entry와 `liferpg_v2` 스키마를 사용한다.

## 1. 구현 범위

| 영역 | 실제 구현 |
| --- | --- |
| 최소 MCP | 5개 도구. 입력 파싱·권한 검사·서버 서비스 호출·결과 반환만 담당. 게임 로직은 `service.ts`/`worker.ts`에 있음 |
| 인증 | 기존 PKCE·소유자 인증·scope 검증 재사용. v2 grant 저장소 분리, game.play/life.delete 등 별도 권한. 승인 화면에 실제 요청 권한 표시 |
| 접수 | 동일 소유자·request_id 재시도는 같은 operation. 다른 내용은 충돌. 접수·현실 보고·job을 함께 저장 |
| 영속 작업 | DB queue, 게임별 단일 running job, lease·heartbeat·fencing, 만료 작업 회수, 최대 3회 시도 |
| 확정 | API/GM 실행 중 DB 잠금을 유지하지 않음. 결과 검증 후 게임 revision·privacy epoch·근거 버전·lease를 재확인해 원자적 반영 |
| 합성 판정 | mock 시작·질문·답변·판정·이의 제기·세계 행동. 합성 사건 XP 5는 테스트용으로만 사용 |
| 비용 기반 | 최대 비용 예약·실사용 정산·불명 비용 보수 유지·operator 예산 변경/재개. 실제 과금이 아닌 합성 단위 |
| 기억 | identity/episode/reflection/summary/world. 내용과 식별자를 분리하고 생성에 사용한 모든 현실 출처를 전파 |
| 정정 | version 비교 후 사실 즉시 수정. 기존 원문·파생 텍스트 폐기, 진행 작업/질문 무효화, 게임 효과 재해석 필요 표시 |
| 삭제 | 사실·이력·파생 기억·정체성·결과·질문·원문 해시 정리. 늦은 worker 저장 차단. 게임 수치는 보존하고 재해석 대기로 표시 |
| 복원 | 내용 없는 삭제 manifest를 별도 파일에 저장. 과거 DB 복원 후 API/worker 시작 전에 삭제 목록 재적용 |
| 로컬 실행 | loopback HTTP + PGlite 디스크 저장 + worker. 프로세스 종료/재시작 후 처리 상태 유지 |

새 핵심 파일은 `src/v2/{contracts,service,storage,worker,mock-gm,memory,privacy,admin,tools,app,local}.ts`, schema는 `migrations/v2/001-foundation.sql`이다. Node 24의 TypeScript 실행과 `tsc --noEmit`을 함께 사용한다. 기존 저장소의 JS를 일괄 변환하지 않았다.

## 2. MCP 계약

`submit_observation`의 일반 입력은 여전히 **request_id와 summary 두 필드**다.

```json
{"request_id":"synthetic-walk-001","summary":"[합성 테스트] 30분 산책을 마쳤다."}
```

| 도구 | 입력 | 실제 결과 |
| --- | --- | --- |
| `submit_observation` | 필수 `request_id`, `summary`. 선택 `occurred_on`, `timezone`, `unknowns`, `event_id`, `confirmed_new_report` | 사건 ID와 operation ID, queued 또는 동일 사실 no_change |
| `interact_with_gm` | `request_id`, `kind`, `message`. answer는 question_id, appeal은 decision_id | start/answer/appeal/action을 DB job으로 접수 |
| `read_liferpg` | `view: status/request/records/game/usage`. request는 operation_id, records는 선택 query/cursor/limit | 저장된 상태만 조회. 읽기로 게임이나 job을 만들지 않음 |
| `revise_real_record` | request_id, event_id, expected_version, summary. 선택 날짜·시간대·unknowns | 수정한 event_version과 reinterpretation=pending |
| `delete_real_record` | request_id, event_ids 최대 20개 | live_purged, backup_status, 정리한 payload 수 |

`request_id`는 1~80자의 영문·숫자·점·밑줄·하이픈 식별자다. 요청 키 원문은 저장하지 않고 digest를 사용한다. summary 최대 1,000자, message 최대 2,000자, unknowns 최대 5개, 알 수 없는 필드는 거부한다. 같은 키의 동일 입력은 재생하고, 일반 요청에서 내용이 다르면 idempotency_conflict다. 삭제·무효화된 과거 요청은 내용을 복원하지 않고 해당 상태만 반환한다.

날짜가 없으면 null이며 수신 시각으로 채우지 않는다. default timezone은 Asia/Seoul이다. 정확히 같은 날짜·시간대·사실·unknowns는 같은 사건으로 처리한다. **문장 의미 기반 중복 판단은 아직 없다.** `event_id`로 다른 사실을 보내면 정정 도구 사용을 요구한다. 이 단계에는 암묵적 사실 보강이나 GM의 현실 원문 덮어쓰기를 넣지 않았다.

MCP에는 XP·memory·SQL·budget·게임 변경 목록 입력이 없다. 모든 쓰기는 destructive=true, 재시도 키 계약은 idempotent=true다. **현재는 외부 모델 호출이 없으므로 openWorld=false**이며 설명에도 mock임을 표시한다. 실제 OpenAI 연결 단계에서 설명·annotation·권한 범위를 함께 변경해야 한다.

권한은 observation에 `life.write + game.play`, 상호작용에 game.play, 정정에 life.write, 삭제에 life.delete가 필요하다. 읽기는 view별 life.read/game.read/usage.read를 검사한다. 현실 보고·정정·삭제 요청 결과 조회에는 game.read와 life.read가 필요하다. 기존 v1 토큰·v1 도구로 v2 game.play 권한을 얻을 수 없다.

## 3. 요청·worker 동작

접수 응답 예시는 아래와 같다. **queued는 보상 완료가 아니다.**

```json
{"operation_id":"<UUID>","status":"queued","event_ids":["<UUID>"],"retry_after_ms":1000}
```

서버 worker가 처리한 뒤 request 조회에는 committed/no_change/needs_input 등이 나온다. 확정 결과에는 decision_id, game_revision, player_result가 포함된다. 수치 changes는 서버가 실제 적용값에서 만든다. 다른 사용자의 operation ID는 조회할 수 없다.

- worker는 game 행을 먼저 잠그고 다른 worker가 잠근 게임은 SKIP LOCKED로 건너뛴다. 게임별 running job unique index가 추가로 보호한다.
- 기본 lease는 30초, mock 실행 timeout은 15초, heartbeat는 lease의 1/3 간격이다. 실패·출력 오류·경합 재판정을 합쳐 작업당 3회로 제한한다.
- worker가 사라지면 lease 만료 후 다른 worker가 fencing 값을 바꾸고 회수한다. 오래된 worker는 결과를 적용할 수 없다.
- 게임 revision 또는 privacy_epoch가 바뀐 출력은 그대로 commit하지 않는다. 삭제로 취소된 작업은 재시도해 되살리지 않는다.
- 질문 대기 중에는 게임 실행권을 반납한다. 질문 답변의 중복·만료와 판정 head가 바뀐 이의 제기를 거부한다.
- 판정의 **대상 사건**과 문맥에서 참고한 **개인정보 출처 집합**을 별도로 관리한다. 다른 기억을 참고했다고 그 기억의 사건에 보상하지 않는다.
- 새 observation이 게임 시작 전에 들어오면 기록은 보존하고 start_required 상태로 대기한다. start가 확정되면 재개한다.
- DB commit은 판정·수치·기억·응답·job 완료를 함께 처리한다. 중간 쓰기 실패는 전체 rollback한다. 외부 호출까지 exactly-once라고 주장하지 않는다.

현재 문맥은 최신 기억 최대 20개(정체성 우선)와 관련 현실 출처다. 최대 50개 출처, JSON 문자 기준 48,000자 한도를 초과하면 context_limit으로 실패하고 mock도 호출하지 않는다. 이는 기반 단계의 메모리/본문 상한이며, 모델별 token 계산·관련성 검색·자동 압축은 3~5단계에서 구현한다.

## 4. 삭제 가능한 기억과 복원

`payloads`가 실제 내용을 보관하고 `payload_sources`가 현실 event 출처를 보관한다. 사건 버전·요청·판정·기억·질문은 payload를 참조한다. 여러 번 요약하거나 identity로 발전시켜도 실제 입력 출처를 계속 상속한다. 모델이 스스로 보고한 출처 목록을 신뢰해 삭제 범위를 좁히지 않는다.

정정/삭제 트랜잭션은 게임의 privacy_epoch를 올리고 파생 payload를 지운다. 해당 payload를 사용한 job을 취소하고 fencing 값을 바꾼다. 원문 입력 hash도 null로 만든다. 조회 시 결과 JSON을 옛 캐시에서 다시 꺼내지 않고 현재 payload 존재 여부를 확인한다.

삭제 뒤에는 자동 현실 수집을 멈춘다. 과거 대화에서 지운 내용을 자동으로 다시 가져오는 것을 막기 위한 상태다. **사용자가 새로 기록하겠다고 명시한 보고**에는 confirmed_new_report=true를 보낼 수 있다. 서버가 모든 다른 표현의 동일 사건을 알아낼 수 있다는 보장은 하지 않는다. 이 필드는 별도의 사용자 확인을 나타내며 임의 자동 재수집에 사용하면 안 된다.

게임 XP처럼 비내용 수치는 유지하고 관련 decision에 needs_reinterpretation을 표시한다. **실제 GM의 보상 조정·허구 치환은 이번 단계에 없다.** 삭제가 GM 호출·예산·game.play 권한에 종속되지는 않는다.

로컬 실행기는 DB 디렉터리 `.local/v2-mock`과 별개로 `.local/v2-deletions.json`을 보관한다. 내용은 owner ID와 삭제 event UUID 목록뿐이다. 삭제 응답은 파일 기록까지 기다린다. DB 삭제는 성공했지만 파일 기록이 실패하면 storage_error를 반환하며 동일 request_id 재시도로 파일 기록을 복구한다. 재시작 때 DB의 삭제 내역도 합쳐, 응답 직전 중단된 삭제를 보존한다.

기존 DB가 있는데 삭제 파일이 없거나 잘못됐으면 API와 worker를 시작하지 않는다. 복원 시 최신 삭제 파일을 먼저 적용하고, 삭제된 사건을 포함한 오래된 payload와 진행 job을 정리한 뒤 serving한다. 삭제 파일 자체를 오래된 DB 백업으로 덮어쓰면 안 된다. 이 보호는 로컬 단일 실행기용이며 운영 다중 인스턴스에는 별도 내구 저장소와 복구 절차가 필요하다.

**live_purged는 디스크 잔여 페이지·WAL·백업의 완전 삭제를 뜻하지 않는다.** backup_status는 현재 not_verified다. 공급자별 보존·키 폐기·백업 만료 검증은 운영 전 남은 과제다. 모든 복구 경로가 최신 삭제 목록을 적용한다는 운영 보장 없이 운영 삭제 완료를 주장할 수 없다.

## 5. 로컬 실행과 테스트

Node.js 24와 기존 의존성이 필요하다. 로컬 mock 실행은 다음 순서다.

1. `.env.v2.example`을 `.env.v2.local`로 복사한다.
2. 서로 다른 임의 OAuth client secret와 owner key(각 32자 이상)를 설정한다. 예시 placeholder를 실제 연결 비밀로 쓰지 않는다.
3. `npm run dev:v2`를 실행한다. 기본 주소는 `http://127.0.0.1:3020/mcp`다.
4. 로컬 MCP 클라이언트에서 OAuth 연결 후 start를 요청하고 합성 observation을 보낸다. request 조회로 worker 결과를 확인한다.

이 실행기는 `.env.local`을 로드하지 않으며 DATABASE_URL과 OPENAI_API_KEY를 사용하지 않는다. loopback에만 바인딩한다. **실제 일상 자료를 넣는 운영 서비스가 아니다.** ChatGPT 클라우드가 로컬 loopback에 직접 연결할 수 있다고 가정하지 않으며 이번 검증은 공식 MCP SDK 클라이언트로 수행했다.

```powershell
npm run check
npm run test:v2
npm test
npm run build
```

실제 PostgreSQL 동시성 테스트는 별도 로컬 테스트 의존성을 설치한 뒤 실행한다. 이는 루트 의존성이나 운영 DB를 바꾸지 않는다.

```powershell
npm install --prefix .local/pg-runtime --no-audit --no-fund embedded-postgres@18.4.0-beta.17
npm run test:v2:postgres
```

테스트는 임의 비밀번호·loopback 임시 포트로 독립 PostgreSQL cluster를 만들고 합성 DB에 migration을 적용한다. 테스트 종료 시 서버를 중지하고 해당 임시 데이터 디렉터리를 제거한다. 운영 연결 문자열이나 환경파일을 읽지 않는다. 사용한 오픈소스는 [embedded-postgres](https://github.com/leinelissen/embedded-postgres) 패키지 계열이며 해당 패키지의 라이선스 파일을 로컬 설치물에 유지한다.

### 검증 결과

- TypeScript 검사와 `npm run build` 통과.
- v2 합성 테스트 **15/15 통과**: 공식 SDK, 권한·계약, 중복/충돌, worker 회수, 수정/삭제 경합, 파생 기억·정체성 제거, 질문·이의 제기, 비용 예약, rollback, 디스크 재개, 과거 snapshot 복원 차단, 별도 삭제 파일, 실제 HTTP 실행·재시작.
- 실제 PostgreSQL **18.4**, **5/5 통과**(상위 테스트 1개 + 시나리오 4개): 20개 동시 접수, worker 선점/회수, 삭제/commit 경합, 소유권 FK.
- 기본 `npm test` **121/121 통과**(기존 서버 106 + v2 15). v2 테스트를 기본 테스트 명령에 포함했다.
- PostgreSQL 검증 환경은 Windows x64다. 테스트용 binary dependency는 `.local/pg-runtime`에만 설치했고 루트 패키지 의존성은 추가하지 않았다.
- 운영 Neon, OpenAI 유료 호출, 실제 ChatGPT 연결, 배포는 실행하지 않음.

## 6. 다음 단계에 남은 것

1. **OpenAI adapter와 실제 모델 평가:** Responses API, structured proposal, refusal/불완전 응답, 실제 usage·모델 가격, 모델별 token 한도, 승인된 합성 소액 평가.
2. **전체 게임 엔진:** 직업·능력치·아이템·퀘스트·NPC·세계 사건, 본격 초기 생성, 사용자 정정·삭제 후 게임 재해석. 현재 XP 5와 단순 문구는 테스트용이다.
3. **기억의 품질:** 관련성 검색·요약/성찰 scheduling·성격 성장 평가·모델 교체 비교. 저장과 삭제 경계가 준비됐다는 것과 자율 성장 품질은 다르다.
4. **운영 실행기와 보호:** PostgreSQL API/worker 운영 호스트 선택, 배포·비밀 설정, 다중 인스턴스 삭제 journal, 데이터 보존·복구 검증, 사용자 식별 매핑. 현재 인증은 기존 단일 소유자 모델이다.
5. **표현:** v2 개인 웹 연결, 결과 카드/선택지, 비용·삭제 상태 화면, 실제 ChatGPT 연동 검증.

설계의 일부 세부사항은 이번 구현 범위에 맞춰 명시적으로 제한했다. MCP 쓰기는 현재 비동기 queued 응답이며 빠른 완료 대기 최적화는 없다. 비용 한도는 mock 기간 전체의 합성 단위이고 일/월 주기나 실제 금액이 아니다. 정정은 즉시 적용하고 재해석 필요 상태를 남기지만 실제 재해석 작업은 아직 실행하지 않는다. snapshot의 최신 삭제 목록 적용은 검증했으나 운영 제공자의 물리 데이터 삭제는 검증하지 않았다.

## 7. 사용자가 다음 단계에서 준비할 OpenAI API 항목

지금 mock 실행에는 OpenAI 설정이 필요 없다. 실제 연결 단계에서 준비할 것은 아래다.

| 항목 | 사용자 설정 / 합의 |
| --- | --- |
| 전용 프로젝트 | LifeRPG 개발·합성 평가용 OpenAI API 프로젝트. 운영 프로젝트와 분리 권장 |
| API 키 | 해당 프로젝트의 모델 호출 권한 키. 다음 단계 서버 secret `OPENAI_API_KEY`에 주입; 채팅·소스·웹 클라이언트에는 넣지 않음 |
| 결제 | API 결제 활성화 또는 사용 가능한 크레딧, 계정의 호출 가능 한도 확인 |
| 평가 모델 | 사용할 정확한 model ID와 계정 접근 가능 여부. Structured Outputs 지원·가격·속도를 확인하고 한 모델부터 시작 |
| 한도 | 첫 합성 평가의 총액, 일/월 최대 금액, 호출 timeout·입출력 상한. 지출 알림과 hard spend limit을 구분 |
| 데이터 보존 | store=false 기본 정책, 공급자 보존·승인된 데이터 제어의 허용 범위 확인 |

API 키는 환경변수 또는 secret 관리에 보관하고, 개발/운영 프로젝트를 구분하는 것이 공식 권장 방식이다. [OpenAI Production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)

지출 알림은 호출을 멈추지 않는다. 월 상한을 강제하려면 해당 조직/프로젝트의 hard spend limit을 사용하며 적용 지연으로 소액 초과가 가능하므로 서비스의 예약 예산도 함께 사용한다. [OpenAI Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)

store=false와 공급자 무보존은 같은 의미가 아니다. [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data)의 실제 계정 조건을 확인한다. 현재 코드에는 모델 선택 환경변수나 실제 OpenAI adapter가 없으므로 설정 이름을 임의로 만들어 넣지 않는다. 다음 단계에서 사용할 모델·예산을 합의한 뒤 연결 설정을 추가한다.
