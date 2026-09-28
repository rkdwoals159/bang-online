# 06. 구현 수락 시나리오

이 문서는 **향후 구현용 명세**다. 현재 실행한 테스트나 통과 결과가 아니다. 구현 요청 시 T42/T60 담당자가 테스트 코드를 작성하고 요청된 검증 범위에서 실행한다. 고정 RNG/덱/역할/HP fixture를 사용하고, 각 시나리오는 입력 전후 state 및 사용자별 projection을 함께 비교한다. 오류 시 HP·카드 위치·version 변화가 없어야 한다.

## 공통 fixture 계약

- 좌석 A→B→C→D→E→F→G는 시계 방향. 명시하지 않은 플레이어는 생존 HP4, 손패0, 장착없음. 보안관 A. 필요한 승리 조건을 막을 때 E 무법자 생존을 명시한다.
- 덱은 배열 첫 원소가 top. discard도 구현 내부 방향을 정하되 명세 배열은 먼저 버림→마지막 top 순서. runtime 카드 ID는 unique opaque ID다.
- 테스트 준비는 fixture builder로 유효한 80장 분배를 만든다. 한 카드를 여러 구역에 복제하지 않는다. 특정 카드가 부족한 비정상 상태는 명시적으로 corruption 사례라고 표시한다.
- 모든 명령에는 인증 actor, expectedVersion, commandId를 준다. pending 응답은 interactionId가 일치해야 한다.
- 각 케이스에 자동화 파일 경로·명령·실제 결과를 구현 시 붙인다. 아래 expected만으로 DONE 처리하지 않는다.

## A. 시작·턴·공간·덱

| ID | Given / When | Then | 규칙 |
|---|---|---|---|
| A01 | 4/5/6/7인 각각 시작 | 역할 구성이 R02와 일치, 보안관만 공개, 모든 인물 다름 |R01–03|
| A02 | Paul 보안관으로 시작 | max/start HP4, 손패4; 일반 Paul은3 |R03|
| A03 | 정상 시작 | 보안관부터, 나머지 순서 시계방향; 각 시작패 HP만큼 |R03|
| A04 | 역할 배정 snapshot을 각 actor로 요청 | 다른 비공개 역할과 손패 face/ID 없음 |R04|
| A05 | 정상 턴 시작→사용 종료 | draw2 후 PLAY; hand>HP면 DISCARD pending |R05,R07|
| A06 | HP3 손패5에서 턴 종료, 2장 순서 선택 | 선택한2장만 버림, 마지막 선택 top, 다음 생존자 |R07|
| A07 | 손패가 HP 이하에서 임의 버리기 | 거절, 동일 상태 |R07|
| A08 | 6명중 B,C 탈락; A가 D 공격 | 생존원 A,D,E,F 기준 최단거리 사용 |R10|
| A09 | A Rose+Scope, B Paul+Mustang | 기본거리+2−2, 최소1; 역방향 별도 계산 |R10|
| A10 | A Winchester, B까지 거리2에서 Panic | 거절; BANG은 거리≤5면 허용 |R11,R18|
| A11 | 덱1장, Stagecoach 사용 | 1장 뽑고 사용한 Stagecoach 포함 discard 재셔플 후 두 번째 뽑음 |R08|
| A12 | 덱0, discard 존재, Pedro 첫 카드 선택 | discard top 먼저 가져오거나 재셔플 후 덱 선택 가능 |R08,C10|
| A13 | 덱·discard0, 뽑기 필요 | 카드를 생성하지 않고 resource-exhausted 일시정지 |D05|
| A14 | Draw!에서 Beer 공개 | HP 변화 없음, 카드 손패로 안 감, discard로 이동 |R09|
| A15 | 동일 seed/fixture/commands 반복 | 동일 최종state/events, RNG state까지 재현 |불변조건|

## B. 22종 카드와 반응

| ID | Given / When | Then | 규칙 |
|---|---|---|---|
| B01 | 정상 A가 첫 BANG B에게; B Missed | 피해0, BANG count1, 두 카드 discard |R12–13|
| B02 | 같은 턴 두 번째 일반 BANG | 거절; 효과 없는 입력이 quota 증가시키지 않음 |R12|
| B03 | Volcanic으로 BANG2회 후 다른 무기 교체 | 추가 일반 BANG 거절, count 유지 |R12,R26|
| B04 | 사거리밖 BANG/자기 BANG/죽은 대상 | 모두 거절, 카드 안 버림 |R10–12|
| B05 | Barrel Heart/비Heart 두 fixture | Heart는 방어1; 실패면 Missed 또는 피해 선택 가능 |R13,R22|
| B06 | Slab BANG에 Barrel 성공 + Missed1 | 방어 성공; Barrel만 성공이면 아직 방어1 필요 |R13,C13|
| B07 | Slab BANG에 Missed1 쓰고 포기 | Missed는 소비, 피해1 |R13|
| B08 | Gatling 사용한 A가 이어 BANG 사용 | Gatling이 quota 소모 안 함, BANG 허용 |R19|
| B09 | Slab Gatling에 B Missed1 | 정상 방어 완료 |R19,C13|
| B10 | Indians 대상이 BANG 제출/포기 | 제출시피해0, 포기시피해1; Barrel/Missed 불가 |R20|
| B11 | Duel A→B | B 먼저 BANG, A,B 교대; 포기한 쪽 피해1, quota 변화없음 |R21|
| B12 | Calamity가 Indians/Duel에 Missed 제출 | BANG 변환 대응 허용 |C03|
| B13 | Calamity 자기턴 Missed로 공격 | BANG count1 증가, 대상 일반 방어 가능 |C03|
| B14 | HP만피 또는 생존자2명, 자기턴 Beer | 사용/버림은 가능, 회복0 |R14|
| B15 | 자기턴 HP2/max4에서 Beer | HP3, 다른 플레이어 회복 불가 |R14|
| B16 | 생존자2명 Saloon | 둘 다 max까지1회복; 죽은 좌석 부활 없음 |R15|
| B17 | Duel 치명상에 Saloon 사용 요청 | 구제 불가, 카드 소비 안 됨 |R15,R27|
| B18 | General Store, 생존5 | 정확히5 공개, 사용자부터5명이1장씩, 중복선택불가 |R17|
| B19 | Panic 상대 손패 선택 | 서버 RNG1장, 남의 hidden ID를 클라이언트에서 고르지 않음 |R18|
| B20 | Cat 상대 장착 선택 | 지정 카드 discard, 손패는 안 바뀜 |R18|
| B21 | 자기 Mustang에 Panic/Cat | Panic이면손패, Cat이면discard; 자기손패 대상은 거절 |D03|
| B22 | Stagecoach/Wells 사용 | 각각2/3 뽑기, 획득 face는 자기만 공개 |R16|
| B23 | 동일명 파란 카드 이미 장착 | 두 번째 동일명 사용 거절; 무기 다른명 교체는 기존 버림 |R06|
| B24 | Jail 보안관/자신 대상으로 사용 | 거절; 거리 먼 일반 상대는 허용 |R23|
| B25 | Jail 판정 Heart/비Heart | Jail은 항상 discard top; Heart 정상draw, 실패 전체턴skip |R23|
| B26 | 감옥 붙은 상대가 공격받음 | Barrel/Mustang 유효, 방어 입력 가능 |R23|
| B27 | Dynamite 판정 Spade2,9,10,A 각각 |2/9 폭발피해3,10/A 전달 |R24|
| B28 | Dynamite+Jail 함께 있는 턴 | Dynamite 먼저, 생존하면 Jail, 죽으면 Jail 판정 안 함 |R05,R24|
| B29 | Dynamite 비폭발, 다음 좌석 사망 | 다음 생존자에게 이동, 새 카드 생성 없음 |R24|
| B30 | 무기 없는 상대 기본 총에 Cat 요청 | 실물 카드가 아니므로 거절 |R11|

## C. 인물 능력·치명상·승리

| ID | Given / When | Then | 규칙 |
|---|---|---|---|
| C01 | Bart HP4 Dynamite3피해 | HP1 후 덱3획득 |C01|
| C02 | Bart HP1 BANG, 손패Beer0, topBeer | 능력 뽑기로 구제 못함, 탈락 |C01,R27|
| C03 | Bart HP1 BANG, 기존Beer1 | Beer구제 후 Bart1장 획득 |C01,R27|
| C04 | Black Jack 두번째 red/black | red추가1, black추가0; 두번째만 공개 |C02|
| C05 | El Gringo가 자신의 Duel에서 패배 | HP−1, 상대손패 탈취없음 |C04|
| C06 | El Gringo 상대 공격 생존/상대손패0 | HP감소, 빈 손패에서 생성/탈취없음 |C04|
| C07 | Jesse 첫뽑기 상대 손패 선택 | 서버 무작위1탈취, 두번째deck; 상대빈손 선택불가 |C05|
| C08 | Jourdonnais+Barrel, Slab공격, 둘다Heart | 판정2회로 방어2완료; 같은원천 재사용불가 |C06,C13|
| C09 | Kit top3 [X,Y,Z], X,Z선택 | 자기손패 X,Z; 덱top Y; 다른사용자는 셋face 모름 |C07|
| C10 | Lucky Jail 판정2장 Heart/Spade | Lucky가 선택한 카드만 판정에 사용, 둘다discard, Jail마지막 |C08,D04|
| C11 | Paul/Mustang 또는 Rose/Scope | 각각중첩2, 거리최소1 |C09,C11|
| C12 | Pedro discard첫카드 선택 | 해당top손패, 다음deck1; discard전체열람불가 |C10|
| C13 | Sid 자기턴 hand4 HP2/max4, 두번 비용 | 정확히4장 버려HP4, 임의장착카드 비용불가 |C12|
| C14 | Sid 다른카드 해결도중 비치명상 회복 | 거절; 자기 치명상 창에서만 예외 허용 |C12,D02|
| C15 | 생존자2명 Sid hand2 HP1에 피해1 | 비용2로HP1 생존; Beer 구제는무효 |D02|
| C16 | Suzy 마지막 General Store/Stagecoach/Wells Fargo 각각사용 | 각각 효과로1/2/3장획득, 능력추가뽑기0 |C14|
| C17 | Suzy 마지막 Duel 사용/응답 | Duel 끝날때까지 능력대기; 아직살아있고 손패0이면1 |C14|
| C18 | Suzy 손패Missed1, Slab공격, topMissed | 첫Missed후뽑아 두번째Missed대응 가능, 다시손패0이면뽑기 |C14|
| C19 | Suzy 마지막BANG→El Gringo 생존피해 | Suzy뽑기→Gringo탈취→Suzy다시뽑기 |C04,C14|
| C20 | Vulture생존, 다른플레이어탈락 | 손패+장착모두 Vulture손패, 장착효과자동적용없음 |C15|
| C21 | 폭발로탈락, Vulture생존 | Dynamite는회수안됨 |C15,R24|
| C22 | Sheriff Vulture가 Deputy처치 | 부관카드회수후 자신의카드까지 전부버림 |C15,R28|
| C23 | Willy가 BANG3회, 세번째사거리밖 | 첫2합법, 세번째거리오류 |C16|
| C24 | HP2 Dynamite3피해, Beer2 | 순서대로회복하여HP1; Beer1만쓰고포기면탈락 |R27|
| C25 | Outlaw가 Duel개시후자신탈락 | 상대가무법자보상3장 못받음 |R28|
| C26 | 다른플레이어가 Outlaw를 BANG처치 | 책임자가3장, 사망정리후 source변경없음 |R28|
| C27 | Dynamite로 Outlaw탈락 | 아무도처치보상없음 |R28|
| C28 | 탈락자손패2+장착1, Sam없음 | 본인이버림순서선택, 일반게임입력은거절 |R07,R28|
| C29 | Renegade Gatling로 Sheriff포함 나머지전멸 | 모든대상해결후 Renegade승리, 중간종료안함 |R29–30|
| C30 | Sheriff사망, 다른생존자2이상 | Outlaw진영승리, 이미죽은Outlaw도승리표시 |R30|
| C31 | Sheriff생존, 마지막Outlaw/Renegade탈락 | Sheriff+Deputy승리, 사망Deputy도공동승리 |R30|
| C32 | 종료후 PLAY_CARD | 거절, 역할전체공개/생존손패비공개 |R30,D08|

## D. 서버·클라이언트·운영

| ID | 조작 | 기대 결과 / 증거 |
|---|---|---|
| D01 | 같은commandId/payload 2회, 첫ACK 유실 | 원래receipt 재전송, 카드/HP/보상/version 1회만 변화 |
| D02 | 같은commandId에 다른payload | COMMAND_ID_REUSED, 변화없음 |
| D03 | 같은version에 동시 정상명령2개 | 하나만커밋, 다른쪽STALE_VERSION; 룰이중실행없음 |
| D04 | JSON에 actorId 또는 남의cardId 삽입 | strict validation/소유권검사 거절 |
| D05 | 남의match sync/임의socket room join 시도 | 존재/비공개내용노출없이거절 |
| D06 | 진행중모든플레이어 snapshot·ACK·오류·웹소켓frame 점검 | 다른손패face/ID·역할·덱순서·seed없음; D09에 따른 deckCount만 공개; legalActions로 숨은카드 추론불가 |
| D07 | 상대손패 임의선택 UI/서버 요청 | zone선택만허용, 서버무작위; opponent cardId 목록안내려옴 |
| D08 | Duel/구제/Lucky/버림순서/전체공격 cursor에서서버재시작 | 정확한pending·HP·카드·책임자·입력권 복구 |
| D09 | DBcommit전장애/commit후ACK전장애 | 전자는롤백, 후자는receipt재응답; outbox유실효과없음 |
| D10 | socket재접속, 브라우저새로고침, 같은세션두탭 | 같은좌석복구; 중복행동은version/receipt제어 |
| D11 | 비참가자/탈락자/방장 게임중kick 입력 | 권한대로거절; 탈락자 자기정리pending만예외 |
| D12 | 한참응답하지않거나연결끊음 | 타이머OFF이므로자동패스/탈락없음, 상태보존안내 |
| D13 | 모바일360px/데스크톱, 키보드만사용 | 대상·방어·구제·순서선택 가능, 포커스명확, 확대카드닫기가능 |
| D14 | 동일타입 다른rank/suit 80장 렌더 | 인스턴스값과표시일치, 원본인쇄값겹침없음; 2장의Stagecoach9Spade는구별ID |
| D15 | 이미지누락/지연 | 텍스트이름+rank/suit+효과가독, 선택막히지않음 |
| D16 | 3명/8명으로시작 또는누군가미준비 | 시작거절; 4~7전원준비만허용 |
| D17 | 초대코드추측폭주/긴표시명/HTML표시명 | rate limit/길이제한/텍스트이스케이프, 서버stack안노출 |
| D18 | 종료후다시시작 | 새matchId, 새덱/역할/seed, 이전secret재사용없음 |
| D19 | 전체기본판한게임 4인 및7인 | 준비→시작→턴→대응→탈락→결과→재대기실 증거; 적어도한번재접속 포함 |
| D20 | 카드이동·재셔플·탈락·보상 매단계 | 카드80장보존, 중복소유0, 음수handCount0, pending담당자유효 |

## 완료 보고 양식

`케이스 ID / 구현 파일 / 실행 명령 / 실제 결과 / 실패 로그 위치 / 재현 seed / 미검증 이유`를 기록한다. UI 사진만으로 서버 비밀성이나 멱등성을 통과 처리하지 않는다. 정적 코드 검토만 수행한 항목은 실행 통과와 구별한다. D05 자원고갈 정책과 D03 자기손패 대상 정책은 공식 판정 증명 대신 선택한 ruleset 계약의 일관성을 검사한다.

# Sites 이식/배포 확인 게이트 (기존 97개 케이스에 포함하지 않음)

다음 호스팅 게이트는 기존 AT-A01~AT-D20 97개 시나리오와 별도다. 해당 게이트를 검증해도 기존 D06/D18 또는 다른 `NOT RUN` 케이스 상태를 바꾸지 않는다.

| Gate | Given / When | Then |
|---|---|---|
| S01 Worker build | 앱이 Sites Worker-compatible output으로 빌드됨 | root `dist/server/index.js`가 default `fetch()`를 내보내고 정적 게임 assets와 favicon이 포함되며 `pg`, Socket.IO server/client가 Worker bundle dependency로 들어가지 않는다. |
| S02 guest/session HTTP | 세션 없음, 유효 쿠키, 변조·만료 쿠키로 기존 T81 routes 요청 | 기존 success/204/401 shape, HttpOnly·Secure·SameSite=Lax, no-store가 일치하고 raw secret은 JSON/DB/log에 없다. |
| S03 invite abuse | 여러 Worker request에서 같은 IP+guest로 invite 실패/성공 JOIN을 섞음 | T90/T94 실패 5회, 6번째 제한, delay/rolling expiry/success reset이 D1 경쟁 상태에서도 동일하고 유효한 초대 상태 오류는 실패 횟수에 포함되지 않는다. |
| S04 atomic D1 room commands | 동일 command ID replay/hash mismatch, stale version, concurrent start/join | 기존 protocol 결과가 유지되고 room/player/match/receipt/outbox의 전부 또는 전무가 보장된다. 중복 START_MATCH가 새 역할/카드 배정이나 새 match를 만들지 않는다. |
| S05 match command atomicity | 같은 match version에 두 브라우저가 서로 다른 명령을 동시 제출, ACK 뒤 command replay | 하나만 해당 버전으로 commit되고 다른 요청은 stale를 받는다. replay는 원 응답이며 state/event/receipt/outbox가 중복 변경되지 않는다. |
| S06 viewer sync privacy | 방 참가자·비참가자·생존/탈락 viewer별 room/match sync 요청 | strict parser 통과하는 canonical DTO만 반환하고 다른 플레이어 손패/숨은 역할/덱 순서/internal context가 response, SSE, HTML 또는 로그 어디에도 없다. |
| S07 SSE revalidation | 탭이 열림/숨김/종료/네트워크 단절 중 다른 플레이어가 command 실행 | 현재 membership의 ID/version 무효화만 수신하고 sync 후 canonical projection으로 화면이 바뀐다. hidden/closed 탭은 stream을 닫고 reconnect 때 마지막 cursor와 full sync로 누락 변경을 복구한다. |
| S08 fresh D1 recovery | Worker 인스턴스/테스트 runtime을 재생성하고 게임은 D1에 저장된 상태 | 같은 seat, role, hand, pending cursor 및 command receipt를 복구하고 메모리 cache/새 RNG에 의존하지 않는다. unsupported schema는 안전하게 격리한다. |
| S09 deployment access | 공개 Site 버전이 저장/배포 완료 | 성공 배포 URL에서 초대 방 생성부터 4인/7인 게임과 재접속 경로가 수행되고 access mode는 사용자가 요청한 public이다. 단일 플레이어 smoke만으로 게임 완료 수락이라 기록하지 않는다. |

## T106 로컬 Sites S01–S08 실행 기록 (2026-09-29)

이 결과는 위 S01–S09 호스팅 게이트와 기존 AT-A01~AT-D20의 97-case 결과와 별개다. 로컬 runner 최종 재실행은 **29 PASS / 0 FAIL / 6 NOT RUN** (35 assertions), 게이트 합계는 **2 PASS / 6 PARTIAL / 0 FAIL**이다. S01과 S04만 전 assertion이 PASS다. S02, S03, S05, S06, S07, S08의 미실행 subcondition은 아래에 그대로 NOT RUN으로 남긴다. 결과 JSON은 [sites-results.json](../../apps/web/e2e/sites-results.json)에 assertion별 명령, fixture, 실행 결과와 함께 저장했다. 재현 절차와 범위는 [Sites README](../../apps/site/README.md), live Worker HTTP 검사 코드는 [worker-http-smoke.mjs](../../apps/site/e2e/worker-http-smoke.mjs)에 있다.

실행 명령은 `apps/site`에서 `node e2e/run-sites-acceptance.mjs --base-url=http://127.0.0.1:8799`이다. runner가 사이트 단위 테스트 35/35, web Sites transport/route 테스트 20/20, Site TypeScript check, Worker build를 먼저 실행하고, 이후 로컬 Wrangler Worker를 같은 loopback URL에 시작해 HTTP 검사를 실행한 뒤 Worker process tree를 종료했다. JSON에는 build, Worker start/stop을 포함해 각 command exit/status가 기록된다. Local Worker direct URL 검사에서 `/`와 `/rooms/t106-direct-route`는 HTML 200, `/assets/cards/playing/01_bang.png`는 `image/png` 200 (116,634 bytes), `/favicon.svg`는 `image/svg+xml` 200, `/api/t106-unknown-route`는 `NOT_FOUND` JSON 404였다. 42개 Korean PNG asset 및 favicon, default Worker fetch export, 48개 emitted JS bundle의 `pg`/Socket.IO dependency 부재도 확인했다.

| Assertion | 상태 | 명령 / fixture / 실행 증거 |
|---|---|---|
| S01-A1 | PASS | `workerHttpSmoke` / `S01.worker-default-fetch`; `dist/server/index.js` default fetch export |
| S01-A2 | PASS | `workerHttpSmoke` / `S01.static-assets`; `dist/client`의 카드·역할·인물 PNG 42개와 `favicon.svg` |
| S01-A3 | PASS | `workerHttpSmoke` / `S01.worker-dependency-boundary`; 48개 emitted JS bundle 검사 |
| S01-A4 | PASS | `workerHttpSmoke` / `S01.local-html-and-static-http`; loopback direct URL·PNG·favicon·safe API 404 HTTP 증거 |
| S01-A5 | PASS | Root의 수동 CUA; 한 in-app browser context/profile의 별도 탭에서 `/` 및 `/rooms/new` 표시 확인. route smoke로만 인정 |
| S02-A1 | PASS | `workerHttpSmoke` / `S02.session-http`; session HTTP 204/201/200/401 및 유효·변조 쿠키 |
| S02-A2 | PASS | `workerHttpSmoke` / `S02.session-http`; `no-store`, `HttpOnly`, `Secure`, `SameSite=Lax` |
| S02-A3 | PASS | `siteMiniflareTests` / `guest cookie create/restore is Worker-safe, expires correctly, and assigned-room restore is identity-scoped`; JSON credential 제외 및 D1 SHA-256 token hash |
| S02-A4 | NOT RUN | Worker 요청/오류 로그 전체에서 raw credential scan 미실행 |
| S03-A1 | PASS | `siteMiniflareTests` / `invite preview is strict and redacted; persistent limiter honors peer IP, backoff, and successful JOIN reset`; 고정 시계 HTTP fixture |
| S03-A2 | PASS | `siteMiniflareTests` / `D1 invite limiter persists reservations across limiter instances and admits at most five`; isolated D1 공유 reservation fixture |
| S03-A3 | PASS | `siteMiniflareTests` / `D1 invite limiter success JOIN reset clears prior failures and retry backoff`; isolated D1 JOIN-reset fixture |
| S03-A4 | NOT RUN | 실패 abuse를 서로 재시작/격리한 real Worker process들에서 반복하는 fixture 미실행 |
| S04-A1 | PASS | `siteMiniflareTests` / `concurrent JOIN is single-writer; room receipts replay and command hash mismatch is rejected`; receipt replay/hash mismatch |
| S04-A2 | PASS | `siteMiniflareTests` / `room ready/owner/version guards and concurrent START_MATCH persist the full initialized snapshot once`; stale version no-write |
| S04-A3 | PASS | `siteMiniflareTests` / `concurrent JOIN is single-writer; room receipts replay and command hash mismatch is rejected`; same-version writer 경쟁 |
| S04-A4 | PASS | `siteMiniflareTests` / `room, player, receipt, and outbox writes roll back together on statement failure`; D1 rollback rows/guards |
| S04-A5 | PASS | `workerHttpSmoke` / `S04-S07.worker-4p-http-flow` + `S04-S07.worker-7p-http-flow`; local Worker 4P와 7P guest/create/join/ready/start/sync |
| S05-A1 | PASS | `siteMiniflareTests` / `D1 expected-version CAS allows one writer for concurrent match commands`; same-version match race |
| S05-A2 | PASS | `siteMiniflareTests` / `Worker match commands resolve effects and turn continuations with atomic receipts and stale no-write behavior`; exact ACK replay and no duplicate state/event/outbox |
| S05-A3 | PASS | `workerHttpSmoke` / 4P 및 7P flow fixtures; legal current actor `END_TURN` 및 exact replay duplicate ACK |
| S05-A4 | NOT RUN | 서로 다른 cookie를 가진 2개 browser context의 same-version concurrent command 미실행 |
| S06-A1 | PASS | `siteMiniflareTests` / `room and match sync use strict canonical parsers and viewer-scoped private projections`; member/outsider fixture |
| S06-A2 | PASS | `workerHttpSmoke` / 4P 및 7P flow fixtures; live strict match sync와 viewer-private projection |
| S06-A3 | PASS | `siteMiniflareTests` / `unsupported match schema and ruleset disclose recovery only to members and never mutate state`; member/outsider no-write fixture |
| S06-A4 | PASS | `workerHttpSmoke` / 4P 및 7P flow fixtures; member SSE allowlist |
| S06-A5 | NOT RUN | 모든 browser HTML 및 Worker log에 대한 hidden-projection/internal-context sentinel scan 미실행 |
| S07-A1 | PASS | `siteMiniflareTests` / `SSE refreshes membership before cursor reads, emits only allowlisted data, and resumes after cancellation`; membership/cursor/cancel/reconnect fixture |
| S07-A2 | PASS | `workerHttpSmoke` / 4P 및 7P flow fixtures; live allowlisted SSE와 last-cursor reconnect 후 match version 확인 |
| S07-A3 | PASS | `webTransportAndRoutes` / `SSE messages only invalidate, hidden streams close, and visible reconnect resumes the cursor`; fake EventSource/visibility fixture, browser test 아님 |
| S07-A4 | NOT RUN | 실제 game tab hide/close/network loss 후 browser full-page sync 미실행. 단일 in-app context/profile의 route smoke와 mock/Worker HTTP·SSE만 있음 |
| S08-A1 | PASS | `siteMiniflareTests` / `fresh Miniflare D1 runtimes are isolated and persisted receipts survive repository recreation`; repository recreation 및 runtime isolation |
| S08-A2 | PASS | `siteMiniflareTests` / `START_MATCH persists the initialized turn-start/draw snapshot and restarts the completed match`; full initialized snapshot/completed restart fixture |
| S08-A3 | PASS | `siteMiniflareTests` / `unsupported state schema is returned as a safe recovery error` 및 member-only sync fixture |
| S08-A4 | NOT RUN | Wrangler Worker process restart 뒤 same guest/seat/role/hand/pending cursor/command receipt 복구 미실행 |

Command ID의 전체 실행 문자열과 exit code/status, top-level test fixture 원문, live HTTP detail은 result JSON의 `commands` 및 `gates[].assertions[]`에 있다. `siteMiniflareTests`는 `apps/site`에서 `node --import tsx --test test/storage/migrations.test.ts test/storage/d1-storage.test.ts test/server/session-room.test.ts test/server/match-sync.test.ts`로 35/35 PASS했다. `webTransportAndRoutes`는 root에서 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/web/test/sites-transport.test.mjs apps/web/src/app/routes.test.mjs`로 20/20 PASS했다. 다른 local command는 Site `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`, Site `node scripts/run-framework.mjs build`, smoke syntax `node --check e2e/worker-http-smoke.mjs`, 그리고 runner가 빌드 뒤 loopback에 실행한 `node --import tsx e2e/worker-http-smoke.mjs`이다. Runner가 시작한 Worker는 최종 검사 후 종료됐고 port 8799는 더 이상 listen하지 않았다. Public deployment, remote D1, S09는 T106 범위 밖이라 NOT RUN이다.

이 보충 실행은 기존 **95/97** 집계와 D06/D18 기록을 수정하지 않았다. S05/S07 full browser flows, S08 real Worker process restart 및 S02/S06 log scan 등 위 NOT RUN은 PASS로 환산하지 않는다.
