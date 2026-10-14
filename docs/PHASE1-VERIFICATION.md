# 현실 사건 식별과 보강 1단계 검증

2026-10-14 · Asia/Seoul · 로컬 구현 검증

기존 MCP/OAuth 구조 위에 현실 사건 최초 등록·추가 사실 보강·정정과 조회 이력을 추가했다. 구현 계약은 [SPEC.md](../SPEC.md), 전체 설계와 후속 범위는 [DESIGN.md](../DESIGN.md)를 따른다. 캐릭터·GM 판정·XP·퀘스트는 구현하지 않았다.

## 격리 검증 결과

| 검증 | 결과 |
| --- | --- |
| npm run check | 통과, JavaScript TypeScript 정적 검사 |
| npm test | 19개 통과: 기존 회귀 10개와 신규 사건 시나리오 9개 |
| npm run test:browser | 1개 통과: 실제 Edge에서 승인 POST·Origin·303 callback·토큰 교환 |
| 기존 데이터가 있는 001→002 이관 | PGlite에서 합성 기존 사건·감사·grant를 먼저 넣고 확인. UUID·요약·근거·발생일·원래 서버 시각·OAuth grant·감사 연결 보존 |
| 다이빙 3회 | 첫 사건을 먼저 등록, 나중에 두 독립 사건을 같은 batch에 등록. 서로 다른 UUID 3개. 후속 대화의 첫 사건 보강은 같은 UUID의 새 버전 |
| 사실 정정 | 수심·날짜·키 정정의 전후 snapshot과 이유 보존, 과거 날짜·키 조회·등록은 기존 UUID로 연결, 다른 사건과 alias 충돌 차단 |
| 시각 구분 | 발생일만 아는 사건과 완전 미상 사건의 timestamp null 보존. 메시지 보고 시각과 서버 시각 분리. UTC/offset·현지 날짜·기간·시간대 유효성 검증 |
| 반복과 재시도 | 동일 요청은 저장 결과 재생, 입력이 다른 동일 요청 키 거부. 무변경 보강은 revision 증가 없음. 미상 날짜의 동일 키도 duplicate |
| 버전 경쟁과 일괄 원자성 | 동시에 제출한 중복은 원본 1개. 같은 버전의 경쟁 변경은 성공 1개·version_conflict 1개. 후반 충돌과 이력/감사 저장 실패는 사건·alias·revision·요청 영수증 전체 rollback |
| 접근과 감사 | 신규 도구의 익명·scope 제한, 엄격한 입력과 정정 이유·batch 크기 제한, 중첩 비밀 필드 미기록, 이력·alias·영수증 UPDATE/DELETE 차단 |

자동 테스트 DB는 별도의 PGlite 메모리 인스턴스다. .env.local이나 운영 DB 연결을 사용하지 않았으며 합성 데이터만 사용했다. 실제 Edge 테스트도 메모리 DB와 테스트 자격증명을 사용하고 ChatGPT callback을 가로챈다. 운영 migration, 원격 smoke, Vercel 배포, 프로젝트 지침 변경은 수행하지 않았다.

## 검증 한계와 운영 전 확인

PGlite는 단일 인스턴스의 트랜잭션을 직렬 실행한다. Promise.all 제출로 중복·버전 판정은 확인했지만 여러 PostgreSQL 세션의 advisory lock 대기·timeout이나 Vercel 함수 인스턴스 경합을 실제 재현한 것은 아니다. 운영 적용 전 격리된 Neon branch에서 독립 연결 경쟁과 실제 migration을 추가 검증해야 한다. 트랜잭션 잠금의 연결 간 동작은 [PostgreSQL 공식 locking 문서](https://www.postgresql.org/docs/current/explicit-locking.html)를 따른다.

의미상 동일 사건 판별과 사실의 진위는 GM 책임이다. 날짜·키가 다른 중복을 서버가 자동 병합하지 않는다. 과거 alias를 예약하므로 정정 전 식별값을 다른 사건에 재사용할 수 없다. 같은 날 독립 활동은 확인된 회차·장소 등의 구분 키를 사용한다. 메시지 ID는 선택적 출처이며 사건 정체성이나 중복 기준이 아니다.

운영 버전에는 아직 새 기능이 없다. 새 코드의 사건 도구는 002 schema를 요구한다. 승인 후 적용 시 기존 데이터 백업과 조회 대조를 준비하고 migration·코드 전환 사이 사건 쓰기를 중단해야 한다. 구버전 쓰기는 새 이력에 참여하지 않으므로 혼용하지 않는다. DB명 검사만으로 branch가 격리됐다고 판단하지 않는다. 기본 db:setup은 여전히 001만 선택하며 002는 파일명을 명시해야 한다.

이번 단계에서는 사건 병합, GM 판정·보상, 게임 상태·초기 캐릭터 생성, 배포와 실제 수다방 신규 도구 검증을 수행하지 않았다.
