# Phase 4 · 개인 전용 모험의 서

2026-10-14 · Asia/Seoul · 로컬 구현 및 검증

DESIGN.md와 SPEC.md, Phase 1~3C 검증 기록을 먼저 확인했다. 기존 Node.js 24 서버와 공개 조회 계약을 확장하여 읽기 전용 판타지 RPG 웹사이트를 구현했다. README와 GM 규칙, 기존 MCP/OAuth 코드를 수정하지 않았다. 이전 단계의 미커밋 변경은 보존했다.

## 구현된 화면

| 화면 | 동작 |
| --- | --- |
| 모험가의 서재 | 레벨·XP·직업·칭호, 6대 최종 스탯, 장착 장비, 주요 스킬, 진행 퀘스트, 최근 취득 항목·성장, 공개 세계 소식. 각 영역에서 상세 이동 |
| 캐릭터 | 기본·장비·기타 활성 보정·최종 스탯 분리, 최초 성장과 이후 XP/스탯 이력, 이전·현재 직업, 스킬·특성·칭호·업적 |
| 소지품 | 장착 슬롯, 희귀도 색상, 수량·내구도, 고정 정의 버전의 설명·효과·설정, 공개 개별 상태에 기록된 획득 경위, 취득·변경 이력 |
| 퀘스트라인 | 상태 필터, 여러 라인의 장·개별 퀘스트, 선행/분기와 교차 연결, 사건 연결, 관련 모험 일지, 완료·실패·중단·재개 이력 |
| 세계 도감 | 세계·지역·국가·세력·NPC, 부모/위치/소속 및 연결된 장소·사람 탐색, NPC 관계, 공개 역사·사건, canon/claim/belief 구분 |
| 모험 일지 | GM 일지 전문 읽기, 퀘스트·인물·세계 사실로 이동, 기록순·현실 발생순·세계 시각순 연대기 |
| 경계 상태 | 미시작, 로딩, 로그인, 소유자 아님, 설정 미완료, 조회 실패 및 재시도 |

짙은 청록 배경·금빛 문장·별과 등대 풍경·책장 형태 일지를 사용했다. 풍경과 문장은 직접 작성한 SVG이며 실제 캐릭터의 외모를 임의로 생성한 것이 아니다. Noto Sans/Serif KR 웹폰트가 불가능하면 시스템 글꼴로 표시한다. 모바일에서는 상단 탐색과 단일 열 배치로 전환한다. 네이티브 dialog의 포커스 제한·Escape 닫기와 키보드 포커스 표시, reduced-motion 설정을 지원한다.

## 인증과 데이터 경계

- Clerk 개발용 **Life RPG** 앱을 Hobby 조직에 생성했다. 유료 상품이나 운영 인스턴스는 생성하지 않았다.
- 사용자가 직접 Google 로그인을 완료했고 그 사용자 ID를 로컬 `CLERK_OWNER_USER_ID`로 지정했다. 지정 전 403 화면, 지정 후 실제 Clerk 세션으로 합성 게임 화면이 표시되는 것을 확인했다.
- 개발 키와 소유자 ID는 Git/Vercel 업로드에서 제외되는 `.env.clerk.local`에 저장했다. 기존 `.env.local`의 운영 DB·OAuth 설정은 변경하지 않았다.
- 서버가 공식 Clerk SDK로 session token과 `authorizedParties`를 검사한 뒤 지정 소유자만 기존 내부 주체 `experiment-owner`로 매핑한다. 브라우저 요청의 owner/view를 신뢰하지 않는다.
- `GET /api/player`만 게임 데이터를 반환한다. 클라이언트는 `pg`, DB URL, MCP 토큰, secret key를 받지 않는다. 모든 게임 응답은 `private, no-store`, `Vary: Cookie, Authorization`이다.
- 기존 `getGameContext(view:player)`를 READ ONLY·REPEATABLE READ 트랜잭션에서 호출한다. 추가 웹 조회도 SELECT만 사용한다. 원본 세계 공개 투영에 더해 웹 응답 허용 필드 목록으로 GM 이유·기억·원본 근거·해시를 제거한다.
- 세계 비공개 레코드·숨겨진 관계 endpoint·미공개 참조는 응답에서 제외한다. public settings/state의 예약된 `gm_*` 필드도 제거한다. 공개 본문 안에 GM이 비밀을 직접 써 넣는 의미상의 오류는 서버가 자동 판별하지 않는다.
- 최신 대시보드 요약은 별도 bounded 최신 조회를 사용한다. 첫 페이지가 오래된 항목으로 찼다고 최근 보상·현재 장비·스킬·진행 퀘스트가 사라지지 않는다.
- 실제 게임이 없으면 `initialized:false`. 조회 자체가 캐릭터·세계를 생성하지 않는다. DB/schema 오류는 게임이 없다고 숨기지 않고 503으로 반환한다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run build` | TypeScript checkJs 검사와 브라우저 번들 생성 통과. 서버·fixture 모듈의 클라이언트 번들 유입 검사 포함 |
| `npm test` | 기존 Phase 1~3C 회귀 **83개 통과** |
| `npm run test:web` | Phase 4 API 통합 **10개 통과** |
| `npm run test:browser` | 기존 Edge MCP OAuth 승인→정확한 Origin→303 callback→토큰 교환 **1개 통과** |
| Clerk 실제 로그인 | 개발 앱 생성, 사용자 직접 Google 로그인, 서버 소유자 지정 전 거부와 지정 후 합성 게임 접근 확인 |
| 웹 인증 부정 경로 | 임시 RSA 키로 발급한 테스트 JWT를 실제 Clerk SDK로 검증. 익명·다른 사용자·만료·위조 서명·잘못된 azp/Origin·MCP 형태 토큰 차단. 거부 시 DB 연결 없음 |
| 읽기 전용 | 전체 public 테이블 snapshot 비교에서 조회 전후 모든 행과 revision 불변 |
| 비공개 경계 | 상세·이력·연대기·검색·대시보드의 GM 비밀 sentinel, 중첩 비밀 키, 원본 증거, 이유, acquisition hash 제외 |
| 화면 데이터 | Level 13/7,860 XP, STR 18+5=23, INT 기본 30/장비 +4/기타 +3/최종 37, 초기 성장·전직·장비·퀘스트·NPC·일지 확인 |
| 페이지와 갱신 | 1건 단위 페이지로 공개 목록·연대기를 중복 없이 순회. 비공개 항목만 있는 페이지의 cursor 유지. GM 변경 후 새 GET에서 revision·진행 내용 갱신 |
| 실제 브라우저 | 여섯 주요 화면, 장비 상세, 퀘스트→일지, NPC 소속·관계, 연대기 정렬, 미시작 화면 확인. 합성 게임 탭 console error 없음 |
| 반응형 | 데스크톱 화면과 실제 관찰된 약 564 CSS px 좁은 뷰포트에서 단일 열/상단 탐색 및 가로 넘침 없음 확인 |

총 자동 검증 94개 통과. 테스트 DB는 PGlite 메모리 인스턴스이며 운영 Neon에 접속하지 않는다. 인증 검증용 RSA 키는 테스트마다 메모리에서 생성하고 실제 Clerk 비밀 키를 테스트 코드에 넣지 않는다.

## 실행

```powershell
npm ci
npm run build
npm run preview:web
```

인증 없이 합성 화면을 살펴보는 전용 로컬 서버는 `http://127.0.0.1:4317`이다. 미시작 화면은 `/?preview=empty`. 이 서버는 loopback에만 bind하며 Host/Origin 검사, Vercel/production 실행 거부를 적용한다. fixture와 preview script는 배포 산출물에서 제외한다. 운영 API에는 preview 우회 옵션이 없다.

실제 Clerk 인증 + 메모리 합성 게임:

```powershell
npm run preview:web:clerk
```

`.env.clerk.local`을 읽고 `http://127.0.0.1:4318`에서 실행한다. 이번에 사용자가 로그인한 개발 계정만 게임을 조회할 수 있다. 미시작 보기에서도 먼저 실제 소유자 인증을 통과해야 한다. 재시작하면 합성 게임 데이터는 새 메모리 DB로 다시 구성된다.

실제 DB를 읽는 웹 개발 서버는 `npm run dev:web`이며 명시한 `WEB_ENV_FILE` 또는 `.env.local`을 읽는다. 향후 승인된 격리 DB 환경에서 `DATABASE_URL`, 해당 웹 origin의 `PUBLIC_BASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_OWNER_USER_ID`를 준비한다. `CLERK_JWT_KEY`는 선택적인 PEM 공개 키다. 이 명령은 migration/초기화 없이 읽기만 하지만 이번 검증에서는 실행하지 않았다.

## 남은 제약

- 운영 Neon migration과 Vercel 배포는 수행하지 않았다. 실제 데이터 웹 사용에는 기존 001~006 schema, 승인된 배포와 운영 Clerk 설정이 별도 필요하다. 로컬 빌드만으로 Vercel 라우팅의 실제 배포 검증을 했다고 주장하지 않는다.
- 실제 캐릭터·세계·종족·초상·운명을 만들지 않았다. 아직 스키마에 없는 전기 정보나 외모를 웹에서 게임 사실처럼 만들어 표시하지 않는다.
- 획득 경위는 공개 state/settings 및 공개 일지에 있는 내용만 표시한다. 비공개 GM 판정 이유를 획득 경위로 그대로 노출하지 않는다.
- 세계 분류 탭은 현재 펼친 도감 페이지에 적용되며 다음 기록을 계속 펼칠 수 있다. 지도 좌표가 없는 모델이므로 지리 위치를 임의로 만들어 지도에 배치하지 않았다.
- 모바일 분기 화면은 좁은 데스크톱 브라우저에서 확인했다. 뷰포트 도구에 390px를 요청했지만 실제 DOM 측정은 약 564px여서 390px 실측 검증으로 기록하지 않는다. 실제 휴대폰 Safari/Chrome 터치·가상 키보드는 미검증이다.
- 운영 Neon 지연·다중 연결 부하·실제 운영 도메인의 Clerk/Cookie·배포 보호 조합은 미검증이다. 개발 앱과 소유자 세션의 성공을 운영 배포 완료로 표현하지 않는다.

## 화면 기록

로컬 `.local/phase4/`에 대시보드, 캐릭터, 소지품, 장비 상세, 퀘스트라인, 일지 리더, 세계 도감, 실제 Clerk 소유자 접근, 연대기, 좁은 화면, 미시작 상태의 PNG를 저장했다. `.local/`은 Git/Vercel 업로드 대상이 아니다.

참고한 공식 API 계약: [Clerk authenticateRequest](https://clerk.com/docs/reference/backend/authenticate-request), [Clerk JavaScript Quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart). Core 3에서는 Clerk UI bundle이 별도로 필요하므로 공식 절차대로 Frontend API domain에서 로드한다.
