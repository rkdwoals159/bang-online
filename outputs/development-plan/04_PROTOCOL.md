# 04. 클라이언트·서버 프로토콜 제안

> **문서 성격:** 구현 전 제안 계약. 이벤트/필드 이름은 TypeScript 공유 DTO를 만들기 위한 초안이다. 게임 규칙은 [01_RULES.md](01_RULES.md)의 D01~D08 및 프로젝트 루트의 최종 조정에 맞춘다.
>
> 모든 클라이언트 입력은 신뢰할 수 없는 JSON이다. `actor`/`actorId`는 입력에서 받지 않는다. actor는 게스트 세션 인증으로 서버가 정한다.

## 1. 전송과 공통 규칙

- 앱 API는 HTTPS, 게임 실시간 명령은 Socket.IO 이벤트로 보낸다. Socket.IO는 메시지 순서를 보장하지만 기본 전달은 최대 한 번이다. 연결이 끊긴 동안 서버가 놓친 이벤트를 자동 저장해 주지 않으므로 명령 재시도는 애플리케이션 idempotency와 DB receipt를 기준으로 처리한다.
- JSON은 `protocolVersion: 1`을 포함한다. 알 수 없는 필드나 enum 값을 조용히 무시하지 않고 입력 스키마를 거절한다. 손패·역할 등 응답 전용 private DTO 타입을 명령 스키마로 재사용하지 않는다.
- 명령의 `commandId`는 클라이언트가 생성한 UUID다. 같은 논리 명령을 재시도할 때 같은 ID와 동일 payload를 사용한다. 다른 payload에 같은 ID를 재사용하면 오류다.
- `expectedVersion`은 변경하려는 room 또는 match의 마지막으로 받은 정수 버전이다. 정상 커밋 한 건은 해당 집계의 버전을 한 번 올린다. 버전 충돌 때 클라이언트는 먼저 sync하고 나서 필요하면 새로운 명령 ID로 다시 요청한다.
- 매치 명령에는 `matchId`가 필수다. 방 명령에는 `roomId`가 필수다. 방 생성은 아직 ID가 없으므로 별도 `room:create` 명령을 쓴다.
- MVP 게임 행동 timeout은 OFF다. ACK/HTTP/network timeout은 통신 실패를 감지하는 전송 제한일 뿐 게임 행동을 자동 진행시키지 않는다.
- 버전/actor 검사 기준은 DB의 권위 상태다. client clock, 브라우저 순서, 화면의 버튼 enabled 상태는 권한의 근거가 아니다.

## 2. 인증, 게스트 생성과 방 입장

### 2.1 게스트 세션 생성

```http
POST /api/guest-sessions
Content-Type: application/json
```

```json
{
  "protocolVersion": 1,
  "displayName": "강가의 여우"
}
```

서버는 정규화된 표시명 및 `playerId`를 만들고 HttpOnly/Secure 쿠키로 세션 credential을 설정한다. JSON에는 만료 전 유출되어 재사용될 수 있는 원본 credential을 되돌려 주지 않는다.

```json
{
  "protocolVersion": 1,
  "player": { "playerId": "p_...", "displayName": "강가의 여우" },
  "sessionExpiresAt": "2026-10-01T00:00:00Z"
}
```

세션 생성 요청의 허용 표시명 길이/문자, 금칙어와 예약 이름은 별도 제품 정책이다. 표시명은 identity가 아니므로 서버 생성 ID와 무관하게 중복될 수 있다. 사용자는 쿠키 세션을 가진 때에만 같은 identity로 재접속한다.

### 2.1.1 쿠키 세션 복원과 좌석 조회

새로고침 뒤 클라이언트가 JavaScript에서 credential을 읽거나 저장하지 않고도 기존 게스트 화면과 좌석을 복원하도록 다음의 읽기 전용 endpoint를 제공한다. 두 요청 모두 credential은 브라우저가 보내는 HttpOnly session cookie에서만 가져오며 응답은 `Cache-Control: no-store`다.

```http
GET /api/guest-sessions
```

유효한 세션이면 200으로 §2.1과 같은 `GuestSessionResponse`를 반환한다. cookie가 없거나 credential이 만료·폐기·무효이면 204와 빈 본문을 반환한다. 이 조회는 새 세션을 만들거나 세션을 연장하지 않는다.

```http
GET /api/guest-sessions/rooms
```

유효한 cookie 세션이면 200으로 그 `playerId`가 현재 배정된 `RoomView[]`만 반환한다. 좌석이 없으면 빈 배열이다. cookie가 없거나 credential이 유효하지 않으면 401 `{ "error": { "code": "SESSION_EXPIRED" } }`를 반환한다. 각 RoomView는 요청 player의 viewer identity 및 해당 멤버십을 서버가 다시 확인해 만든다. endpoint는 초대 코드·세션 credential·매치 전체 상태를 반환하지 않으며 `room:sync`/`match:sync`를 대체하지 않는다. 클라이언트는 이어서 해당 room/match ID로 sync하여 최신 projection을 받아야 한다.

### 2.2 연결 핸드셰이크와 인증

웹과 소켓은 동일 origin을 우선 사용한다. Socket.IO 연결 middleware에서 쿠키 세션을 확인하고 `socket.data.playerId`에 서버 조회 identity를 둔다. `skipMiddlewares` 형태로 재연결 인증을 건너뛰지 않는다. Socket.IO middleware는 연결마다 한 번 실행되므로 매치/방 권한은 각 명령과 sync 요청에서도 별도 확인한다.

연결이 만들어졌다고 플레이어가 특정 room에 자동 참여하는 건 아니다. 서버는 authenticated `playerId`와 DB membership을 확인한 뒤 다음 서버 전용 채널에 join시킨다.

```text
lobby:<roomId>      대기실 참가자
match:<matchId>     해당 판의 등록 플레이어(탈락자 포함)
player:<playerId>   동일 게스트가 여러 탭/장치에서 받는 자기 알림
```

클라이언트는 임의 채널명에 직접 join할 수 없다. 실제 Socket.IO room 이름은 이 프로토콜의 응답 payload로 반환하지 않는다.

### 2.3 입장 사전 확인과 초대 코드

`room:preview` 요청은 아래 키만 가진다. `requestId`와 `inviteCode`는 UTF-16 code unit 기준 1–256자의 문자열이고, 프로토콜 버전은 정수 `1`이다. 런타임 파서는 누락 키와 알 수 없는 키를 모두 `BAD_REQUEST`로 거절한다.

```json
{
  "protocolVersion": 1,
  "requestId": "req_preview_...",
  "inviteCode": "ABCD-EFGH"
}
```

성공 응답은 다음 필드만 포함한다. `version`과 `occupancy`는 0 이상의 안전한 정수이고, `status`는 room 상태 enum `waiting`, `starting`, `in_game`, `paused`, `completed`, `closed` 중 하나다.

```json
{
  "protocolVersion": 1,
  "requestId": "req_preview_...",
  "roomId": "r_...",
  "version": 3,
  "occupancy": 2,
  "status": "waiting"
}
```

거절 응답은 다음 형태다. 형식 오류는 `BAD_REQUEST`; 초대 코드가 잘못됐거나 존재하지 않거나 요청자가 입장 권한이 없으면 모두 `INVITE_INVALID`다. 이 경우는 같은 응답 shape/code를 사용해 방의 존재 여부나 초대 권한을 드러내지 않는다. 시도 제한에 걸리면 초대 유효성 조회를 수행하지 않고 `RATE_LIMITED` 및 양의 정수 `retryAfterMs`를 돌려준다.

```json
{
  "protocolVersion": 1,
  "requestId": "req_preview_...",
  "status": "rejected",
  "error": { "code": "INVITE_INVALID" }
}
```

초대 제한 응답은 `error`에 `code`와 `retryAfterMs`만 포함한다. 다른 거절 코드는 기존처럼 `error: { code }` shape를 사용한다.

```json
{
  "protocolVersion": 1,
  "requestId": "req_preview_...",
  "status": "rejected",
  "error": { "code": "RATE_LIMITED", "retryAfterMs": 1000 }
}
```

성공·거절 응답 DTO에는 원초대 코드와 세션 credential을 포함하지 않는다.

입장 흐름은 다음과 같다.

1. 클라이언트가 초대 링크/코드와 함께 `room:preview`를 요청한다.
2. 서버는 invite hash를 확인해 preview DTO만 돌려준다. 초대 코드와 세션 secret은 응답에 싣지 않는다.
3. `room:command`의 `JOIN`에 초대 코드와 preview의 version을 `expectedVersion`으로 넣는다. 서버는 room 행을 잠그고 만료/용량/상태/중복 가입을 다시 확인한다.
4. successful join 후 정식 `RoomView`를 반환하고 서버가 소켓을 채널에 넣는다.

초대 링크는 세션 credential을 포함하지 않는다. 공유 링크에 초대 코드가 실리는 방식이라면 브라우저 referrer/접근 로그에 코드가 남지 않도록 배포 설정을 한다. 사람이 입력하는 짧은 코드만 쓸 경우 실패 시도 횟수 제한이 필수다.

## 3. 공통 명령 envelope

### 3.1 진행 중 매치의 명령

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "matchId": "m_7b...",
  "expectedVersion": 42,
  "type": "PLAY_CARD",
  "payload": {
    "cardInstanceId": "ci_...",
    "targetPlayerId": "p_..."
  }
}
```

스키마 계약:

```ts
interface MatchCommandEnvelope<TType extends string, TPayload> {
  protocolVersion: 1;
  commandId: string;
  matchId: string;
  expectedVersion: number;
  type: TType;
  payload: TPayload;
}
```

`actorId` 필드는 스키마에 존재하지 않는다. 유효하지 않은 JSON shape, 누락 필드, 불명 필드는 `BAD_REQUEST`다. 서버는 세션에서 actor를 구해 매치 seat과 비교한다. UI가 보내는 `targetPlayerId`, `cardInstanceId`, 선택 값은 참조 ID일 뿐이며 서버는 소유권·타깃 합법성·대기 응답자인지 다시 확인한다. Gatling/Indians 같은 전체 대상 효과는 `targetPlayerIds` 목록을 받지 않고 서버가 카드 시작 시점의 생존 좌석과 D01 순서로 큐를 만들며, 해당 순서는 snapshot에 저장한다.

### 3.2 대기실 명령

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "roomId": "r_31...",
  "expectedVersion": 5,
  "type": "SET_READY",
  "payload": { "ready": true }
}
```

대기실 타입 예시: `SET_READY`, `SET_RULESET`, `START_MATCH`, `RETURN_TO_LOBBY`, `CLOSE_ROOM`, `KICK_MEMBER`(시작 전만). `KICK_MEMBER`를 `IN_GAME`에서 받으면 `ROOM_LOCKED`로 거부한다. 방장 여부도 세션 identity와 room owner 행에서 확인한다.

`RETURN_TO_LOBBY`는 현재 방장만 종료된 매치에서 실행할 수 있다. 매치가 아직 진행 중이면 거부하며 게임을 취소하지 않는다. 성공은 방 상태를 `waiting`으로 바꾸고 같은 방 좌석을 유지하되 모든 참가자를 `ready=false`로 초기화한다. 완료된 match snapshot/receipt/event는 보존한다. 방 변경은 room version, command receipt, room outbox와 원자 커밋한다. 새 RoomView는 `activeMatchId: null`을 주고 모든 참가자는 같은 대기실에서 다시 준비한다.

별도 경로로, 종료된 매치가 있는 방에서 owner가 `START_MATCH`를 바로 제출할 수 있다. 현재 roster가 그대로이고 모든 좌석이 여전히 ready일 때만 기존 start guard로 새 match ID 및 새 초기화 상태를 원자 생성한다. 진행 중인 매치가 있으면 계속 `ROOM_LOCKED`다. 이 직접 재시작 경로는 대기실 복귀/ready reset을 대신하지 않으며, `RETURN_TO_LOBBY` 뒤에는 전원 재준비가 필요하다.

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "expectedVersion": 0,
  "type": "CREATE_ROOM",
  "payload": { "capacity": 6, "rulesetVersion": "base4-ko-online-1.0", "displayName": "저녁 모임" }
}
```

방 생성 요청은 루트 aggregate가 아직 없으므로 `roomId`를 받지 않는다. 서버는 생성 트랜잭션을 직렬화하고 중복 ID에 같은 receipt를 돌려준다. 성공 응답에서 서버 생성 `roomId`, invite URL/token의 1회 표시 값, version을 돌려준다. DB에는 invite hash만 저장한다.

### 3.3 명령 type과 payload 정책

매치 명령의 네 가지 canonical `type`은 `PLAY_CARD`, `RESPOND`, `USE_ABILITY`, `END_TURN`이다. 요청 코드는 T02에서 이 enum을 구현하되, 이 문서가 command 의미와 payload 계약을 정한다. ruleset별 새 enum을 마음대로 만들지 않고 아래 discriminated payload 의미에 포함시킨다.

| type | payload 필드 | 적용 규칙 |
|---|---|---|
| `PLAY_CARD` | `cardInstanceId`, 필요한 경우 `targetPlayerId`, `targetZone`, `targetCardInstanceId`, `asCardType` | 카드 ID는 자신의 손패에서 확인한다. 숨은 손패 target은 `targetPlayerId`와 `targetZone: HAND`만 보낸다. 다중 대상 카드에 `targetPlayerIds`를 보내지 않는다. 전체 대상 순서는 서버가 D01대로 만든다. |
| `RESPOND` | `interactionId`, 현재 `pendingInteraction.options` 중 하나인 `choice`, 필요에 따라 `cardInstanceId`, `cardInstanceIds`, `selectedCardInstanceId`, `selectedCardInstanceIds`, `targetPlayerId`, `zone`, `source`, `orderedCardInstanceIds` | 현재 응답자·선택창·카드 소유권을 검사한다. 해당 pending kind의 strict payload schema에 정의된 필드만 허용한다. |
| `USE_ABILITY` | `abilityId`, 필요 시 `cardInstanceIds` | 서버가 가진 actor의 인물 능력만 실행한다. 예: Sid Ketchum 비용은 자기 손패 ID 정확히 2장. |
| `END_TURN` | `{}` | 정규 사용 단계를 닫는다. 손패가 현재 HP를 넘으면 서버가 `DISCARDS_ORDER`를 열고, 남은 선택 입력을 완료하기 전에는 다음 턴으로 가지 않는다. |

**pending 종류별 RESPOND payload**

| `pendingInteraction.kind` | 허용 actor / 요청 payload | 카드 ID 규칙과 후속 상태 |
|---|---|---|
| `BANG_RESPONSE` | 피해 대상 본인. `choice: USE_MISSED`와 자기 손패 `cardInstanceId`, `choice: USE_BARREL`, `choice: USE_JOURDONNAIS`, 또는 `choice: TAKE_HIT` | Barrel과 Jourdonnais는 각각 한 번만 시도한다. Slab처럼 방어 카드가 여러 장 필요한 경우 한 번에 한 장씩 응답을 열어, Suzy가 손패를 비운 뒤 뽑은 카드도 다음 응답에 사용할 수 있다. 타인의 손패 ID를 받지 않는다. |
| `INDIANS_RESPONSE` | 현재 대상 본인. `choice: USE_BANG`와 자기 손패 카드 1장, 또는 `choice: TAKE_HIT` | Calamity Janet 등 허용 변환은 서버 ruleset이 판정한다. |
| `GATLING_RESPONSE` | 현재 대상 본인. `choice: USE_MISSED`와 자기 손패 `cardInstanceId`, `choice: USE_BARREL`, `choice: USE_JOURDONNAIS`, 또는 `choice: TAKE_HIT` | Barrel과 Jourdonnais는 이 대상의 현재 응답에서 각각 한 번만 시도한다. 서버가 `effectQueue` 커서로 다음 대상만 지정한다. |
| `DUEL_RESPONSE` | 현재 Duel 응답자 본인. `choice: PLAY_BANG`와 자기 손패 카드 1장, 또는 `choice: YIELD` | 입력권을 다음 duel participant로 넘기며 source/reward 정보를 바꾸지 않는다. |
| `DEATH_RESCUE` | 피해를 입은 본인만. `choice: USE_BEER` + 자기 손패 카드 1장, `choice: USE_SID` + 자기 손패 카드 2장, 또는 `choice: ACCEPT_ELIMINATION` | 다른 플레이어가 피해자 대신 Beer를 내는 command는 받지 않는다. `pendingDeath`는 본인 responder만 갖는다. |
| `DISCARDS_ORDER` | 현재 버릴 소유자 본인. `choice: ORDER_CARDS`와 `orderedCardInstanceIds` 배열 | `END_TURN`이면 초과분 정확히 그 수량, 제거/다중 버림이면 규칙상 버릴 집합을 정확히 한 번씩 배열한다. 첫 ID가 먼저 버려지고 마지막 ID가 pile top이 된다. 타인의 숨은 ID는 받지 않는다. `RESPOND` 공통 계약에 따라 `choice`를 생략하지 않는다. |
| `GENERAL_STORE_PICK` | 현재 선택자 본인. `selectedCardInstanceId` | 현재 공개시장에 남은 카드 한 장을 선택한다. 서버가 이미 가져간 카드나 공개되지 않은 카드 ID는 거절한다. |
| `KIT_CARLSON_PICK` | 능력 사용자 본인. `selectedCardInstanceIds` 2개 | 현재 그 사용자에게만 공개된 3장 중 2장을 선택한다. 서버는 나머지 1장을 덱 top에 돌려놓는다. |
| `LUCKY_DRAW` | 판정 사용자 본인. `choice: SELECT_JUDGMENT`, `selectedCardInstanceId`, `orderedCardInstanceIds` | 해당 draw의 공개 후보 중 하나를 판정에 사용하고 두 후보를 모두 버린다. 후보 순서는 D04에 따라 Lucky가 선택하고 ruleset이 저장한다. |
| `JESSE_FIRST_DRAW` | Jesse 본인. `choice: DRAW_FROM_PILE` 또는 `choice: TAKE_FROM_HAND`와 `sourcePlayerId` | 첫 드로우 원천 선택이다. `TAKE_FROM_HAND`일 때 대상 플레이어 ID만 보내고 숨은 카드 ID는 보내지 않는다. 서버가 그 손패에서 무작위로 한 장을 가져온다. |
| `PEDRO_DISCARD_TOP` | Pedro 본인. `choice: SELECT_SOURCE`와 `source: DISCARD_TOP` 또는 `DRAW_PILE_TOP` | 버림더미에서 보이는 맨 위만 선택할 수 있다. 전체 pile을 살피거나 ID로 맨 아래/중간 카드를 고를 수 없다. |

모든 선택 ID는 그 actor에게 서버가 현재 보여준 합법 후보 중에서 검증한다. 상대의 무작위 손패를 지정하거나 전체 버림더미에서 보이지 않는 카드를 선택하는 `cardInstanceId`는 금지한다. 마지막 공개 카드의 인스턴스 ID는 현재 top 한 장을 옮기는 게임 능력에만 허용될 수 있다.

상대 손패를 무작위 대상으로 고르는 입력은 `targetPlayerId`와 `targetZone: HAND`만 받으며, 서버가 대상을 정한다. 이 요청에는 상대 손패의 `cardInstanceId`를 포함하지 않는다. 카드 선택 여러 장은 해당 pending schema가 명시적으로 허용한 경우에만 `cardInstanceIds` 또는 `selectedCardInstanceIds`로 보낸다.

시퀀스형 효과는 한 번의 명령으로 전체 대상 결과를 클라이언트가 제출하지 않는다. 서버 엔진이 저장된 `effectQueue`의 현재 대상만 진행한 다음 다음 응답자에게 새 `pendingInteraction`을 열거나 큐를 계속한다. `sourcePlayerId`와 reward policy는 클라이언트 입력으로 수정할 수 없다.

다음과 같은 게임 흐름은 protocol이 각각의 대기 단계를 sync 뒤에도 계속 표시할 수 있어야 한다.

- 인디언/기관총 등 여러 플레이어가 차례로 응답하는 타깃 처리
- 생명점수가 0이 된 플레이어의 구조/맥주 응답 창
- 사망 처리 후 타인의 카드 회수/카드 버리기 선택
- 탈락자가 카드 버림 순서를 직접 선택하는 `DISCARDS_ORDER`
- Vulture Sam 카드 회수 뒤 남은 카드를 정리하는 순서
- 한 카드/효과가 여러 명을 탈락시켰을 때 마지막 대상의 효과까지 끝난 뒤 승리 판정. 보안관이 Gatling/Indians의 첫 피해로 먼저 죽어도 나머지 대상을 해결하고, 전체 효과가 끝난 시점에 배신자가 마지막 생존자라면 배신자 승리. [2025 공식 대회 규정 일반 FAQ p.13]

이것들은 protocol의 지속성 요구다. 승리 조건의 일반 판정은 [01_RULES.md D01/R29](01_RULES.md)에 맞춘다. 다중 탈락 효과 뒤 검사 시점은 2025 공식 규정의 일반 FAQ p.13 보충이다. 여기서는 pp.12–14의 일반 FAQ 보충만 채택하고 대회 변형/운영 절차는 사용하지 않는다.

## 4. 명령 응답과 오류

모든 명령은 Socket.IO ACK로 한 번의 최종 결과를 받는다. ACK timeout은 실패 확정이 아니라 응답 유실일 수 있다. 클라이언트는 같은 `commandId`와 같은 payload로 다시 보내거나 `match:sync`/`room:sync`를 요청한다.

성공:

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "status": "accepted",
  "duplicate": false,
  "aggregateVersion": 43,
  "eventSeq": 87
}
```

기존 receipt 재응답:

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "status": "accepted",
  "duplicate": true,
  "aggregateVersion": 43,
  "eventSeq": 87
}
```

거절:

```json
{
  "protocolVersion": 1,
  "commandId": "018f8e3d-...",
  "status": "rejected",
  "error": {
    "code": "STALE_VERSION",
    "messageKey": "match.staleVersion",
    "retryable": true,
    "currentVersion": 43
  }
}
```

### 4.1 receipt와 멱등성

- key는 `(authenticatedPlayerId, commandId)`이며 request hash에는 protocolVersion, aggregate ID, expectedVersion, type, 정규화한 payload 전체를 포함한다.
- 성공 명령은 engine output, snapshot, version, `match_events`, receipt, outbox가 하나의 DB transaction에서 commit된다. receipt 저장 전 event는 전송하지 않는다.
- 동일 actor와 동일 command ID, 동일 hash면 원래 outcome을 재전달한다. 동일 ID, 다른 hash면 `COMMAND_ID_REUSED`다.
- 인증 후 집계 대상으로는 알려졌지만 규칙/버전상 거절된 명령의 outcome도 receipt로 저장해 재시도 때 같은 결과를 돌려준다. 스키마 형식 오류나 인증 실패는 DB 집계 영수증으로 취급하지 않는다.
- 명령 ID 처리 확인이 안 될 때 새 ID를 만들면 동일 플레이 동작이 두 번 발생할 수 있다. 클라이언트는 ACK를 받기 전까지 pending ID를 보존한다.

### 4.2 오류 코드 초안

| code | 뜻 | 클라이언트 동작 |
|---|---|---|
| `BAD_REQUEST` | 스키마, 필수 열, 길이 또는 지원하지 않는 프로토콜 오류 | 입력 수정; 자동 재시도 금지 |
| `UNSUPPORTED_PROTOCOL` | 서버가 프로토콜 버전을 지원하지 않음 | 새로고침/클라이언트 업데이트 안내 |
| `UNAUTHENTICATED` | 유효한 guest session 없음 | 새 guest 생성 또는 다시 로그인 |
| `NOT_FOUND_OR_FORBIDDEN` | 집계가 없거나 이 actor가 볼 수 없음 | 존재 여부 추측 불가 메시지 |
| `INVITE_INVALID` | 만료/틀린 초대 코드 | 재입력, 실패 rate limit 안내 |
| `ROOM_FULL` / `ROOM_CLOSED` | 로비 상태상 입장할 수 없음 | 로비에서 나가기 |
| `ROOM_LOCKED` | 게임 시작 뒤 명령 금지(특히 kick/entry) | 최신 room view 반영 |
| `NOT_A_PLAYER` | 매치 membership 없음 | 방 목록으로 이동 |
| `STALE_VERSION` | `expectedVersion`이 현재 상태와 다름 | 해당 aggregate sync, 사용자 재검토 후 새 commandId 사용 |
| `COMMAND_ID_REUSED` | commandId에 다른 요청 hash가 이미 묶임 | 버그/중복 상태 보고; 그 ID 재사용 중지 |
| `NOT_YOUR_TURN` | 현재 입력권이 아님 | 최신 snapshot 표시 |
| `NO_PENDING_INTERACTION` / `WRONG_INTERACTION` | 대기 창이 끝났거나 ID가 낡음 | sync 후 다시 선택 |
| `ILLEGAL_ACTION` / `INVALID_CHOICE` | 최신 규칙/대상/선택에서 허용되지 않음 | 오류 표시 후 sync |
| `RATE_LIMITED` | 빈도 제한 | `retryAfterMs` 이후 재시도 |
| `RECOVERY_REQUIRED` | 상태/ruleset 복구가 안 되어 매치를 일시 정지 | 재시도 루프 금지, 운영 알림 표시 |
| `MATCH_PAUSED` / `RULE_RESOURCE_EXHAUSTED` | 덱과 버림더미가 모두 비어 진행을 멈춤 | 명령 재시도 금지; 운영이 판을 확인할 때까지 sync만 허용 |
| `SERVER_BUSY` | 일시 DB/큐 문제; 상태 미확정 가능 | 같은 ID로 안전하게 재시도 |
| `INTERNAL_ERROR` | 예상하지 못한 실패 | 요청 ID로 지원/로그 연동; 내부 stack/비밀정보 미노출 |

`currentVersion`은 버전 공개 권한이 있는 actor에게만 싣는다. `retryAfterMs`는 제한 상태일 때만 보낸다. 외부 `messageKey`를 사용해 로케일별 문장을 UI에서 결정한다.

## 5. 동기화와 서버 발신 이벤트

### 5.1 room/match sync

`room:sync`와 `match:sync` 요청은 각각 아래 exact key set을 사용한다. `requestId`, `roomId`, `matchId`는 1–256자의 문자열이고 version/cursor 필드는 0 이상의 안전한 정수다. 공유 계약의 strict parser는 누락 또는 추가 필드, 잘못된 버전, 음수/비정수 cursor를 `BAD_REQUEST`로 거절한다.

```json
{ "protocolVersion": 1, "requestId": "req_room_...", "roomId": "r_...", "knownVersion": 3 }
```

```json
{ "protocolVersion": 1, "requestId": "req_match_...", "matchId": "m_...", "knownVersion": 42, "afterEventSeq": 80 }
```

room/match sync가 거절될 때 쓰는 공통 DTO는 resource ID를 되돌려 주지 않는다. 잘못된 요청은 `BAD_REQUEST`; 집계가 없거나 요청자에게 볼 권한이 없으면 같은 `NOT_FOUND_OR_FORBIDDEN` 응답을 사용한다.

```json
{
  "protocolVersion": 1,
  "requestId": "req_sync_...",
  "status": "rejected",
  "error": { "code": "NOT_FOUND_OR_FORBIDDEN" }
}
```

응답은 authenticated player projection을 만든 뒤 다음을 반환한다.

```json
{
  "protocolVersion": 1,
  "requestId": "018f8e40-...",
  "matchId": "m_7b...",
  "version": 43,
  "eventSeq": 87,
  "requiresFullSnapshot": true,
  "snapshot": {
    "status": "playing",
    "viewer": { "playerId": "p_...", "seatIndex": 2, "mode": "active" },
    "publicTable": {
      "players": [],
      "turn": {},
      "deckCount": 57,
      "publicDiscard": { "topCard": null, "count": 12 }
    },
    "selfPrivate": { "role": "...", "hand": [] },
    "pendingInteraction": null
  },
  "visibleEvents": []
}
```

`publicDiscard`는 현재 맨 위 카드와 카드 수만 반환한다. `Card[]` 전체, 이전 top 기록을 모아 둔 배열, 버림더미를 페이지 단위로 조회하는 API는 없다. 2025 공식 일반 FAQ p.12의 “버림더미를 볼 수 없다”에 맞춰 버림 기록 이력도 카드 인스턴스 전체를 열거하지 않는다. 카드가 공개 사용되는 동안의 공개 행동 이벤트는 보여줄 수 있지만 sync로 전체 버림더미를 다시 만들 수 있게 하지 않는다.

`publicTable.deckCount`는 01_RULES.md D09의 제품 공개 범위에 따라 현재 draw pile의 남은 장수만 반환한다. 덱의 카드 면, 인스턴스 식별자, 순서는 응답에 넣지 않는다.

`selfPrivate`는 자기 identity의 허용 정보만 포함하고 `viewer.mode`가 탈락자라면 별도 `EliminatedObserverView`를 준다. 다른 플레이어의 손패, 생존자의 아직 비공개인 역할, deck order, 전체 internal state/resolution queue는 응답 DTO에 존재하지 않는다. 이미 탈락하며 공개된 역할과 보안관 역할은 public field다. JSON을 한번 `JSON.stringify`해서 전체 상태를 만드는 방식이 아니라 각 필드 projection을 화이트리스트로 생성한다.

### 5.1.1 viewer별 게임 입력·진행·결과 DTO

`MatchSnapshotView.legalActions`는 해당 viewer가 지금 제출할 수 있는 일반 명령 제안 목록이다. 각 항목은 canonical `MatchCommand`의 `type`과 `payload`만 포함하며 `PLAY_CARD`, `USE_ABILITY`, `END_TURN`만 허용한다. `protocolVersion`, `commandId`, `matchId`, `expectedVersion`, actor/owner ID를 제안 안에 넣지 않는다. 실제 제출은 현재 snapshot version과 새 idempotency ID를 담은 별도 `MatchCommand`로 서버가 다시 검증한다. 현재 입력권이 없는 viewer와 탈락 observer에게는 빈 목록을 보낸다. T69 projection 전환 중에는 필드가 생략될 수 있지만, 새 producer는 항상 목록을 명시한다.

현재 pending 입력권이 있는 viewer에게만 `responseOptions`를 준다. 배열 항목은 현재 서버에 저장된 `pendingInteraction.options`의 선택과 payload를 변형하지 않고 typed `PendingRespondOption` 형식으로 직렬화한다. 각 항목의 `interactionId`는 해당 pending ID와 같아야 한다. 저장 option이 Jesse/Pedro/Lucky 선택이면 실제 runtime literal과 payload 이름을 그대로 쓴다. `DISCARDS_ORDER`의 저장 option은 `{ interactionId, choice: "ORDER_CARDS" }` template이다. 이것은 command payload가 아니며, 실제 `RESPOND` 명령은 `orderedCardInstanceIds`를 반드시 제출해야 한다. responder view에는 엔진의 저장 context에서 `discardOrder: { requiredCount, allowedCards }`를 함께 투영한다. `allowedCards`는 `allowedCardInstanceIds`에 대응하는 card faces만 담고, 다른 viewer와 다른 종류의 pending에는 이 필드를 넣지 않는다. 서버는 저장된 discard context와 현재 손패/테이블 구역으로 길이·중복·소유권을 다시 검증한다. 기존 consumer 호환을 위해 `allowedChoices`를 유지하며, 응답자 뷰에서는 옵션에서 처음 나타난 순서대로 중복을 제거한 choice 목록과 일치시킨다.

다른 viewer에게는 pending 선택지를 보내지 않는다. 이 progress 뷰는 `interactionId`, `kind`, 빈 `allowedChoices`, `currentResponderPlayerId`, `{ current, total }`의 공개 진행 단계만 담고 `responseOptions`, card ID, context를 담지 않는다. `current`는 1부터 시작하고 `total`보다 클 수 없다. viewer-aware DTO의 공유 parser는 viewer ID를 받아 응답자와 비응답자 모양을 구별하고 exact keys 및 `PendingRespondOption`을 검사한다. 실제 command parser는 complete `RespondPayload`만 받으며 pending `ORDER_CARDS` template를 command로 거부한다. 기존 `allowedChoices`만 있는 v1 snapshot 형식은 소비자 마이그레이션용 legacy 타입으로 남긴다.

`MatchSnapshotView.outcome`은 `status: completed`일 때만 존재하며 `{ winningFaction, winningPlayerIds }` 요약만 담는다. 진행/일시정지/복구 중에는 생략한다. 전체 internal state, 비공개 카드 또는 역할 원본을 결과 DTO에 포함하지 않는다.

예시 — 현재 responder:

```json
{
  "interactionId": "i-7",
  "kind": "BANG_RESPONSE",
  "allowedChoices": ["USE_MISSED", "TAKE_HIT"],
  "currentResponderPlayerId": "p2",
  "step": { "current": 1, "total": 2 },
  "responseOptions": [
    { "interactionId": "i-7", "choice": "USE_MISSED", "cardInstanceId": "p2-private-card" },
    { "interactionId": "i-7", "choice": "TAKE_HIT" }
  ]
}
```

예시 — 다른 viewer:

```json
{
  "interactionId": "i-7",
  "kind": "BANG_RESPONSE",
  "allowedChoices": [],
  "currentResponderPlayerId": "p2",
  "step": { "current": 1, "total": 2 }
}
```

`requiresFullSnapshot`은 현재 버전으로부터 event delta만 적용해 같은 상태가 보장되지 않거나 cursor가 저장 한계를 벗어난 경우 `true`다. full snapshot이 아니어도 current version/eventSeq는 항상 반환한다. visible events는 각 viewer에게 공개 가능한 내용만 이벤트별로 projection하고, 버림더미 카드 전체 목록을 조회하는 역사 API로 쓰지 않는다. 숨김 eventSeq가 생략되어 시퀀스 값이 띄엄띄엄 보이는 건 정상이다.

로비 동기화도 `room:sync { requestId, roomId, knownVersion }` -> 인증된 `RoomView`의 전체 스냅샷/변경 여부로 같은 패턴을 쓴다. RoomView는 반드시 `activeMatchId`를 포함한다. 매치가 없는 `waiting`, `starting`, `closed` 방은 `null`이고 `in_game`, `paused`, `completed` 방은 해당 매치 ID를 포함한다. 클라이언트는 이 ID로 `match:sync`를 요청하되 서버가 현재 세션의 매치 참가를 다시 인증한다. RoomView의 viewer는 반드시 현재 멤버여야 하며 `isOwner`는 `ownerPlayerId`와 일치해야 한다. 방 sync DTO에 역할·손패·초대/세션 secret은 추가하지 않는다.

`RoomSyncResponse`는 `protocolVersion`, `requestId`, `roomId`, `version`, `requiresFullSnapshot`, `room`만 포함하고, `room.roomId`는 envelope `roomId`와 같아야 한다. strict consumer parser는 RoomView exact keys, 4~7 capacity 범위, 중복 없는 member ID/seat, 좌석 범위, viewer membership 및 owner 일치를 검사한다. 응답에 session credential, 초대 코드, 역할, 손패 또는 전체 게임 상태를 더하지 않는다.

### 5.2 server -> client 이벤트

| 이벤트 | 구독 대상 | 내용 |
|---|---|---|
| `room:changed` | 대기실 채널 | `{ roomId, version }`. 상세 room snapshot은 sync로 가져온다. |
| `match:changed` | 매치 채널 | `{ matchId, version, eventSeq }`. 비공개 game payload 없이 sync를 요청하는 힌트다. |
| `match:presence` | 해당 매치 플레이어 | `{ matchId, playerId, seatIndex, connectionState, observedAt }`. 공개 정책을 적용하며 게임 version을 증가시키지 않는 일시 상태다. |
| `session:expired` | 해당 게스트의 소켓 | 재인증/새 guest flow 안내. |
| `server:maintenance` | 연결 세션 | 예정된 서버 재시작과 읽기 전용/재연결 안내. 게임 상태 변경 신호가 아니다. |

아웃박스는 먼저 DB에 영속화한다. worker는 `(aggregate_id, aggregate_version, event_seq)` 순서를 맞춰 `match:changed`나 `room:changed`를 보내고 발행 확인 시 `published_at`을 쓴다. 알림 재전송은 같은 version을 포함할 수 있다. 클라이언트는 version이 더 클 때만 동기화한다. 새 상태는 그 클라이언트의 현재 권한을 기준으로 만들어지므로 아웃박스 payload로 private state를 전달하지 않는다.

## 6. 동시 입력, 재접속과 장애 응답

### 6.1 동시 명령 처리

매치 명령 수신 서버는 DB transaction에서 match aggregate row를 잠그고 idempotency receipt를 먼저 확인한 뒤 버전 및 엔진 규칙을 검사한다. 두 탭이 `expectedVersion: 42`로 다른 카드를 동시에 내면 한 건이 43으로 commit될 수 있고 나머지는 `STALE_VERSION(currentVersion: 43)`을 받는다. 두 번째 화면은 최신 상태를 가져와 현재 턴/손패를 표시한다.

서버 프로세스가 여러 개 떠도 모든 명령이 같은 PostgreSQL 행 잠금 규칙을 사용하면 판 상태 쓰기는 단일 writer 의미를 유지한다. 다만 Socket.IO 채널 broadcast는 기본 adapter의 서버 한 대 메모리에만 존재한다. MVP는 Node 한 대로 제한하고, 멀티 서버 배포 때는 공식 compatible adapter와 아웃박스 dispatcher 경합 방지 설계를 별도 작업으로 한다.

### 6.2 재접속 절차

1. 소켓이 연결될 때 게스트 cookie 인증을 다시 수행한다.
2. client가 마지막 room/match ID와 확인한 `knownVersion` 및 event cursor를 보낸다.
3. 서버는 동일 player의 room/match membership이 유효한지 확인한다. 연결이 끊긴 동안에도 seat와 pending choice는 보존한다.
4. 서버가 채널에 join시키고 viewer 전용 `room:sync`/`match:sync`를 응답한다.
5. client는 `requiresFullSnapshot`에 따라 교체 또는 공개 event를 순서대로 적용한다. 반환된 현재 pending interaction만 현재 actor가 응답 가능하다.

Socket.IO connection state recovery를 별도 활성화해도 success/failure를 확인하고 위 sync 절차는 항상 실행한다. 공식 문서에 따르면 recovery는 실패할 수 있으며 서버/클라이언트 상태를 맞추는 처리가 계속 필요하다.

### 6.3 서버 재시작과 결과 불명

- commit 전에 연결 종료: transaction rollback이면 receipt/event/state 없음. 같은 명령이 다음에 정상 처리될 수 있다.
- commit 직후 ACK 전 종료: receipt는 저장되어 있다. 클라이언트 같은 commandId retry는 기존 ACK 결과와 버전을 반환한다.
- commit 뒤 broadcast 전 종료: outbox dispatcher가 재시도하고, 재연결 sync도 저장된 현재 상태를 가져온다.
- 게임 중 서버 restart: 서버는 DB에서 진행 중 매치 snapshot 및 serialized pending interaction/queue를 복원한다. 클라이언트는 재접속 후 original seat로 돌아간다.
- `schemaVersion` 또는 `rulesetVersion`이 더 이상 지원되지 않는 판은 `RECOVERY_REQUIRED` 응답으로 차단한다. pending resolution을 버리거나 다른 규칙으로 자동 진행하지 않는다.

## 7. 방 lifecycle, kick, 탈락자 관전

| 현재 상태 | 허용 명령 | 거부 명령 |
|---|---|---|
| `WAITING` | 방장 설정, 준비, 초대코드 입장, 시작 전 필요 시 kick/퇴장 | 자격 없는 방장 명령 |
| `STARTING` | 시작 snapshot 확인·실패 rollback | 신규 참가, 좌석 변경 |
| `IN_GAME` | 참여자 gameplay, sync, 연결 복귀, 공개 상태 보기 | 신규 참가/제3자 관전, 방장 임의 kick, 손패/역할 열람 대행 |
| `PAUSED` | 참여자 sync, 운영자 진단 | gameplay 명령, 자동 재개 |
| `COMPLETED` | 최종 projection/공개 이력 조회 | 추가 게임 명령, 좌석 강제 변경 |
| `CLOSED` | 상태/정책에 따른 사후 조회 | 입장·게임 진행 |

방장 권한은 초대 방 관리와 시작 전 좌석 구성까지만 갖는다. 게임 시작 시 seat roster는 잠긴다. 진행 중 actor identity를 room owner가 대체하거나 탈락자를 즉시 삭제할 수 없다.

탈락자 `match:sync`는 인증된 본인의 `playerId`로만 탈락 observer projection을 만든다. 포함 범위는 **그 사용자가 이미 알고 있는 자기 정보와 모든 플레이어에게 공개된 정보**다. 탈락 이후 새로 알게 되면 안 되는 다른 플레이어의 개인 상태, 숨겨진 덱, 생존자의 아직 비공개인 역할은 제공하지 않는다. 이미 탈락해 공개된 역할과 보안관 역할은 공개 정보다. 살아있는 플레이어의 손패·pending choices를 탈락자에게 보여 주지 않는다. 제3자 관전자는 MVP에서 들어오지 못한다.

서버는 연결 끊김을 퇴장/사망/좌석 양도로 해석하지 않는다. 탈락자도 판 안의 participant identity를 보유하므로 판이 끝날 때까지 자기 허용 뷰를 읽는다.

## 8. 게임 timeout OFF와 presence 의미

MVP 게임 행동 timeout은 **OFF로 확정**한다. 턴과 대기 상호작용은 deadline 없이 저장하고, 무응답 기본 선택·자동 패스·자동 버리기·자동 탈락 처리를 하지 않는다. 연결이 끊겨도 좌석과 pending 상태가 유지되며, 같은 guest identity가 재접속해 명령을 제출할 때까지 기다린다. 이 온라인 정책은 공식 게임 규칙에 시간 제한을 추가하지 않는다. [01_RULES.md D07]

Socket.IO ACK timeout/HTTP 요청 timeout은 통신 응답을 기다리는 상한일 뿐 게임 상태를 변경하지 않는다. 요청 ACK가 유실되면 같은 `commandId`로 안전하게 재시도하고, server timeout만으로 turn/pending resolution을 진행하지 않는다. 게스트 세션 만료도 인증 정책이며 게임 행동 timeout과 별개다.
presence 통지는 비권위·휘발성이다. `match:presence`는 version/eventSeq를 올리지 않는다. 카드/턴/탈락/선택 결정은 영속 command를 통해서만 발생한다.

## 9. Rate limit 및 입력 상한

서버 연결 middleware는 인증과 연결 빈도 제한을 하고, 명령 handler는 게임/로비별 request limit을 따로 적용한다. 연결 인증만 제한해도 이미 열린 소켓의 event 남용은 막지 못한다.

제안 초기값(운영/악용 방지 설정; 게임 규칙이 아님):

- 세션별 게임/방 command: 평균 10회/초, burst 20.
- invite preview/join에서 알 수 없는·틀린 invite 실패: IP+인증 guest session 조합 rolling 60초 동안 5회까지 조회를 허용하고, 6회째부터 rate limit. 유효 invite의 ROOM_FULL/ROOM_CLOSED 등 상태 오류는 guessing 실패 횟수에 넣지 않는다.
- room create: 세션별 3회/10분.
- 동시 소켓: 세션당 5개, 연결당 30초 heartbeat 기준.
- 단일 JSON frame: 8 KiB. 긴 이력/리플레이는 cursor pagination으로 나눈다.
- 로그인 없는 생성형 API와 소켓 handshake도 전송 요청 timeout 및 body 상한을 둔다. 이 통신 제한은 gameplay timeout OFF와 별개다.

초과 요청은 `RATE_LIMITED`와 다음 시도까지 남은 양의 정수 밀리초 `retryAfterMs`를 보낸다. 첫 제한은 1초이고, 허용 시각 전에 거듭 요청하면 지연을 2배씩 늘려 최대 15분으로 제한한다. 실패 기록은 rolling 60초에서 만료한다. 15분 동안 실패 입력이 없거나 유효한 초대 preview 뒤 JOIN이 성공하면 지연 단계와 실패 기록을 초기화한다. 제한 응답에서는 invite lookup을 실행하지 않는다.

IP 제한은 신뢰된 reverse proxy가 정의된 경우에만 forwarded IP를 쓰고, 그렇지 않으면 raw socket peer를 사용한다. MVP 메모리 bucket은 재시작 시 초기화되고 여러 서버에서 공유되지 않는다. 다중 인스턴스 운영 전에는 공유 limiter를 선택한다.

## 10. 구현 작업 완료 조건

- Match/room command DTO가 프로토콜 버전과 strict runtime validation을 갖고 `actorId` 필드를 받지 않는다.
- 한 명령은 DB transaction에서 expected version, command receipt, state, event history, outbox를 원자 처리하며 commit 뒤에만 ACK/broadcast 된다.
- command ACK 유실 및 동일 commandId 재전송에서 중복 게임 효과가 발생하지 않는다.
- 동시 명령은 DB 잠금과 expectedVersion으로 직렬화되고, 버전이 낡은 요청은 current version을 알려준다.
- sync projection은 살아있는 참가자/탈락자/비참여자 간 정보를 정확히 제한한다. 숨겨진 손패·역할·덱 순서가 unauthorized network response에 전혀 포함되지 않는다.
- 진행 중 매치의 탈락 플레이어가 새로고침 후 같은 guest identity로 돌아와 `pendingInteraction`과 `effectQueue`가 살아 있는 위치에서 sync한다.
- 서버 restart 후 `pendingDeath`/rescue, 다중 대상 효과, `DISCARDS_ORDER`, card custody order, reward source, 승리 판정 위치가 저장된 순서 그대로 재개된다.
- 방장 kick/임의 seat 조작은 `IN_GAME`에서 거부된다. 연결 끊김은 좌석 제거가 아니다.
- gameplay timeout이 OFF이고, 네트워크 ACK 제한시간은 자동 게임 행동을 발생시키지 않는다.

## 11. 공식 기술 문서

- [Socket.IO Delivery Guarantees](https://socket.io/docs/v4/delivery-guarantees/) — 전송 순서, at-most-once 기본 동작, 애플리케이션 확인·저장 설계.
- [Socket.IO Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery/) — session/packet 복구 기능 및 항상 완전하지 않다는 주의.
- [Socket.IO Middlewares](https://socket.io/docs/v4/middlewares/) — 인증 정보의 handshake 전달과 연결마다 middleware 실행.
- [Socket.IO Rooms](https://socket.io/docs/v4/rooms/) — room channel은 서버 개념이며 연결 해제 때 room에서 나감.
- [Socket.IO Server API](https://socket.io/docs/v4/server-api/) — server event/ack API.
- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — 격리 수준과 트랜잭션의 동시성 의미.
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — row-level lock, `SELECT ... FOR UPDATE`, deadlock 주의.
- [PostgreSQL Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — PK, UNIQUE, FK, CHECK의 보장 범위.
- [PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html) — JSON/JSONB 저장·처리.
- [Node.js HTTP API](https://nodejs.org/api/http.html) — Socket.IO에 전달할 HTTP server API.

## 12. Sites HTTP/SSE transport mapping

이 절은 v1 wire DTO를 새로 만들지 않는다. Sites Worker가 기존 `packages/contracts` DTO를 HTTP로 전달하고 응답 본문은 같은 exact-key parser로 검증한다. JSON 요청의 content type은 `application/json`, 세션 요청은 `credentials: include`, 응답은 기본적으로 `Cache-Control: no-store`를 사용한다. CSRF 방어를 위해 state-changing API는 same-origin `Origin`을 검사하고 JSON content type만 받는다. CORS wildcard는 허용하지 않는다.

| HTTP route | v1 operation | body/query | 성공 응답 |
|---|---|---|---|
| `POST /api/guest-sessions` | guest session create | `GuestSessionRequest` | 기존 `GuestSessionResponse`, 세션 credential은 설정한 HttpOnly cookie로만 반환 |
| `GET /api/guest-sessions` | guest session restore | 없음 | 기존 `GuestSessionResponse`; 없거나 만료된 세션은 `204` |
| `GET /api/guest-sessions/rooms` | assigned-seat restore | 없음 | 인증 player의 `RoomView[]` |
| `POST /api/rooms/preview` | `room:preview` | `RoomPreviewRequest` | 기존 `RoomPreviewResponse` 또는 동일한 rejection DTO |
| `POST /api/rooms` | `room:create` | `CREATE_ROOM` `RoomCommand` | 기존 create result DTO |
| `POST /api/rooms/{roomId}/commands` | `room:command` | 기존 `RoomCommand` | 기존 command ACK/RoomView/rejection shape |
| `POST /api/matches/{matchId}/commands` | `match:command` | 기존 `MatchCommand` | 기존 `CommandAck` |
| `POST /api/rooms/{roomId}/sync` | `room:sync` | `RoomSyncRequest` | 기존 `RoomSyncResponse` |
| `POST /api/matches/{matchId}/sync` | `match:sync` | `MatchSyncRequest` | 기존 `MatchSyncResponse` |
| `GET /api/notifications/events?after={cursor}` | `room:changed`, `match:changed` | non-negative cursor; cookie authentication | `text/event-stream` invalidation items; no game/private payload |

HTTP status는 전송 계층만 나타낸다. 규칙/권한/버전 거절은 해당 v1 rejection body의 코드를 보존하고, caller가 요청한 resource ID를 공개하지 않는 sync의 `NOT_FOUND_OR_FORBIDDEN` 규칙도 유지한다. 인증된 match member의 저장 상태가 지원되지 않으면 `match:sync`는 같은 sync rejection shape의 `RECOVERY_REQUIRED`를 반환하고 resource ID나 stored metadata를 덧붙이지 않는다. 이 응답은 멤버십 확인 뒤에만 반환한다. `room:sync`는 이 코드를 반환하지 않는다. route ID와 body DTO의 room/match ID가 다르면 mutation 전에 `BAD_REQUEST`로 거절한다. 요청 본문은 8 KiB, 응답은 기존 DTO 크기 범위에서 제한한다.

명령 receipt key는 `(actor_player_id, command_id)`이며 요청 hash는 command envelope 전체의 canonical JSON으로 계산한다. 동일 key와 동일 hash 재전송은 저장된 기존 응답을 반환하고, hash가 다르면 `COMMAND_ID_REUSED`다. room/create/join/start/restart/return 및 match 명령의 aggregate version, receipt, 내부 event, 무효화 outbox는 동일한 D1 batch에서 갱신한다. 권한과 strict DTO를 확인한 뒤 batch를 구성하며, batch 실패를 부분 적용으로 해석하지 않는다.

SSE event ID는 D1 `outbox.cursor`의 증가 정수다. `data`에는 다음 allowlist만 담는다: room 변경 `{kind:"room", aggregateId, version}`, match 변경 `{kind:"match", aggregateId, version, eventSeq}`. 매 요청/연결에서 쿠키 session을 인증하고 현재 membership에서 허용 aggregate를 구한 다음에만 outbox cursor를 읽는다. 클라이언트 cursor는 접근 제어를 대신하지 않는다. D1 query는 인덱스 cursor와 membership aggregate를 사용하며 stream은 연결 중 15초 간격으로 확인하고 최대 25초 안에 SSE comment heartbeat를 보낸다. 연결이 끝나면 새 HTTP stream과 마지막 `Last-Event-ID` cursor로 재개한다. 삭제/만료된 membership의 ID를 오래된 outbox에서 재전달하지 않는다.

모든 Site 전송은 단일 출처다. browser transport는 기존 Socket transport와 별도 `SitesGameTransport`를 제공하고 사이트 빌드만 후자를 선택한다. 로컬 Vite 개발은 기존 Socket.IO transport를 계속 선택한다. UI/engine과 canonical DTO는 전송 구현에 의존하지 않는다.

## 2026-10-04 동기화 및 접속 표시 보완

- 기존 v1 sync 요청은 전체 응답을 유지한다. 캐시가 있는 클라이언트만 `acceptUnchanged:true`를 추가한다.
- 같은 room version 또는 같은 match version/eventSeq를 인증·멤버십·지원 schema/ruleset 확인 후 비교해 `status:"unchanged"`와 식별자/버전만 반환할 수 있다. 클라이언트는 요청 ID와 자원 ID, 캐시 버전/cursor가 모두 일치할 때만 기존 projection을 재사용한다. 미일치·캐시 없음은 전체 sync로 재요청한다.
- RoomView의 선택적 `version`은 같은 projection에서 읽은 방 버전이며, 방 명령 성공 응답에도 사용할 수 있다. RoomSyncResponse에 포함되면 envelope version과 같아야 한다.
- RoomView.members의 선택적 connectionState는 connected/disconnected/unknown이다. 비공개 게임 규칙·시간 제한·좌석 유지에는 영향을 주지 않는다.
- SSE `presence` 이벤트는 RoomPresenceView(protocolVersion/roomId/observedAt/members[playerId,connectionState])만 전달한다. 인증된 현재 방 멤버에게만 노출하며, 권위 게임 버전과 분리한다. 마지막 접속 확인의 만료는 자동 탈락이나 자리 제거를 뜻하지 않는다.

