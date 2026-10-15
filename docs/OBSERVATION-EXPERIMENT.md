# 초경량 MCP 전달 실험

2026-10-15 09:44 KST: 사용자 승인으로 운영 반영 완료. deployment `dpl_5Rnu3AXuMEoSbwVZnEy5jfEVw4cv`에서 두 canonical host의 도구 등록과 health/storage 상태를 확인했다. 실제 `submit_observation` 호출은 사용자가 진행하도록 남겨두었다. 아래 배포 전제와 미실행 설명은 최초 구현 시점의 기록이며, 이번 운영 반영 결과는 [배포 기록](DEPLOYMENT.md)을 따른다.

`submit_observation`은 요약을 서버에 전송하고 기존 `tool_calls`에 수신 영수증을 추가한다. 외부 GM 호출, 현실 사건 등록, XP·캐릭터·퀘스트·세계 변경은 없다. 새 테이블이나 migration이 필요하지 않으며 기존 OAuth `life.write` 권한을 사용한다. 읽기 전용·파괴적 도구가 아니고, 호출마다 새 감사 행을 추가하므로 `idempotentHint:false`다. 설명과 메타데이터는 실제 쓰기 동작을 명시하며 ChatGPT 안전 검사를 우회하지 않는다.

입력은 엄격한 객체로 아래 두 필드만 허용한다. `summary`는 앞뒤 공백 제거 후 1~300자, `test_id`는 1~80자이며 영문·숫자로 시작하고 영문·숫자·점·밑줄·하이픈만 허용한다. 테스트 ID는 대소문자를 구분하며 현재 고정 OAuth 소유자 범위에서 사용한다.

```json
{"summary":"합성 MCP 전달 실험","test_id":"mcp-probe-20261015-001"}
```

최초 성공 응답 예시(시각과 UUID는 실제 수신 값으로 반환):

```json
{
  "outcome":"received",
  "received":true,
  "received_at":"2026-10-15T01:00:00.000Z",
  "test_id":"mcp-probe-20261015-001",
  "duplicate":false,
  "first_call_id":"<최초 호출 UUID>",
  "call_id":"<이번 호출 UUID>"
}
```

동일 ID의 다음 호출은 `outcome:duplicate`, `duplicate:true`, 동일 `first_call_id`와 새 `call_id`를 반환하고 별도 수신 행을 추가한다. 요약이 달라도 같은 ID이면 중복이며 최초 요약을 덮어쓰지 않는다. 동시 요청은 전용 DB 트랜잭션 advisory lock으로 직렬화한다. 판정 기준은 보존된 성공 영수증이며 실패한 호출은 ID를 예약하지 않는다. 성공 응답은 감사 행 커밋 이후 반환한다. DB 오류는 `isError:true/outcome:storage_error`이며 성공을 주장하지 않는다.

## ChatGPT 최소 테스트

배포는 별도 승인 대상이며 이번 구현에서 수행하지 않는다. 승인 후 새 코드를 적용한 MCP 연결에서 아래 절차를 실행한다. 유지보수 모드가 켜져 있으면 기존 정책대로 503으로 거절된다. 실제 ChatGPT 연결의 도구 목록에 `submit_observation`이 노출되는지 먼저 확인한다.

1. 새 테스트 ID를 정하고 다음을 요청한다: **“LifeRPG submit_observation을 한 번 호출해 줘. summary는 '합성 MCP 전달 실험', test_id는 'mcp-probe-20261015-001'. 게임 판정이나 사건 등록은 하지 마.”**
2. 정상 응답에서 `received:true`, `outcome:received`, `test_id`, UTC 수신 시각, `call_id`를 확인한다.
3. `get_gm_status`를 호출해 최근 호출에 같은 ID의 `submit_observation`과 결과가 있는지 확인한다. 최근 10개만 반환하므로 호출 직후 확인한다.
4. 같은 입력으로 한 번 더 호출한다. `outcome:duplicate`, 새 `call_id`, 최초 `first_call_id`가 반환되는지 확인한다.
5. 차단되면 자동으로 다른 쓰기 도구를 대신 호출하지 말고, 테스트 ID·시도 시각·ChatGPT 표시 오류를 기록하고 아래 서버 근거와 비교한다.

## 서버에서 확인

최근 10개 밖의 기록도 다음 읽기 전용 SQL로 확인할 수 있다. 실제 조사 시 `$1`에 해당 테스트 ID를 바인딩한다. DB 조회나 배포는 이 문서를 작성하면서 실행하지 않았다.

```sql
SELECT id, called_at, completed_at, arguments, outcome, result
FROM tool_calls
WHERE tool = 'submit_observation' AND arguments->>'test_id' = $1
ORDER BY called_at, id;
```

| 근거 | 해석 |
| --- | --- |
| DB에 received/duplicate 행 | 서버가 영수증을 영구 저장함. ChatGPT가 오류를 표시했다면 응답 전달·후속 처리 문제도 조사 |
| 런타임 observation_received 로그만 있고 성공 행 없음 | 인증·scope 검사를 통과해 도구 핸들러에 도달함. 같은 call_id의 mcp_call 오류와 DB 상태 확인 |
| HTTP 접근 기록에 401/403/503 등 | 서버 또는 앞단까지 도달했지만 인증·Origin·유지보수 정책 등에서 거절될 수 있음 |
| DB·도구 로그에 모두 없음 | 영구 수신 및 인증된 핸들러 도달 증거 없음. HTTP 접근 기록도 함께 확인해야 함 |

`observation_received`는 인증·scope 확인 후 DB 트랜잭션 전 남기는 런타임 로그다. 정상 입력이면 `test_id`, 모든 경우 `call_id/called_at`을 포함하고 요약은 로그에 남기지 않는다. 영수증의 요약은 DB에 저장된다. 미인증 요청 본문은 DB에 저장하지 않는다. 로그 부재만으로 ChatGPT 안전 검사를 원인으로 확정할 수 없다. 네트워크 실패·앞단 거절·인증 실패·로그 보존 상태를 함께 구분한다. 클라이언트 차단 정책 자체의 진단 결과는 실제 ChatGPT 실험 후 판단한다.

## 로컬 검증 범위

공식 MCP SDK 클라이언트와 메모리 PGlite DB로 도구 발견, 최초 수신, 재수신, 동시 중복, 입력 제한, 익명·읽기 scope 거절, 감사 저장 실패와 재시도를 검증한다. 성공·중복 요청 전후에 감사/OAuth 테이블을 제외한 모든 public 테이블의 행 snapshot을 비교한다. 기존 도구 수 검증은 9개에서 10개로 갱신했다. 운영 DB·배포·실제 ChatGPT 호출은 로컬 검증 범위에 포함되지 않는다.

2026-10-15 로컬 결과: npm run check 통과, npm test 106/106 통과. 최초 성공 행만으로 first_call_id를 찾도록 최종 보정한 뒤 test/server.test.js 11/11 및 타입 검사를 다시 통과했다. git diff --check에서 공백 오류가 없었다.
