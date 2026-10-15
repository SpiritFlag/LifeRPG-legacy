# Life RPG Phase 8-D/E · 운영 migration·전환·서비스 재개

2026-10-14 23:19 KST. 형의 D/E 일괄 승인에 따라 **002→007 migration과 기존 staged promote, 운영 로그인·MCP 검증 및 서비스 재개를 완료했다.** 실제 게임 생성(F), Git push, 새 배포·release commit, 수다방 지침 변경은 없다. 새 관리 스크립트를 작성하지 않았고 기존 CLI/setup-db/백업 도구와 필요한 inline 실행만 사용했다.

## 전제와 migration

- Neon API에서 project `cool-waterfall-23850161`, branch `br-spring-night-a1jbloxd`, endpoint `ep-soft-sky-a1kxmx2q`를 확인했다. 운영 DB `liferpg_experiment`, role `liferpg_owner`, verified direct host 및 verify-full을 확인했다.
- WAF active version=1, 기존 production target과 staged `dpl_51oiGLcHWdW3p1BQR4nRfPRuDb1w`의 READY/STAGED 및 release SHA `2e8b1b8d0650cc9b912b5fa14b6f681d0fda6616`를 확인했다. C의 산출물/격리 회귀는 반복하지 않았다.
- A의 최신 암호화 archive `2026-10-14T13-11-25-256Z.pgdump.aesgcm`를 기존 verify로 인증했다. 기존 복구 성공 기록을 사용했고 restore를 반복하지 않았다. 현재 운영 schema·원본 행 지문이 archive manifest와 같았으며 migration 직전 다른 DB client connection은 없었다.
- 기존 `scripts/setup-db.js`로 002→003→004→005→006→007을 파일별 순차 실행했다. 각 migration hash는 release source manifest와 같았다. 파일 자체 BEGIN/COMMIT과 실패 ROLLBACK 동작을 사용했다. 모두 통과했고 최종 public table은 39개다.
- 매 단계 원래 컬럼 projection으로 life_events 6행, OAuth 6행, auth_attempts 1행, tool_calls 30행의 전체 지문을 대조했다. 002의 alias/revision은 각각 기존 6개 사건에 대응하며 다른 새 table은 모두 0행이다. 게임·캐릭터·세계·초기 생성 draft를 만들지 않았다.

## 전환과 실제 연결 계약 보정

구버전 writer 후보를 먼저 publish하고 유지보수 차단 아래 기존 staged를 promote했다. production target과 MCP/web canonical alias가 동일한 새 deployment로 전환됐다. Git main alias는 구버전 deployment에 남지만 writer WAF가 차단한다. 함수/산출물 설정은 C에서 확인한 배포 그대로다.

최초 제한 smoke에서 기존 연결이 403이었다. 실제 connector transport는 **`https://liferpg.spiritflag.work/mcp`**였으며 준비 문서의 단일 MCP host 허용 가정이 기존 연결을 막았다. 즉시 전체 유지보수 규칙을 재활성화한 뒤 두 canonical host 모두 새 deployment임을 확인했다. `/mcp*`·`/oauth*`에 대해 두 host만 허용하고 다른 host는 deny하도록 기존 writer 규칙을 보정·검토·publish했다. issuer/resource/client/secret/callback이나 연결 root를 변경하지 않았다. 이 보정은 데이터/인증 변경이 아닌 기존 canonical 연결의 WAF 접근 복원이다.

최종 WAF active version=6: 유지보수 규칙 `rule_life_rpg_transition_maintenance_L748fV`는 disabled로 보존, writer 규칙 `rule_life_rpg_canonical_mcp_origin_only_s9dv99`는 active/valid=true/deny, draft=null/bypass=[]다. DDoS·Attack Mode·시스템 bypass는 변경하지 않았다. 기존 정책 JSON도 실제 규칙과 일치하도록 보정했다.

## 운영 검증과 데이터 보존

- 실제 소유자가 canonical 웹에서 운영 Clerk 이메일 로그인을 완료했다. 브라우저에서 정상 서재와 unstarted 화면을 확인했고 같은 로그인 Cookie의 `/api/player`가 `{"initialized":false,"initialization":{"status":"unstarted"}}`를 반환했다.
- 익명 `/api/player` 401, 잘못된 Origin 403, API private/no-store 및 Vary Cookie/Authorization을 확인했다. health/web-config/discovery는 200, 기존 issuer/resource/scopes는 동일하다.
- 두 canonical host의 실제 tools/list는 모두 200, 도구 9개 및 object inputSchema/OAuth securitySchemes를 반환했다.
- **기존 LifeRPG connector의 실제 `get_gm_status` 호출이 성공했다.** storage=ready, event_count=6, call ID `ee35f895-4935-4471-a600-ad358bc47152`. 기존 OAuth 연결을 재등록하지 않았다.
- OAuth baseline은 이미 복구된 A의 DB를 읽기 전용으로 대조했다. 기존 6행 중 5행이 완전히 보존됐고 기존 refresh 1행만 정상 소비됐다. 새 access/refresh 각 1행의 payload가 소비된 refresh와 같았다. 실제 기존 연결의 자동 refresh 호환성이 확인됐다. 별도 신규 OAuth login/grant는 만들지 않았다. baseline 확인 후 기존 격리 compute에 suspend를 요청했다.
- 최종 사건 6행·auth_attempts 1행·원래 audit 30행 지문이 보존됐으며 승인된 get_gm_status smoke 감사 1행만 추가됐다. 새 model table은 모두 0행이고 import alias/revision만 각각 6행이다.
- 과거 운영 deployment의 Vercel 인증을 거친 `/mcp` POST가 실제 403 + X-Vercel-Mitigated=deny였다. raw 보호 URL의 401/302는 WAF 증거로 계산하지 않았다. CLI가 생성한 임시 deployment protection 토큰 하나는 검증 후 revoke(regenerate=false)하여 최종 0개를 확인했다.

## 남은 제약

현재 connector가 캐시한 도구는 옛 3개이므로 새 `get_game_context`의 connector 실호출은 수행하지 못했다. 대신 운영 DB READ ONLY의 실제 GM storage 조회와 로그인 Cookie 웹 API에서 initialized=false/unstarted를 확인했다. 서버는 9개 도구를 정상 노출하며 새 도구 사용에는 클라이언트 도구 목록 갱신이 필요하다. 이 한계를 새 connector 호출 성공으로 표현하지 않는다.

실제 다른 계정/변조 azp 세션은 추가 발급하지 않았고 기존 합성 검증과 owner/authorizedParties 코드 근거를 유지했다. 이번 실측은 실제 소유자 Cookie 허용, 익명/잘못된 Origin 거부까지다. 긴 finalize의 실제 운영 client 성능과 실제 게임 생성은 이번 범위가 아니다.

서비스는 재개됐고 F는 별도 승인 대기다. 로컬 encrypted backup/DPAPI 키는 보존한다. 보존 기간은 기존 계약(Phase 8 완료 후 7일, 삭제는 형 확인)을 따른다. 상세 비공개 증거는 `.local/phase8de/`의 migrations, db-before/final, pre-smoke-http, tool-list, OAuth-context, infrastructure-final에 있다. 문서 변경은 미커밋이며 배포 SHA는 그대로다.
