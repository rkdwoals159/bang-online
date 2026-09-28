# 03. 시스템 아키텍처

> **문서 성격:** 구현 전 제안 계약. 저장소 코드가 아니라 준비 문서다. 패키지/이벤트/테이블 이름은 작업 에이전트 간 합의를 위한 초안이며, 게임 규칙은 [01_RULES.md](01_RULES.md)의 공식 출처와 제품 결정에 맞춘다.
>
> **제품 범위:** 뱅(BANG!) 기본판 4~7인 초대방 온라인 웹 게임. 서버가 규칙과 비밀 상태의 유일한 권위자다. 방장은 진행 중인 판에서 임의로 플레이어를 추방할 수 없다. 탈락자의 관전 정보는 그 사람의 기존 정보와 공개 정보에 한정한다.

## 1. 확정 제안과 근거

| 영역 | 프로젝트 제안 결정 |
|---|---|
| 공유 언어 | 프런트엔드, 서버, 도메인 엔진 모두 TypeScript |
| 웹 클라이언트 | React + Vite. UI와 소켓 상태 어댑터를 분리한다. |
| 애플리케이션 서버 | Node.js + Socket.IO. HTTP API와 실시간 이벤트를 같은 서비스에서 제공한다. |
| 도메인 엔진 | 순수 TypeScript 모듈. React, Socket.IO, SQL, 시계, 전역 난수에 의존하지 않는다. |
| 영속성 | PostgreSQL. 방, 게스트 세션, 전체 비공개 게임 상태, 버전, 명령 영수증, 이벤트 이력, 전달 아웃박스를 저장한다. |
| MVP 배포 토폴로지 | Node 서버 1개와 PostgreSQL 1개. 멀티 인스턴스/Redis는 MVP 필수 항목으로 넣지 않는다. |
| 동기화 | DB 커밋 뒤에만 클라이언트에 버전 무효화 알림을 보낸다. 클라이언트는 서버가 생성한 권한별 projection을 다시 가져온다. |
| 연결 복구 | 소켓 세션 복구 기능에 의존하지 않는다. 재연결 뒤 인증·좌석 확인 후 저장된 최신 projection과 필요한 공개 이력을 요청한다. |

React는 UI 컴포넌트와 상태 표시를, Vite는 개발 및 정적 빌드를 맡긴다. TypeScript 타입은 코드 작성 실수를 줄이지만 네트워크 JSON을 검증해 주지는 않으므로, 서버는 모든 입력을 런타임 스키마로 확인해야 한다. Node HTTP 서버에 Socket.IO를 붙이는 형태는 공식 서버 API가 지원한다. 공식 자료는 문서 말미를 참고한다.

## 2. 모듈 경계와 책임

제안 모노레포 경계는 다음과 같다. 실제 패키지 매니저, ORM/SQL 계층, 런타임 스키마 도구는 루트 조정 때 결정한다.

```text
apps/web
  React 화면, 접근성, 애니메이션, 사용자 입력
  socket client 어댑터, 서버 projection 상태, 재연결/동기화 UI

apps/server
  HTTP 및 Socket.IO 연결, 게스트 인증, 방·좌석 권한 확인
  명령 스키마 검증, 제한, 매치 동시성, 트랜잭션과 영속성
  상태 projection, 아웃박스 전달, 로깅

packages/engine
  타입이 명시된 게임 상태와 규칙 카탈로그
  순수 reducer/transition, 합법 명령 판단, 진행 큐, 승리 조건
  내부 상태 -> 공개 이벤트/좌석별 view 변환의 규칙 입력

packages/contracts
  클라이언트와 서버 사이 명령·응답·이벤트 DTO 타입
  프로토콜 버전과 오류 코드

packages/catalog
  기본판 카드·캐릭터·역할 정의 데이터와 ruleset 버전
```

### 2.1 게임 엔진

- 기본 함수 계약은 `transition(state, command, context) -> TransitionResult`로 제안한다. `TransitionResult`는 새 내부 상태, 0개 이상의 정렬된 도메인 이벤트, 처리 결과를 반환한다. 입력 객체를 직접 수정하지 않는다.
- `context`에는 `rulesetVersion`과 미리 준비된 난수 결과, 시스템 시각이 필요한 경우 명시적으로 전달된 서버 시각만 둔다. 엔진 내부에서 `Math.random()`, `Date.now()`, DB 조회, 네트워크 호출을 하지 않는다.
- 덱 셔플, 역할 배정 등 난수는 서버의 보안 난수 어댑터가 판 생성 시 만든 뒤 결과 순서를 상태에 저장한다. 엔진은 그 순서를 소비한다. 서버 프로세스 재시작 때 새 난수로 과거 매치를 다시 구성하지 않는다.
- 엔진은 UI 텍스트를 만들지 않는다. 이벤트에는 안정된 enum과 필요한 식별자·수치만 두고, 화면은 번역 테이블로 문장을 표시한다.
- 카드의 인쇄상 명칭과 카드 정의를 분리한다. 실제 카드 인스턴스에는 고유 `cardInstanceId`와 정의 참조(`cardDefinitionId`), 문양, 숫자, 덱/확장 출처를 둔다. 같은 카드 유형의 여러 물리 카드가 서로 다른 인스턴스가 되므로 카드 80장 카탈로그의 문양·숫자를 손실하지 않는다.

### 2.2 서버

- 소켓 페이로드의 `actorId`, 좌석 번호, 카드 소유자 주장은 신뢰하지 않는다. 핸드셰이크 인증에서 확인한 `playerId`와 매치 좌석을 사용한다.
- 명령을 받고 나면 크기/형식 검사, 세션 확인, 자원 권한, rate limit, idempotency, 버전 비교, 게임 규칙 검증 순서로 처리한다. 매치의 최종 합법성은 엔진이 판정한다.
- 각 매치의 트랜잭션을 직렬화한다. 다른 매치는 병렬 처리할 수 있다.
- 실패한 엔진 불변조건(예: 같은 카드 인스턴스가 손과 버림 더미 양쪽에 존재)은 상태를 저장하거나 알리지 않고 해당 매치 처리를 중지한다. 오류 ID와 매치 ID를 서버 로그에 남긴다. 비밀 상태 본문과 세션 토큰은 로그에 남기지 않는다.
- 소켓 연결 성공 자체가 좌석 권한은 아니다. 재연결 시 인증·매치 참여자 검사를 다시 거친 뒤 서버가 생성한 방에 넣는다.

### 2.3 웹 클라이언트

- React는 전달받은 `PlayerView` projection을 렌더링한다. 내부 `GameState` 타입을 가져오거나 서버와 공유하지 않는다.
- 제출 전 버튼 활성화 같은 빠른 피드백을 할 수 있지만 최종 합법성 판정을 대체하지 않는다. 서버 오류나 버전 차이가 오면 최신 projection으로 화면을 갱신한다.
- 손패, 역할, 숨겨진 덱을 브라우저 로그·URL·오류 추적 정보에 포함하지 않는다. 서버가 projection에서 제외한 정보는 DOM, 개발자 도구에서 확인할 수 있는 네트워크 응답에도 포함하지 않는다.

## 3. 영속 데이터 모델 제안

매치 인원은 작지만 판 상태를 복구하고 동시 명령을 막기 위해, 정규화 메타데이터와 버전이 붙은 JSON 상태 스냅샷을 함께 둔다. PostgreSQL의 `jsonb`는 가변 JSON 객체 저장에 맞고, PK/UNIQUE/FK/CHECK 제약은 중복과 참조 오류를 DB에서 막는다. 규칙 검증은 애플리케이션 엔진이 담당한다.

### 3.1 테이블과 핵심 열

| 테이블 | 핵심 열 및 제약 | 용도 |
|---|---|---|
| `guest_sessions` | `id`, `token_hash` UNIQUE, `display_name`, `created_at`, `expires_at`, `revoked_at`, `last_seen_at` | 로그인 없는 게스트 신원과 재접속 자격. 원본 bearer secret은 저장하지 않는다. |
| `rooms` | `id`, `owner_player_id`, `invite_code_hash` UNIQUE, `status`, `capacity` CHECK 4..7, `version`, 시각 | 대기실·초대·방장 소유권. 초대 토큰은 추측하기 어렵게 생성하고 DB에는 해시로 저장한다. |
| `room_players` | `(room_id, player_id)` PK, `seat_index`, `ready`, `joined_at`, `last_presence_at`; `(room_id, seat_index)` UNIQUE | 대기실 참가 및 좌석 순서. 게임 시작 시 확정 좌석을 매치로 복사한다. |
| `matches` | `id`, `room_id`, `status`, `version`, `event_seq`, `ruleset_version`, `state_schema_version`, `state_json`, `created_at`, `started_at`, `updated_at`, `ended_at` | 권위 있는 전체 매치 상태와 낙관적 클라이언트 버전. 행 잠금의 기준이다. |
| `match_players` | `(match_id, player_id)` PK, `seat_index`, `alive`, `eliminated_at`, `connection_state` | 매치 참여·좌석·최소 검색용 인덱스. 역할·손패의 별도 열을 projection 용도로 공개하지 않는다. |
| `match_events` | `(match_id, event_seq)` PK, `event_id` UNIQUE, `version`, `type`, `actor_player_id` nullable, `payload_json`, `created_at` | 감사, 클라이언트 재접속 이력, 공개 이벤트 projection. 내부 payload는 서버 전용으로 보호한다. |
| `command_receipts` | `(actor_player_id, command_id)` PK, `match_id` nullable, `room_id` nullable, `request_hash`, `outcome_json`, `created_at` | 명령 중복 실행 방지 및 재시도에 같은 응답 제공. |
| `outbox` | `event_id` PK, `aggregate_id`, `aggregate_version`, `event_seq`, `kind`, `payload_json`, `created_at`, `published_at`, 재시도 횟수 | 커밋된 변경의 재시도 가능한 전달 신호. 알림만 담고 비공개 상태를 넣지 않는다. |

각 참여 테이블에는 부모 FK, 좌석 범위 및 역할 값 제약을 보강한다. 4~7명 전체와 게임 진행 중 좌석 고정 같은 교차 행 조건은 트랜잭션과 도메인 검증으로 강제한다. DB CHECK 제약은 다른 행을 안전하게 참조하는 용도가 아니다.

### 3.2 내부 매치 스냅샷

`state_json`은 서버만 읽고 쓴다. `state_schema_version`을 별도로 둬 상태 구조 마이그레이션을 분명히 한다.

```ts
interface MatchState {
  schemaVersion: number;
  rulesetVersion: string;
  status: "playing" | "paused" | "completed" | "recovery_required";
  pauseReason: "RULE_RESOURCE_EXHAUSTED" | null;
  version: number;
  eventSeq: number;
  seats: SeatState[];              // 역할, 캐릭터, 생명점수, 살아 있음, 위치
  zones: CardZones;                // 각 카드 인스턴스의 유일한 현재 위치
  turn: TurnState;
  resolution: ResolutionState;    // 아래 정의: 큐, 대기 상호작용, 재개 지점
  outcome: MatchOutcome | null;
}

interface ResolutionState {
  effectQueue: EffectStep[];        // 순차 다중 대상·후속 효과의 남은 단계
  continuations: ResolutionFrame[]; // 대기 선택/죽음 처리 후 복귀할 실행 문맥
  pendingInteraction: PendingInteraction | null;
  pendingDeath: PendingDeath | null; // 피해자, 구조 응답 순서, 피해 원인, 재개 지점
  victoryCheckDeferredByEffectId: string | null; // 단일 카드의 다중 탈락 후 효과 종료까지 검사 보류
}

interface PendingDeath {
  victimPlayerId: string;
  sourcePlayerId: string | null;
  rescueResponderIds: string[];    // 기본판에서는 피해자 자신만 응답할 수 있음
  rescueCursor: number;
  consequenceStage: "rescue" | "elimination" | "cleanup" | "win_check";
  resumeFrameId: string | null;
}
```

실제 TypeScript 인터페이스의 모든 열거형과 유니온은 게임 규칙 문서에서 승인한 이름으로 맞춘다. `state_json`에 버전, 현재 actor, 실제 대상, 원본 카드/행동 인스턴스, 남은 단계가 모두 있어야 다음 명령으로 정확히 이어갈 수 있다.

**직렬화할 상호작용의 최소 계약**

- `pendingInteraction`은 null 또는 `{ interactionId, kind, actorPlayerIds, options, context, resumeFrameId, createdAt }` 형태다. `options`는 현재 응답자의 허용 선택지만 엔진이 생성한다. `context`에는 일시 효과를 복원할 때 필요한 원본 카드와 source actor, 현재 대상, 이미 수행한 단계가 포함된다.
- 복수 대상 카드/효과는 화면에서 한 번에 처리하지 않는다. 엔진은 전체 효과의 시작 시점 생존자를 기준으로 카드 사용자 다음부터 시계 방향 대상 목록을 만들고 그 순서를 `effectQueue`에 먼저 영속화한다. 클라이언트가 target ID 목록을 정하지 않는다. 매 대상의 반응·피해·구제·탈락 후처리를 저장하고 다음 대상으로 이동한다. Gatling/Indians 도중 보안관이 먼저 죽어도 같은 카드의 남은 대상 해결은 계속한다.
- 원본 카드 사용자(`sourcePlayerId`)와 보상 책임 규칙을 큐에 보존한다. 원본 사용자가 효과 진행 중 탈락해도 이미 시작된 다중 대상 처리의 귀속은 임의로 현재 actor로 바꾸지 않는다. Duel은 공격자/응답자와 사망 원인이 분리되어야 하며, 공격자가 진 Duel에서 상대에게 제거 보상이 부여되지 않는 공식 FAQ Q23 판정을 보존한다.
- 죽음/구조 응답은 `pendingDeath`에 피해자, 구조 응답자, 피해 원인, 복귀할 큐 위치를 저장하고, 현재 응답 UI는 `pendingInteraction.kind = DEATH_RESCUE`처럼 표현한다. 기본판에서는 피해를 입은 본인만 Beer 또는 Sid 능력으로 구제 응답할 수 있으며 다른 플레이어가 Beer를 대신 내지 않는다. 이 둘을 같은 JSON 스냅샷에 원자적으로 저장해 프로세스가 꺼져도 구조 선택 창과 후속 처리를 정확히 다시 만든다.
- 탈락 후 보유 카드 처리가 선택 순서를 받는 규칙이면 `DISCARDS_ORDER` 상호작용으로 배열을 명시적으로 받아야 한다. Vulture Sam의 카드 회수는 이 순서 선택보다 먼저 수행되며, Deputy를 처치한 Sheriff는 회수된 카드까지 포함해 자기 손패·장착 카드 모두 버린다. 버림 배열과 후속 효과 순서를 그대로 보존한다.
- 단일 카드/효과가 여러 명을 탈락시킨 경우 `victoryCheckDeferredByEffectId`를 보존하고, 해당 효과의 모든 대상과 마지막 효과 단계가 끝날 때까지 승리 검사를 보류한다. 매 대상의 구조·탈락 정리·카드 회수/버림·보상은 해당 순서대로 처리한 뒤 다음 대상으로 진행한다. 전체 효과가 종료된 후 승리 조건을 한 번 확인한다. 예를 들어 Gatling을 쓴 배신자가 보안관을 먼저 탈락시키더라도 나머지 대상 효과를 마치고 배신자 승리를 판정한다. 이는 사용 순서와 무관하게 배신자가 마지막에 남으면 이기는 처리다. [2025 공식 대회 규정 일반 FAQ p.13]
- 덱과 버림더미가 모두 비어 필요한 카드를 공급할 수 없는 상태는 임의로 카드를 만들거나 승패를 정하지 않는다. `status: "paused"`, `pauseReason: "RULE_RESOURCE_EXHAUSTED"`를 저장하고 운영 결정을 기다린다. 모르는 schema/ruleset 복구 상태는 `recovery_required`로 격리한다. [01_RULES.md D05]

위 게임 판정은 [01_RULES.md](01_RULES.md)의 승인된 ruleset에 맞춘 엔진 요구다. 같은 카드로 여러 명이 탈락할 때 전체 카드 효과 종료 뒤 승리를 검사한다는 보충 판정은 2025 공식 문서 일반 FAQ p.13에 근거한다. 이 문서에서는 S5의 일반 FAQ pp.12–14 중 기본판 보충만 사용하고, 대회 절차/변형은 게임 엔진 규칙으로 가져오지 않는다.

## 4. 매치 명령의 원자적 처리와 동시성

동일 매치에 두 명령이 거의 동시에 들어오면 PostgreSQL 트랜잭션 안에서 `matches` 행을 `SELECT ... FOR UPDATE`로 잠그고 다음 순서를 수행한다. PostgreSQL 문서는 명시적 행 잠금이 해당 행의 변경을 다른 트랜잭션 종료까지 막는다고 설명한다.

1. 인증된 actor가 이 매치의 등록된 좌석인지 확인한다.
2. `(actor_player_id, command_id)` receipt를 조회한다. 기존 ID와 요청 hash가 같으면 원래 응답을 돌려주고, 다르면 `COMMAND_ID_REUSED`로 거부한다. 이 단계가 버전 검사보다 먼저이므로 성공한 명령의 응답 유실 후 재시도가 새 실행으로 변하지 않는다.
3. 현재 `matches.version`과 `expectedVersion`을 비교한다. 다르면 상태를 변경하지 않고 현재 버전의 `STALE_VERSION`을 반환한다.
4. 명령을 허용하는 phase/actor/응답 창인지 검증하고 순수 엔진을 호출한다.
5. 성공 시 새 내부 상태와 1 증가한 매치 버전, 생성된 0개 이상의 이벤트, 같은 트랜잭션의 `command_receipts`, 안전한 무효화용 `outbox` 행을 저장한다. 변경이 없는 명령도 매치 버전을 올릴지는 규칙 명세에서 정하지만, MVP 계약은 accepted state-changing command 한 건당 한 번 증가다.
6. COMMIT 성공 후에만 `command:result` acknowledgement를 보내고 아웃박스 작업자가 `match:changed`를 전달한다.

같은 매치에서 동시 두 번째 명령은 잠금이 풀린 뒤 새 버전을 읽는다. 첫 번째가 커밋한 버전을 기대하지 않았다면 두 번째는 `STALE_VERSION`으로 끝난다. 카드 소유권/턴 순서의 중복 반영을 막는다. 서로 다른 매치는 서로 다른 행을 잠가 병렬 진행한다. deadlock/serialization 오류가 발생하면 트랜잭션 전체를 재시도할 수 있지만, 엔진 외부 난수와 시간 입력도 재시도 시 동일해야 한다.

**저장 후 전송 원칙:** DB 저장이 성공하기 전에 소켓 broadcast를 하지 않는다. Node가 COMMIT 직후 중단되어 신호를 놓쳐도 outbox에 남은 행을 다시 전달한다. 전송은 중복될 수 있으므로 `eventId`와 `version`으로 소비자가 중복 제거한다. Socket.IO는 이벤트 순서를 보장하지만 기본 전송은 최대 한 번이고 끊긴 동안 서버에서 보낸 이벤트를 서버가 보관해 주지 않는다. 따라서 브로드캐스트는 새 버전이 있다는 힌트로만 쓰고, 권위 있는 데이터는 재요청 가능한 DB projection이다.

## 5. 개인정보, 관전 투영, 연결 복구

### 5.1 projection 경계

`toPlayerView(matchState, viewerIdentity)` 또는 서버의 동등한 투영 서비스는 내부 상태를 그대로 직렬화하지 않고 뷰 전용 DTO를 새로 생성한다.

- `PublicPlayerView`: 좌석, 표시명, 공개 가능한 캐릭터/생명점수/장착 카드/공개 행동 기록/생존 상태 등 규칙상 테이블에 공개되는 정보만 보낸다. 버림더미 projection은 `topCard`와 `count`만 둔다. 전체 버림더미를 조회하거나 event cursor를 통해 버린 카드 전체를 복원하는 API를 제공하지 않는다. 버림 기록 이벤트는 카드 인스턴스 목록 대신 공개 가능한 수량/행동 요약만 노출한다. 카드가 공개 사용될 때 공개되는 정보는 그 행동 이벤트에서만 보일 수 있다.
- `MatchSnapshotView.publicTable.deckCount`는 D09 제품 결정에 따라 현재 draw pile의 남은 장수만 공개한다. 카드 인스턴스·정체·순서는 projection에서 제외한다.
- `SelfPrivateView`: viewer가 현재 살아 있는 자기 플레이어이면 자기 역할, 자기 손패, 자기 선택에 필요한 비공개 선택지를 포함한다.
- `PendingView`: 현재 응답권이 viewer에게 있을 때만 개인에게 허용된 옵션을 준다. 다른 사람에게는 대기 중이라는 공개 신호를 줄 수 있으나 남의 선택지나 숨겨진 역할/카드는 싣지 않는다.
- `EliminatedObserverView`: 탈락자는 같은 판의 공개 테이블 정보와 본인이 이미 알던 정보만 받는다. 탈락 후 새 손패, 다른 사람의 손패, 생존자의 아직 비공개인 역할, 남은 덱 순서, 내부 룰 처리 컨텍스트는 주지 않는다. 이미 탈락해 공개된 역할과 보안관 역할은 공개 정보다. 클라이언트가 viewer 역할 값을 바꿔 조회해도 서버 세션의 `playerId`로 권한을 결정한다.
- 역할 배분, 덱 순서, 아직 뽑히지 않은 카드, 남의 손패 및 버림더미의 과거 목록은 모든 비인가 projection에서 빠져야 한다. 프런트엔드에 전체 상태를 보낸 뒤 UI에서 감추는 방식은 금지한다.

탈락자의 자기 비밀 정보가 어디까지 계속 공개 가능한지는 [01_RULES.md D08]에 따른다. 탈락자는 자기 역할과 공개 테이블만 열람한다. 게임 종료 때 역할은 모두 공개하지만 생존자의 손패와 덱 순서는 계속 비공개다.

### 5.2 재접속 및 서버 재시작

- Socket.IO의 connection state recovery는 일시 연결 끊김을 위한 선택 기능이며 문서상 복구가 항상 성공하지 않는다. 따라서 사용하더라도 최적화로만 쓰고, 항상 별도 `match:sync`를 권위 경로로 둔다.
- 재접속 때 게스트 세션을 인증하고 기존 좌석 membership을 찾은 다음 그 플레이어의 projection을 만들고, `clientVersion`/`afterEventSeq`에 맞춘 동기화 응답을 돌려준다. 클라이언트 상태가 맞지 않으면 전체 스냅샷을 교체한다.
- 소켓/Socket.IO room membership은 메모리 상태로 취급한다. 프로세스 재시작 후 세션과 현재 매치가 DB에서 복구되면 클라이언트가 재접속하여 권한을 다시 받고 방에 다시 join한다.
- 부팅 시 `playing` 상태의 매치들을 DB에서 로드하고 `schemaVersion`과 지원 `rulesetVersion`을 검사한다. 저장된 `pendingInteraction`, 효과 큐와 순서를 유지한다. 알 수 없는 schema/ruleset이거나 엔진 불변조건이 깨진 판은 자동 진행·변환하지 않고 `recovery_required` 상태의 오류로 격리한다.
- 공개 이벤트 이력은 `(matchId, eventSeq)` cursor로 재요청한다. 숨김 이벤트가 필터링되어도 전역 `eventSeq`를 건너뛰는 정상 동작이다. 이벤트 수가 클 경우 오래된 이력 보존 기간과 snapshot 시점을 운영 설정으로 둔다.

### 5.3 방과 플레이어의 생명주기

제안 상태 전이:

```text
WAITING -> STARTING -> IN_GAME -> COMPLETED
    |          |                        |
    +-------> CLOSED                  ARCHIVED
```

- `WAITING`: 초대 코드가 유효하고 4~7명의 플레이어가 입장할 수 있다. 방장은 대기실 구성만 관리한다.
- `STARTING`: 플레이어 수, 준비 상태, ruleset이 검사되고 좌석이 잠긴다. 초기 역할/카드가 생성된다.
- `IN_GAME`: 신규 참가·관전 입장을 차단한다. 현재 게임의 방장은 좌석을 킥하거나 다른 사람을 강제 조작할 수 없다. 연결이 끊겨도 좌석은 남는다.
- `COMPLETED`: 승리 규칙으로 끝난 상태를 저장하고 최종 projection을 반환한다.
- `CLOSED`/`ARCHIVED`: 대기실 폐쇄 또는 판 종료 후 보존 만료 상태. 저장 삭제 정책은 운영/개인정보 정책에서 결정한다.

대기실에서 마지막 참가자가 명시적으로 나가면 D10에 따라 `CLOSED`로 전환하고 초대 입장을 막는다. 별도 운영 보존 설정이 정해지지 않은 동안에는 방 기록을 자동 삭제하지 않는다.

MVP는 **초대받은 게스트 참여**를 지원하고, 활성 판에 임의의 제3자가 관전자 입장하는 기능은 두지 않는다. 탈락자는 자기 기존 정보와 공개된 테이블을 보는 탈락자 관전 모드로 계속 연결될 수 있다. 방장은 게임 시작 뒤 `kick` 명령을 보낼 수 없으며 서버가 이를 무조건 거부한다. 방장은 좌석 소유권 또는 타인의 세션을 회수할 수 없다.

끊김은 좌석 제거가 아니다. 해당 플레이어의 `connection_state`만 disconnected로 표시하고 동일 게스트 세션이 재인증되면 원래 좌석에 복귀시킨다. 여러 탭/기기 연결 정책은 동일 `playerId` 좌석으로 묶고 각 소켓마다 같은 projection을 새로 인증해 보낸다. 명령 중복/버전 검사는 어느 탭에서도 동일하게 적용한다.

## 6. 게스트 세션, 초대와 남용 방지

- `POST /api/guest-sessions`가 게스트 표시명을 정규화하고 예측 불가능한 세션 비밀을 발급한다. 원본 토큰 대신 hash만 DB에 둔다. 웹에는 TLS 연결의 `HttpOnly`, `Secure`, 적절한 `SameSite` 쿠키로 설정하고 토큰을 로컬 저장소/로그/초대 URL에 넣지 않는다. 구체적인 cookie 도메인과 CSRF 설정은 배포 origin 결정에 맞춘다.
- 세션 갱신/만료 규칙은 운영 설정이다. 재접속할 때 만료되지 않은 세션과 매치 membership이 있어야 이전 좌석에 붙는다. 세션을 잃은 사용자가 표시명만 입력해 남의 자리를 차지할 수 없어야 한다.
- 방 입장은 서버가 해시로 초대 코드를 검증하고 잔여 좌석/방 상태를 잠금 트랜잭션으로 확인한다. 소켓이 임의의 내부 room 이름에 join하는 입력은 받지 않는다.
- IP 추출은 신뢰된 reverse proxy가 설정된 배포에서만 전달 헤더를 사용한다. 직접 접속 시 임의 `X-Forwarded-For` 값을 rate limit 키로 믿지 않는다.
- 1차 제안 제한값(게임 밸런스 규칙이 아닌 악용 억제 설정): 세션별 명령 10회/초, 최대 burst 20; IP+세션별 초대 코드 시도 5회/분, 15분 내 지수형 지연; 세션별 방 생성 3회/10분; 동시 활성 소켓 5개/세션; 단일 JSON 메시지 본문 8 KiB. 실제 수치는 관측 후 조정한다. HTTP와 소켓 모두 동일한 정책을 적용한다.
- MVP 단일 서버에서는 메모리 token bucket을 쓸 수 있으나 재시작 시 카운터가 초기화된다. 여러 서버로 확장할 때는 공용 저장소 기반 제한기로 교체해야 한다. Socket.IO 연결 middleware는 인증과 연결 제한에 활용할 수 있다.

## 7. 게임 동작 타임아웃: OFF

MVP 게임 타임아웃은 **OFF로 고정**한다. 자기 턴과 `pendingInteraction`에 마감 시각을 두지 않고, 무응답 기본 행동·자동 패스·자동 버리기·탈락 처리를 하지 않는다. 연결이 끊긴 플레이어의 좌석과 직렬화된 상호작용은 유지되며 그 플레이어가 재접속해 명령을 제출할 때까지 기다린다. 이 온라인 정책은 공식 게임 규칙에 타임아웃을 추가하지 않는다. Socket.IO ACK 대기시간, HTTP 요청 제한시간, 인증 세션 만료는 게임 행동 타이머와 별개인 전송/보안 설정이다. [01_RULES.md D07]

## 8. 운영·품질 경계와 완료 조건

### 모듈 완료 조건

| 모듈 | 완료로 보는 조건 |
|---|---|
| 엔진 | 동일 초기 상태·명령·난수 입력이면 항상 동일 결과; 모든 pending/queue/continuation/deferred victory check를 직렬화하고 복원; illegal command는 상태를 바꾸지 않음; 다중 탈락 효과 종료 뒤 승리를 검사; 빈 자원은 `RULE_RESOURCE_EXHAUSTED`로 pause. |
| 서버 | actor가 인증에서 결정됨; 동일 매치의 명령 직렬화; receipt+이벤트+스냅샷+outbox가 원자적으로 커밋됨; 재시작 후 진행 상태 복구; commit 전 broadcast 없음. |
| projection | 숨김 정보를 클라이언트 payload에 실지 않음; discard pile은 top+count로 제한하고 전체 목록을 event sync로 우회 조회할 수 없음; 탈락자는 자기 역할과 공개 정보만 받으며 게임 종료 때 생존자 손패·덱은 계속 비공개. |
| 방/세션 | 4~7 좌석 제한; guest invite 및 재접속; 시작 후 kick 불가; 탈락자가 자기 판 공개정보를 읽는 경로가 동일한 권한 검사 적용. |
| 웹 | 현재 버전과 명령 결과 표시; stale/error 뒤 서버 sync; 대기 상호작용별 합법 선택지만 표시; 재접속/재동기화 상태와 종료 상태 표시. |
| 운영 | guest token, hidden state, 타인의 개인 projection, invite 원문을 로그에서 제외; rate limit과 recovery 오류를 집계. |

### 고려할 장애 조건

| 상황 | 요구되는 동작 |
|---|---|
| 명령 응답 전 브라우저 연결 종료 | 같은 commandId 재전송 시 기존 receipt 반환. 최신 projection은 별도 동기화. |
| DB commit 이후 소켓 알림 전에 서버 종료 | outbox가 남고 재시작 전달 또는 client sync로 최신 상태 복구. |
| 중복/동시 카드 명령 | 잠금·버전·receipt가 하나만 반영되도록 함. |
| 명령이 이전 카드/턴을 참조 | `STALE_VERSION` 또는 `ILLEGAL_ACTION`; 카드 손실 없음. |
| 게임 진행 중 프로세스 재시작 | saved queue/pending/rescue stage에서 이어감. |
| 모르는 규칙/상태 버전 | 매치를 격리하고 수동 복구 결정을 요청; 상태를 임의로 폐기하지 않음. |
| 비정상 reconnect 다량 | 인증 후 rate limit, payload 상한 및 연결 수 제한 적용. |

## 9. 공식 참고 자료

아래는 프로젝트의 기술 선택 및 Socket.IO/PostgreSQL 동작 근거로 사용한 공식 문서다. 제품 구조와 임계값은 문서 사실이 아니라 이 프로젝트의 제안이다.

- [React Learn](https://react.dev/learn) — React UI 구성 학습 문서.
- [Vite Getting Started](https://vite.dev/guide/) — Vite의 개발 서버, 빌드와 템플릿.
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) — 타입 검사와 언어 자료.
- [Node.js HTTP API](https://nodejs.org/api/http.html) — `http.Server` API.
- [Socket.IO Server API](https://socket.io/docs/v4/server-api/) — HTTP 서버에 Socket.IO를 연결하는 API.
- [Socket.IO Middlewares](https://socket.io/docs/v4/middlewares/) — 인증/인가/연결 제한 지점과 handshake credential.
- [Socket.IO Rooms](https://socket.io/docs/v4/rooms/) — 서버 전용 방 개념, `join`/`leave`, 연결 종료 시 자동 이탈.
- [Socket.IO Delivery Guarantees](https://socket.io/docs/v4/delivery-guarantees/) — 메시지 순서 보장, 기본 at-most-once 전달, 애플리케이션 저장/재전송 필요성.
- [Socket.IO Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery/) — 일시 연결 복구가 항상 성공하지 않으며 상태 동기화가 계속 필요하다는 제한.
- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — 트랜잭션 격리 수준.
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — 명시적 행 잠금과 `FOR UPDATE`.
- [PostgreSQL Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — PK/UNIQUE/FK/CHECK 제약과 그 범위.
- [PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html) — JSON 및 JSONB 타입.
- [2025–26 BANG! Campionato Nazionale, Casistica generale e FAQ, pp. 12–14](https://www.dvgiochi.com/bang_champ/MaterialeCampionato/BANG%21%20Campionato%20nazionale_Regolamento-daTorneo.pdf) — p.12의 discard pile 비열람, p.13의 탈락자 관전 정보 제한 및 단일 카드/효과의 다중 탈락 뒤 승리 검사. 이 프로젝트는 명시적으로 일반 FAQ 보충만 참조하며 대회 변형·운영 절차는 적용하지 않는다.

## 12. Sites 전용 공개 호스팅 보완 결정

이 절은 무료 공개 배포를 위해 승인된 최종 호스팅 구조다. §1의 Node.js/Socket.IO/PostgreSQL은 로컬 개발과 기존 회귀 실행에만 남긴다. 공개 사이트 요청 경로에서는 Node 서버, Socket.IO, PostgreSQL 또는 외부 서버를 사용하지 않는다.

| 영역 | Sites 배포 결정 |
|---|---|
| 사이트 런타임 | Codex Sites가 지원하는 Cloudflare Worker 호환 런타임. 새 사이트 스타터의 앱 셸과 현재 React 게임 화면을 연결한다. |
| 게임 저장 | Sites의 논리 `d1` binding 하나를 권위 저장소로 사용한다. 런타임은 binding이 없을 때 기동 실패를 명확히 반환하며 메모리 모드로 조용히 전환하지 않는다. |
| 브라우저 전송 | 같은 출처 JSON HTTP API. 기존 v1 request/response DTO와 strict parser를 사용하고 쿠키를 `credentials: include`로 보낸다. |
| 변경 알림 | 인증된 `text/event-stream` 연결. 브라우저 연결 중에만 D1에서 커서 이후 허용 aggregate의 무효화 레코드를 읽는다. 알림에는 aggregate ID/version/eventSeq만 넣고 자세한 projection은 기존 room/match sync API에서 다시 가져온다. |
| 인증 | 게스트 세션은 기존 T81의 `HttpOnly; Secure; SameSite=Lax` 쿠키 계약을 유지한다. 원문 credential은 브라우저 JS/URL/로그/DB에 남기지 않고, Worker의 Web Crypto로 digest를 만들며 D1에는 hash만 둔다. |
| 원자성/동시성 | D1 `batch()` 내 순서화된 SQL과 `expectedVersion` compare-and-swap으로 상태·이벤트·receipt·outbox를 함께 커밋한다. commit guard가 없는 stale 요청은 모든 변경 SQL을 0행 처리하고, 중복 receipt/제약 오류가 나면 batch 전체가 롤백되어야 한다. Worker 내 메모리 큐는 정합성 근거로 쓰지 않는다. |
| 무작위 | 엔진 RNG 주입 경계는 유지하며 Worker의 `crypto.getRandomValues()`에서 준비한다. 매치에 저장한 초기 상태/대기 상호작용을 복원하고 재시작 시 새 시드로 재생성하지 않는다. |
| 레이트 리밋 | 초대 코드 실패와 성공 JOIN reset은 인스턴스 메모리가 아닌 D1 원자 갱신으로 여러 Worker 인스턴스에 공유한다. IP는 Cloudflare가 설정한 연결 IP만 사용하고 클라이언트가 전달한 `X-Forwarded-For`는 신뢰하지 않는다. |
| 로컬 개발 | 기존 Node + Socket.IO + PGlite/PostgreSQL 경로를 유지한다. 사이트 전용 테스트는 Cloudflare 호환 로컬 Worker 및 별도 D1 테스트 DB로 실행한다. |

SSE는 WebSocket 상시 채널을 대체하는 무효화 전용 신호다. 구독은 현재 세션의 방/매치 membership에 한정하고, 서버는 저장된 `outbox`의 증가 커서만 흘려 보낸다. 클라이언트는 중복/오래된 버전을 무시하고 sync projection을 요청한다. 탭 숨김, 페이지 이탈, 세션 만료, stream error에서 연결을 닫고 재연결하며, 명령 ACK 직후 명령자의 화면은 SSE를 기다리지 않고 sync한다. 게임 행동 timeout은 계속 OFF다.

공개 호스팅은 Cloudflare Workers Free 및 D1 Free quota를 따르는 것으로 한정한다. 현재 공식 문서에는 Workers Free 하루 100,000 요청, D1 하루 5,000,000 row read·100,000 row write·총 5 GB 저장이 기재돼 있다. 한도를 넘으면 관련 호출이 초기화 전까지 실패할 수 있으므로 무제한/상시 무료 용량을 보장하지 않는다. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). SSE 응답은 Workers Streams API의 `ReadableStream`으로 보낸다. [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/).

논리 저장소는 기존 §3.1 aggregate의 의미를 유지하며 D1 SQLite 테이블 `guest_sessions`, `rooms`, `room_players`, `matches`, `match_players`, `match_events`, `command_receipts`, `outbox`, `invite_attempts`를 사용한다. JSON 상태는 `TEXT`로 저장하되 읽을 때 schema/ruleset version과 aggregate metadata를 검증한다. `outbox.cursor`는 단조 증가 `INTEGER PRIMARY KEY AUTOINCREMENT`이고 outbox에는 비공개 projection/state를 저장하지 않는다. `invite_attempts` key는 trusted source IP 및 authenticated guest ID의 hash이며 초대 원문은 기록하지 않는다.

D1에는 PostgreSQL interactive transaction이나 row lock을 가정하지 않는다. repository는 batch 안에서 `commit_guards` marker를 expected aggregate version이 일치할 때만 조건부로 만들고, state/receipt/event/outbox SQL을 그 marker에 종속시킨 뒤 marker를 제거한다. batch 결과에서 변경 수를 검사하여 stale/unauthorized을 구별한다. unique receipt/marker 충돌 또는 SQL 오류는 D1 batch의 rollback을 사용하며, receipt 충돌 이후 기존 receipt를 새로 읽어 replay할 수 있어야 한다. 이 패턴은 로컬 D1-compatible test runtime과 실제 Sites D1 binding에서 검증 전까지 승인된 구현으로 간주하지 않는다.
