# LifeRPG v2 — 3단계 OpenAI GM 연결

2026-10-15 · 구현 및 무과금 검증. 실제 OpenAI 요청, 운영 DB 변경, 배포는 수행하지 않았다.

이후 사용자가 승인한 첫 합성 실호출은 2회 완료했다. 계측 오류와 예약 정리, 실제 사용량·판정·발견한 품질 문제는 [첫 실행 및 재개 기록](V2-OPENAI-FIRST-RUN.md)을 따른다. 아래의 무과금 검증 수치는 구현 완료 시점 기록이다.

## 모델과 연결

공식 API 모델 ID는 `gpt-6.1-sol`. Responses API와 Structured Outputs를 지원한다. reasoning은 `low`, `medium`, `high`, `xhigh`, `max`를 지원한다. **사용자 결정에 따라 기본값은 `medium`**이다. 모델 접근과 두 합성 사례의 지연·판정은 이후 [첫 실행 기록](V2-OPENAI-FIRST-RUN.md)에서 확인했다. 확장된 4단계 RPG 계약의 실모델 품질은 아직 검증하지 않았다. [공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

Node 24 내장 `fetch`로 `https://api.openai.com/v1/responses`에 요청한다. 새 SDK/에이전트 프레임워크는 추가하지 않았다. 전송 계층을 주입할 수 있어 테스트는 합성 응답 또는 loopback 가짜 HTTP 서버만 사용한다. 실제 전송은 `createLiveOpenAiGm` 경계에만 있다. HTTP redirect를 허용하지 않고 오류 응답 원문·키·프롬프트를 로그에 남기지 않는다.

요청은 `text.format.type=json_schema`, `strict=true`, 모든 속성이 required인 닫힌 schema를 사용한다. 선택 질문은 wire에서 null로 표현하고 내부 계약에 맞게 변환한다. API의 형식 검증에 더해 기존 Zod 판정 규칙과 서버 무결성 검증을 다시 거친다. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

3단계 최초 판정 범위는 commit / clarify / no_change, summary, XP 증감, 질문, 다섯 종류의 기억이었다. 이후 4단계에서 구조화된 RPG operations·reward_source·공개 scene을 추가했다. 최신 계약과 문맥 크기 제약은 [V2-RPG.md](V2-RPG.md)를 따른다. 서버가 실제 읽은 memory/input/event/RPG의 출처를 전파하며 모델이 출처 목록을 결정하지 않는다. `target_event_id`를 별도로 전달해 참고 문맥의 사건과 실제 판정 대상을 구분한다.

`store:false`, `stream:false`, `service_tier:default`, `truncation:disabled`를 설정한다. 도구 실행, previous_response_id, provider 대화 세션에 의존하지 않는다. 매 호출 DB에서 정체성·기억·현재 게임·사건·이전 판정을 읽어 전송한다. 입력 JSON과 기억은 지시가 아닌 데이터로 취급하도록 서버 헌장을 분리했다.

## 서버 상태와 실패 처리

- 기존 request_id 중복 방지, 영속 job, lease/heartbeat/fencing, revision/privacy_epoch, 출처 버전 검사와 원자적 게임 commit을 재사용한다.
- **사용량 정산은 게임 commit보다 먼저 별도 트랜잭션으로 저장한다.** 판정 저장이 실패하거나 삭제로 응답이 폐기되어도 이미 확인한 비용이 사라지지 않는다. 같은 attempt의 정산 재실행은 중복 집계하지 않는다.
- 거절, 불완전 응답, 사용량/단가 확인 불가는 게임에 적용하지 않고 자동 재시도하지 않는다. schema/도메인 형식 오류, 네트워크 장애, 429/5xx는 기존 최대 3회 시도 제한을 따른다. SDK 자체 재시도는 없다.
- HTTP 오류/응답 유실/timeout으로 사용량을 확인하지 못하면 예약액을 계속 점유한다. provider 오류 메시지나 거절 본문은 DB에 저장하지 않는다. timeout 뒤 provider가 실제로 처리를 끝냈는지는 확정할 수 없다.
- 모델명·tier가 설정 단가표와 일치하지 않으면 계산을 추측하지 않는다. 토큰은 보존하되 비용은 미확정 예약 상태로 남기고 판정을 멈춘다. 다른 model/tier의 요금을 적용하려면 검증된 설정이 필요하다.
- 삭제는 기존 서버 purge/출처 전파/manifest 규칙대로 즉시 처리한다. 비용 메타데이터에는 현실 원문이나 생성 텍스트를 넣지 않는다.

`store:false`는 provider의 모든 보존을 제거한다는 뜻이 아니다. API abuse monitoring과 prompt cache 등 provider 보존은 서버 live purge와 별개다. 실제 개인정보 사용 전 계정 보존 정책을 확인해야 한다. 이번 테스트 자료는 모두 합성이다. [데이터 보존 정책](https://developers.openai.com/api/docs/guides/your-data)

## 실제 사용량과 예산

새 migration `migrations/v2/002-openai-accounting.sql`은 attempts에 provider, usage_details, price_card, settled_at을 추가하고 전역 `gm_budget`을 만든다. 기본 전역 한도는 0이다. 기존 001 migration은 수정하지 않았다. 이번 실행에서는 새 합성 테스트 DB에만 적용했다.

`attempts`에 실제 응답의 input/output/total/cached/cache-write/reasoning 토큰과 요청 모델, 단가표 버전, 예약·정산 금액을 저장한다. reasoning 토큰은 output_tokens에 포함되어 따로 더하지 않는다. `read_liferpg(view:usage)`는 소유자별·모델/단가표별 합계와 미확정 예약을 보여준다. 모델 응답의 토큰은 실제 보고 수치이고, **금액은 토큰 × 단가표로 계산한 추정 USD**다. provider 청구서 대조는 아직 구현하지 않았다.

2026-10-15 확인한 standard 단가(1M 토큰): input $2, cached input $0.10, cache write $2.50, output $10. 입력 토큰에서 cached와 cache-write를 각각 빼고 세 종류를 별도 계산한다. [모델 가격](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [캐시 사용량 계산](https://developers.openai.com/api/docs/guides/prompt-caching)

내부 금액은 정수 micro-USD(1 USD = 1,000,000)이다. 단가표는 0.1 micro-USD/token 정수 단위이며 최종 요청 비용을 micro-USD 단위로 올림한다. 반환 token이 잘못되었으면 정산하지 않는다.

예산 방어는 다음을 함께 적용한다.

1. 요청 직렬화 UTF-8 바이트 수 + 4,096 framing 여유를 입력 토큰 상한과 비교한다. tokenizer 실측값이 아닌 보수적 로컬 상한 추정이며, 초과 시 전송 전에 중단한다. schema/헌장도 포함하고 근거를 임의로 자르지 않는다. 기본 16,384, 설정 최대 64,000이다.
2. API `max_output_tokens` 기본 2,048(추론 포함), 설정 최대 16,000. 기본 호출 예약은 가장 비싼 입력 단가 기준 **61,440 micro-USD = $0.06144**이다.
3. 기존 소유자 lifetime 한도 + 서버 전체 lifetime/UTC 일/UTC 월 한도를 모두 검사한다. 전역 budget 행 잠금 아래에서 예약해 여러 owner/worker가 한도를 공유한다. 네트워크 대기 중에는 DB 잠금을 잡지 않는다.
4. 정산은 받은 시점의 UTC 기간에 반영하고 미확정/진행 중 예약은 기간을 넘어도 계속 차감한다. 설정 변경과 재시작은 이미 쓴 금액을 초기화하지 않는다.
5. 예산 부족 작업은 `blocked_budget`으로 멈춘다. operator가 한도/UTC 기간을 확인하고 `resumeBudgetJobs` 또는 합성 runner 재실행으로 재개한다. GM/MCP는 한도를 바꿀 수 없다.

한도는 이 DB/서비스의 기록에 적용된다. 동일 키를 쓰는 외부 앱, provider 가격 변경/추가 요금, 이미 전송된 요청의 취소·환불을 통제하지 않는다. 가격이 다른 모델/지역 요금은 검증한 별도 price card가 필요하다. 비용 ledger까지 오래된 백업으로 되돌린 경우에는 provider 사용량과 대조하기 전 유료 worker를 재개하면 안 된다.

## 키와 설정

저장소 루트 `.env.openai.example`을 **`.env.openai.local`로 복사해 사용자 직접 편집**한다. 이 파일은 gitignore 대상이다. 키는 `OPENAI_API_KEY`에 넣거나 서버 프로세스의 비밀 환경변수로 주입한다. 코드는 값을 출력하지 않는다. 기존 `.env.local`/운영 DB 설정은 필요 없다.

| 변수 | 기본/의미 |
| --- | --- |
| `OPENAI_API_KEY` | 사용자 직접 설정. dry-run에는 불필요 |
| `GM_MODEL` | `gpt-6.1-sol` |
| `GM_REASONING_EFFORT` | **`medium`** |
| `GM_MAX_INPUT_TOKENS` | 16384, 로컬 보수적 입력 상한 |
| `GM_MAX_OUTPUT_TOKENS` | 2048, reasoning 포함 |
| `GM_LIFETIME_BUDGET_MICRO_USD` | 합성 runner 기본 150000 = $0.15 |
| `GM_DAILY_BUDGET_MICRO_USD` | UTC 일 한도, 기본 $0.15 |
| `GM_MONTHLY_BUDGET_MICRO_USD` | UTC 월 한도, 기본 $0.15 |
| `GM_PRICE_CARD_JSON` | 모델 변경 시 필수. .env 예제에 정수 단위 형식 제공 |
| `LIFERPG_ALLOW_PAID_SYNTHETIC` | 기본 빈 값. 별도 유료 승인 뒤에만 아래 절차로 일시 설정 |

다른 모델도 Responses API, 해당 Structured Outputs schema, 선택한 reasoning effort를 지원해야 한다. 모델 교체는 설정으로 가능하지만 능력·가격·실제 응답 모델 ID를 검증하지 않은 모델을 자동 fallback으로 호출하지 않는다.

## 첫 유료 합성 테스트

먼저 비용 예상만 확인한다. **아래 명령은 DB를 열거나 API를 호출하지 않는다.**

```powershell
npm run gm:synthetic
```

OpenAI 프로젝트 결제/모델 접근 권한을 확인하고 키를 위 로컬 파일 또는 서버 환경에 직접 설정한다. 프로젝트의 예산 알림·사용량 화면도 사용자가 관리한다. 키를 채팅으로 전달할 필요는 없다.

**별도 승인 후에만** 다음을 실행한다. 이번 구현 작업에서는 실행하지 않았다.

```powershell
$env:LIFERPG_ALLOW_PAID_SYNTHETIC = 'I_APPROVE_PAID_SYNTHETIC'
try {
  npm run gm:synthetic -- --execute
} finally {
  Remove-Item Env:LIFERPG_ALLOW_PAID_SYNTHETIC -ErrorAction SilentlyContinue
}
```

고정된 합성 탄생 1건 + 합성 산책 1건을 처리한다. 사례당 한 번만 dispatch하므로 **한 실행 최대 2회**, 기본 최대 예약 합계 **$0.12288**, DB에 누적되는 lifetime/일/월 한도는 **$0.15**다. 캐시 없는 2,000 input + 500 output이라면 1회 $0.009, 입력 전부 cache-write라면 $0.010 예시다. 실제 reasoning 길이와 캐시 결과에 따라 달라지므로 평균 비용 예측으로 보장하지 않는다. `medium`에서 2,048 출력 제한으로 incomplete가 나오면 결과를 확인하고 한도/출력 토큰을 함께 조정한 뒤 별도 승인 범위에서 재평가한다.

결과는 operation 영수증, 공개 판정, 모델별 토큰·정산 비용·미확정 예약, 서버 예산 사용량으로 출력한다. `committed`/`no_change`가 아니면 즉시 중단하며 종료코드 1이다. 일반 worker의 유료 자동 재시도 루프를 돌리지 않는다.

데이터는 `.local/v2-openai-synthetic`, 삭제 journal은 `.local/v2-openai-synthetic-deletions.json`에 보존한다. 기존 mock·운영 데이터와 섞지 않는다. 동일 사례의 request_id를 재사용하므로 성공 후 명령을 다시 실행해도 재판정하지 않는다. 실패 사례를 새 ID로 억지 반복하거나 비용 ledger를 삭제해 예산을 초기화하지 않는다. 실패 원인 수정 후 operator 절차로 재시도 여부를 결정한다.

`npm run dev:v2`는 기존 mock 모드를 유지한다. 아직 유료 GM을 켠 공개 서버 entry나 배포를 제공하지 않는다. 향후 운영 host에서는 002 적용 후 `createV2App(..., 'openai')`와 실제 adapter를 주입한 `GmWorker`를 같은 scoped DB에 연결하고 보존 정책·공유 예산을 설정해야 한다.

## 검증과 다음 단계

최종 결과: 전체 `npm test` **135/135**, v2 전체 **29/29**(OpenAI 전용 14개 포함), 격리된 PostgreSQL **6/6**, `npm run build`와 `git diff --check` 통과. `npm run gm:synthetic`의 무과금 dry-run에서 medium·예약액·예산 설정을 확인했다. 실제 OpenAI 호출은 **0회**다.

- OpenAI 전용 테스트: 설정/무승인 차단, 가짜 HTTP 계약, 캐시·추론 과금, 거절/incomplete/schema 오류, context 상한, 중복 판정, 전역 예산과 UTC 기간, timeout/불명 비용, 삭제와 늦은 응답, 파생 기억 purge, MCP 접수→worker→조회, 판정 DB rollback과 비용 정산 분리.
- 기존 1~2단계 영속성·복원·인증·게임 규칙 회귀 테스트를 유지한다.
- 별도 로컬 PostgreSQL 두 연결에서 다른 owner의 OpenAI 예산 동시 예약을 검증한다. 모든 GM 응답은 합성이다.
- `npm run test:v2:openai`, `npm run test:v2`, `npm test`, `npm run test:v2:postgres`, `npm run build`로 검증한다. PostgreSQL 테스트는 이전 단계의 `.local/pg-runtime` 격리 바이너리를 사용하며 운영 접속정보를 읽지 않는다.
- 남은 검증: 승인한 첫 소액 실호출, 계정 모델 접근/응답 호환성, medium 지연·출력 토큰 조정, 합성 판정 품질. 이어서 4단계 완전한 RPG 상태·규칙, 5단계 기억 검색/압축, 6단계 운영 전환을 진행한다.
