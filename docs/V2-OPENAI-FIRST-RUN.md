# 첫 유료 합성 테스트 승인 후 실행 기록

2026-10-15 11:16 KST. 사용자는 합성 탄생 1건과 산책 1건, `gpt-6.1-sol`, reasoning `medium`, 총 예약 한도 $0.15를 승인했다. 실패 후 임의 추가 시도와 예산 초기화는 금지했다.

## 결과

**첫 탄생 사례가 로컬 계측 검사 오류로 API 전송 전에 중단되었다. 실제 OpenAI 요청은 0회이며 산책은 접수하지 않았다.** 모델이나 API의 오류로 확인된 것이 아니다.

무과금 `npm run gm:synthetic`은 통과했다. 설정은 모델 `gpt-6.1-sol`, reasoning `medium`, 입력 상한 16,384, 출력 상한 2,048, 호출당 예약 $0.06144, 두 건 최대 예약 $0.12288였다. 누적/일/월 한도는 각각 $0.15였으며 키 존재 여부만 확인했다. 실행 전 유료 합성 DB와 삭제 journal은 없었다.

Codex가 호출별 지연 측정을 위해 이번 명령에만 추가한 임시 wrapper에서 `context.input.request_id`를 검사했다. 서버는 `service.ts`에서 request_id를 제외한 input을 저장하므로 실제 문맥에는 `kind`, `message`만 있었다. 해당 assertion이 원래 `OpenAiGm.generate` 호출보다 먼저 실패했다. 이 임시 wrapper는 저장소 코드에 반영하지 않았다. `synthetic-openai.ts` 자체의 사전 점검이나 provider 오류가 아니다.

| 항목 | 확인 결과 |
| --- | --- |
| 로컬 worker attempt | 탄생 1회 |
| 실제 OpenAI 요청 | 0회, adapter 실행 전 중단 |
| 실제 API 토큰 응답 | 없음; DB token 필드는 null |
| 이번 실행의 API 비용 | $0, 요청을 보내지 않음 |
| DB 정산 금액 | $0 |
| 보존한 미확정 예약 | 61,440 micro-USD = $0.06144 |
| 남은 예약 여유 | 88,560 micro-USD = $0.08856 |
| API 지연 | 측정 불가, 요청 없음 |
| 실행 명령 전체 시간 | 약 5.86초, 로컬 초기화/작업 처리 포함 |
| 탄생 결과 | `retryable_error`, `gm_failed` |
| 산책 | 미접수·미실행 |
| 확정 판정 | 0건 |

작업 ID는 `4a1c297c-228e-4a99-aa3f-0d5d28702954`이며, DB attempt의 상태는 `unknown`, job은 `queued`, attempts=1이다. 프로세스는 종료되었으며 유료 worker를 계속 실행하지 않았다. usage 집계의 token 0은 null을 0으로 합산한 표시이고, API가 반환한 0-token 응답을 의미하지 않는다.

## 중단 후 조치

- 추가 API 호출, 탄생 재시도, 산책 실행을 하지 않았다.
- 합성 DB를 읽어 input 필드, attempt, 예산, 판정 수를 확인했다. 예산이나 미확정 예약은 수정하지 않았다.
- 키 값·provider 응답 원문을 출력하거나 기록하지 않았다.
- 운영 DB 변경과 배포는 하지 않았다. 로컬 합성 DB와 journal은 보존했다.
- 추후 재실행은 별도 사용자 결정이 필요하다. 문서의 runner를 사용하고, 계측 식별자는 외부 사례 ID 또는 `operation_id`를 사용해야 한다. 입력 payload에 request_id가 있다고 가정하면 안 된다.

따라서 이번 실행으로 모델 접근 권한, 실제 Structured Outputs 응답, 판정 품질이나 API 지연을 검증했다고 볼 수 없다.
