# BANG! 온라인 기본판 — 개발 준비 패키지

2026-09-29 · 상태: **기존 로컬 구현: T01/T02/T03/T04/T05/T06/T07/T08/T09/T10/T11/T12/T13/T14/T15/T16/T17/T18/T19/T20/T21/T22/T23/T24/T25/T26/T27/T28/T29/T30/T31/T32/T33/T34/T35/T36/T37/T38/T39/T40/T41/T42/T43/T44/T45/T46/T47/T48/T49/T50/T51/T52/T53/T54/T55/T56/T57/T58/T59/T61/T62/T63/T64/T65/T66/T67/T68/T69/T70/T71/T72/T73/T74/T75/T76/T77/T78/T79/T80/T81/T82/T83/T84/T85/T86/T87/T88/T89/T90/T91/T92/T93/T94/T95/T96/T97/T98 DONE, T60 IN_PROGRESS. Sites 이식: T99/T100/T101/T102/T103/T104/T105/T108/T109/T110/T111/T106 DONE, T107 IN_PROGRESS**.

**현재 통합 수락 상태 (2026-09-28 07:28 UTC):** 최신 T60 기록은 D 통합 17 PASS, 0 FAIL, 2 NOT RUN이며 엔진 78/78과 합해 95/97 검증이다. 브라우저에서 D13 키보드 흐름(모바일/데스크톱 대상·방어·구제·탈락·정리·카드 확대 닫기), D14 기본판 80장 표시와 Stagecoach 9♠ 인스턴스 구분, D15 이미지 실패 대체 표시와 행동 선택을 확인했다. D06은 초기 4P/7P 비밀 projection과 일부 알림만 점검했고 모든 ACK·원시 WebSocket frame·상태별 legalActions 노출 검증을 하지 않아 NOT RUN이다. D18은 새 match ID와 초기 손패 ID 비중복까지만 확인했으며 전체 덱/역할/seed 비재사용은 projection으로 입증하지 못해 NOT RUN이다. T60은 두 항목을 통과 처리하지 않고 IN_PROGRESS를 유지한다. 외부 배포는 하지 않았다.

**추가 UI 보완 (2026-09-28):** T98은 손패 및 서버가 허용한 응답·정리 후보 카드에 분리된 상세 보기 버튼과 접근 가능한 dialog를 추가했다. 이름, rank/suit, 01_RULES 기반 설명을 표시하며 버튼/Escape 닫기와 focus 복귀를 지원한다. 루트는 소유 경로, 비공개 projection 경계와 기존 선택 버튼 분리를 검토하고 focused tests 19/19, web check/build 및 360×800 keyboard open/Escape/focus-return을 확인했다. 이 부분 검증은 T60의 D13 전체 모바일/데스크톱 흐름 PASS를 의미하지 않는다.

**과거 T60 수락 기록 (2026-09-28 04:28 UTC):** 실제 브라우저에서 4인과 7인 게임을 각각 승패 결과까지 진행하고 방장이 같은 대기실로 복귀했다. 두 방 모두 좌석 전원이 준비 해제됐고 시작 버튼은 비활성이었다. 별도 격리 API 실행은 4인 84/84, 7인 82/82 명령을 수락했다. 탈락 정리 pending 중 연결 해제 30초 뒤 상태 유지, 동일 guest 재접속 시 responder 단계 복원, 동일 commandId/payload 재전송 시 `duplicate=true`와 상태/효과 불변을 확인했다. 통합 D 케이스는 **9 PASS / 0 FAIL / 10 NOT RUN**이며, 엔진 78/78과 합해 **87/97**이다. 미검증 조건은 [웹 수락 기록](../../apps/web/README.md)과 [결과 JSON](../../apps/web/e2e/acceptance-results.json)에 따르며, T60은 전체 통합 acceptance를 마치지 않아 IN_PROGRESS로 유지한다. 별도 D08 시도는 DEATH_RESCUE pending 1/1까지 진행했지만 3003/5436 listener 소유권을 증명하지 못해 서버 재시작은 실행하지 않았고 D08은 NOT RUN이다. 외부 배포는 하지 않았다. 아래 T60 초기 실행 기록은 이 최신 상태로 갱신해 읽는다.

루트 재검증 결과, T85의 R27 초과 피해 구제 잔여 HP 보존 수정은 runtime 전용 테스트 25/25와 `pnpm --filter @bang/engine check`를 통과했다. 수정 후 T42 엔진 사례 AT-A01~A15, AT-B01~B30, AT-C01~C32, AT-D20은 **78/78** 통과했다. scenario runner는 각 사례를 두 번 재생해 상태·이벤트·중간 snapshot을 비교하고, 매 snapshot에서 80장 zone invariant 및 viewer별 private projection을 확인한다. 이는 전체 97개 통합 수락 완료를 뜻하지 않는다. T86 fetch receiver 회귀 6/6, web check/build 및 workspace `pnpm check`를 통과했고, T87 Kit Carlson 테스트 5/5와 엔진 전체 **362/362**, engine check도 통과했다. T88은 서버 효과 registry/연속 턴 실행과 KICK 잠금을 연결했다. 루트 재실행은 `pnpm --filter @bang/server check`, command relay **13/13**, runtime **4/4** 통과였다. 새 포트 3001/PGlite와 Vite proxy 5174를 사용해 수락 runner를 갱신 코드로 실행했고 4인·7인 게임 API 명령 모두 완료 상태까지 수락됐다. 이 결과는 API 대리 플레이이므로 D19 완료가 아니다. D11의 owner kick은 `ROOM_LOCKED`, outsider는 `NOT_FOUND_OR_FORBIDDEN`이고 상태 변경이 없었으나 탈락자 자기정리 예외는 미검증이다. 이전 통합 실행에서 D17/D18은 FAIL이었으며 T93/T94/T91 수정 뒤 격리 T60 runner에서 D17은 PASS로 확인됐다. D18은 새 match ID와 초기 hand ID 비중복까지만 확인돼 전체 기준으로 NOT RUN이다. 루트 브라우저 테스트에서 새로고침·두 번째 탭이 같은 좌석으로 복구됐고 4인 준비/시작·역할 공개(`/role`)·게임 테이블은 동작했지만 START_MATCH 뒤 `/role-reveal` 404가 재현됐고, T89가 canonical `/role` redirect로 수정했다. 루트 route test 10/10, web check/build 통과; 실제 browser recheck는 T60에서 진행한다. D19 브라우저 전체 흐름과 나머지 통합 시나리오는 계속 확인 중이며 전체 97개 통합 수락을 완료하지 않았다.

T52 로비 UI와 T47 인증 sync projection/outbox는 루트 검토와 전용 테스트를 통과해 DONE이다. 로비 테스트 9/9, 웹 check/build 통과; projection/outbox 테스트 9/9, server check 통과. 실제 앱 라우트/Socket.IO server assembly 및 해당 통합 수락 사례는 여전히 미검증이다. T65 공용 인물 API도 루트 engine check, compile-time strict tsc, 전용 타입 테스트 2/2로 DONE 처리했으며 통합 AT는 미실행이다.

T90 공용 계약은 root recheck에서 contracts 13/13와 workspace `pnpm check`를 통과해 DONE이다. T91은 완료된 최신 매치에서 방장 직접 재시작을 허용하는 저장소/서비스 흐름을 구현했다. 잠긴 같은 roster와 clockwise seat 순환·ready 검증, 새 match 초기화/저장, receipt/outbox 원자성, receipt replay, 미완료 최신 매치 차단을 PGlite storage/service 테스트 **25/25** 및 `pnpm --filter @bang/server check`로 루트 재검증해 DONE 처리했다. T92는 owner-only `RETURN_TO_LOBBY` 서버 경로를 연결해 모든 참가자 준비를 해제하고 완료 match 이력을 보존하며 RoomView를 `activeMatchId:null`로 반환한다. outbox 충돌 rollback 포함 storage/service **29/29**, runtime **4/4**, server check를 루트 재검증해 DONE 처리했다. T91/T92 단위·runtime 검사는 통합 D18/D19 완료로 계산하지 않는다. T60 acceptance runner의 이전 결과는 PASS 5 / FAIL 3 / NOT RUN 11이며 새 서버 동작의 통합 재실행이 남아 있다.

T93 표시명 정책은 서버와 브라우저에서 trim 후 1–20 Unicode code point 및 C0/C1 제어문자 거절을 일치시켰다. 루트 재검증에서 PGlite room service **12/12**, room-entry model **5/5**, Lobby SSR/text-escaping **3/3**, server/web checks 및 web build가 통과해 DONE 처리했다. D17의 invite guessing rate limit은 T94와 T60에서 별도 검증하며 D17 전체는 아직 PASS가 아니다.

T94는 authenticated Socket.IO raw peer IP와 server-resolved guest ID를 결합한 in-memory invite limiter를 연결했다. invalid preview/JOIN 실패 누적, 조회 전 차단, backoff, rolling expiry, idle cleanup, 성공 JOIN reset 및 invalid JOIN code normalization을 루트 재검증했다: limiter/gateway tests **24/24**, `pnpm --filter @bang/server check`, 격리된 `pnpm --filter @bang/server test:runtime` **4/4** 통과. 병렬 실행 한 번은 runtime test 3/4로 `draw`/`play` 상태 경계에 실패했고 이후 격리 실행에서는 4/4 통과했다. D17 통합 수락은 새 runner 결과가 생길 때까지 미완료다.

T95/T96 결과 화면은 완료 MatchSnapshot과 같은 `activeMatchId`의 `in_game` RoomView와 일치하는 owner/viewer ID에서만 재대기실 action을 제공한다. exact empty `RETURN_TO_LOBBY` command, 최신 version/new commandId, ACK 뒤 더 높은 버전의 대기실 sync 확인, 중복 클릭 방지와 실패 재시도를 루트 검증했다: 결과/라우트 tests **22/22**, web check/build 통과. 실제 브라우저 D19 재대기실 흐름은 T60에서 실행한다. T60 1차 격리 통합 실행은 D02/D03/D04/D07/D16/D17 **6 PASS**, D19 **1 FAIL**, 나머지 **12 NOT RUN**이다. 78개 엔진 사례와 합쳐 **84/97 검증**으로 기록했다. 4인 브라우저 게임은 재접속·응답·탈락자 정리·결과까지 갔으나 T95 room-status 조건이 실제 lifecycle과 달라 재대기실 버튼이 없었다. T96에서 이를 `in_game` RoomView 조건으로 수정해 route/status tests 22/22, web check/build를 통과했다. 7인은 5/7 입장 뒤 F/G preview가 막혀 미완료다. 최신 2차 검증에서 D19는 4인·7인 브라우저 게임 및 방장 재대기실 복귀까지 PASS이고, D02/D03/D04/D05/D07/D11/D16/D17도 PASS다. 현재 통합 D는 9 PASS/0 FAIL/10 NOT RUN이며 엔진 78/78과 합해 87/97이다. 탈락 정리 pending 중 reconnect 및 동일 명령 replay 증거는 G7 하위 조건을 확인하지만 D01·D10 전체 조건과 혼동하지 않는다. D01/D06/D08/D09/D10/D12/D13/D14/D15/D18 미검증으로 T60은 IN_PROGRESS다.

T48 복구 로직은 유지된 PGlite DB에 새 recovery/storage/sync 서비스 인스턴스를 구성해 pending cursor 복원, viewer 경계, receipt 재사용과 지원 불가 snapshot 격리를 확인했고 server check 및 전용 테스트 2/2를 통과했다. OS 프로세스 재기동과 실제 PostgreSQL은 통합 단계에서 미검증이다. T66 카드 runtime은 루트 engine check 및 runtime 전용 테스트 10/10 통과로 DONE 처리했다. T49는 공식 PGlite Socket 기반 영속 local-dev 경로, 앱 readiness, guest-session 및 재기동 보존을 검증해 DONE 처리했다. 실제 PostgreSQL TLS/auth/다중 연결 및 통합 AT는 미검증이다. T28/T29/T30 El Gringo/Jesse/Jourdonnais는 완료했다.

T69 engine producer/projection은 15/15 candidates/projection tests 및 engine check 통과로 DONE이다. T55 행동 UI/T56 응답 UI/T57 status UI/T58 transport와 T75 앱 경로 통합은 루트 검증을 통과했다. T56 reactions 9/9, T57 status 7/7, T75 route 9/9 및 전체 web 57/57이고 web check/build도 통과했다. T75 화면은 projection/feature composition 기준으로 검증했으며 실제 server 연결, 다중 게스트, 전체 게임은 T60에서 수행한다. 97개 전체 통합 수락 케이스는 아직 실행하지 않았다.

T83/T84 root-owned contracts 보완은 runtime response literals와 complete `ORDER_CARDS` command를 strict parser로 고정하고, 현재 responder에게만 server-saved discard candidates/count를 투영한다. contracts tests 13/13, projection tests 12/12, contracts/engine check 통과. 통합 acceptance 시나리오는 미실행이다.

T28 El Gringo C04 모듈과 경계 테스트는 루트 재검증에서 6/6 및 strict 타입 검사를 통과했다. T29 Jesse Jones(6/6)와 T30 Jourdonnais(5/5)는 루트 재검증 및 engine check를 통과했다. T30의 Barrel/가상 Jourdonnais 경계는 기존 관련 테스트 20/20도 다시 통과했다. T66 engine check와 runtime 전용 테스트 10/10도 통과했다. 이 단위 결과를 통합 AT 통과로 계산하지 않는다.

T49 서버 코드는 `pnpm --filter @bang/server check`, PGlite Socket runtime 3/3, recovery tests 2/2가 통과해 DONE이다. PostgreSQL CLI·서비스가 없는 로컬 환경에서 PGlite Socket 영속 개발 모드로 migration, 앱 readiness, guest cookie, Socket.IO 인증, DB 재기동 후 저장 상태를 확인했다. 이는 일반 PostgreSQL TLS/auth/다중 연결 호환성이나 D05/D06/D09/D10 통합 AT 통과로 간주하지 않는다.

T37 Slab은 루트 재검증에서 전용 tests 5/5, T77 회귀 tests 37/37, `pnpm --filter @bang/engine check`, strict isolated tsc를 통과해 DONE 처리했다. 자기의 실제 물리 BANG에만 추가 Missed를 요구하며 Gatling, 다른 공격자, Calamity 변환 Missed, 재개 진행값 및 상태 불변 경계를 확인했다. T82 Barrel/Dynamite 설치 효과 보완 완료 뒤 T41 registry는 루트 재검증에서 전용 tests 6/6 및 `pnpm --filter @bang/engine check`를 통과해 DONE 처리했다. T74 START_MATCH/RoomView activeMatchId 경로와 T81 cookie-auth restore GET는 루트 server check 및 combined service/runtime/sync/gateway tests 31/31 통과로 DONE 처리했다. T55/T56/T57/T58 UI·transport 작업은 각자 소유 경로의 tests와 루트 web check/build를 통과했다. T79 Lucky judgment runtime 연결도 engine tests/check로 완료했다. T78은 Suzy hook/runtime tests 24/24 및 `pnpm --filter @bang/engine check`를 통과했고 전체 AT는 미실행으로 남겼다. 97개 통합 AT는 미실행이다.

T31 Kit Carlson은 루트 재검증 전용 테스트 5/5와 engine check를 통과해 DONE이다. 모듈은 T67이 공급한 비공개 top-three 후보를 선택하고, 후보를 못 받은 경우 조용히 아무 것도 옮기지 않는다. T31 단위 완료는 C07 통합 수락 케이스 통과를 뜻하지 않는다.

T70 공용 R08 supplier는 루트 engine check, 신규 10/10 및 draw-select 회귀 7/7을 통과했다. T25 Bart Cassidy는 루트 engine check 및 전용 테스트 7/7로 DONE이다. T26 Black Jack은 루트 재검증 전용 테스트 6/6 및 engine check로 DONE이다. T32 Lucky Duke는 T67이 공급한 두 공개 후보를 소비하는 hook 범위에서 전용 테스트 3/3 및 engine check로 DONE이다. T71은 성공한 effective BANG PLAY_CARD만 명령 경계에서 1회 누적하며 quota+command tests 15/15와 engine check를 통과했다. T27은 Calamity 6/6, basic-actions 11/11, tablewide 9/9, Duel 5/5, commands 9/9, runtime 10/10 및 engine check를 루트 재검증해 DONE이다. T34 Pedro Ramirez는 C10 첫 일반 뽑기 대체 선택과 비어 있는 덱/버림 더미 경계를 전용 테스트 7/7 및 engine check로 재검증해 DONE 처리했다(통합 AT 미실행). T35 Rose Doolan은 R10 거리 query 루트 재검증 및 engine check, 전용 테스트 4/4로 DONE이다. HP 0 구제 대기 좌석도 거리 원형에 남는 경계를 확인했다. T33 Paul Regret은 전용 테스트 3/3과 engine check를 통과했으며 통합 AT는 미실행이다. T73 방 시작 storage는 루트 재검증 PGlite tests 19/19 통과로 DONE이다. T36 Sid Ketchum은 전용 tests 4/4 및 engine check 통과로 DONE이며 C12 통합 AT는 미실행이다. server check의 유일한 오류는 T72 필수 activeMatchId를 제공할 T74 producer 경로가 아직 구현되지 않은 점이며 T74 뒤 다시 검사한다. AT D16은 미실행이다. 97개 통합 AT는 미실행이다.

T38 Suzy 모듈은 전용 tests 4/4와 engine check로 DONE이며 runtime dispatch는 T78에서 연결한다. T77 Slab/BANG runtime은 루트 재검증에서 engine check와 basic-actions/dynamite-barrel/runtime tests 37/37을 통과했고 T37은 전용 tests 5/5 및 strict type 검토를 마쳐 DONE이다. T40 Willy는 전용 3/3 및 quota/command 15/15, T67 draw orchestration은 draw 9/9·turn reducer 8/8·Jail 7/7과 engine check로 루트 재검증 완료했다. T76 local proxy는 frozen install, web check/build 및 PGlite+Vite smoke에서 guest-session 201, 보안 쿠키 속성, 인증 WebSocket handshake를 확인했다. T80 루트 단독 Suzy API 계약 보완은 engine check, standalone strict tsc, API 테스트 2/2 통과로 DONE이며 C14/S5 p13 순서를 D11 및 `before_el_gringo_reward` typed trigger로 고정했다. C08 Lucky judgment 연결은 T79로 완료했다. Root recheck에서 Jail/Dynamite-Barrel/runtime/turn-draw tests 55/55 및 engine check를 통과했으며 통합 AT는 미실행이다. AT-A01~AT-D20의 97개 통합 케이스는 실제 실행 결과가 생기기 전까지 통과로 기록하지 않는다.

T39 Vulture Sam 모듈은 루트 재검증 전용 테스트 3/3과 engine check를 통과해 DONE이다. 유효한 cleanup snapshot의 hand/장착 카드 이동 draft를 반환하고, 모듈 입력 상태는 불변이다. 현재 실제 탈락 처리는 T13 direct cleanup이 담당하며 T66 hook dispatcher는 미연결이라 통합 AT C20-C22는 미실행이다.

## 목표

친구 4~7명이 초대 링크로 들어와 한국어 기본판 BANG! 한 판을 시작하고, 모든 카드·인물·승리 조건을 서버 판정으로 진행하며, 연결이 끊겨도 같은 자리로 돌아오는 무료 웹사이트를 만든다. 현재 준비물은 구현을 작게 나누고 서로 다른 에이전트의 코드가 같은 계약으로 합쳐지게 하는 문서와 데이터다.

### 고정 범위

- 기본판 80장 / 플레이 카드22종 / 인물16명 / 역할4종.
- 게스트 이름, 비공개 초대방, 준비 및 시작, 개인 손패/역할, 전체 카드 효과와 응답, 탈락 및 결과, 재접속.
- 한국어 이미지42종 활용. 카드마다 달라지는 숫자·무늬는 80장 카탈로그에서 가져온다.
- 서버 권위, DB 저장, 중복 명령 방지, 플레이어별 비공개 정보 필터링.
- 타이머 OFF. 진행 중 강제퇴장과 자동 탈락 없음.

AI 상대, 확장판, 공개 매칭, 계정·랭킹·결제, 채팅·음성 기능은 첫 릴리스에서 제외한다. 대화는 외부 음성 서비스 등을 사용한다. 무료 이용 서비스라도 서버/DB 호스팅 비용은 별도 운영 비용이다.

## 읽는 순서

| 문서 | 쓰임 |
|---|---|
| [01_RULES.md](01_RULES.md) | 공식 출처, 게임 규칙 R01–30, 인물 C01–16, 명시적 구현 결정 D01–10 |
| [02_PRODUCT_UX.md](02_PRODUCT_UX.md) | 화면·입력·오류·모바일·에셋 요구사항 |
| [03_ARCHITECTURE.md](03_ARCHITECTURE.md) | 패키지 경계, 순수 엔진, 영속 상태, 세션·보안 |
| [04_PROTOCOL.md](04_PROTOCOL.md) | 명령·응답·버전·멱등성·동기화 계약 |
| [05_EXECUTION_PLAN.md](05_EXECUTION_PLAN.md) | T01 이후 기본 계획과 통합 acceptance, 구현 중 추가된 보완 작업의 의존성·파일 소유권·완료 기준 |
| [06_ACCEPTANCE_TESTS.md](06_ACCEPTANCE_TESTS.md) | 97개 Given/When/Then 수락 시나리오 명세 |
| [07_READINESS.md](07_READINESS.md) | 결정 기록, 출시 전 운영 체크, 남은 작업 구분 |
| [prompts/ORCHESTRATOR.md](prompts/ORCHESTRATOR.md) | 루트 에이전트의 배정·통합·리뷰 절차 |
| [prompts/AGENT_TASK_TEMPLATE.md](prompts/AGENT_TASK_TEMPLATE.md) | 작업자에게 한 작업씩 전달하는 프롬프트 |

## 바로 쓸 데이터

| 파일 | 내용 |
|---|---|
| [data/base-deck.json](data/base-deck.json) / [CSV](data/base-deck.csv) | 개별80장, 고유 definitionId, typeId, rank, suit, copyIndex |
| [data/card-types.json](data/card-types.json) | 22종, 수량, 색상, 한국어 에셋 경로 |
| [data/characters.json](data/characters.json) | 16명, 기본HP, 규칙ID, 에셋 경로 |
| [data/roles.json](data/roles.json) | 역할 및 4~7인 배분 |
| [data/catalog-summary.json](data/catalog-summary.json) | 사용 주의점과 수량 요약 |
| [data/sources.json](data/sources.json) | 공식 출처 URL·확인일·원본 SHA-256 |
| [data/task-index.csv](data/task-index.csv) | 작업 의존성·소유 경로·수락 기준과 최신 상태 |

`assetPath`는 이 문서가 있는 development-plan 폴더 기준이다. 실제 앱에 복사할 때 T05/T54가 public URL로 변환한다. `definitionId`는 공개 카탈로그의 항목 키다. 숨긴 실제 카드의 `cardInstanceId`로 쓰면 카드 종류가 노출되므로 매치 시작 때 별도 불투명 ID를 생성한다. Stagecoach 두 장은 **둘 다 Spade9**이며 숫자·무늬 조합을 unique key로 쓰면 안 된다.

## Luna max 병렬 개발 운영

이 준비 문서 작성에도 Luna max 작업자3명을 사용해 UX·아키텍처·작업 계획을 병렬 작성하고 루트에서 규칙·데이터·수락 기준을 통합했다. 모델이 한 번에 전체 게임을 완벽히 구현한다고 전제하지 않는다.

1. 루트1명 + 작업자최대3명. 한 작업자는 한 번에 T-ID 하나만 맡는다.
2. T01~T26, T28~T33, T35, T43~T54, T61/T62/T63/T64/T65/T66/T68/T70/T71은 루트의 작업별 검토와 기록된 검사 근거를 거쳐 DONE이다. T20 결투는 엔진 검사와 전용 테스트 5/5에서 거리 무관 대상, 대상부터 교대 응답, 포기/응답 소진, Calamity 변환, BANG 사용량 비증가 및 개시자 자기 탈락 보상 없음을 확인했다. T21 감옥은 엔진 검사와 전용 테스트 7/7에서 대상 제한, 차례 시작 판정, 판단/감옥 버림 순서, 덱 재활용/고갈, 다이너마이트 선행 전제를 확인했다. T22 다이너마이트/배럴은 전용 테스트 11/11에서 폭발/전달·R08·D05·책임자 없는 피해·Barrel 및 Slab 응답을 확인했고 forged responder 차단도 검사했다. T22/T18 Barrel 실패 뒤 다음 방어 응답의 runtime 재개는 T66에서 검증했다. T23 무기/거리 장비 전용 테스트 5/5, T24 손패 제한 전용 테스트 6/6, T43 repository 8/8, T46 relay PGlite 9/9가 통과했다. 외부 PostgreSQL 여러 연결 잠금 경합은 미검증이다. T44/T64 저장소 경로는 PGlite DB의 migration/서비스 테스트를 통과했다. T47 인증 sync projection/outbox 무효화와 T48 저장 상태 재접속/격리는 루트 검토 및 전용 테스트를 통과했다. T49는 server check, PGlite Socket runtime 3/3, recovery tests 2/2 및 persistent local smoke로 DONE이며 실 PostgreSQL TLS/auth/다중 연결 경합은 미검증이다. T65 공용 인물 contract, T66 effect runtime, T68 viewer DTO, T70 공용 R08 supplier, T71 BANG quota boundary 및 T72 RoomView activeMatchId contract는 지정 API/전용 검사를 통과했으며 통합 AT는 미실행이다. T25 Bart와 T35 Rose는 전용 테스트/engine check를 루트에서 재검증해 완료했다. T27 Calamity는 T71 성공 PLAY_CARD quota 경계와 연동해 루트 재검증 tests/check를 통과해 DONE이다. T26 Black Jack은 전용 tests 6/6, T32 Lucky는 3/3 및 engine check를 통과해 완료했다. T33 Paul Regret은 전용 테스트 3/3과 engine check를 통과했으며 통합 AT는 미실행이다. T12는 해결 cursor, 피해자 전용 구조, 정확한 버림 순서와 재개 테스트를 구현했다. T14 엔진 명령 처리와 T16 기본 행동 카드 및 T17 Panic/Cat 효과는 DONE이다. T16 전용 테스트 11/11, T17 전용 테스트 8/8, T18 광역 효과 9/9, T19 드로우/선택 7/7이 통과했으며, 통합 AT는 미실행이다. T02 preview/sync DTO와 T45 session gateway 단위 테스트도 완료됐다. T51 방 진입 UI 및 T52 로비 테스트 9/9, T53 테이블 UI 및 T54 이미지 렌더러는 모듈 테스트/build를 통과했으나 실제 transport·라우트·쿠키 동작과 browser visual review는 T58/T60 통합에서 확인한다. T44는 초대 코드 원문을 DB에 저장하지 않으므로 CREATE_ROOM 최초 ACK 유실 뒤 같은 commandId로 receipt를 재조회해도 invite를 복구할 수 없다. T54의 카드 렌더러는 한국어 42개 이미지를 public 경로로 연결했으며 T63은 공개 덱 잔여 장수 projection을 연결했다. 97개 AT를 통합 성공으로 기록한 항목은 아직 없다.
3. 공용 상태·reducer·효과 API를 고정한 후 카드/인물 모듈을 병렬화한다.
4. 작업 패킷은 관련 규칙 절, 고정 DTO, 허용 경로, 수락 케이스만 담는다. 전체 규칙을 매번 재해석하게 하지 않는다.
5. 구현 에이전트의 완료 주장 뒤 루트가 diff·계약·증거를 검토한다. REVIEW 상태를 DONE과 혼동하지 않는다.
6. 막힌 규칙이나 공용 API 변경은 독단 해결하지 않고 루트에 제안한다. 다른 독립 작업은 계속한다.

### 개발 시작용 프롬프트

```text
outputs/development-plan/00_README.md와 prompts/ORCHESTRATOR.md를 기준으로
BANG! 기본판 온라인 게임을 구현해주세요.
작업자는 gpt-6-luna, reasoning effort max로, 동시 최대3명 사용하세요.
먼저 T01을 완료하고 의존성이 DONE인 작업만 한 번에 하나씩 배정하세요.
공용 계약은 단독 소유자로 관리하고, 05_EXECUTION_PLAN의 파일 소유권을 지키세요.
01_RULES의 공식 규칙과 명시적 구현 결정을 적용하고 새 규칙을 추측하지 마세요.
06_ACCEPTANCE_TESTS를 기준으로 구현 테스트를 작성·실행하여 검증해주세요.
97개 수락 케이스의 미검증 항목을 통과로 기록하지 마세요.
로컬에서 전체 흐름을 완성하고 결과를 보고해주세요. 외부 배포는 별도 단계입니다.
```

## 근거와 한계

기준은 [공식 4판 규칙서](https://www.dvgiochi.com/giochi/bang/download/Bang_rules_ENG.pdf), [공식 FAQ](https://www.dvgiochi.com/giochi/bang/download/Bang!_FAQ_ENG.pdf), [공식 카드 목록](https://bang.dvgiochi.com/cardslist.php?id=1&lang=en)이다. 최신 [공식 대회 문서](https://www.dvgiochi.com/bang_champ/MaterialeCampionato/BANG!%20Campionato%20nazionale_Regolamento-daTorneo.pdf)의 **일반 기본판 FAQ만** 보충 적용한다. 대회 변형 규칙은 제외했다.

공식 문서가 온라인 순서까지 정하지 않는 항목은 01_RULES §8에 제품 결정으로 표시했다. 특히 Sid의 상세 타이밍과 자기 Panic/Cat 대상 범위를 공식 인용과 구분했다. 현재 워크스페이스, 공유 계약, 카탈로그 스키마, 브라우저 앱 셸 및 웹 기반 설정이 완료됐다. `pnpm install --frozen-lockfile`, `pnpm check`를 실행할 수 있다. 게임 규칙, 서버, 전체 브라우저 흐름 검증과 배포는 완료되지 않았다.














## Sites 이식 결정 (2026-09-29)

공개 실행은 Codex Sites Worker + D1 + same-origin HTTP/SSE이며, 기존 Node/Socket.IO/PGlite는 로컬 개발과 회귀 실행용이다. canonical v1 DTO와 기존 97개 acceptance baseline은 변경하지 않았다. Sites 전용 S01–S09 게이트는 별도 집계하며 D06/D18은 계속 NOT RUN이다. Workers Free/D1 Free quota와 사용 한도는 [03_ARCHITECTURE §12](03_ARCHITECTURE.md#12-sites-전용-공개-호스팅-보완-결정)에 따른다. T100 화면 골격과 T101 root build/D1 manifest가 완료됐다. D1 시작 저장은 engine seat rotation과 Node T91의 full `initializeGame → resolveTurnStart → executeTurnDraw` snapshot을 받아들이며, seed 1의 version/eventSeq `5/0`, `play` state를 저장한다. 이 초기 상태를 저장한 뒤 match 완료와 직접 재시작을 확인하는 회귀를 포함해 루트 단독 isolated Miniflare D1 suite **20/20**, `pnpm exec tsc --noEmit -p apps/site/tsconfig.json` 통과로 T102를 DONE 처리했다. 한 차례 TSC와 병렬 실행에서 Miniflare `fetch failed` 2건이 관찰됐지만, 단독 재실행에서는 20/20 통과했다. T103은 D1 게스트 세션·초대 제한·방 수명주기 HTTP handler를 추가했고, 루트 단독 실행 `node --import tsx --test test/server/session-room.test.ts` **6/6**, Site TypeScript check 통과 및 후속 T102 D1 회귀 **20/20**으로 DONE 처리했다. cookie/초대 비밀 경계, 동시 입장·시작, 초기 match 상태·완료 후 직접 재시작, 로비 복귀를 검증했으며 이 단위 검사는 S01–S09 또는 기존 97개 게임 acceptance에 포함하지 않는다. T104 착수 중 기존 `CommandAck`와 `MatchSyncResponse`의 strict shared response parser가 없는 것을 발견해 root 단독 계약 보완 T108을 선행 추가했고 T104는 보류했다. T104 route mounting/build와 T105 Sites HTTP/SSE app transport가 완료됐다. 원격 Cloudflare D1과 S01–S08 browser/runtime acceptance는 T106에서, 공개 배포는 T107에서 실행한다. 기존 **95/97**, D06/D18 NOT RUN은 그대로다.

T108은 기존 canonical `CommandAck`와 `MatchSyncResponse`를 변경하지 않고 strict shared parser 및 valid/invalid fixtures를 추가했다. 루트에서 `pnpm --filter @bang/contracts check`와 계약 테스트 **15/15**를 통과해 DONE 처리했다. T109는 기존 sync rejection body를 유지한 채 `RECOVERY_REQUIRED` code와 member-only match semantics를 추가했고, contract check/15 tests로 root review를 통과했다. T104는 Worker 매치 명령·sync·SSE handler와 recovery gate를 연결했다. 루트 재검증 `node --import tsx --test test/server/match-sync.test.ts` **6/6**, `pnpm exec tsc --noEmit -p apps/site/tsconfig.json`, `pnpm run sites:build`가 모두 통과했다. 테스트에서 atomic receipt/event/outbox, D1 CAS 경쟁, viewer projection, 미지원 저장 상태의 member-only recovery/no-write, 성공 receipt replay와 비회원 거절, SSE cursor 접근 경계를 확인했다. 이 단위 검사는 S01–S09나 기존 97개 게임 acceptance를 통과 처리하지 않는다. T105 Sites browser HTTP/SSE transport도 구현과 root checks를 통과했다. Remote D1, S01–S08 실 runtime/browser 흐름, 공개 배포는 아직 실행하지 않았다. 기존 통합 수락은 **95/97**, D06/D18은 NOT RUN이다.

T105는 기존 React 소비 surface에 `SitesGameTransport`를 구현했다. production Sites bundle은 HTTP/SSE 어댑터를 만들고 Socket.IO 의존은 production output에서 빠진다. 로컬 Vite 개발은 Socket.IO 어댑터를 lazy-load한다. Same-origin cookie 요청, strict protocol parser, command retry의 동일 ID/payload 유지, SSE invalidation 후 projection sync, hidden 탭 stream 종료와 visible 복귀 cursor 재연결을 focused tests **11/11** 및 앱 route tests **15/15**로 확인했다. web check/build, Sites build도 루트 재실행에서 통과했다. 기존 통합 baseline **95/97**, D06/D18 NOT RUN은 유지한다.

T110은 Drizzle source schema, generated migration SQL과 metadata, D1 first-request bootstrap을 완료했다. `pnpm run sites:db:check`, isolated migration/concurrency tests **3/3**, T102 storage **20/20**, T103 session-room **6/6**, T104 match-sync **6/6**, Site TypeScript check/build가 통과했다. fresh local Sites Worker에 첫 `GET /api/guest-sessions`를 보냈을 때 **204**가 반환됐다. `PRAGMA optimize`는 실제 isolated D1 실행을 확인했다. 아직 배포 D1 migration은 없다.

T111은 guest/room/match 흐름용 WebMCP 도구 7개를 추가하고, exact input 검증과 기존 transport/server command 경로를 사용하도록 연결했다. WebMCP tests **6/6**, web check/build가 통과했다. 현재 사용할 수 있는 Codex in-app browser는 WebMCP native tool 발견·호출 인터페이스를 제공하지 않아 native context의 valid/invalid tool 실행과 read-back은 **NOT RUN**으로 남겼다. Mock context의 등록·실패 처리·signal 수명주기와 도구 실행 로직은 검증했다. 다음은 T106 S01–S08 local runtime/browser gate이며, 기존 97-case 결과와 D06/D18은 변경하지 않는다.

T106의 로컬 Sites S01–S08 실행 증거를 2026-09-29에 기록하고 루트 검토해 DONE 처리했다. 실행은 35개 assertion 중 **29 PASS / 0 FAIL / 6 NOT RUN**, gate 기준 **2 PASS / 6 PARTIAL / 0 FAIL**이다. S01/S04는 전 assertion이 PASS이고, S02/S03/S05/S06/S07/S08의 미실행 조건은 NOT RUN을 유지한다. Site Miniflare tests **35/35**, web transport/route tests **20/20**, TypeScript check, Worker build, local Wrangler start/HTTP smoke/stop이 통과했다. HTTP smoke에서 4P와 7P의 방 생성·입장·준비·시작·viewer sync·legal `END_TURN`·정확한 receipt replay·SSE cursor reconnect를 각각 수행했다. Root의 in-app browser 한 context/profile에서는 `/` 및 `/rooms/new` route 표시만 봤으며, 전체 UI 4P/7P 게임, 독립 browser cookie contexts, Wrangler Worker restart recovery, secret log scans는 NOT RUN이다. Worker 프로세스는 종료됐고 port 8799는 비어 있다. 상세 assertion command/fixture/HTTP 근거는 [Sites 결과 JSON](../../apps/web/e2e/sites-results.json), [06 acceptance 기록](06_ACCEPTANCE_TESTS.md), [Sites README](../../apps/site/README.md)에 있다. 이는 통합 97-case 수락 결과가 아니며 기존 **95/97**, D06/D18 NOT RUN은 그대로다. T107에서 사용자 승인된 Codex Sites 공개 게시를 진행한다.
