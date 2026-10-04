# 05. 실행 계획 및 작업 명세

## 목적과 실행 전제

이 문서는 뱅! 기본판 한국어 온라인 웹게임의 구현을 위해 작업을 나누고, 각 작업의 파일 소유권과 완료 기준을 고정한다. 상태는 실행 진척에 따라 갱신한다. 최초 저장소 작업 T01은 루트 검토 및 기본 설치·정적 타입 검사 통과 후 DONE이다. 브라우저 앱 셸의 기반 도구 설정은 T61에서 별도 단독 소유로 추가했다.

구현 저장소 경로는 작업 시작 시 정한다. 아래 파일 소유권은 저장소 루트 기준 상대 경로다. 권장 구조는 다음과 같다.

- apps/web: React + Vite 브라우저 클라이언트
- apps/server: Node.js + Socket.IO 실시간 서버
- packages/engine: I/O 없는 순수 TypeScript 게임 엔진
- packages/contracts: 클라이언트와 서버 사이의 공유 프로토콜 계약
- packages/catalog: 카드, 역할, 인물, 이미지 매핑 데이터
- packages/test-fixtures: 프로토콜과 엔진의 결정적 테스트 입력

세부 프레임워크 설정, 저장소 방식, 배포 방식은 03_ARCHITECTURE.md가 정한다. 프로토콜 필드와 이벤트 의미는 04_PROTOCOL.md가 정한다. 작업자는 이 문서에서 스택 결정을 추측해 새 기술 의존성을 추가하지 않는다.

모든 작업자는 다음 자료를 읽고 적용한다.

1. 00_README.md
2. 01_RULES.md
3. 02_PRODUCT_UX.md
4. 03_ARCHITECTURE.md
5. 04_PROTOCOL.md
6. 05_EXECUTION_PLAN.md의 할당 작업과 완료된 의존 작업만
7. 06_ACCEPTANCE_TESTS.md
8. 07_READINESS.md
9. 카드 이미지 또는 카드 수량을 다루는 경우 outputs/assets/ASSET_INVENTORY.md, outputs/assets/asset_manifest.csv, outputs/assets/ATTRIBUTION.md

01_RULES.md는 공식 게임 규칙에 대한 권위 문서다. 해석이 불분명하거나 문서 사이에서 규칙이 충돌하면 임의로 규칙을 정하거나 구현하지 말고, 작업을 막는 정확한 근거와 질문을 오케스트레이터에게 보고한다. 규칙 변경은 루트 담당자가 확인한 출처를 바탕으로 01_RULES.md를 갱신한 뒤에만 반영한다.

초기 범위는 기본판, 비공개 초대방, 게스트 참가, 서버 권위 게임 진행, 재접속 복구다. AI 상대, 확장판, 공개 매칭, 랭킹, 자동 턴 제한 시간은 범위에 없다. 시간 만료는 기본 OFF다.

## 공통 품질 및 소유권 규칙

- 작업 하나는 에이전트 하나가 맡는다. 한 에이전트가 동시에 여러 작업을 소유하지 않는다. 작업을 더 작은 하위 작업으로 재위임하지 않는다.
- 작업자는 명시된 소유 경로만 수정한다. 공유 파일을 바꾸어야 하면 직접 충돌을 만들지 말고 오케스트레이터에게 변경 제안과 이유를 보낸다.
- packages/contracts의 공유 프로토콜 타입은 T02 담당자가 소유한다. 이번 UI blocker를 해소하는 추가 `legalActions`/pending/outcome DTO는 T68이 단독 소유하며, T68 기간에 다른 작업자가 contracts 경로를 수정하지 않는다. 공용 엔진 상태·reducer·효과 인터페이스도 각각 해당 작업 담당자만 수정한다.
- 카드별 규칙 구현은 개별 카드 효과 모듈 경로를 나누어 병렬화한다. 한 카드 모듈은 하나의 작업만 소유한다. 공용 reducer, 공용 상태 타입, 효과 API, 등록기 수정은 개별 카드 작업에 포함되지 않는다.
- 셔플은 외부에서 주입되는 RNG 인터페이스만 사용한다. 게임 로직에서 Math.random, 벽시계 또는 네트워크 순서에 기대지 않는다.
- 모든 플레이어에게 전달되는 공개 상태와 본인만 읽는 비공개 상태를 분리한다. 변경 알림은 버전 무효화 정보만 보내고, 서버는 인증된 sync 요청마다 플레이어별 projection을 생성한다.
- 게임 명령에는 프로토콜에 정의된 expectedVersion과 idempotency 식별자를 적용한다. 같은 명령의 재전송은 중복 상태 변경을 만들지 않는다.
- 연결 끊김 후에는 저장된 게임 상태와 플레이어별 비공개 정보를 복구해 올바른 클라이언트 projection으로 다시 보낸다.
- 향후 수락 기준의 테스트 파일은 계획된 산출물이다. 이번 계획 작성에서는 코드나 테스트를 만들거나 실행하지 않았다.
- 작업 상태의 정본은 이 문서의 개별 `상태`와 `data/task-index.csv`다. TODO, IN_PROGRESS, BLOCKED, REVIEW, DONE 중 실제 진행·검토 결과를 기록한다. DONE은 오케스트레이터가 수락 근거를 확인한 뒤에만 표시한다.

## 실행 파동과 통합 게이트

의존성 그래프가 우선이며 파동 번호는 권장 착수 순서다. 독립 작업은 앞선 파동과 겹쳐 실행할 수 있지만 선행 작업의 산출물 계약이 고정되기 전에 종속 파일을 만들지 않는다.

| 파동 | 작업 | 목적 및 통과 기준 |
|---|---|---|
| W0 문서 기준선 | 작업 전 게이트 G0 | 00~07 문서와 준비 데이터가 존재하고 상호 모순을 검토한다. 공식 규칙 질문이 있으면 루트 담당자가 판정하기 전까지 해당 규칙에 의존하는 작업을 BLOCKED로 둔다. |
| W1 저장소와 계약 | T01~T05 | G1: 워크스페이스가 설치 가능하고 공유 프로토콜, 카탈로그 스키마, 기본 데이터 형태가 04_PROTOCOL.md 및 03_ARCHITECTURE.md와 일치한다. |
| W2 엔진 공용 기반 | T06~T15 | G2: 순수 엔진에서 결정적인 초기화, 턴 reducer, 합법성 검사, 해결 파이프라인, 게임 종료 규칙 및 효과 API가 고정된다. 공용 reducer/state/protocol 변경은 오케스트레이터가 조정한다. |
| W3 효과 모듈 | T16~T40 | 서로 독립적인 카드 모듈을 병렬 작성한다. G3: 모듈별 수락 기준을 통과하고 각 변경이 지정된 파일 경로에만 한정된다. |
| W4 엔진 등록 및 검증 | T41~T42, T71, T77~T80 | G4: 개별 효과가 한 등록 경로로 조립되고, 엔진 시나리오가 정해진 입력에서 결정적으로 통과한다. T71은 R12의 BANG 사용 누적을 명령 경계에서 보완한다. T77~T79는 이미 정의된 Slab/Suzy/Lucky hook을 기존 카드 효과 runtime과 연결하고 T80은 C14/D11 hook boundary를 단독 소유한다. |
| W5 서버 | T43~T49, T62, T64, T73, T74 | 일부 저장소/방 서비스 작업은 W2 이후 병행 가능하다. T62는 저장소 작업 전 테스트 런타임을 고정한다. T64는 T43 repository의 방 생명주기 영속 API를 보완하고 T44보다 먼저 완료한다. T73은 방 시작, 게임 초기 상태/매치 행, receipt 및 두 변경 outbox를 단일 트랜잭션으로 연결한다. T74는 T73 저장소와 T67 초기 드로우를 START_MATCH 명령으로 연결한다. G5: 초대방, 명령 권한 검사, 비공개 projection, 재접속 복구를 서버 통합 기준으로 확인한다. |
| W6 웹 클라이언트 | T50~T59, T61, T63, T72, T75, T76 | T61 package setup과 T50 셸은 T01/T02 뒤에 시작할 수 있다. T63은 UX가 요구한 공개 덱 잔여 수를 계약·projection·화면까지 연결한다. T72는 RoomView에 권위 있는 activeMatchId를 추가해 room sync에서 게임 경로를 찾게 한다. T76은 브라우저 Socket.IO 의존성과 local proxy를 준비하고 T58 transport보다 앞선다. T75는 준비된 feature/transport를 실제 경로 화면에 연결한다. G6: 로비부터 재접속까지 브라우저 경로와 접근성 기준이 연결된다. |
| W7 전체 검수 | T60 | G7: 승인된 로컬 실행 환경에서 초대 게스트들이 게임을 끝까지 진행하고 재접속하는 수락 흐름이 증거와 함께 확인된다. |

## 병렬 실행 계획

현재 동시성 가정은 총 4 슬롯이며, 오케스트레이터 1명과 작업자 최대 3명으로 계산한다. 실제 실행 환경의 동시성 제한이나 충돌 위험에 따라 오케스트레이터가 작업자 수를 낮춘다. 이는 용량 계획일 뿐 특정 모델의 속도, 성능 또는 토큰 크기를 보장하지 않는다.

작업 큐는 준비된 의존성 중에서 다음 우선순위로 채운다.

1. 한 번에 하나의 작업만 각 작업자에게 전달한다.
2. 세 작업자에게 서로 겹치지 않는 파일 소유권 작업을 우선 배정한다.
3. T16~T40의 카드 효과는 T15가 고정된 뒤 파일 단위로 나눠 배정한다. 공용 카드 이벤트 모델을 고쳐야 한다고 판단되면 해당 카드 작업을 멈추고 오케스트레이터가 공용 변경을 별도 처리한다.
4. 여러 작업자가 공용 계약 또는 엔진 공용 파일을 수정해야 하는 상황은 허용하지 않는다. 계약 또는 reducer 변경은 단일 소유 작업으로 합친 뒤 소비자 작업을 재개한다.
5. 완료 산출물은 통합 게이트를 통과하기 전까지 후속 작업의 기준 버전으로 간주하지 않는다.

## 중요 경로

기본적인 플레이 가능한 경로는 G0 → T01 → T02/T03/T04/T05 → T06/T08 → T09 → T10/T11/T12/T13 → T14/T15 → 카드 모듈(T16~T40) → T41/T42 → T43/T44/T45/T46/T47/T48 → T58 → T60 순서다. UI는 계약 T02와 게임 projection T07을 이용해 일부 서버 작업과 겹쳐 진행할 수 있다. 재접속/비공개 상태 검증 T48 및 웹 동기화 T58은 통합 검수 전에 생략할 수 없다.

## 작업 명세

각 작업은 단일 파일 소유권을 갖고, 산출물은 변경 파일과 acceptance 증거다. 아래 입력 목록은 공통 입력 문서에 추가되는 해당 작업의 직접 입력이다. 작업 ID, 상태, 파동, 의존성, 소유 경로, 수락 기준의 CSV 색인은 [data/task-index.csv](data/task-index.csv)에 있다.

### W1 — 저장소와 계약

#### T01 — 모노레포 기본 뼈대

- 상태: DONE
- 의존: 없음
- 파일 소유: 루트 package.json, pnpm-workspace.yaml, 공통 package manager lockfile, 루트 tsconfig.json, 각 apps/packages의 최소 package manifest
- 입력: 03_ARCHITECTURE.md
- 범위: 위 여섯 영역의 workspace 연결과 공통 개발 명령 진입점을 만든다.
- 제외: 앱 기능, 프로토콜 필드, CI 배포 파이프라인
- 산출물: 의존성 설치와 각 패키지 작업 진입점이 정의된 워크스페이스
- 수락 기준: 깨끗한 checkout에서 `pnpm install --frozen-lockfile`이 성공한다. 각 앱/패키지 manifest가 workspace에 포함되고, 앱 코드를 아직 요구하지 않는 `pnpm check`가 실패 없이 종료한다. 근거: Node v22.23.1, pnpm v11.19.0; 두 명령 모두 2026-09-27 실행 성공.

#### T02 — 공유 프로토콜 계약과 기본 fixture

- 상태: DONE
- 의존: T01
- 파일 소유: outputs/development-plan/04_PROTOCOL.md, packages/contracts/**, packages/test-fixtures/protocol/**
- 입력: 04_PROTOCOL.md
- 범위: 버전이 붙은 이벤트/명령/응답/상태 DTO, expectedVersion, idempotency key, fixture 직렬화 예제를 정의한다.
- 제외: 서버 라우팅, 엔진 상태 전이, UI 컴포넌트
- 산출물: 계약 타입 및 유효한 프로토콜 샘플과 잘못된 샘플
- 수락 기준: 각 문서화 이벤트의 최소 유효 fixture가 타입 검사를 통과한다. 누락된 버전 또는 필수 필드가 포함된 fixture는 검증에서 거부된다. 비공개 역할/손패 필드는 공개 응답 타입에 존재하지 않는다. 근거: `pnpm --filter @bang/contracts check`, `pnpm --filter @bang/contracts test` 성공(4/4); 공개 역할인 Sheriff에게도 인증된 본인 `selfPrivate.hand`을 제공하는 타입 예제와 의미 주석을 검토.
- T45 unblock 보완: `room:preview`의 정확한 request/success/rejected DTO와 room/match sync rejection DTO를 04_PROTOCOL §2.3/§5.1에 고정하고 packages/contracts 및 protocol fixtures에 구현한다. RoomPreviewRequest는 protocolVersion/requestId/inviteCode, success는 protocolVersion/requestId/roomId/version/occupancy/status, 실패는 protocolVersion/requestId/status="rejected"/error code `BAD_REQUEST` 또는 `INVITE_INVALID` 형태다. 초대 코드는 invalid/unauthorized를 같은 INVITE_INVALID로 처리한다. SyncRejectedResponse는 protocolVersion/requestId/status="rejected"/error code `BAD_REQUEST` 또는 `NOT_FOUND_OR_FORBIDDEN`이다. status/요청 문자열 경계는 기존 v1 string/status 계약과 맞추며 세션 credential/invite 원문을 응답에 포함하지 않는다. strict parser는 room preview와 room/match sync request에 제공해 T45가 중복 검사하지 않게 한다.
- 루트 근거: `pnpm --filter @bang/contracts check` 통과; `pnpm --filter @bang/contracts test` 통과(7/7). Preview/sync request strict parsing, preview/sync rejection exact-key response parsing 및 nested secret/resource 필드 거절 확인. 통합 AT는 미실행.

#### T03 — 카탈로그 스키마

- 상태: DONE
- 의존: T01, T02
- 파일 소유: packages/catalog/src/schema.ts, packages/catalog/src/validate.ts, packages/catalog/test/schema.test.ts
- 입력: 01_RULES.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md, outputs/assets/asset_manifest.csv
- 범위: 카드 정의, 물리 덱 수량, 역할, 인물, 에셋 참조 데이터의 필드와 정적 검증 규칙을 정의한다.
- 제외: 실제 효과 실행, 이미지 수정, 규칙 문구 재해석
- 산출물: 카탈로그 자료형과 입력 데이터 검증 함수
- 수락 기준: 유효/무효 카탈로그 fixture 각각이 스키마 검사에서 올바르게 승인/거부된다. 식별자 중복, 알 수 없는 에셋 경로, 음수 수량은 거부된다. 근거: `pnpm --filter @bang/catalog check`, `node --experimental-strip-types --test packages/catalog/test/schema.test.ts` 성공(7/7); numeric rank는 2–10 및 A/J/Q/K만 승인.

#### T04 — 기본 덱 데이터 가져오기 및 검증

- 상태: DONE
- 의존: T03
- 파일 소유: packages/catalog/src/cards/**, packages/catalog/test/cards.test.ts
- 입력: 01_RULES.md, outputs/development-plan/data/base-deck.json, outputs/development-plan/data/base-deck.csv, outputs/development-plan/data/card-types.json, outputs/assets/asset_manifest.csv
- 범위: 이미 준비된 기계용 덱/카드 정의를 packages/catalog로 가져오고 스키마를 검증한다. 원본 데이터는 수량과 정확한 rank/suit의 기준이다.
- 제외: 카드 데이터 수작업 재수집/재입력, 카드 효과 구현, 출처 이미지 재가공
- 산출물: 기본 덱 카탈로그 어댑터/데이터와 원본 대조 테스트
- 수락 기준: 테스트가 소스 JSON에 기록된 80개 인스턴스, 22개 카드 종류, 수량, rank, suit를 모두 대조한다. 두 소스가 다르면 하나를 추측해 고치지 않고 차이를 보고한다. 카드 정의의 에셋 키가 inventory에 존재한다. 근거: JSON/CSV 80장 일치, 22종 및 에셋 매핑 검증; `pnpm --filter @bang/catalog check`, deck tests 4/4 성공.

#### T05 — 역할·인물 데이터 가져오기와 에셋 경로

- 상태: DONE
- 의존: T03
- 파일 소유: packages/catalog/src/roles/**, packages/catalog/src/characters/**, packages/catalog/src/assets/**, packages/catalog/test/roster-assets.test.ts
- 입력: 01_RULES.md, outputs/development-plan/data/roles.json, outputs/development-plan/data/characters.json, outputs/assets/asset_manifest.csv, outputs/assets/ASSET_INVENTORY.md, outputs/assets/ATTRIBUTION.md
- 범위: 이미 준비된 역할/인물 자료를 스키마로 가져오고 실제 웹 공개 경로에 맞춰 에셋 ID와 파일 URL을 연결한다. 파일 URL은 apps/web/public/assets/cards/ 아래를 기준으로 한다.
- 제외: 인물 능력 코드, 역할/인물 데이터 수작업 재수집, 권리 범위 확대, 카드 이미지 편집
- 산출물: 역할/인물 카탈로그 및 public asset URL/출처 메타데이터
- 수락 기준: 테스트가 원본 JSON의 7개 역할 카드와 16개 인물의 ID/정적 필드를 대조한다. 모든 이미지 URL이 T54에서 복사할 실제 파일명과 일치하고 attribution metadata가 보존된다. 규칙 의미 불일치는 임의 보정하지 않고 질문으로 등록한다. 근거: 역할 배분 합(4~7인), 16인 정적 필드, source inventory URL/attribution tests 3/3 통과; `pnpm --filter @bang/catalog check` 성공. `apps/web/public/assets/cards/`는 T54가 아직 복사하지 않아 실제 대상 디렉터리 존재 확인은 미검증으로 남긴다.

### W2 — 엔진 공용 기반

#### T06 — 엔진 상태 모델

- 상태: DONE
- 의존: T02, T03
- 파일 소유: packages/engine/src/state/types.ts
- 입력: 01_RULES.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md
- 범위: 게임 내부 상태의 덱/버림/플레이어/턴/대기 중인 해결 단계 자료형을 정의한다.
- 제외: 상태 전이 함수, 네트워크 DTO 중복 선언
- 산출물: 직렬화 가능한 내부 GameState 및 불변식 타입
- 수락 기준: 정상 플레이 상태와 대기 중인 반응 상태를 모두 표현한다. 공개 DTO와 비공개 정보의 경계가 타입으로 구분되고, 프로토콜 DTO를 복사해 중복 정의하지 않는다. 근거: `pnpm --filter @bang/engine check` 성공; JSON 직렬화 가능한 GameState, seat private/public 분리, 저장 가능한 resolution/death/frame state를 루트 검토.

#### T07 — 플레이어별 공개 상태 projection

- 상태: DONE
- 의존: T02, T06
- 파일 소유: packages/engine/src/state/projection.ts, packages/engine/test/state/projection.test.ts
- 입력: 01_RULES.md, 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: 내부 상태와 관전자 자격이 아닌 지정 좌석 정보를 받아 해당 플레이어가 볼 수 있는 상태를 계산한다.
- 제외: Socket.IO 전송, 임의의 추가 정보 노출, 로그인
- 산출물: 순수한 player-specific projection 함수
- 수락 기준: 두 플레이어의 손패/역할 비공개 필드가 서로의 projection에 나타나지 않는다. 공개 상태(버림 더미, 장착, 생명력 등)는 모든 플레이어 projection에서 같은 버전으로 일치한다. projection 호출은 상태를 변경하지 않는다. 근거: `pnpm --filter @bang/engine check`, `node --experimental-strip-types --test packages/engine/test/state/projection.test.ts` 성공(7/7); 비밀 필드 격리, 공개 테이블 일치, 버림 top/count, pending actor 제한, 탈락/종료 projection, 불변성, 비좌석 거절 검증.

#### T08 — 주입형 RNG와 덱 셔플

- 상태: DONE
- 의존: T06
- 파일 소유: packages/engine/src/random/**, packages/engine/test/random/**
- 입력: 03_ARCHITECTURE.md, 06_ACCEPTANCE_TESTS.md
- 범위: 엔진 생성 시 전달할 RNG 계약과 덱 셔플을 구현한다.
- 제외: 전역 RNG, 방 생성, 외부 난수 서비스
- 산출물: 주입형 결정적 난수 인터페이스와 셔플 함수
- 수락 기준: 동일한 고정 RNG 시퀀스와 같은 덱에서 동일한 결과가 나온다. 원소 수와 카드 식별자가 셔플 전후 보존된다. 구현은 Math.random과 시스템 시간에 접근하지 않는다. 근거: `pnpm --filter @bang/engine check`, `node --experimental-strip-types --test packages/engine/test/random/shuffle.test.ts` 성공(4/4); `packages/engine/src/random`에서 전역 RNG/시간 접근 없음.

#### T09 — 게임 초기화

- 상태: DONE
- 의존: T04, T05, T06, T08
- 파일 소유: packages/engine/src/setup/**, packages/engine/test/setup/**
- 입력: 01_RULES.md, 06_ACCEPTANCE_TESTS.md
- 범위: 인원수와 시드가 주어졌을 때 역할/인물/초기 손패/체력/턴/덱을 규칙에 따라 배정한다.
- 제외: 룸 로비, 네트워크 메시지
- 산출물: 초기 GameState 생성기와 재현 가능한 fixture
- 수락 기준: 허용 인원수 경계에서 역할별 장수, 보안관 첫 차례, 초기 체력 및 카드 수가 01_RULES.md와 일치한다. 고정 RNG를 사용한 초기화가 재현 가능하다. 근거: `pnpm --filter @bang/engine check`, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/setup/initialize.test.ts` 성공(4/4); 4~7인 역할/좌석, 서로 다른 인물, HP·손패, 80장 유일 배치 및 결정성 검증.

#### T10 — 턴 상태 reducer

- 상태: DONE
- 의존: T06, T09
- 파일 소유: packages/engine/src/turn/**, packages/engine/test/turn/**
- 입력: 01_RULES.md, 04_PROTOCOL.md
- 범위: 단계 진입/종료, 현재 차례 전환, 필수 단계의 진행을 순수 reducer로 구현한다.
- 제외: 개별 카드 효과, Socket.IO 시간/이벤트
- 산출물: 엔진 공용 reducer와 상태 전이 결과 타입
- 수락 기준: 허용되지 않은 단계 전이가 명시적 오류를 낸다. 합법 전이는 버전과 현재 좌석을 갱신하며 상태 불변식을 유지한다. 같은 입력 상태/행동/난수에 같은 결과가 나온다. 근거: `pnpm --filter @bang/engine check`, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/turn/reducer.test.ts` 성공(8/8); 순수 전이, 종료·버리기 단계, 탈락 좌석 순환, 잘못된 actor/phase 및 모든 resolution 대기 조건 거부 검증.

#### T11 — 합법 행동, 거리 및 대상 계산

- 상태: DONE
- 의존: T06, T10
- 파일 소유: packages/engine/src/rules/legality.ts, packages/engine/src/rules/distance.ts, packages/engine/test/rules/**
- 입력: 01_RULES.md, 06_ACCEPTANCE_TESTS.md
- 범위: 현재 상태에서 가능한 행동/대상, 좌석 간 거리, 장착 카드에 따른 거리 보정을 계산한다.
- 제외: UI 대상 강조, 개별 능력 효과
- 산출물: 재사용 가능한 합법성/거리 순수 함수
- 수락 근거: `pnpm --filter @bang/engine check` 및 `node --experimental-strip-types --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./packages/engine/test/setup/ts-source-loader.mjs", pathToFileURL("./"));' --test packages/engine/test/rules/distance-legality.test.ts` 통과(12/12). 루트 검토에서 작업 소유 경로, 원형 좌석 거리, 방향별 거리 보정과 무기 사거리 분리, BANG! 제한·Volcanic/Willy 예외, Panic!/Cat Balou 공개 대상 검증을 확인했다. 이 단위 테스트는 연관 AT 케이스 전체 통과를 의미하지 않는다.
- 수락 기준: 좌석 수와 탈락 좌석을 포함한 원형 거리 예제가 규칙대로 계산된다. 무기 사거리와 거리 보정이 서로 다른 규칙을 중복 적용하지 않는다. 불법 대상 선택은 거부된다.

#### T12 — 카드 해결과 반응 프레임워크

- 상태: DONE
- 의존: T06, T10, T11
- 파일 소유: packages/engine/src/resolution/**, packages/engine/test/resolution/**
- 입력: 01_RULES.md, 04_PROTOCOL.md
- 범위: 해결 중 카드, 순차 effectQueue, 응답 대기 좌석, 죽음/구제 선택, 후속 continuation을 명시적으로 직렬화하고 재개한다.
- 제외: 개별 카드 효과 내용, 자동 시간 만료
- 산출물: 순수 해결 프레임/응답 큐 API
- 수락 기준: Duel, 다중 대상 공격, 죽음/구제, DISCARDS_ORDER 선택을 저장/복구할 수 있다. 유효 응답은 해당 cursor만 한 번 진행하고 잘못된 응답자는 상태를 바꾸지 못한다. 중간 재시작 뒤 다음 actor와 resume frame이 동일하다.

#### T13 — 탈락 및 승리 판정

- 상태: DONE
- 의존: T06, T10, T12
- 파일 소유: packages/engine/src/endgame/**, packages/engine/test/endgame/**
- 입력: 01_RULES.md
- 범위: 생명력 0 구제 완료, 역할 공개/탈락, Vulture Sam 회수, 소유자 지정 버리기 순서, 처치 보상 및 효과 완료 경계의 승리 판정을 처리한다.
- 제외: 결과 화면, 랭킹/통계
- 산출물: 탈락 처리 및 게임 종료 판정 함수
- 수락 기준: Beer/Sid 구제 완료 또는 포기 뒤에만 탈락 처리를 시작한다. Vulture Sam이 살아 있으면 손패/장착을 먼저 자신의 손패로 회수하고, 없으면 탈락자가 공개 카드 정리 순서를 입력한다. 무법자 처치 보상과 보안관의 부관 처치 벌칙 순서를 확인한다. 승리는 multi-target 효과의 마지막 대상/후처리 완료 뒤 한 번만 검사한다. 근거: `pnpm --filter @bang/engine check`, 명시된 엔진 테스트 8개 실행(52/52 통과). `endgame/endgame.test.ts` 7개가 Sam 회수·Sheriff 벌칙 순서, Dynamite/ Duel 귀속, 보상, victory role reveal 및 multi-target victory 경계를 확인한다. 통합 acceptance ID는 실행하지 않았다.

#### T14 — 엔진 명령 처리기

- 상태: DONE
- 의존: T02, T06, T10, T11, T12, T13
- 파일 소유: packages/engine/src/commands/**, packages/engine/test/commands/**
- 입력: 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: 검증된 도메인 명령의 현재 actor/단계/카드/대상 합법성을 확인하고 엔진 전이 또는 규칙상 거절 결과를 만든다.
- 제외: 인증, aggregate expectedVersion 비교, command receipt/idempotency, 저장소, 네트워크 전달
- 산출물: 순수 엔진 명령 적용 API
- 수락 기준: 불법 명령은 상태를 바꾸지 않고 명시적 규칙 오류를 반환한다. 같은 상태·명령·준비된 RNG 결과에 같은 전이와 이벤트가 나온다. expectedVersion/idempotency 처리는 T46 서버 경계에 한 번만 존재한다.
- 근거: `pnpm --filter @bang/engine check` 통과, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/commands/commands.test.ts` 통과(9/9). END_TURN의 T10 전이와 초과 손패 T12 선택/버림/frame 종료, actor·phase·소유권·사거리·Calamity 변환·응답 cursor 검증 및 결정성을 확인했다. 카드/인물 효과는 T41 등록기에서 주입하며 expectedVersion/receipt는 T46 경계다. 통합 수락 AT는 실행하지 않았다.

#### T15 — 카드 효과 모듈 인터페이스

- 상태: DONE
- 의존: T06, T11, T12
- 파일 소유: packages/engine/src/effects/api.ts, packages/engine/test/effects/api.test.ts
- 입력: 01_RULES.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md
- 범위: 카드별 효과 모듈이 받는 상태, 대상, 난수, 응답 요청, 결과 이벤트의 최소 계약을 정의한다.
- 제외: 효과 등록기, 카드 규칙 구현, 공용 상태 변경
- 산출물: 고정된 카드 효과 API 타입
- 수락 기준: 후속 카드 모듈이 공용 reducer 수정 없이 효과를 작성할 수 있다. 대상이 없거나 불법인 경우, 선택/응답이 필요한 경우를 API가 구분한다. 타입에는 클라이언트 전용 UI 의존성이 없다. 근거: `pnpm --filter @bang/engine check`, API 단독 `pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck packages/engine/src/effects/api.ts`, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/api.test.ts` 모두 통과(5/5). 비카드 인물 능력은 sourceCardInstanceId `null`로 표현한다. 이 단위 테스트는 AT 케이스 통과가 아니다.

### W3 — 기본 카드 효과 모듈

각 작업은 자신의 효과 파일과 전용 테스트만 소유한다. 공용 reducer/state/effect API 수정은 제외한다.

#### T16 — BANG!, 빗나감!, 맥주

- 상태: DONE
- 의존: T11, T12, T13, T15
- 파일 소유: packages/engine/src/effects/cards/basic-actions.ts, packages/engine/test/effects/basic-actions.test.ts
- 입력: 01_RULES.md
- 범위: BANG! 사용/대응, 빗나감! 응답, 맥주의 회복 규칙을 모듈화한다.
- 제외: 무기/인물 능력에 따른 카드 사용 제한 자체의 공용 API 변경
- 산출물: 세 기본 행동 카드 효과와 경우별 테스트
- 수락 기준: BANG 사용 횟수와 Missed 대응이 구분되고, 맥주는 최대 체력까지만 회복한다. 2인 Beer, 2인 자기 턴 사용, 구제용 Beer의 차이를 테스트한다. 모든 결과가 기본 ruleset과 일치한다.
- 근거: `pnpm --filter @bang/engine check` 통과; 전용 테스트 11/11 통과. 2인 사망 구제에서 Beer 사용은 수락되고 회복량 0/HEAL_PLAYER 없음 확인. 통합 AT는 미실행.

#### T17 — 패닉!과 캣 벌루

- 상태: DONE
- 의존: T11, T12, T15
- 파일 소유: packages/engine/src/effects/cards/steal-discard.ts, packages/engine/test/effects/steal-discard.test.ts
- 입력: 01_RULES.md
- 범위: 거리 조건에 맞는 대상의 허용된 카드 영역에서 카드를 가져오거나 버리는 효과를 구현한다.
- 제외: 거리 API 변경, 장착 카드 공용 상태 모델 변경
- 산출물: 패닉!/캣 벌루 효과와 대상/카드 선택 테스트
- 수락 기준: Panic은 인접 상대, Cat Balou는 거리 무관 대상을 처리한다. 손패 대상은 서버 RNG로 무작위 1장을 고르고, 공개 장착 카드는 카드를 낸 플레이어가 대상의 공개 영역에서 선택한다(S1 “The Symbols”). 자기 대상 정책 D03에 따라 자기 공개 장착은 허용하고 자기 손패는 거부한다. 무작위 선택은 주입 RNG로 재현된다.
- 근거: `pnpm --filter @bang/engine check`와 전용 테스트 8/8 통과. 내부 무작위 손패 카드 ID는 비공개 projection 통합 검토 대상이며 통합 AT는 미실행.

#### T18 — 인디언!, 개틀링, 술집

- 상태: DONE
- 의존: T12, T13, T15
- 파일 소유: packages/engine/src/effects/cards/tablewide.ts, packages/engine/test/effects/tablewide.test.ts
- 입력: 01_RULES.md
- 범위: 전체 대상 공격/응답 순서와 전체 회복의 카드 효과를 구현한다.
- 제외: 개별 카드 반응 UI 및 사거리 계산
- 산출물: 광역 카드 효과 모듈과 좌석 순서 테스트
- 수락 기준: Gatling의 Missed/Barrel 대응과 Indians의 BANG 폐기/피해 선택이 다르게 처리된다. Calamity의 변환 예외, Slab 미강화, 사용자 다음 좌석부터의 시계방향 직렬 응답을 테스트한다. 광역 카드로 발생한 모든 탈락/후처리를 끝낸 뒤 승리를 판정한다. Saloon은 자기 포함 생존자 회복이며 2인에도 유효하다.
- 근거: `pnpm --filter @bang/engine check` 및 전용 테스트 9/9 통과. 시계방향 대상 큐, Missed 1장과 직렬 `BARREL_CHECK` 위임, Indians 선택/Calamity 변환, Saloon 2인 회복/최대HP/부활 불가, 큐 전체 후 승리 검사를 확인. Barrel 판정 결과와 실패 뒤 Missed 연결은 T22/T31/T41 통합 검증에 남겨 두며 통합 AT는 미실행.

#### T19 — 역마차, 웰스 파고, 엠포리움

- 상태: DONE
- 의존: T12, T15
- 파일 소유: packages/engine/src/effects/cards/draw-select.ts, packages/engine/test/effects/draw-select.test.ts
- 입력: 01_RULES.md
- 범위: 덱에서 여러 장 뽑기와 엠포리움의 좌석 순서 선택 절차를 구현한다.
- 제외: 덱 셔플, 기본 드로우 단계
- 산출물: 세 카드 효과와 덱 부족/좌석별 선택 테스트
- 수락 기준: Stagecoach 2장, Wells Fargo 3장, General Store는 현재 생존자 수만큼 공개한 뒤 사용자부터 시계방향으로 한 장씩 고른다. 덱/버림더미 고갈은 명시된 재셔플 규칙에 따르고 선택하지 않은 카드는 규칙에 맞는 구역에 남는다.
- 근거: `pnpm --filter @bang/engine check` 통과; 전용 테스트 7/7 통과. R08 재셔플/D05 일시정지, 생존자 수만큼 공개, 사용자부터 순차 선택 및 남은 카드 버림을 확인. 통합 AT는 미실행.

#### T20 — 결투

- 상태: DONE
- 의존: T12, T15
- 파일 소유: packages/engine/src/effects/cards/duel.ts, packages/engine/test/effects/duel.test.ts
- 입력: 01_RULES.md
- 범위: 두 좌석 간 교대 응답, 응답 소진 및 피해 종료 규칙을 구현한다.
- 제외: UI, 범용 응답 프레임 API 수정
- 산출물: 결투 효과 상태 진행과 테스트
- 수락 기준: 대상은 거리 무관 다른 생존자이고 상대부터 BANG을 번갈아 낸다. Duel 대응 BANG은 자기 턴 사용 횟수를 소모하지 않는다. Calamity 변환과 즉시 종료, Duel 원 개시자가 죽을 때 처치 보상이 없는 규칙을 고정 RNG/fixture로 검증한다.
- 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 공용 TypeScript loader를 사용한 전용 테스트 5/5 통과. 거리 무관 대상/자기 대상 차단, 대상 우선 교대, 포기·응답 카드 부족 시 즉시 피해, Calamity의 Missed 변환, BANG 사용량 비증가, 개시자 자기 탈락 시 R28 보상 없음 경계를 확인했다. T41 runner 및 통합 AT는 미실행.

#### T21 — 감옥

- 상태: DONE
- 의존: T12, T15
- 파일 소유: packages/engine/src/effects/cards/jail.ts, packages/engine/test/effects/jail.test.ts
- 입력: 01_RULES.md
- 범위: 감옥 설치/대상 제한과 차례 시작 시 해결 결과를 구현한다.
- 제외: 턴 순환 공용 reducer 변경, 자동 시간 만료
- 산출물: 감옥 카드 효과와 차례 시작 테스트
- 수락 기준: 보안관이 아닌 다른 생존자에게만 설치되고 차례 시작 시 다이너마이트보다 뒤에 판정한다. Heart면 진행, 아니면 드로우/사용/버리기 전체를 건너뛰며 감옥은 결과와 무관하게 버려진다. 카드 영역과 표시 순서를 검증한다.
- 근거: `pnpm --filter @bang/engine check`와 감옥 전용 테스트 7/7 통과. 합법/불법 대상, Heart·비Heart, R08 버림 더미 재활용, D05 자원 고갈, 판단 카드/감옥 버림 순서, 다이너마이트 해결 뒤 판정 전제 확인. Lucky Duke 2장 판단(C08/C10)은 인물 통합 작업 범위이며 미검증. 통합 AT는 미실행.

#### T22 — 다이너마이트와 배럴

- 상태: DONE
- 의존: T08, T12, T13, T15
- 파일 소유: packages/engine/src/effects/cards/dynamite-barrel.ts, packages/engine/test/effects/dynamite-barrel.test.ts
- 입력: 01_RULES.md
- 범위: 차례 시작 판정, 다음 좌석 이동, 배럴 대응 및 피해를 구현한다.
- 제외: RNG 구현, 공용 턴 reducer 변경
- 산출물: 다이너마이트/배럴 효과와 고정 RNG 테스트
- 수락 기준: 다이너마이트는 감옥보다 먼저 처리되며 Spade 2~9면 피해 3, 아니면 다음 생존 좌석으로 이동한다. 폭발 책임자는 없고 Barrel은 비-BANG 다이너마이트 피해를 막지 않는다. 주입 RNG가 같은 결과를 재현한다.
- 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 전용 테스트 11/11 통과. Spade 2/9 폭발·10/A 전달, 다음 생존 좌석, R08 결정적 재셔플, D05 고갈, 책임자 없는 피해와 Barrel 비적용, Gatling 직렬 Barrel/Missed·Slab·Jourdonnais 경계 및 forged responder 거절을 확인했다. 실제 T18/T41 runner의 다음 방어 응답 재개와 매치 이벤트 적용은 미검증이며 통합 AT는 미실행.

#### T23 — 무기와 거리 장비

- 상태: DONE
- 의존: T11, T15
- 파일 소유: packages/engine/src/effects/cards/equipment.ts, packages/engine/test/effects/equipment.test.ts
- 입력: 01_RULES.md
- 범위: 무기 교체/장착 및 조준경·무스탕 등 거리 보정 카드의 효과를 구현한다.
- 제외: 공용 거리 함수 변경, 카드 UI
- 산출물: 장착 효과와 거리 보정 테스트
- 수락 기준: 무기별 사거리 1~5와 무기 1개 장착 제한을 대조한다. Volcanic 장착 중 BANG 무제한이어도 잃은 뒤 턴 사용 횟수는 초기화되지 않는다. 상대 Mustang/Paul과 자신의 Scope/Rose 보정이 비대칭 거리 공식에 적용된다.
- 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 전용 테스트 5/5 통과. 가상 Colt와 무기별 거리, 무기 교체 시 버림/장착 순서, Volcanic 제거 뒤 BANG 사용량 보존, 방향별 Mustang/Paul/Scope/Rose 보정과 잘못된 장착을 확인했다. 이벤트 적용은 모듈 fixture 수준이며 통합 AT는 미실행.

#### T24 — 차례 종료 손패 버리기

- 상태: DONE
- 의존: T10, T15
- 파일 소유: packages/engine/src/effects/cards/hand-limit.ts, packages/engine/test/effects/hand-limit.test.ts
- 입력: 01_RULES.md
- 범위: 차례 종료 시 손패 제한과 초과 카드 폐기 계산을 구현한다.
- 제외: 공용 차례 reducer 변경, 버리기 선택 UI
- 산출물: 손패 제한 효과와 체력 변화 경계 테스트
- 수락 기준: 턴 종료 손패는 현재 HP 이하가 되며 필요한 초과분만 버린다. 손패와 장착 카드의 임의 폐기를 허용하지 않고 여러 장 순서는 소유자의 배열대로 기록한다. 종료/탈락 정리 순서와 턴 손패 제한을 구분한다.
- 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 loader를 사용한 전용 테스트 6/6 통과. 현재 HP 기준 초과분, 불필요한 손패/장착 카드 버리기 거절, HP 변경 뒤 오래된 선택 거절, 탈락 cleanup과의 분리, JSON 왕복 뒤 T12 `DISCARDS_ORDER` 이어하기 및 입력 순서/top 검증을 확인했다. 턴 진행/effect runner 통합과 acceptance suite는 미실행.

### W3 — 인물별 효과 모듈

각 작업의 효과는 지정된 단일 파일에 둔다. 인물의 시작 능력/지속 효과/대응 능력을 01_RULES.md에 기록된 범위 안에서만 구현한다. 카드 인물 파일, 등록기, 공유 API 수정은 제외한다.

#### T25 — Bart Cassidy

- 상태: DONE
- 의존: T11, T12, T15, T65, T66, T70
- 파일 소유: packages/engine/src/effects/characters/bart-cassidy.ts, packages/engine/test/effects/characters/bart-cassidy.test.ts
- 입력: 01_RULES.md C01/R27/R08/D05, T05 카탈로그 산출물, T65 CharacterAbilityModule API, T66 damage-resolved hook, T70 draw-pile supply
- 산출물: 피해 수신 능력 모듈
- 수락 기준: 생존한 상태로 잃은 HP당 공용 R08 공급 경로로 덱 1장을 얻고 Dynamite 3 피해를 버텨도 3장을 얻는다. 치명상 구제 창에서 능력으로 Beer를 찾아 구제할 수 없고, 다른 인물은 발동하지 않는다. D05 자원 고갈은 카드를 만들지 않고 정해진 pause 이벤트로 위임한다.
- 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 Bart 전용 tests 7/7 통과. 실제 HP 손실량 기준의 생존 후 드로우, Dynamite 피해, 치명상 구제 뒤 발동, D05 부분 고갈, source/player 귀속과 불변성을 확인했다. T66 Beer 구제 회귀도 포함했다. 통합 AT 미실행.

#### T26 — Black Jack

- 상태: DONE
- 의존: T08, T12, T15, T65, T70
- 파일 소유: packages/engine/src/effects/characters/black-jack.ts, packages/engine/test/effects/characters/black-jack.test.ts
- 입력: 01_RULES.md C02/R08, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 시작 카드 추가 공개/획득 모듈
- 수락 기준: 뽑기 단계 두 번째 카드만 공개한다. Heart/Diamond면 추가 덱 카드 1장을 비공개로 얻으며, Black Jack 공개는 Draw! 판정이 아니고 추가 뽑기에는 능력이 반복되지 않는다. 근거: 루트 재검증 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/characters/black-jack.test.ts` 6/6 통과, `pnpm --filter @bang/engine check` 통과. 통합 AT C04는 미실행.

#### T27 — Calamity Janet

- 상태: DONE
- 의존: T11, T12, T15, T65, T66, T71
- 파일 소유: packages/engine/src/effects/characters/calamity-janet.ts, packages/engine/test/effects/characters/calamity-janet.test.ts, packages/engine/src/effects/cards/basic-actions.ts, packages/engine/src/effects/cards/tablewide.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 카드 대체 사용 능력 모듈
- 수락 기준: BANG을 Missed로, Missed를 BANG으로 일반 사용/대응할 수 있다. BANG 변환은 턴 BANG quota를 쓰고 Duel/Indians 대응에도 변환 BANG이 허용된다. 다른 인물은 변환하지 않는다.
- 근거: T71의 성공 effective BANG 누적 경계를 사용해 C03 변환 및 일반 BANG 대응을 검증했다. 루트 재검증 Calamity tests 6/6, basic-actions 11/11, tablewide 9/9, Duel 5/5, command tests 9/9, runtime tests 10/10 및 `pnpm --filter @bang/engine check` 통과. 공용 API/state/reducer를 바꾸지 않았다. 통합 AT 미실행.

#### T28 — El Gringo

- 상태: DONE
- 의존: T12, T15, T65
- 파일 소유: packages/engine/src/effects/characters/el-gringo.ts, packages/engine/test/effects/characters/el-gringo.test.ts
- 입력: 01_RULES.md C04/R27, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 피해 출처 손패 획득 능력 모듈
- 수락 기준: 다른 플레이어의 사용 카드로 HP를 잃고 생존한 경우 HP당 해당 사용자의 손패를 무작위 1장씩 가져온다. 상대 손패가 없으면 얻지 않는다. Dynamite/자신이 연 Duel에서 진 경우에는 발동하지 않는다. 근거: 루트에서 전용 테스트 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/characters/el-gringo.test.ts` 6/6, 지정 소스·테스트 strict tsc 통과. 전체 engine check는 작업 중인 T66 `runtime/index.ts`의 타입 오류 2개 때문에 실패했으며 이 작업의 파일 오류는 아니다. 통합 AT 미실행.

#### T29 — Jesse Jones

- 상태: DONE
- 의존: T08, T12, T15, T65
- 파일 소유: packages/engine/src/effects/characters/jesse-jones.ts, packages/engine/test/effects/characters/jesse-jones.test.ts
- 입력: 01_RULES.md C05/R12, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 시작 뽑기 대체 선택 모듈
- 수락 기준: 뽑기 단계 첫 카드만 다른 생존자의 손패에서 무작위로 가져오거나 덱에서 받는다. 두 번째 카드는 덱에서 뽑으며 빈 상대 손패의 처리가 룰 문서와 같다. 근거: 루트 재검증 전용 테스트 6/6, `pnpm --filter @bang/engine check`, 지정 소스·테스트 strict tsc 통과. 테스트는 첫 슬롯 private source options, 현재 손패의 무작위 1장 이전, 빈 상대손 처리, 덱 선택 시 R08/D05 호출자 위임, 두 번째 슬롯 비활성을 확인했다. 통합 드로우와 97개 AT 미실행.

#### T30 — Jourdonnais

- 상태: DONE
- 의존: T08, T12, T15, T65
- 파일 소유: packages/engine/src/effects/characters/jourdonnais.ts, packages/engine/test/effects/characters/jourdonnais.test.ts
- 입력: 01_RULES.md C06/R13, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 피해 회피 판정 모듈
- 수락 기준: BANG-symbol 공격마다 가상 Barrel 판정을 한 번 한다. Heart면 Missed 1개로 인정한다. 실제 Barrel도 장착한 경우 판정이 각각 한 번 적용되고, 비공격 피해에는 판정하지 않는다. 근거: 루트 재검증 Jourdonnais 모듈 5/5, `pnpm --filter @bang/engine check`, 지정 파일 strict tsc, `dynamite-barrel.test.ts` 11/11 및 `tablewide.test.ts` 9/9 통과. 별도 가상 판정원 제공, Heart/비Heart Missed 수, 장착 Barrel과의 독립 1회, BANG/Gatling 응답 및 비공격 Dynamite 경계를 확인했다. 통합 AT 미실행.

#### T31 — Kit Carlson

- 상태: DONE
- 의존: T08, T12, T15, T65
- 파일 소유: packages/engine/src/effects/characters/kit-carlson.ts, packages/engine/test/effects/characters/kit-carlson.test.ts
- 입력: 01_RULES.md C07/R08, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 시작 카드 선택 뽑기 모듈
- 수락 기준: 뽑기 단계 덱 3장을 본인만 보고 2장 손패에 넣으며, 남은 1장을 덱 맨 위에 비공개로 돌려놓는다. 다른 viewer projection에서 선택 후보를 숨긴다. 근거: 루트 재검증 전용 테스트 5/5, `pnpm --filter @bang/engine check` 통과. 후보 비공개 선택지, top-three/revealed-pool 위치 확인, 두 장 획득과 나머지 top 반환, viewer projection 격리, 후보 미제공 시 no-op을 검사했다. 통합 AT 미실행.

#### T32 — Lucky Duke

- 상태: DONE
- 의존: T08, T12, T15, T65, T70
- 파일 소유: packages/engine/src/effects/characters/lucky-duke.ts, packages/engine/test/effects/characters/lucky-duke.test.ts
- 입력: 01_RULES.md C08/R08, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 판정 복수 공개 능력 모듈
- 수락 기준: T67이 Draw! 시 공용 R08 supplier로 만든 공개 후보 2장을 hook에 전달한다. T32는 후보 검증, Lucky의 선택에 따른 판정, 두 장의 D04 순서 버림 이벤트만 만든다. 일반 뽑기와 Black Jack 추가 뽑기에는 hook을 호출하지 않는다. T32가 별도 RNG/덱 공급을 수행하지 않는다. 근거: 루트 재검증 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/characters/lucky-duke.test.ts` 3/3 통과, `pnpm --filter @bang/engine check` 통과. T67 통합 및 AT C10은 미실행.

#### T33 — Paul Regret

- 상태: DONE
- 의존: T11, T15
- 파일 소유: packages/engine/src/effects/characters/paul-regret.ts, packages/engine/test/effects/characters/paul-regret.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 다른 플레이어의 거리 보정 모듈
- 수락 기준: 상대가 Paul Regret에게 계산하는 자기 거리에 +1을 적용하고 Mustang과 누적한다. Rose/Scope 및 탈락 좌석을 포함한 방향별 거리 fixture가 R10 공식과 일치한다. 근거: 루트 engine check, T33 전용 테스트 3/3 통과. 방향별 query, Mustang/Rose/Scope 누적, eliminated seat 원형거리, 최소 거리1, malformed/duplicate seat, 입력 불변성을 확인했다. 통합 AT 미실행.

#### T34 — Pedro Ramirez

- 상태: DONE
- 의존: T08, T12, T15, T65
- 파일 소유: packages/engine/src/effects/characters/pedro-ramirez.ts, packages/engine/test/effects/characters/pedro-ramirez.test.ts
- 입력: 01_RULES.md C10/R08, T05 카탈로그 산출물, T65 CharacterAbilityModule API
- 산출물: 시작 버림 더미 카드 획득 모듈
- 수락 기준: 뽑기 단계 첫 카드는 버림 더미 top을 선택할 수 있고, 그 뒤 두 번째 카드는 덱에서 뽑는다. 버림 더미가 비면 대체 선택이 없으며, 덱이 비어도 규칙상 먼저 top을 가져올 수 있는 경우를 확인한다. 루트 재검증: Pedro 전용 테스트 7/7 및 `pnpm --filter @bang/engine check` 통과. C10 통합 AT 미실행.

#### T35 — Rose Doolan

- 상태: DONE
- 의존: T11, T15
- 파일 소유: packages/engine/src/effects/characters/rose-doolan.ts, packages/engine/test/effects/characters/rose-doolan.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 대상 거리 보정 모듈
- 수락 기준: Rose가 자신에게 계산하는 상대까지 거리에서 -1, 최소 1을 적용한다. 상대가 Rose에게 계산하는 거리에는 적용하지 않고 Scope와 누적한다. 근거: 루트 재검증 `pnpm --filter @bang/engine check` 및 Rose 전용 테스트 4/4 통과. Scope/Paul/Mustang 누적, 죽은 좌석 원형거리, 최소 1, 역방향, malformed/duplicate seat, HP 0 구제 대기 중 거리 효과와 불변성을 확인했다. 통합 AT 미실행.

#### T36 — Sid Ketchum

- 상태: DONE
- 의존: T12, T13, T14, T15, T65, T66
- 파일 소유: packages/engine/src/effects/characters/sid-ketchum.ts, packages/engine/test/effects/characters/sid-ketchum.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 손패 폐기 회복 능력 모듈
- 수락 기준: 손패 정확히 2장 폐기로 HP 1 회복이 반복 가능하고 최대 HP를 넘지 않는다. 자기 사용 단계와 치명상 구제에만 열리며 다른 카드 해결 중 임의 끼어들기는 거부한다. 2인 상태에서도 Sid 회복은 유효하다. 루트 재검증: Sid 전용 테스트 4/4 및 `pnpm --filter @bang/engine check` 통과. C12 통합 AT 미실행.

#### T37 — Slab

- 상태: DONE
- 의존: T12, T15, T65, T66, T77
- 파일 소유: packages/engine/src/effects/characters/slab.ts, packages/engine/test/effects/characters/slab.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: BANG! 대응 추가 비용 모듈
- 수락 기준: Slab의 자기 BANG 카드 공격에만 Missed 2개가 요구된다. Barrel 성공은 1개로 인정되고 Gatling은 강화하지 않는다. Missed 1개만 낸 뒤 나머지를 포기해 피해를 받을 수 있다. 루트 재검증: Slab 전용 tests 5/5, T77 basic-actions/dynamite-barrel/runtime 회귀 37/37, `pnpm --filter @bang/engine check`, strict isolated tsc 통과. Registry 연결은 T41 및 통합 AT에서 확인한다.
- 진행: registry 통합 및 97개 수락 시나리오는 미실행이다.

#### T38 — Suzy Lafayette

- 상태: DONE
- 의존: T12, T15, T65, T66
- 파일 소유: packages/engine/src/effects/characters/suzy-lafayette.ts, packages/engine/test/effects/characters/suzy-lafayette.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 손패 없음 상태 능력 모듈
- 수락 기준: 손패가 0장이 된 순간 덱에서 1장을 얻는다. 마지막 Slab 대응 Missed 뒤에는 즉시 발동해 새 Missed로 두 번째 대응을 계속할 수 있다. 마지막 Duel과 General Store의 발동 경계도 구분한다. 루트 재검증: Suzy module 전용 tests 4/4 및 `pnpm --filter @bang/engine check` 통과. Runtime dispatch는 T78에서 연결하며 통합 AT 미실행.

#### T39 — Vulture Sam

- 상태: DONE
- 의존: T12, T13, T15, T65, T66
- 파일 소유: packages/engine/src/effects/characters/vulture-sam.ts, packages/engine/test/effects/characters/vulture-sam.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: 탈락 처리 중 카드 획득 모듈
- 수락 기준: 다른 플레이어 탈락 시 손패와 장착 카드를 자신의 손패로 회수하며 자동 장착하지 않는다. 폭발한 Dynamite는 이미 폐기되어 회수되지 않고, 이미 처리된 탈락은 중복 회수하지 않는다. 루트 재검증: Vulture Sam 전용 테스트 3/3, `pnpm --filter @bang/engine check` 통과. T13은 현재 실제 탈락 경로에서 회수를 직접 처리하며 T66의 `elimination_cleanup` hook dispatch는 별도 연결되지 않았다. 통합 AT C20-C22는 미실행.

#### T40 — Willy the Kid

- 상태: DONE
- 의존: T11, T15, T65
- 파일 소유: packages/engine/src/effects/characters/willy-the-kid.ts, packages/engine/test/effects/characters/willy-the-kid.test.ts
- 입력: 01_RULES.md, T05 카탈로그 산출물
- 산출물: BANG! 횟수 제한 능력 모듈
- 수락 기준: 자기 턴 BANG 횟수 제한이 없어지지만 사거리와 유효 대상 제한은 유지된다. 다른 인물의 제한과 Volcanic 상실 후 횟수 누적은 바뀌지 않는다. 루트 재검증: Willy tests 3/3, T71 quota/command regressions 15/15, `pnpm --filter @bang/engine check` 통과. 통합 AT C23 미실행.

#### T41 — 효과 모듈 등록기

- 상태: DONE
- 의존: T15~T40, T65, T82
- 파일 소유: packages/engine/src/effects/registry.ts, packages/engine/test/effects/registry.test.ts
- 입력: 03_ARCHITECTURE.md, T04/T05 카탈로그 산출물
- 범위: 기본 카드와 16종 인물 모듈을 식별자 기반으로 등록하고, T66/T67이 소비할 타입 검증된 정적 레지스트리를 제공한다.
- 제외: 개별 효과 파일 변경, 런타임 플러그인 검색
- 산출물: 타입이 확인되는 단일 정적 카드/인물 등록기
- 수락 기준: 모든 기본판 카드 효과와 C01-C16 인물 모듈이 정확히 한 번 등록되고, 중복 또는 누락 ID 요청은 거부된다. 레지스트리는 T65 타입 계약을 구현하며 T66/T67 runtime에 주입 가능한 형태다. 의존 작업 T15~T40, T65, T82가 모두 루트 검토 DONE이다. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/registry.test.ts` 6/6 통과, `pnpm --filter @bang/engine check` 통과. 22개 카드/16개 인물 ID, Barrel/Dynamite 설치 등록, 중복·누락·미등록 ID·잘못된 모듈, T66 runtime 주입 타입을 확인했다. 통합 AT는 미실행.

#### T42 — 엔진 시나리오 수락 테스트

- 상태: DONE
- 의존: T04~T24, T25~T41, T65~T67, T69, T71, T77~T80, T85
- 파일 소유: packages/engine/test/scenarios/**, packages/test-fixtures/engine/**
- 입력: 01_RULES.md, 06_ACCEPTANCE_TESTS.md
- 범위: AT-A01~AT-A15, AT-B01~AT-B30, AT-C01~AT-C32와 카드 구역 불변조건 AT-D20을 고정 RNG/덱으로 검증한다.
- 제외: 웹 UI, 실제 네트워크 연결
- 산출물: 규칙 사례 기반 엔진 시나리오와 fixture
- 수락 기준: 06_ACCEPTANCE_TESTS.md의 78개 엔진 사례가 각각 테스트에 연결된다. 동일 입력 반복 실행의 상태와 이벤트 출력이 같고, projection의 비공개 필드 누출 검사 및 매 단계 80장 중복 소유/누락 검사가 포함된다. 사례 ID는 AT-A01처럼 접두사를 포함해 추적하며, AT-D01~AT-D19 서버/브라우저 사례는 T60이 소유한다. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/scenarios/engine-acceptance.test.ts` **78/78 통과** (A01-A15, B01-B30, C01-C32, D20). 각 scenario runner는 고정 RNG/interaction IDs로 2회 실행 후 중간 snapshot·최종 state·event stream을 비교하고, 각 snapshot에서 80장 zone invariant와 viewer별 projection privacy를 검사한다. T85 병합 후 재실행했다. D01-D19 및 통합 브라우저 흐름은 T60에서 검증한다.

### W4/W5 — 서버와 실시간 동기화

#### T43 — PostgreSQL 버전 관리 저장소

- 상태: DONE
- 의존: T02, T06, T62
- 파일 소유: apps/server/src/storage/**, apps/server/migrations/**, apps/server/test/storage/**
- 입력: 03_ARCHITECTURE.md, 04_PROTOCOL.md §4.1
- 범위: PostgreSQL 스키마/migration과 저장/로드 repository를 구현한다. room, match snapshot, event, command receipt, outbox가 03_ARCHITECTURE/04_PROTOCOL의 트랜잭션 경계를 따른다. 인증된 known-match 규칙/버전 거절 결과도 현재 observed version이 일치할 때 receipt만 원자적으로 저장한다.
- 제외: 방 정책, 클라이언트 전송
- 산출물: 버전 포함 저장/복구 어댑터와 어댑터 테스트
- 수락 기준: 저장 후 읽은 상태가 직렬화 의미상 동일하고, 낮은 버전 저장은 거절된다. snapshot/version/event/receipt/outbox가 한 DB 트랜잭션으로 원자 커밋된다. migration이 빈 PostgreSQL DB에서 적용되고 테스트 후 상태/영수증을 조회할 수 있다. 인증된 known-match 규칙/버전 거절 receipt는 match row lock과 membership 확인 뒤 observed version이 일치할 때만 저장하며, 상태/version/event/outbox를 바꾸지 않는다. 버전 경합이면 receipt 없이 현재 버전을 돌려 재판정하게 한다. 같은 hash는 기존 outcome, 다른 hash는 COMMAND_ID_REUSED다.
- 근거: 루트 재검증 `pnpm --filter @bang/server check` 및 `node --experimental-strip-types --test apps/server/test/storage/repository.test.ts` 통과(8/8). PGlite 새 DB에서 migration·round-trip·stale version·receipt/outbox·rollback과 거절 receipt 저장/중복/키 재사용/비멤버 차단/관측 버전 경합을 확인했다. 한 연결 PGlite이므로 다중 연결 잠금 경합과 외부 PostgreSQL은 미검증이다.

#### T64 — 방 생명주기 저장소 API

- 상태: DONE
- 의존: T43, T62
- 파일 소유: apps/server/src/storage/room-lifecycle.ts, apps/server/test/storage/room-lifecycle.test.ts
- 입력: 03_ARCHITECTURE.md §3, §5.3, §6; 04_PROTOCOL.md §2–3
- 범위: T44 서비스가 사용할 게스트 세션 hash 조회, invite hash로 대기실 preview, 방 생성, 방 입장·퇴장/방장 이전·준비 변경·대기실 폐쇄/시작 상태 저장 API를 PostgreSQL transaction으로 제공한다. 기존 T43 파일은 수정하지 않는다.
- 제외: 초대/세션 비밀 생성과 보안 정책, 방장/참가자 command 권한 결정, Socket.IO/HTTP 전송, 매치 생성 및 게임 규칙
- 산출물: T44가 주입받는 영속 room lifecycle repository와 PGlite 테스트
- 수락 기준: 방 생성은 방·owner seat·receipt·allowlisted outbox를 한 트랜잭션에 만들며 동일 command 재시도에 같은 outcome을 돌려준다. 방 변이는 room row lock 및 expected version 검사 아래 좌석 중복/용량/상태를 원자 검증하고, room version·command receipt·허용된 room outbox 신호를 함께 저장한다. 동일 command 재시도는 저장된 outcome을 돌려주며 재적용하지 않는다. 방장 퇴장 시 남은 사람 중 가장 먼저 입장한 참가자에게 넘기고, 마지막 참가자 퇴장 시에는 방을 CLOSED로 바꾸고 invite 입장을 막는다. 이 마지막 참가자 결정은 게임 규칙이 아닌 서비스 생명주기 정책으로 문서화한다. 게스트 조회는 유효 기간/폐기 여부를 확인하고 token hash만 입력으로 사용한다. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/storage/room-lifecycle.test.ts` 10/10 통과. `pnpm --filter @bang/server check`에는 T72의 필수 RoomView.activeMatchId를 T74가 아직 제공하지 않은 단일 오류가 남아 있어 T74 연결 후 재실행한다. 외부 PostgreSQL 다중 연결 경합 및 AT D16 미검증.
- T46 보완: 04_PROTOCOL §4.1의 인증된 known-aggregate 규칙/버전 거절 receipt를 위한 `recordMatchRejection` transaction API를 추가한다. match row lock 아래 receipt를 재확인하고, observedVersion이 유지된 경우 receipt만 저장한다(상태/version/events/outbox는 변경하지 않는다). race면 receipt 없이 currentVersion을 반환해 T46이 다시 판정한다. 같은 hash는 기존 outcome, 다른 hash는 COMMAND_ID_REUSED다.

#### T44 — 비공개 초대방 및 게스트 좌석 서비스

- 상태: DONE
- 의존: T02, T43, T64
- 파일 소유: apps/server/src/rooms/**, apps/server/test/rooms/**
- 입력: 02_PRODUCT_UX.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md
- 범위: 비공개 방 생성, 초대 코드 발급/입장, 게스트 좌석 배정, 재접속 credential을 구현한다. 세션 만료와 보존기간은 명시 설정으로 주입하고, 설정이 없을 때 자동 만료/삭제를 하지 않는다. 게임 행동 timeout은 D07에 따라 OFF다.
- 제외: 공개 로비/매칭, 사용자 계정, 기본 자동 턴 timeout
- 산출물: 룸/게스트 세션 서비스와 서비스 테스트
- 수락 기준: 유효한 초대 코드 preview와 JOIN 없이 비공개 방에 들어갈 수 없다. 방 인원은 4~7명이며 중복 좌석/8번째 입장을 막는다. 방장이 명시적으로 나가면 남은 좌석 중 가장 먼저 입장한 참가자에게 소유권을 넘기며, 마지막 참가자의 퇴장은 D10에 따라 방을 닫는다. credential은 설정된 만료 전까지 해당 게스트와 그 좌석만 복구한다. 만료/보존 설정 미지정 시 자동 만료·삭제는 하지 않고 게임 행동 timeout은 OFF다. 근거: `pnpm --filter @bang/server check` 통과, `node --experimental-strip-types --test apps/server/test/rooms/service.test.ts apps/server/test/storage/room-lifecycle.test.ts` 통과(13/13, PGlite); 표시명 1–256 UTF-16 code units 경계, invite/session hash, room 권한·좌석·receipt·outbox, owner 이전과 D10 폐쇄를 확인했다. 실제 PostgreSQL 다중 연결 경합과 T45 HTTP/Socket.IO 쿠키 통합은 미검증이다. DB에는 invite hash만 저장하므로 CREATE_ROOM 최초 ACK와 원문을 모두 잃으면 같은 commandId receipt 재응답으로 invite 원문을 복구할 수 없다.

#### T45 — Socket.IO 세션 게이트웨이

- 상태: DONE
- 의존: T02, T44
- 파일 소유: apps/server/src/socket/**, apps/server/test/socket/**
- 입력: 03_ARCHITECTURE.md, 04_PROTOCOL.md
- 범위: 연결 handshake, 룸 가입, 이벤트 envelope 검증, disconnect 처리를 프로토콜에 매핑한다. 서버 라이브러리 인스턴스는 Socket.IO 호환 인터페이스로 주입받아 구현하며 실제 Socket.IO 패키지 설치와 server assembly는 T49가 맡는다.
- 제외: 엔진 규칙 계산, 별도 HTTP 제품 API
- 산출물: Socket.IO 게이트웨이와 연결 계약 테스트
- 수락 기준: 쿠키 세션을 handshake에서 인증하고, match/room membership은 sync 및 각 명령에서 다시 확인한다. 계약에 없는 이벤트/잘못된 envelope/임의 채널 가입은 거부된다. disconnect가 좌석 제거/탈락으로 바뀌지 않는다.
- 근거: 기존 8/8 baseline 검증 뒤 T02 계약 보완을 연결했다. 루트 재검증 `pnpm --filter @bang/server check` 및 gateway 테스트 10/10 통과; 공유 sync parser, authenticated membership-free preview, generic INVITE_INVALID, shared SyncRejectedResponse, allowed event list, presence-only disconnect를 확인. 실제 Socket.IO 조립은 T49 범위, 통합 AT는 미실행.


#### T46 — 권한/버전/idempotency 명령 중계

- 상태: DONE
- 의존: T14, T43, T44, T45
- 파일 소유: apps/server/src/commands/**, apps/server/test/commands/**
- 입력: 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: 연결 세션 좌석과 게임 버전을 확인하고 엔진에 유효 명령을 한 번 적용한 뒤 저장한다.
- 제외: projection 브로드캐스트, UI optimistic state
- 산출물: 검증된 명령 중계기와 중복/버전 경계 테스트
- 수락 기준: 플레이어는 다른 좌석 명령을 제출할 수 없다. stale expectedVersion은 저장 상태를 바꾸지 않는다. engine output, snapshot, version, events, receipt, outbox가 한 트랜잭션에 반영된다. 같은 idempotency key 재전송은 같은 outcome을 반환하며 게임 효과와 저장 이벤트를 중복시키지 않는다. 인증된 known-match 규칙/버전 거절은 04_PROTOCOL §4.1에 따라 receipt를 저장하고 버전 경합이면 저장 없이 재판정한다.
- 근거: 루트 재검증 `pnpm --filter @bang/server check` 및 명령 중계 전용 PGlite 테스트 9/9 통과. D01 재전달·중복 실행 방지, D02 다른 payload commandId 재사용, D03 same-version 동시 커밋 CAS, D04 actor/card 위조 거절, 규칙/STALE_VERSION 거절 receipt replay, 관측 version 경합과 expectedVersion이 현 버전으로 맞춰지는 경합 뒤 엔진 재평가/정상 commit, 비멤버 영수증 차단을 확인했다. 테스트는 PGlite이며 다중 프로세스 PostgreSQL 운영 경합과 실제 Socket.IO 조립(T49), 통합 AT는 미검증.

#### T47 — 인증된 sync projection과 변경 알림

- 상태: DONE
- 의존: T07, T45, T46
- 파일 소유: apps/server/src/projections/**, apps/server/test/projections/**
- 입력: 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: 인증된 match:sync/room:sync 요청에서 actor 권한을 다시 확인하고 필요한 전체 스냅샷/공개 이벤트를 viewer projection으로 응답한다. outbox 알림은 새 버전이 있다는 무효화 정보만 싣는다.
- 제외: projection 브로드캐스트, UI 상태 저장, 역할 공개 규칙 재정의
- 산출물: sync projection 응답기와 비공개 필드/무효화 outbox 테스트
- 수락 기준: sync 응답은 authenticated player 기준의 PlayerView와 필요한 이벤트 projection이다. 다른 좌석 손패/역할, 전체 GameState, effectQueue 및 invite 원문이 sync/outbox payload에 없다. outbox에는 aggregate ID/version/eventSeq만 포함하고 상태 본문을 넣지 않는다. 재생할 수 없는 cursor는 requiresFullSnapshot으로 응답한다. 근거: 루트 재검증 `pnpm --filter @bang/server check` 및 projection/outbox 전용 테스트 9/9 통과. match/room membership 재확인, 저장 room과 member view 일치, viewer 전용 snapshot 및 공개 이벤트 allowlist, secret payload 차단, 잘린/미래 event cursor의 full snapshot 플래그, 상태 없는 outbox 무효화 DTO를 확인했다. 실제 T49 gateway/server assembly와 통합 AT D05/D06/D09는 미검증이다.

#### T48 — 연결 복구와 저장 상태 재개

- 상태: DONE
- 의존: T43, T44, T46, T47
- 파일 소유: apps/server/test/recovery/**, apps/server/src/recovery/**
- 입력: 03_ARCHITECTURE.md, 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: disconnect 또는 서버 재시작 뒤 세션 credential과 membership으로 원 좌석을 복구하고 최신 sync, 공개 이벤트 이력, 현재 pending 상태를 반환한다.
- 제외: 클라이언트 화면 구현, 재접속 정책을 벗어난 계정 시스템
- 산출물: 복구 핸들러와 다중 연결 통합 테스트
- 수락 기준: Duel, DEATH_RESCUE, DISCARDS_ORDER, multi-target effectQueue 중간에 저장소를 유지한 새 recovery/storage/sync 서비스 인스턴스가 기존 좌석·cursor·resume frame·자기 비공개 상태를 복원한다. 같은 commandId는 receipt로 한 번만 반영된다. 비인가 projection/outbox에 사적 정보가 없다. 미지원 schema/ruleset은 자동 진행하지 않고 recovery_required로 격리한다. 근거: `pnpm --filter @bang/server check` 통과; `node --experimental-strip-types --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./packages/engine/test/setup/ts-source-loader.mjs", pathToFileURL("./"));' --test apps/server/test/recovery/recovery.test.ts` 2/2 통과. 새 서비스 인스턴스/기존 PGlite DB로 재시작 경계를 모사했다. 실제 OS 프로세스 재기동 및 Socket.IO 조립은 T49에서 검증하며 97개 통합 AT의 통과 근거로 계산하지 않는다.

#### T49 — 서버 실행 진입점과 환경 설정

- 상태: DONE
- 의존: T43~T48
- 파일 소유: apps/server/src/main.ts, apps/server/src/config.ts, apps/server/README.md, apps/server/test/runtime/**, apps/server/package.json, pnpm-lock.yaml
- 입력: 03_ARCHITECTURE.md
- 범위: 개발용 환경 변수 검증, Socket.IO 서버 조립, 종료 처리, 로컬 실행 설명을 제공한다. T45 게이트웨이를 실제 Socket.IO 서버에 연결하고 server workspace의 Socket.IO runtime dependency를 설치한다. 실제 PostgreSQL 서버를 별도 설치할 수 없는 개발자를 위한 영속 PGlite Socket 모드도 제공하되 일반 node-postgres 연결/운영 경로는 유지한다. `pnpm-lock.yaml`은 T49가 단독으로 수정한다.
- 제외: 배포 플랫폼 설정, 제품 분석 이벤트
- 산출물: 재현 가능한 서버 시작 진입점과 설정 문서
- 수락 기준: 필수 설정 누락 시 명시적인 시작 오류를 낸다. node-postgres 기반 일반 환경과 PGlite Socket 로컬 모드에서 schema migration 뒤 HTTP readiness, `/api/guest-sessions`, Socket.IO 인증·거부를 확인한다. 세션 credential은 HttpOnly/Secure 쿠키로만 돌려주고 원본 token을 로그에 남기지 않는다. 문서의 로컬 명령으로 앱이 준비 상태에 도달하고 DB 상태가 재기동 간 보존된다. PGlite Socket 결과는 로컬 PostgreSQL 호환 smoke 근거이며 일반 PostgreSQL 서비스/운영 호환성이나 통합 AT의 통과로 간주하지 않는다. 근거: 루트 재검증 `pnpm --filter @bang/server check`, `pnpm --filter @bang/server test:runtime` 3/3, recovery tests 2/2 통과. 작업자도 clean install, PGlite Socket persistent restart, readiness 및 guest-session 201을 실행 확인했다. 실 PostgreSQL TLS/auth/다중 연결 경합과 통합 AT는 미검증.

### W6/W7 — 브라우저 클라이언트

#### T50 — React 앱 셸과 라우팅

- 상태: DONE
- 의존: T01, T02, T61
- 파일 소유: apps/web/src/app/**
- 입력: 02_PRODUCT_UX.md, 03_ARCHITECTURE.md
- 범위: 앱 셸, 페이지 라우팅, 공통 로딩/오류 프레임과 전역 상태 경계를 만든다.
- 제외: 방 로비/게임 세부 UI
- 산출물: React/Vite 앱 진입점과 페이지 뼈대
- 수락 기준: Vite 개발 서버에서 앱 셸과 정의된 경로가 로드된다. 잘못된 경로는 안내 상태를 보이고 콘솔 오류나 타입 오류 없이 빌드된다. 근거: `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 성공; 로컬 브라우저에서 홈/방 만들기/참가/대기실/역할/게임/결과/잘못된 경로 표시 확인, 브라우저 오류 로그 0건.

#### T61 — React/Vite 웹 워크스페이스 의존성

- 상태: DONE
- 의존: T01
- 파일 소유: apps/web/package.json, apps/web/tsconfig.json, apps/web/vite.config.ts, apps/web/index.html, pnpm-lock.yaml
- 입력: 03_ARCHITECTURE.md, [Vite Getting Started](https://vite.dev/guide/), [React createRoot](https://react.dev/reference/react-dom/client/createRoot)
- 범위: React/React DOM, Vite, React Vite plugin 및 TypeScript React types의 정확한 의존성·개발/build 스크립트·JSX/DOM 설정을 추가한다. 빈 React mount 대상 HTML과 Vite 설정은 T50 앱 셸의 고정 위치를 가리킨다.
- 제외: React 화면/라우트 컴포넌트, 제품 UI 문구/스타일, Socket.IO 연결
- 산출물: 설치 가능한 브라우저 workspace 설정 및 `dev`/`build` 진입 명령
- 수락 기준: 잠금 파일을 갱신하고 `pnpm install --frozen-lockfile`, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web exec vite --version`이 성공한다. build 스크립트는 설치되지만 `src/app/main.tsx`를 소유한 T50 이후에 실행한다. HTML mount 경로는 `/src/app/main.tsx`로 고정한다. 근거: 위 3개 명령 성공; Vite 8.3.1.

#### T62 — PostgreSQL 저장소 테스트 런타임

- 상태: DONE
- 의존: T01
- 파일 소유: apps/server/package.json, pnpm-lock.yaml
- 입력: 03_ARCHITECTURE.md, [PGlite 공식 문서](https://pglite.dev/docs/about)
- 범위: 네이티브 PostgreSQL 서버 설치에 의존하지 않고 migration/repository 통합 테스트가 실제 PostgreSQL SQL 엔진에서 실행되도록 PGlite 개발 의존성을 추가한다. `pnpm-lock.yaml`은 이 작업에서만 수정한다.
- 제외: 운영 DB 연결 드라이버, 저장소 구현, 스키마/migration SQL
- 산출물: server workspace의 PostgreSQL 기반 테스트 런타임
- 수락 기준: `pnpm install --frozen-lockfile`이 성공하고, server workspace에서 PGlite를 생성해 새 데이터베이스에 SQL을 실행한 뒤 닫는 smoke 검증이 통과한다. PGlite는 이 저장소 통합 테스트에만 사용하며 운영 DB 연결 어댑터를 대체하지 않는다. 근거: PGlite 0.5.8 dev dependency, `pnpm install --frozen-lockfile` 성공, 새 인메모리 PostgreSQL 인스턴스에서 `select 1 as value` 결과 `{ value: 1 }` 확인 후 정상 종료.

#### T63 — 공개 덱 잔여 수 projection 계약 보완

- 상태: DONE
- 의존: T02, T07, T53
- 파일 소유: outputs/development-plan/01_RULES.md, outputs/development-plan/03_ARCHITECTURE.md, outputs/development-plan/04_PROTOCOL.md, packages/contracts/** (T02 단독 계약 담당 루트가 직접 소유), packages/engine/src/state/projection.ts, packages/engine/test/state/projection.test.ts, apps/web/src/features/game-table/**
- 입력: 02_PRODUCT_UX.md §4.5, 06_ACCEPTANCE_TESTS.md D06
- 범위: 현재 프로토콜 projection에 남은 덱 장수만 공개하는 `deckCount`를 추가한다. 이 작업은 제품 UX 명세에 이미 적힌 정보 범위를 타입·projection·테이블에 연결하고, D09 구현 결정을 명시한다.
- 제외: 덱 카드 ID, 카드 정체·순서, 비공개 역할/손패, 명령 프로토콜 변경
- 산출물: 일관된 public deckCount 계약·projection·테이블 표시 및 프라이버시 회귀 테스트
- 수락 기준: 같은 매치 버전의 모든 좌석 projection이 내부 draw-pile 길이와 같은 deckCount를 받는다. 어떤 draw-pile ID/카드면/순서도 전달되지 않는다. 생존/탈락 SSR 테이블은 장수만 읽을 수 있는 형태로 표시하고 기존 secret sentinel을 내보내지 않는다. 근거: contracts typecheck 및 4개 테스트, projection 테스트 7/7, web typecheck/build, survivor/eliminated SSR fixture 검증 통과. 이 단위 검증은 D06 수락 케이스 전체 통과를 의미하지 않는다.

#### T51 — 방 만들기와 초대 입장 화면

- 상태: DONE
- 의존: T02, T44, T50
- 파일 소유: apps/web/src/features/room-entry/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 게스트 이름, 새 비공개 방 생성, 초대 코드 입력, 세션 보관/오류 안내 UI를 구현한다.
- 제외: 외부 계정 로그인, 공개 매칭
- 산출물: 룸 진입 경로 및 로딩/실패 상태
- 수락 기준: 먼저 guest session을 생성하고 난 뒤 방을 만들거나 초대 코드 preview/JOIN 절차로 입장한다. 초대 preview와 입장 version이 포함되고 유효하지 않은 코드는 같은 방식으로 거절된다. 초대 URL에는 session secret이 없으며 새로고침 뒤 쿠키 credential로 같은 좌석을 복구한다.
- 근거: `pnpm --filter @bang/web check`, `node --experimental-strip-types --test apps/web/src/features/room-entry/model.test.mjs` 통과(5/5), `pnpm --filter @bang/web build` 통과. 테스트는 표시명 경계·공개 DTO·preview 후 버전 JOIN·초대 오류 통일·session secret 없는 URL을 확인했다. 브라우저 쿠키/실제 transport 및 앱 라우트 연결은 통합 T58/T60에서 검증한다.

#### T52 — 대기실 및 시작 준비 UI

- 상태: DONE
- 의존: T44, T45, T50
- 파일 소유: apps/web/src/features/lobby/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 좌석 입장/퇴장, 게스트 표시, 준비/시작 가능 상태, 초대 코드 공유 화면을 구현한다.
- 제외: 게임 중 카드 행동
- 산출물: 비공개 방 대기실 뷰와 이벤트 바인딩
- 수락 기준: 4~7명 대기실의 참가 좌석과 준비 상태가 서버 상태와 일치한다. 4명 미만 시작과 8번째 입장은 막고 게임 시작 후 kick/중간 입장을 거부한다. 방장만 시작 가능하며 방/인원 상태가 안내된다. 근거: 루트 재검증 `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`, lobby 모델/UI 테스트 9/9 통과. 4~7 좌석 표시, 서버 좌석·준비 상태, 전원 준비/방장/최소 인원 시작 조건, 진행 후 잠금, 만석 초대 차단 및 계약형 명령 생성을 확인했다. 앱 라우트/실제 room transport 및 브라우저 통합은 T58/T60에서 검증한다.

#### T53 — 게임 테이블과 좌석 상태 표시

- 상태: DONE
- 의존: T02, T07, T50
- 파일 소유: apps/web/src/features/game-table/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 자신의 자리와 상대 자리, 공개 체력/장착/역할 공개 상태를 projection 기준으로 배치한다.
- 제외: 카드 사용 인터랙션, 서버 상태 자체 생성
- 산출물: 반응형 테이블 프레젠테이션 컴포넌트
- 수락 기준: 생존자/탈락자 projection fixture가 허용 정보만 표시한다. 공개 역할을 포함해도 아직 비공개인 상대 역할, 손패, 덱 순서는 DOM/접근성 이름 어디에도 나타나지 않는다. 공개 손패 수와 버림 top/수량만 표시한다. 근거: `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`, `node apps/web/src/features/game-table/verify-fixtures.mjs` 성공; 생존/탈락 server-rendered markup에서 개인 hand, 공개 역할, turn/discard와 handCount 및 secret sentinel 비노출 확인. 화면 크기별 스타일은 구현했으나 브라우저 시각 검수와 라우트 연결은 후속 통합에서 확인한다.

#### T54 — 카드 앞면, 손패, 보유 카드 렌더링

- 상태: DONE
- 의존: T04, T05, T53
- 파일 소유: apps/web/src/features/cards/**, apps/web/public/assets/cards/**, apps/web/src/features/cards/attribution.tsx
- 입력: outputs/assets/ASSET_INVENTORY.md, outputs/assets/asset_manifest.csv, outputs/assets/ATTRIBUTION.md, 02_PRODUCT_UX.md
- 범위: 제공된 플레이/인물/역할 42개 카드면을 웹 public 폴더로 복사하고, catalog의 80장별 rank/suit를 이미지에 겹쳐 렌더링한다. 원본 숫자/무늬가 인스턴스 값과 다르면 해당 인쇄 영역을 가리거나 삽화 영역만 써서 중복 문양/숫자를 막는다.
- 제외: source_images 원본 재가공/삭제, 카드 효과, 추가 외부 이미지 수집
- 산출물: 카드 렌더러, public asset manifest mapping, rank/suit frame 및 출처 크레딧 링크
- 수락 기준: 22 플레이 카드형·16 인물·4 역할 이미지 경로가 실제 public 파일과 맞는다. 권한 있는 본인 손패/공개 카드 face에는 각 물리 인스턴스의 catalog rank/suit가 표시되고, 인쇄 rank/suit와 중복/충돌하지 않는다. 상대 손패는 rank/suit 없이 뒷면으로 보인다. 특히 Stagecoach 두 장은 별도 ID를 유지하며 둘 다 Spade 9로 표시된다. 이미지가 없어도 텍스트 fallback/출처가 보이고 빈 대체 텍스트가 없다. 근거: 42개 public 파일이 준비 원본과 바이트 일치, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`, `node --experimental-strip-types --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./packages/engine/test/setup/ts-source-loader.mjs", pathToFileURL("./"));' --test apps/web/src/features/cards/assets.test.mjs` 통과(4/4). 라우트 연결과 브라우저 network failure 동작은 통합 단계에서 확인한다.

#### T55 — 행동 선택과 합법 대상 UI

- 상태: DONE
- 의존: T02, T11, T14, T54, T68, T69
- 파일 소유: apps/web/src/features/actions/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 서버 projection이 제공한 합법 행동과 대상을 표시하고 명령 제출 전 선택을 수집한다.
- 제외: 클라이언트 자체 규칙 계산, optimistic server authority 대체
- 산출물: 카드 선택/대상 선택/명령 제출 UI
- 수락 기준: 제출 envelope가 계약의 expectedVersion/idempotency 필드를 가진다. 비합법 대상은 선택 불가하다. 서버 거절 후 화면은 최신 projection에 맞게 복구된다. 루트 재검증: `node --test apps/web/src/features/actions/actions.test.mjs` 6/6, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. 통합 UI/AT 미실행.

#### T56 — 반응 프롬프트

- 상태: DONE
- 의존: T02, T12, T15, T68, T69, T84
- 파일 소유: apps/web/src/features/reactions/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 빗나감, 결투, 감옥 등 해결 프레임워크가 전달한 응답 대기 상태를 표시하고 유효 응답을 제출한다.
- 제외: 해결 순서 규칙, 타이머 기본값 활성화
- 산출물: 응답 프롬프트와 선택 제어
- 수락 기준: multi-target 순차 응답, DEATH_RESCUE, DISCARDS_ORDER, Vulture Sam 후처리에서 현재 응답 좌석만 조작할 수 있다. 비응답 좌석은 진행 신호만 보고 남의 선택지를 보지 않는다. 재접속 sync 뒤 같은 pending prompt가 돌아온다.

#### T57 — 차례, 로그, 결과 표시

- 상태: DONE
- 의존: T02, T13, T50, T68, T69
- 파일 소유: apps/web/src/features/status/**
- 입력: 02_PRODUCT_UX.md, 04_PROTOCOL.md
- 범위: 현재 차례/단계, 공개 게임 이벤트, 종료 결과를 표시한다.
- 제외: 기록 서버, 랭킹/통계
- 산출물: 진행 상태, 로그, 승패 결과 UI
- 수락 기준: 공개 eventSeq/version 순서로 이벤트를 중복 없이 표시하고 숨겨진 eventSeq 누락을 허용한다. 내부 state나 손패/역할 비공개 이벤트는 로그에 나오지 않는다. 종료 후 행동 입력이 닫힌다.

#### T58 — 브라우저 Socket.IO 동기화와 재접속

- 상태: DONE
- 의존: T02, T45, T47, T48, T51, T53, T72, T76, T81
- 파일 소유: apps/web/src/transport/**
- 입력: 04_PROTOCOL.md, 06_ACCEPTANCE_TESTS.md
- 범위: 변경 알림 수신 뒤 인증된 room:sync/match:sync로 재조회하고 event version, reconnect cookie, requiresFullSnapshot, pending commandId를 관리한다.
- 제외: 서버 재전송 정책 변경, 로컬 상태를 권위 상태로 승격
- 산출물: 타입이 지정된 전송 client 및 상태 연결 hook
- 수락 기준: match:changed/room:changed outbox 신호는 projection 데이터가 아닌 sync trigger로 처리한다. 중복/역순 버전 알림은 화면을 퇴행시키지 않는다. reconnect 뒤 별도 sync를 항상 호출하고 pending commandId를 같은 payload로 안전하게 재시도한다. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/web/src/transport/client.test.mjs` 5/5 통과; web check/build도 통과했다. 통합 AT 미실행.

#### T59 — 반응형 및 키보드 접근성 정리

- 상태: DONE
- 의존: T50~T58
- 파일 소유: apps/web/src/styles/accessibility.css, apps/web/src/components/accessibility/**
- 입력: 02_PRODUCT_UX.md, 06_ACCEPTANCE_TESTS.md
- 범위: 기존 화면 요소의 모바일 레이아웃, 키보드 초점, 버튼 이름, 상태 안내를 마무리한다.
- 제외: UI 기능/게임 규칙, 시각 디자인 전체 재설계
- 산출물: 공통 접근성 스타일과 필요한 표시 컴포넌트
- 수락 기준: 주요 게임 행동을 키보드만으로 수행할 수 있다. 카드/대상/응답 컨트롤은 읽을 수 있는 이름과 초점 표시를 갖는다. 화면 폭이 좁을 때 손패와 응답 선택을 가로 스크롤로 조작할 수 있다.

#### T60 — 전체 브라우저 수락 흐름

- 상태: IN_PROGRESS
- 의존: T42, T49, T51~T59, T74, T75, T76, T77~T80, T85, T86, T88~T90, T91, T92, T93, T94, T95, T96, T97, T98
- 파일 소유: apps/web/e2e/**, apps/web/README.md의 수락 흐름 절
- 입력: 06_ACCEPTANCE_TESTS.md, 07_READINESS.md
- 범위: 네 개 이상의 게스트 브라우저 세션으로 초대, 게임, 비공개 projection, 재접속 및 종료까지 연결 검증한다.
- 제외: 공개 배포, 부하/성능 수치 주장
- 산출물: 자동화된 전체 흐름과 실행/결과 기록
- 진행: 2026-09-28 07:28 UTC 최신 acceptance JSON/README는 D 통합 17 PASS/0 FAIL/2 NOT RUN, 엔진 78/78, 합계 95/97이다. 루트 CUA가 D13 모바일 360×800·데스크톱 키보드 입력으로 대상/응답/맥주 구제/탈락/손패 버리기 순서를 완료했고 확대 dialog의 Escape 닫기와 포커스 복귀를 확인했다. D14는 production PlayingCardFace로 80장 렌더, 두 Stagecoach 9♠의 다른 definition ID와 인접 rank/suit 표시를 확인했다. D15 강제 이미지 실패에서 fallback의 이름/rank/suit/효과 설명이 읽히고 keyboard 카드 선택이 가능함을 확인했다. D06 feasibility 재검토는 454 sync ACK response와 1,374 decoded room/match 알림에 한정되며 모든 raw frame/command 오류 ACK/상태별 legalActions 검사는 실행하지 않아 NOT RUN이다. D18은 완료 게임 뒤 고유 match ID와 이전 최종 손패와 겹치지 않는 초기 hand ID만 확인했으며 전체 덱·새 역할·seed 비재사용은 sync projection으로 검증할 수 없어 NOT RUN이다. T60은 D06/D18 두 조건이 남아 IN_PROGRESS이고 외부 배포하지 않았다. 검증 명령 `node --check apps/web/e2e/run-acceptance.mjs` 및 `node apps/web/e2e/run-isolated-api-acceptance.mjs`; 별도 E2E `.mjs` 7개 구문 검사, JSON/README 집계와 D14/D15 fixture HTTP 200 확인.
- 수락 기준: AT-D01~AT-D19를 통합 환경에서 실제 실행한다. 게스트 브라우저 네 개와 일곱 개 세션 각각으로 한 판을 끝까지 진행해 4인/7인 결과를 모두 확인한다. 상대 손패/비공개 역할이 노출되지 않는다. 다중 대상/죽음 정리 입력 중 한 클라이언트 재접속 뒤 현재 단계가 복원되고 동일 명령 재전송은 중복 적용되지 않는다. 결과는 AT- 접두사 케이스 ID, 커밋, 환경, 실행 명령, 실제 결과로 남는다.

#### T65 — 인물 능력 트리거 공용 계약

- 상태: DONE
- 의존: T11, T12, T14, T15
- 파일 소유: packages/engine/src/effects/character-api.ts, packages/engine/test/effects/character-api.test.ts
- 입력: 01_RULES.md C01-C16, 03_ARCHITECTURE.md, 04_PROTOCOL.md, 완료된 T11/T12/T14/T15 산출물
- 범위: 인물 모듈과 후속 효과 런타임이 공유할 단일 타입 계약을 정의한다. 피해 해결 후(실제 HP 손실 및 구제 뒤 생존 결과), 턴 드로우 슬롯/출처, 카드 대체/반응, 판정, 거리 질의, 능력 명령, 카드 효과 완료, 탈락 후처리, BANG 사용 제한 조회 trigger를 C01-C16에 근거해 타입으로 표현한다. 결과는 기존 EffectEventDraft/EffectStep/T12 interaction 계약과 결정적 RNG 입력을 재사용한다.
- 제외: 개별 인물 능력 로직, 효과 런타임/레지스트리 구현, 프로토콜 DTO, 클라이언트 UI
- 산출물: 타입 검증 가능한 CharacterAbilityModule/trigger/result 계약 및 API 회귀 테스트
- 수락 기준: C01-C16에서 요구하는 trigger/query 상황을 타입으로 모두 구분한다. C01 피해 trigger는 실제 HP 손실량, 피해 귀속/cause, 구제 처리 후 생존 여부를 입력으로 받는다. C02 등 draw hook은 일반 1·2번째 드로우, 공개/비공개 노출, 보너스/초기 분배 구분을 표현한다. C03 변환 hook은 사용/응답 맥락과 물리/효과 카드 종류를 구분한다. 상태는 읽기 전용이며 RNG는 주입형이고, 사용자별 비공개 상태는 서버 내부 계약 밖으로 노출하지 않는다. 근거: 루트 재검증 `pnpm --filter @bang/engine check`, 독립 strict tsc of compile-time API test, `node --experimental-strip-types --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./packages/engine/test/setup/ts-source-loader.mjs", pathToFileURL("./"));' --test packages/engine/test/effects/character-api.test.ts` 2/2 통과. T12 `EffectStep`/choice 결과 재사용, C01 HP 손실/구제 뒤 생존, C02-C10 hook 범위와 민감한 숨은 카드 비식별 입력을 확인했다. 통합 AT는 미실행이다.

#### T66 — 카드 효과 실행기와 피해/구제 재개

- 상태: DONE
- 의존: T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T65
- 파일 소유: packages/engine/src/effects/runtime/**, packages/engine/test/effects/runtime/**
- 입력: 01_RULES.md, 03_ARCHITECTURE.md §3.2/§4, 완료된 T12-T24/T65 산출물
- 범위: 주입된 정적 card/character registry를 소비하는 순수 엔진 runtime을 구현한다. PLAY_CARD/RESPOND/USE_ABILITY handler, CardEffectResult events/steps 적용, 순차 effectQueue와 T12 prompt/resume, 피해·Beer/Sid 구조·탈락 후처리 경계, 재접속용 continuation 보존을 연결한다. 완료된 피해 trigger를 T65 형식으로 산출해 인물 모듈을 호출할 수 있게 한다.
- 제외: 정적 ID 등록(T41), 일반 턴 draw 단계(T67), 서버/DB/socket, 새 규칙 또는 자동 타이머
- 산출물: 주입 레지스트리용 effect runtime/command handlers와 runtime 단위 테스트
- 수락 기준: 카드·응답 명령이 실제 후보 상태와 이벤트를 만들고 모든 EffectStep을 순차 처리한다. 피해자는 HP 감소 뒤 R27 구제 창을 받고, Beer/Sid 응답 후에야 C01/C04용 실제 hpLost/survived trigger가 한 번 결정된다. pending 대상/응답/죽음 중간 상태가 JSON 왕복 뒤 동일 지점에서 재개된다. RNG/interaction 식별은 caller 주입값만 쓴다. T16-T24 연결 runtime 테스트와 typecheck를 실행한다. 미실행 AT는 통과로 기록하지 않는다. 근거: 루트 재검증 `pnpm --filter @bang/engine check` 통과, runtime 전용 테스트 10/10 통과. BANG 응답/JSON 재개, Beer·Sid 구제 후 피해 hook, Duel, Gatling/Barrel, Jail/Panic, Stagecoach/장비, Dynamite 직접 진입, 탈락 정리를 확인했다. T41 static registry와 통합 AT는 별도 미실행이다. T12 계약상 prompt와 step 동시 반환은 지원하지 않고 구제 내부 step은 HEAL_PLAYER만 허용한다.

#### T67 — 차례 시작과 드로우 단계 실행

- 상태: DONE
- 의존: T08, T09, T10, T12, T21, T22, T26, T29, T31, T32, T34, T65, T66, T70
- 파일 소유: packages/engine/src/turn/draw.ts, packages/engine/test/turn/draw.test.ts
- 입력: 01_RULES.md R08/R12/C02/C05/C07/C08/C10, 03_ARCHITECTURE.md, 완료된 T08-T10/T12/T21/T22/T26/T29/T31/T32/T34/T65/T66/T70 산출물
- 범위: 현재 turn actor의 start 단계에서 Dynamite/Jail 해결을 runtime에 위임하고, 정상 드로우 2장과 Black Jack/Jesse/Kit/Lucky/Pedro hook 호출 위치를 구현한다. 덱 재활용은 R08 및 주입 RNG를 사용한다.
- 제외: 카드/인물 모듈 구현 및 static registration(T41), 공개 DTO/화면, 확장판
- 산출물: 결정적 start/draw phase orchestrator와 테스트
- 수락 기준: start effects가 완료 또는 Jail skip된 뒤에만 draw가 진행된다. 일반 드로우는 정확히 2장이고, 각 슬롯의 대체/추가 드로우/공개 정보와 보너스 드로우 반복 금지가 T65 module 결과대로 적용된다. 빈 덱은 R08을 따르고 카드 80장 zone 불변식을 보존한다. 고정 입력 재실행은 같은 상태/events이며 typecheck 및 전용 tests를 실행한다. 루트 재검증: draw tests 9/9, turn/reducer tests 8/8, Jail regressions 7/7, `pnpm --filter @bang/engine check` 통과. C08 Jail/Dynamite judgment 연결은 T79, Kit actor-only candidate projection 소비자는 T68/T69 범위다. 통합 AT 미실행.

#### T70 — 공용 R08 드로우 더미 공급

- 상태: DONE
- 의존: T08, T06, T19, T66
- 파일 소유: `packages/engine/src/effects/draw-pile.ts`, `packages/engine/test/effects/draw-pile.test.ts`, `packages/engine/src/effects/cards/draw-select.ts`
- 입력: 01_RULES.md R08/D05, 완료된 T06/T08/T19/T66 산출물
- 범위: 순수·불변 공용 공급 계획 함수를 만들고 T19의 Stagecoach/Wells Fargo/General Store가 이를 사용하도록 refactor한다. 함수는 요청 장수, actor/source, 목적지(hand/revealed_pool/peek)와 주입 RNG를 받아 ordered `DRAW_PILE_RESHUFFLED`, 목적지별 카드 이동, 필요 시 `RULE_RESOURCE_EXHAUSTED` draft와 선택된 실제 카드 ID·충족 장수를 반환한다. `peek`은 카드 이동 없이 후보 ID를 반환하여 Kit의 비공개 top-three 공급에 사용한다. 새 카드를 생성하지 않는다.
- 제외: 차례 draw-slot orchestration(T67), 개별 인물 능력 모듈(T25/T26/T31/T32/T34), registry(T41), effect runtime의 공용 step/API 변경, 새 규칙
- 산출물: 카드 공급 계획 함수, 기존 카드 드로우 효과 refactor, R08/D05 결정적 테스트
- 수락 기준: 덱 top 우선, 덱이 빈 순간 버림더미 전체를 주입 RNG로 재셔플, 요청 장수 미달 시 `RULE_RESOURCE_EXHAUSTED`/paused를 정확히 산출하며 부분 충족 수를 기록한다. 반환 이벤트 순서는 실제 재생 가능하고 모든 카드 ID를 중복/손실 없이 보존하며 원본 state를 변경하지 않는다. hand/revealed 이동은 해당 목적지 규칙을 따르고 peek은 카드 이동 이벤트를 내지 않으며 비공개 후보 사용을 위해 실제 ID를 caller에게만 돌려준다. 같은 입력/RNG 결과는 결정적이다. 근거: 루트 재검증 `pnpm --filter @bang/engine check`, T70 전용 테스트 10/10, `packages/engine/test/effects/draw-select.test.ts` 회귀 테스트 7/7 통과. R08 순서, source Stagecoach 재활용, hand/revealed/peek 경계, D05 부분 고갈 및 불변성·결정성을 확인했다. 통합 AT 미실행.

#### T71 — 성공한 BANG 사용 횟수 누적

- 상태: DONE
- 의존: T11, T12, T14
- 파일 소유: `packages/engine/src/commands/index.ts`, `packages/engine/test/commands/bang-quota.test.ts`
- 입력: `01_RULES.md` R12/C03, T11 카드 합법성, T12 차례 상태, T14 명령 경계
- 산출물: 성공한 일반 BANG 카드 명령을 턴별 quota 상태에 정확히 한 번 반영하는 명령 경계와 전용 테스트
- 제외: BANG 규칙 변경, Calamity 카드 변환 규칙, 응답형 BANG(Duel/Indians)의 quota 변경, 턴 reducer 수정, 공용 상태 타입 변경
- 수락 기준: 엔진이 유효 `PLAY_CARD`의 effective type을 `bang`으로 승인하고 effect handler도 성공했을 때만 `bangCardPlaysThisTurn`을 1 증가시킨다. 물리 BANG 및 유효한 Calamity Missed→BANG에 적용하고 Volcanic/Willy의 무제한 사용 중에도 횟수를 누적해 해당 효과를 잃은 뒤 초기화되지 않게 한다(R12). 거절/실패 명령, 비-BANG 카드, `RESPOND`의 Duel/Indians BANG 버리기는 카운터를 증가시키지 않는다. 다음 일반 BANG 명령은 R12/T11 quota로 거절되어야 하며 T12의 새 턴 초기화가 유지된다. 테스트는 같은 명령 경계에서 성공·실패·변환·무제한 예외·응답 경계를 검사한다. 근거: 루트 재검증 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/commands/bang-quota.test.ts packages/engine/test/commands/commands.test.ts` 15/15 통과, `pnpm --filter @bang/engine check` 통과. 통합 AT B02/B03/B12/B13/C23는 미실행.

#### T68 — viewer별 합법 행동·응답·결과 DTO 계약

- 상태: DONE
- 의존: T02
- 파일 소유: outputs/development-plan/04_PROTOCOL.md, packages/contracts/**, packages/test-fixtures/protocol/** (T68 단독 소유, 실행 중 다른 계약 수정 금지)
- 입력: 02_PRODUCT_UX.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md, T02 계약 산출물
- 범위: snapshot이 운반할 typed `legalActions`, actor 전용 pending response option, 비응답자용 비밀 없는 pending progress, 종료 `winningFaction`/`winningPlayerIds` projection DTO를 추가한다. legal action은 canonical match command 종류와 payload로 제한한다. 기존 Viewer snapshot의 private-data 경계를 문서화한다.
- 제외: 후보 합법성 계산, 엔진/서버 상태 projection, UI, 새 규칙/새 command type
- 산출물: additive v1 DTO 계약 및 protocol type/fixture 검증
- 수락 기준: 본인 합법 선택은 기존 `PLAY_CARD`/`USE_ABILITY`/`END_TURN` payload만 표현하고 RESPOND 선택은 `RespondPayload` 계약과 일치한다. actor 옵션은 pending responder 본인에게만 제공되며 그 payload는 해당 옵션에 실제 저장된 값만 담는다. 다른 뷰어 progress에는 현재 입력자/단계 정보만 있고 선택지·손패 ID·context가 없다. outcome은 종료 판에서만 공개된다. 근거: `pnpm --filter @bang/contracts check`, `pnpm --filter @bang/contracts test` 10/10, `pnpm --filter @bang/engine check` 모두 통과. fixture tests에서 canonical action schema, responder 분리, progress privacy, completed outcome-only 경계를 검증했다. T69 projection producer/network integration과 97개 통합 AT는 미실행이다.

#### T69 — 합법 행동 후보 생성과 viewer projection

- 상태: DONE
- 의존: T07, T11, T13, T14, T41, T66, T67, T68, T83
- 파일 소유: packages/engine/src/actions/**, packages/engine/test/actions/**, packages/engine/src/state/projection.ts, packages/engine/test/state/projection.test.ts
- 입력: 01_RULES.md, 02_PRODUCT_UX.md, 03_ARCHITECTURE.md, T07/T11/T13/T14/T41/T66/T67/T68 산출물
- 범위: 현재 서버 권위 상태 및 등록된 효과 API로 actor에게 가능한 complete command proposal을 계산하고 T68 viewer snapshot fields로 투영한다. pending prompt는 current actor의 엄격한 response options만 주고 다른 viewer에게는 선택 세부가 없는 진행 신호를 준다. 끝난 매치는 엔진 outcome을 안전하게 투영한다.
- 제외: UI, 서버 전송, 클라이언트의 별도 규칙 계산, 숨은 카드/역할/덱 순서 누출, 새 규칙
- 산출물: 결정적 action candidate builder와 player-specific projection 확장
- 수락 기준: 출력된 모든 action/response payload가 동일 state에서 T14 검증을 통과하고 현재 actor 외에는 실행 후보가 비어 있다. resolution 중 일반 action은 보이지 않는다. hidden opponent hand은 target player/zone만 주고 card ID를 투영하지 않는다. actor만 자기 response options를 받고 다른 viewer는 현재 입력자·단계 signal만 받는다. outcome은 종료 상태에서만 모든 viewer가 보고 R01/R30과 일치한다. 80장/비공개 projection 및 API 테스트와 engine check를 실행한다. Pending response 후보의 공용 DTO literal/옵션-template 보완은 T83 뒤에 연결한다. 루트 재검증: pnpm --filter @bang/engine check 통과, candidates/projection tests 15/15, pnpm --filter @bang/contracts check 및 contracts tests 13/13 통과. 통합 AT 미실행.

#### T72 — RoomView의 활성 매치 참조 계약

- 상태: DONE
- 의존: T02
- 파일 소유: `outputs/development-plan/04_PROTOCOL.md`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/validation.ts`, `packages/contracts/test/**`, `packages/test-fixtures/protocol/**`
- 입력: `03_ARCHITECTURE.md`, `04_PROTOCOL.md`, `06_ACCEPTANCE_TESTS.md`, R10/D16 room/match lifecycle decisions
- 범위: 인증된 RoomView에 필수 `activeMatchId: string | null`을 추가한다. 대기/폐쇄 등 매치가 없는 방은 null, 게임 진행·일시중지·완료된 방은 서버가 만든 match ID를 반환한다. strict RoomView/room sync response parser와 fixtures를 함께 갱신한다.
- 제외: RoomView producer/service, 시작 명령 구현, DB 조회, 브라우저 라우트/화면
- 산출물: room sync response에서 match 경로를 식별하는 shared contract, parser 및 protocol fixtures
- 수락 기준: valid waiting/in-game fixture가 정확히 파싱되고 missing/ill-typed activeMatchId, status와 nullability 불일치, 추가 필드는 거부한다. viewer가 room member이며 owner flag가 RoomView owner ID와 일치하는 것을 검증한다. 근거: 루트 `pnpm --filter @bang/contracts check` 및 `pnpm --filter @bang/contracts test` 11/11 통과. RoomView producer는 T74에서 연결한다. 통합 AT D02/D16 미실행.

#### T73 — 방 시작과 매치 생성을 위한 원자 저장 API

- 상태: DONE
- 의존: T09, T43, T62, T64
- 파일 소유: `apps/server/src/storage/room-lifecycle.ts`, `apps/server/src/storage/repository.ts`, `apps/server/test/storage/room-lifecycle.test.ts`, `apps/server/test/storage/repository.test.ts`
- 입력: `03_ARCHITECTURE.md` §3/§5/§6, `04_PROTOCOL.md` §2–3/§6, `01_RULES.md` R02/R03, T09 `GameState`, T43/T64 storage APIs
- 범위: `startRoomWithMatch`를 추가해 room row lock 아래 권한/버전/대기실 상태/멤버 수/전원 ready를 검증하고 initialized `GameState`, `matches`, `match_players`, room status/version, command receipt와 room+match changed outbox를 하나의 DB transaction으로 저장한다. 매치 ID 재조회 API를 추가해 RoomView producer가 activeMatchId를 읽을 수 있게 한다.
- 제외: 역할/인물/덱 초기화 자체(T09), start/draw effect orchestration(T67), socket command adapter/service(T74), schema migration, 새 ready/seat 규칙
- 산출물: atomic start lifecycle API, active match lookup 및 PGlite rollback/idempotency/concurrency tests
- 수락 기준: 4–7 명의 현재 모든 room member가 ready인 경우만 owner가 시작할 수 있고, 게임 좌석/player ID set은 ready snapshot과 정확히 일치한다. 비소유자, 비회원, 4명 미만, 미준비/잠긴/종료 방, stale version은 상태를 일부도 변경하지 않는다. 같은 command 재전송은 원래 match ID/outcome을 반환하고 신규 match/outbox를 추가하지 않는다. 성공은 room version/status, match/state/players, receipt, 두 allowlisted outbox를 함께 commit한다. forced error/receipt race는 orphan row나 partial status를 남기지 않는다. 루트 재검증: T73 storage 전용 PGlite tests 19/19 통과. `pnpm --filter @bang/server check`에는 T72 required `RoomView.activeMatchId` producer가 아직 없는 T74 예정 경로의 단일 오류만 남아 T73 변경 오류와 분리됨을 확인했다. T74 연결 뒤 server check 재실행 예정. 통합 AT D16 미실행.

#### T74 — START_MATCH 서비스 및 Socket.IO 처리

- 상태: DONE
- 의존: T09, T41, T44, T45, T46, T49, T67, T72, T73
- 파일 소유: `apps/server/src/rooms/service.ts`, `apps/server/src/main.ts`, `apps/server/test/rooms/service.test.ts`, `apps/server/test/runtime/runtime.test.ts`, `apps/server/test/projections/sync.test.ts`, `apps/server/test/socket/gateway.test.ts`
- 입력: `01_RULES.md` R02/R03, `02_PRODUCT_UX.md` §4.2, `03_ARCHITECTURE.md`, `04_PROTOCOL.md` §2–5, T09/T41/T67 engine APIs, T44/T73 room lifecycle
- 범위: 인증된 START_MATCH를 서비스의 암호학적 주입 RNG, T09 setup 및 T67 차례 시작/초기 드로우로 구성하고 T73의 atomic storage API에 전달한다. `roomViewForMember`는 T73 active-match lookup을 사용해 RoomView의 필수 activeMatchId를 만든다. Socket command ack와 sync path를 연결한다.
- 제외: browser transport/UI, 사용자 이름/좌석 새 규칙, 공개 매칭, event/outcome 규칙 변경, 추측형 타이머
- 산출물: 방장 전용 매치 시작 서비스, START_MATCH handler 및 RoomView producer integration tests
- 수락 기준: owner/member/current room version와 4~7 전원 준비 조건은 서버에서 확인되고, 성공 ACK 및 이후 room sync는 정확한 match ID를 준다. engine start/draw 상태가 한 번만 저장되며 응답 유실 재시도는 원래 match를 반환한다. 비소유자·미준비·stale·잠금은 receipt/매치 없이 거절되고 멤버는 시작 후 kick/join되지 않는다. 루트 재검증 `pnpm --filter @bang/server check` 통과; `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/rooms/service.test.ts apps/server/test/runtime/runtime.test.ts apps/server/test/projections/sync.test.ts apps/server/test/socket/gateway.test.ts` 31/31 통과(서비스 10, runtime 4, sync 7, gateway 10). T81 guest restore route도 보존되어 runtime에서 확인했다. 통합 AT D02/D16 미실행.

#### T75 — 화면 라우트와 기능 모듈 연결

- 상태: DONE
- 의존: T50, T51, T52, T53, T54, T55, T56, T57, T58, T59, T72, T74, T76
- 파일 소유: `apps/web/src/app/**`
- 입력: `02_PRODUCT_UX.md`, `03_ARCHITECTURE.md`, `04_PROTOCOL.md`, T51~T59 feature APIs, T72/T74 room→match routing
- 범위: 앱 셸이 게스트 session→방 생성/초대 입장→대기실→시작→역할 공개→게임 테이블→종료 결과 화면에서 feature 모듈과 T58 transport를 실제 사용하도록 라우트를 연결한다.
- 제외: 엔진 규칙 재구현, server authority 우회, public asset 변경, transport/protocol 계약 변경, 접근성 스타일 전면 재설계
- 산출물: 로딩/오류/세션/room/match 상태를 가진 앱 경로 통합과 페이지 integration tests
- 수락 기준: 홈부터 새로고침/초대 경로, guest cookie, room sync activeMatchId, private match snapshot, legal actions/pending/result projection까지 canonical transport만 사용한다. 페이지 직접 URL 및 back navigation에서 인증 상태를 다시 sync하고 URL에 세션 secret/비공개 match data가 없다. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/web/src/app/routes.test.mjs` 9/9, 전체 `apps/web/src/**/*.test.mjs` loader 실행 57/57, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. 로컬 Vite 앱 홈 페이지를 브라우저로 열어 확인했다. 실제 guest/server/game 경로 및 다중 게스트 E2E는 T60.

#### T76 — 브라우저 Socket.IO 의존성과 로컬 proxy

- 상태: DONE
- 의존: T49, T61
- 파일 소유: `apps/web/package.json`, `apps/web/vite.config.ts`, `pnpm-lock.yaml`
- 입력: `03_ARCHITECTURE.md` §5/§6, T49 server local URL/config, Socket.IO official client/Vite proxy documentation
- 범위: web workspace가 직접 의존하는 버전 일치 `socket.io-client`를 추가하고 Vite dev server의 API/Socket.IO websocket 경로를 local server로 전달한다. existing server origin/config defaults와 다른 production deployment를 설정하지 않는다.
- 제외: transport hooks/API(T58), UI(T75), server dependency/config changes, external deploy
- 산출물: frozen-lockfile 재현 가능한 browser transport dependency와 local proxy
- 수락 기준: client/server Socket.IO protocol versions are compatible; 루트 `pnpm install --frozen-lockfile`, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. T49 PGlite 서버와 Vite local proxy에서 guest-session POST가 201 및 HttpOnly/Secure/SameSite=Lax 쿠키를 반환하고 인증 WebSocket handshake가 연결됨을 확인했다. 사용한 origin/포트 `127.0.0.1:5174`/3000/5433, 서버 데이터 디렉터리는 `%LOCALAPPDATA%\BangOnline\t76-proxy-smoke`; 세션 credential 원문은 출력하지 않았으며 종료 뒤 포트 listener가 없음을 확인했다. Vercel/public deployment remains untested.

#### T77 — Slab의 일반 BANG 방어 런타임 연결

- 상태: DONE
- 의존: T11, T12, T14, T15, T16, T18, T22, T65, T66
- 파일 소유: `packages/engine/src/effects/cards/basic-actions.ts`, `packages/engine/test/effects/basic-actions.test.ts`, `packages/engine/src/effects/cards/dynamite-barrel.ts`, `packages/engine/test/effects/dynamite-barrel.test.ts`, `packages/engine/src/effects/runtime/index.ts`, `packages/engine/test/effects/runtime/runtime.test.ts`
- 입력: `01_RULES.md` R13/C13/R22, T12 interaction, T15 card API, T65 Slab attack-response query, T16/T18/T22 card effects, T66 runtime
- 범위: 실제 물리 BANG 공격에서 등록된 Slab attacker query를 호출하고, Barrell/Jourdonnais/손패 Missed의 성공 수를 지속해 필요한 방어 응답을 재개한다.
- 제외: Slab module 자체(T37), 새 protocol/state contract, Gatling에 능력 적용, T41 등록기
- 산출물: 서버 권위의 Slab BANG defense continuation과 BANG/Barrel/runtime regression tests
- 수락 기준: Slab의 자기 물리 BANG만 추가 방어가 필요하고, successful Barrel/Jourdonnais 판정은 각 1 Missed로 계산한다. 필요한 방어 수가 충족될 때만 BANG이 무효화된다. Missed 한 장 뒤 TAKE_HIT 선택은 정상 피해로 이어지며 Missed가 부족할 때 두 번째 방어창이 재접속 가능한 T12 상태로 저장된다. Gatling, 비-Slab BANG 및 Calamity의 물리 Missed→BANG 변환에는 Slab 강화가 없다. 루트 재검증: `pnpm --filter @bang/engine check` 통과; `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/basic-actions.test.ts packages/engine/test/effects/dynamite-barrel.test.ts packages/engine/test/effects/runtime/runtime.test.ts` 37/37 통과. JSON 재개, TAKE_HIT, Barrel+Jourdonnais 순차 Heart, Calamity 변환, Gatling/non-Slab 제외 및 zone invariant를 확인했다. 통합 AT 미실행.

#### T78 — Suzy response/효과 완료 hook runtime 연결

- 상태: DONE
- 의존: T17, T18, T19, T20, T22, T28, T37, T38, T41, T65, T66, T77, T80
- 파일 소유: `packages/engine/src/effects/characters/suzy-lafayette.ts`, `packages/engine/test/effects/characters/suzy-lafayette.test.ts`, `packages/engine/src/effects/runtime/index.ts`, `packages/engine/test/effects/runtime/runtime.test.ts`
- 입력: `01_RULES.md` C14/D11, T80 Suzy boundary hook, T16~T20/T22 card runtime, T28 El Gringo, T37/T38 modules, T41 registry, T66 runtime
- 범위: card response 직후와 resolution completion 시 Suzy module을 dispatch하고, Suzy가 만든 실제 생존 피해가 El Gringo의 C04 보상을 발생시킬 때 R27 이후 C04 탈취 직전 Suzy draw → El Gringo steal → resolution-complete draw 순서를 구현한다.
- 제외: card rule 재구현, 타 인물 hook, T67 turn draw 변경, protocol/deployment
- 산출물: Suzy runtime hook dispatcher 및 실제 T12 continuation boundary integration tests
- 수락 기준: Slab 대응의 마지막 Missed로 손패가 0이면 다음 방어 응답을 열기 전에 한 장을 뽑고 새 Missed로 대응할 수 있다. Duel은 전체 Duel이 끝난 뒤에만 빈 손패를 확인한다. General Store/Stagecoach/Wells Fargo가 먼저 카드 제공하면 추가 뽑기가 없다. Suzy의 마지막 공격으로 El Gringo가 생존 피해를 받는 시나리오는 C14/S5 순서대로 카드 이동을 증명한다. effect 종료 후 비어 있으면 다시 한 장, 카드가 남으면 추가 없음. 루트 재검증: `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/characters/suzy-lafayette.test.ts packages/engine/test/effects/runtime/runtime.test.ts` 24/24, `pnpm --filter @bang/engine check` 통과. 통합 AT 미실행.

#### T79 — Lucky Duke의 카드 판정 선택 runtime 연결

- 상태: DONE
- 의존: T21, T22, T32, T65, T66, T67, T70, T78
- 파일 소유: `packages/engine/src/effects/cards/jail.ts`, `packages/engine/test/effects/jail.test.ts`, `packages/engine/src/effects/cards/dynamite-barrel.ts`, `packages/engine/test/effects/dynamite-barrel.test.ts`, `packages/engine/src/effects/runtime/index.ts`, `packages/engine/test/effects/runtime/runtime.test.ts`, `packages/engine/src/turn/draw.ts`, `packages/engine/test/turn/draw.test.ts`
- 입력: `01_RULES.md` R08/C08/D04/D05, T21 Jail, T22 Dynamite/Barrel, T32 Lucky candidate selection, T65 judgment hook, T66/T78 runtime
- 범위: Jail, Dynamite, Barrel 및 Jourdonnais 가상 Barrel의 Draw! 공급을 Lucky 공개 후보/선택창에 연결한다. Jail은 T67 turn-start orchestration이 T66 effect runtime을 통해 실행되도록 해당 Jail 호출 경계만 연결해 저장된 선택/재개를 보장한다. 일반 손패 draw와 Black Jack 후보는 제외.
- 제외: 새 Lucky 규칙/공용 contract, 일반 T67 차례 드로우 변경(명시된 Jail start-effect runtime 연결은 포함), 비공개 후보 노출 확대
- 산출물: source별 Lucky judgment supplier와 saved choice/재개 tests
- 수락 기준: Lucky가 관련 Draw!를 할 때 고유한 top 두 후보만 공개하고 한 장을 판정에 쓰며 두 장 모두 D04 선택 순서대로 버린다. pending 선택은 T12에 저장·재개되고 동일 명령 재시도에 후보/순서가 바뀌지 않는다. Jail 선택은 T67 start orchestration이 runtime continuation으로 연결되어야 한다. non-Lucky는 기존 단일 카드 판정과 같고 일반 draw/Black Jack에는 hook이 없다. 80장 zone invariant, 빈 자원 D05, deterministic RNG, engine check/tests 통과. 통합 AT 미실행. 루트 재검증: `pnpm --filter @bang/engine check` 및 Jail/Dynamite-Barrel/runtime/turn-draw tests 55/55 통과. Lucky Jail R08 재셔플 뒤 top-2 selection 저장/재개, turn-start Jail runtime continuation, 비-Lucky/일반 draw/Black Jack 제외를 확인했다. 통합 AT 미실행.

#### T80 — C14 El Gringo 순서를 위한 Suzy hook 계약 보완

- 상태: DONE
- 의존: T65
- 파일 소유: `outputs/development-plan/01_RULES.md`, `packages/engine/src/effects/character-api.ts`, `packages/engine/test/effects/character-api.test.ts`
- 입력: 공식 tournament general FAQ S5 p13, `01_RULES.md` C14, T65 기존 Suzy hook
- 범위: C14가 요구하는 Suzy-caused El Gringo 생존 피해 순서에 한해, R27 구제까지 끝나 실제 생존 피해가 확정된 뒤 C04 카드 탈취 직전의 명시적 boundary를 typed Suzy contract에 추가한다. root만 규칙/engine shared hook contract 수정 권한을 가진다.
- 제외: runtime dispatch(T78), protocol DTO, 다른 인물/card API
- 산출물: 규칙 문서에 근거한 D11 및 compile-time checked Suzy hook union
- 수락 기준: `resolution_complete` hook은 기존 Duel/General Store 처리를 유지하고, `before_el_gringo_reward` hook은 명시적 `EL_GRINGO_DAMAGE` trigger marker와 피해자 좌석을 가져야 한다. 이 boundary는 실제 HP 손실 및 R27 구제 후 생존이 확인된 El Gringo만 표현한다. Duel은 `after_response`에 포함하지 않는다. 공식 S5 보충 판정과 구분한 D11, API type tests와 engine check 통과. 루트 재검증: `pnpm --filter @bang/engine check`, strict standalone tsc of `character-api.test.ts`, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/character-api.test.ts` 2/2 통과. runtime 연결 T78 및 통합 AT 미실행.

#### T81 — 쿠키 세션 및 배정 좌석 복원 HTTP API

- 상태: DONE
- 의존: T44, T48, T49, T51, T74
- 파일 소유: `outputs/development-plan/04_PROTOCOL.md` (공용 계약 단독 소유자: 루트), `apps/server/src/main.ts`, `apps/server/test/runtime/**`, `apps/server/README.md`
- 입력: 02_PRODUCT_UX.md §4.1, 03_ARCHITECTURE.md §6, 04_PROTOCOL.md §2.1/§2.1.1, T44 guest authentication/assigned-seat recovery, T49 runtime
- 범위: 브라우저 refresh에서 기존 게스트 정보를 재구성하는 cookie-auth GET과 같은 player의 RoomView 목록을 돌려주는 GET을 프로토콜·런타임·테스트·로컬 문서에 함께 추가한다.
- 제외: guest credential을 JavaScript에 제공/저장, 방·게임 상태를 브라우저 authority로 사용, 신규 command/event, 매치 sync 대체, 게임 규칙/계정 시스템 변경
- 산출물: `GET /api/guest-sessions` 및 `GET /api/guest-sessions/rooms`의 안전한 cookie 기반 서버 구현과 runtime 회귀 테스트
- 수락 기준: 유효 cookie의 세션 조회는 `GuestSessionResponse`를, 무효/만료/부재 세션은 빈 204를 돌려준다. 좌석 조회는 유효 인증 player의 자기 RoomView 목록만 주고 부재/무효 세션은 401 `SESSION_EXPIRED`로 거절한다. 둘 다 `Cache-Control: no-store`; 쿠키 원문은 JSON/log/storage에서 노출하지 않는다. room views는 각 멤버십에 대해 server-side service가 다시 계산하며 초대/비밀/전체 match state를 포함하지 않는다. runtime tests는 유효/무효 cookie, 신규 게스트의 빈 방 배열, 소유자 좌석 복구, no-store/private boundary를 실행해 확인한다. 루트 재검증 `pnpm --filter @bang/server check` 및 T74와 결합한 service/runtime/sync/gateway tests 31/31 통과; runtime 4/4 중 cookie/session/assigned seat 복구 및 재시작 후 경계를 확인했다. T58은 revised contract에 따라 재개한다.

#### T82 — Barrel/Dynamite 설치 효과 보완

- 상태: DONE
- 의존: T22, T23, T66
- 파일 소유: `packages/engine/src/effects/cards/equipment.ts`, `packages/engine/test/effects/equipment.test.ts`, `packages/engine/src/effects/cards/dynamite-barrel.ts`, `packages/engine/test/effects/dynamite-barrel.test.ts`
- 입력: 01_RULES.md R06/R22/R24, T22/T23/T66 산출물
- 범위: registry에 누락된 Barrel과 Dynamite의 손패→자기 in-play 설치 `CardEffectModule` 지원을 추가하고, 이미 구현된 방어/턴 시작 판정과 공존하도록 전용 회귀를 작성한다.
- 제외: registry 수정, R06 같은 이름 장착 제한/무기 교체 변경, turn-start 순서/판정 재구현, 새 규칙/공용 effect API/reducer/state 변경
- 산출물: `equipmentEffect`의 R06 준수 Barrel 설치 지원 및 Dynamite 전용 설치 효과와 전용 테스트
- 수락 기준: 무대상 자기 설치, 실제 자기 손패의 올바른 물리 카드 ID, 살아 있는 actor 검증을 통과한 경우만 해당 카드를 `in_play`로 옮기는 event draft가 생성된다. Barrel은 R06의 같은 이름 파란 카드 중복 금지를 적용하고 무기 교체 규칙에 영향을 주지 않는다. Dynamite 설치는 다음 자기 턴 시작 판정을 실행하거나 RNG를 소비하지 않는다. 잘못된 카드/소유/대상/비활성 actor 입력은 거절되고 입력 state는 불변이다. 카드 사용 단계 제한은 T14 command legality가 권위 판단한다. 루트 재검증: equipment/dynamite-barrel tests 19/19, T77 basic-actions/dynamite-barrel/runtime/equipment regression 45/45, `pnpm --filter @bang/engine check` 통과. T41 registry는 이 완료된 효과를 소비한다.

#### T83 — RESPOND pending 옵션 계약과 parser 동기화

- 상태: DONE
- 의존: T02, T66, T67, T68
- 파일 소유: `outputs/development-plan/04_PROTOCOL.md`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/validation.ts`, `packages/contracts/test/protocol.test.mjs`, `packages/contracts/test/protocol.type-test.ts`, `packages/test-fixtures/protocol/**` (공용 계약 단독 소유자: 루트)
- 입력: T66/T67 runtime의 저장된 `InteractionOption`, Jesse/Pedro/Lucky 응답 handler, `04_PROTOCOL.md` §4 및 §5.1.1
- 범위: 현재 runtime이 실제로 제공하는 Jesse(`DRAW_FROM_PILE`, `TAKE_FROM_HAND` + `sourcePlayerId`), Pedro(`SELECT_SOURCE` + `source`), Lucky(`SELECT_JUDGMENT` + `selectedCardInstanceId`/`orderedCardInstanceIds`) 응답값을 typed `RespondPayload` 및 strict parser로 동기화한다. 입력 시 클라이언트가 정렬 순서를 채우는 `ORDER_CARDS` 저장 옵션과 완전한 command payload를 타입상 분리한다. 프로토콜의 character-choice 표기를 같은 runtime literal에 맞춘다.
- 제외: 게임 규칙/효과 선택지 변경, engine runtime 변경, UI, 다른 protocol command/event 변경
- 산출물: 실제 runtime option/complete RESPOND command와 맞는 additive v1 type, validation, fixtures 및 protocol 설명
- 수락 기준: 네 runtime 선택 유형을 pending response fixture/parser에서 정확히 수용한다. `ORDER_CARDS` pending template은 옵션 목록에서는 interactionId와 choice만 가지되 actual `RESPOND` command는 `orderedCardInstanceIds`를 반드시 요구한다. `TAKE_FROM_HAND`, `SELECT_SOURCE`, `SELECT_JUDGMENT`에 필요한 payload shape는 parser가 검사하고 extra/missing fields를 거부한다. 루트 검토: `pnpm --filter @bang/contracts check` 통과, `pnpm --filter @bang/contracts test` 13/13 통과(추가 strict command/pending parsing, runtime option fixtures, type test 포함). 97개 통합 규칙 AT 미실행.


#### T84 — DISCARDS_ORDER 응답자 선택 정보 projection 계약

- 상태: DONE
- 의존: T02, T12, T68, T69
- 파일 소유: `outputs/development-plan/04_PROTOCOL.md`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/validation.ts`, `packages/contracts/test/protocol.test.mjs`, `packages/contracts/test/protocol.type-test.ts`, `packages/test-fixtures/protocol/**`, `packages/engine/src/state/projection.ts`, `packages/engine/test/state/projection.test.ts` (공용 계약 및 projection 단독 소유자: 루트)
- 입력: `02_PRODUCT_UX.md` §4.12–4.13, `04_PROTOCOL.md`, T12 saved `DISCARDS_ORDER` context, T68/T69 viewer pending projection, T83 pending RESPOND option
- 범위: 현재 responder가 `DISCARDS_ORDER`일 때만 엔진에 저장된 정확한 `requiredCount`와 그 pending context의 `allowedCardInstanceIds`에 대응하는 card faces를 actor 전용 pending view에 추가한다. 공유 타입/strict parser, engine projection, valid/invalid fixtures 및 privacy tests를 함께 갱신한다.
- 제외: `DISCARDS_ORDER` 처리/규칙 변경, non-responder나 다른 종류 pending에게 후보/context 공개, UI 구현(T56 소유), 다른 contract 또는 reducer 변경
- 산출물: exact-key 검증을 거친 responder-only discard-order view 정보
- 수락 기준: `DISCARDS_ORDER`의 현재 responder만 exact saved candidate faces와 양의 필수 선택 수를 받는다. requiredCount가 candidate 수보다 크거나 0/비정수거나 후보 ID가 중복/누락/비문자이면 parser/projection은 거절한다. 비응답자는 필드 및 후보 ID를 받지 않고 다른 종류 응답 view에도 discardOrder 필드가 없어야 한다. 루트 재검증: `pnpm --filter @bang/contracts check`, `pnpm --filter @bang/contracts test` 13/13, `pnpm --filter @bang/engine check`, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/state/projection.test.ts` 12/12 통과. 현재 responder 전용 후보/필수 수, non-responder privacy, 탈락 actor cleanup prompt 및 malformed saved context를 검증했다. 통합 AT 미실행.

#### T85 — R27 초과 치명상 구제 잔여 HP 보존

- 상태: DONE
- 의존: T06, T12, T66, T79 (모두 DONE)
- 파일 소유: `packages/engine/src/effects/runtime/index.ts`, `packages/engine/test/effects/runtime/runtime.test.ts`
- 입력: `01_RULES.md` R27, T66/T79 완료 산출물, T42의 AT-C24 재현 결과
- 범위: 초과 피해의 음수 HP 잔여분을 기존 저장 가능한 runtime continuation에 보존하고 Beer/Sid 구제의 회복량에 반영한다. 구제 후 실제 HP, 구제 창 유지/종료, 사망 후속 처리 및 피해 hook 경계를 R27에 맞춘다.
- 제외: 공식 규칙 수정, `GameState` 공용 state type 또는 protocol/contracts 변경, projection에 음수 HP/비공개 피해 context 노출, 다른 카드 규칙 변경
- 산출물: 재접속/직렬화 가능한 R27 rescue deficit runtime 수정 및 전용 회귀 테스트
- 수락 기준: HP2에 Dynamite 3 피해면 내부 실효 HP−1로 시작해 Beer 1장 뒤에도 HP0/구제 pending이며, Beer 2장 뒤 HP1로 생존한다. Beer 1장 뒤 탈락을 수락하면 정상 탈락 정리로 이동한다. HP1에 피해1처럼 정확히 0이 된 경우 Beer 1장으로 생존한다. Beer/Sid가 해결 전후 카드 구역 80장 보존·재현성을 깨지 않으며, pending snapshot 직렬화/복원 뒤에도 같은 잔여량으로 이어진다. T66의 치명상·피해 hook 회귀가 유지되고 `pnpm --filter @bang/engine check` 및 runtime 전용 테스트가 통과한다. R27 이외의 새 해석은 추가하지 않는다. 루트 재검증: `pnpm --filter @bang/engine check` 통과, `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/runtime/runtime.test.ts` **25/25 통과**, 이후 AT-C24를 포함한 엔진 수락 시나리오 **78/78 통과**. HP2→−1→0→1 Beer/Sid continuation, JSON round-trip, 정확히 0인 피해 구제, 부분 구제 뒤 정상 탈락 정리, Bart 사후 hook 및 80장 zone invariant를 확인했다.

#### T86 — 브라우저 fetch receiver 오류 수정

- 상태: DONE
- 의존: T58, T75 (모두 DONE)
- 파일 소유: `apps/web/src/transport/client.ts`, `apps/web/src/transport/client.test.mjs`
- 입력: T60 브라우저 재현, T58 cookie-auth transport, D10 및 D19
- 범위: 기본 `fetch` 함수가 브라우저의 `globalThis/window` receiver로 호출되도록 고쳐 세션 생성 및 복구 HTTP 요청에서 `Illegal invocation`이 발생하지 않게 하고, receiver 민감 회귀 테스트를 추가한다.
- 제외: protocol/contracts, room/game route UI, API/server 동작, T60 E2E/README 산출물
- 산출물: 안전하게 호출되는 browser fetch wrapper와 실제 실패 형태를 재현하는 transport test
- 수락 기준: 기본 fetch 경로가 브라우저 receiver를 유지하고 guest session create/restore/assigned-room 복구가 그대로 동작한다. 주입 transport fetcher 테스트가 보존된다. `client.test.mjs`, web check/build가 통과한다. 루트는 T60이 소유한 공유 브라우저를 건드리지 않고 수락 후 서버 연결 브라우저 smoke를 별도로 재검증한다. 루트 재검증: receiver-sensitive default-fetch regression으로 create POST/restore GET/assigned rooms GET이 모두 `globalThis` receiver, URL, method, credentials/cache options와 parsed results를 확인한다. `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/web/src/transport/client.test.mjs` **6/6 통과**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`, `pnpm check` 통과. 실제 browser recheck는 T60에 남겼다.

#### T87 — Kit Carlson 비응답자 pending projection 테스트 동기화

- 상태: DONE
- 의존: T31, T68, T69, T84 (모두 DONE)
- 파일 소유: `packages/engine/test/effects/characters/kit-carlson.test.ts`
- 입력: `04_PROTOCOL.md` §5.1, T68 safe pending-progress contract, T69 projection, T84 responder-only context
- 범위: 기존 Kit Carlson private-candidate privacy test의 낡은 `pendingInteraction === null` 기대를 current non-responder progress DTO에 맞춘다. 안전한 public progress shape를 정확히 확인하면서 개인 후보 face/ID 및 response option 부재 검사를 유지한다.
- 제외: projection/contract/runtime 구현 변경, 후보 데이터 범위 변경, 새 규칙, 다른 테스트 파일
- 산출물: T68/T84와 일치하는 Kit Carlson 비응답자 projection regression
- 수락 기준: 비응답 projection은 저장 pending kind, current responder, step, 빈 `allowedChoices`만 갖고 `responseOptions`/`discardOrder`/후보 card ID·definition ID가 없다. `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/effects/characters/kit-carlson.test.ts` **5/5 통과**, `pnpm --filter @bang/engine check` 통과. 루트가 전체 엔진 test files **362/362 통과**를 재검증했다.

#### T88 — 서버 매치 효과 런타임 및 연속 차례 진행 연결

- 상태: DONE
- 의존: T14, T41, T46, T49, T66, T67, T74, T78, T79, T80, T83, T84, T85 (모두 DONE)
- 파일 소유: `apps/server/src/main.ts`, `apps/server/src/commands/index.ts`, `apps/server/src/commands/turn-runtime.ts`, `apps/server/test/commands/command-relay.test.ts`, `apps/server/test/runtime/runtime.test.ts`, `apps/server/README.md`
- 입력: `01_RULES.md` R05/R08/R23/R24, `03_ARCHITECTURE.md` §3–6, `04_PROTOCOL.md` §3–5, `06_ACCEPTANCE_TESTS.md` D01/D02/D11/D19, T41/T46/T66/T67/T74/T83/T84/T85 완료 산출물 및 T60 기준선 결과
- 범위: 서버 `match:command` 조립에서 T41 registry를 T66 command handlers와 연결하고, `END_TURN`/완료된 start/draw 응답 후 T67 시작 효과·드로우 continuation을 서버 authority 안에서 이어 실행한다. 한 클라이언트 명령의 결과는 한 aggregate version 변경 및 기존 atomic receipt/state/event/outbox transaction으로 저장한다. 매치 시작 이후 `KICK_MEMBER`는 04_PROTOCOL §3.2대로 `ROOM_LOCKED`를 반환한다.
- 제외: 공유 protocol/contracts 변경, engine 규칙·카드/인물 효과 변경, 자동 턴 timeout 또는 기본 게임 규칙 수정, 로비의 신규 퇴장/강제 제거 정책, UI/E2E 파일 수정, 외부 배포
- 산출물: registered card/ability/respond commands를 지원하고 다음 turn start/draw까지 복구 가능한 서버 match command assembly, start/draw continuation routing, in-game kick lock 응답 및 회귀 tests
- 수락 기준 및 루트 재검증: `main.ts`가 T41 registry/T66 handler를 연결하고, `END_TURN`과 start/draw 응답 후 T67 phase continuation을 같은 version/receipt/event/outbox transaction 안에서 완료한다. saved `TURN_DRAW`는 T66 effect continuation과 분리해 재개한다. registered PLAY_CARD/USE_ABILITY/RESPOND, next turn two-card draw, Kit draw prompt, Jail start interaction 후 draw, receipt replay 중 effect 재실행 방지를 tests로 확인했다. `pnpm --filter @bang/server check` 통과, `command-relay.test.ts` 13/13, `pnpm --filter @bang/server test:runtime` 4/4 통과. 실제 API runner에서 4인·7인 매치가 완료 상태에 도달했으나 이 결과는 D19 브라우저 수락으로 계산하지 않았다. KICK owner `ROOM_LOCKED`, outsider generic denial 및 room/match version/seats 불변도 확인했다. 루트가 T60 소유 E2E 경로를 수정하지 않고 재검증했다.

#### T89 — 역할 공개 canonical 경로 리다이렉트 수정

- 상태: DONE
- 의존: T75, T88 (모두 DONE)
- 파일 소유: `apps/web/src/app/pages.tsx`, `apps/web/src/app/routes.test.mjs`
- 입력: 02_PRODUCT_UX.md §3–4.4; 04_PROTOCOL.md §5; T75 앱 라우트; T60의 START_MATCH 브라우저 재현
- 범위: 서버가 START_MATCH를 수락한 뒤 앱이 `/role-reveal`이라는 미등록 URL을 생성하는 오류를 수정한다. 공개된 라우터 경로 `/role`을 canonical URL로 사용하고 route unit regression을 추가한다.
- 제외: 서버 게임 상태/계약, 역할 정보 projection, 다른 브라우저/E2E 산출물, 전체 라우트 재설계
- 산출물: 역할 공개 URL을 `/role`로 고정하는 앱 경로 수정과 회귀 테스트
- 수락 기준 및 루트 재검증: internal `role-reveal` surface에 대한 canonical redirect가 router에 등록된 `/rooms/:roomId/role`을 만들고 `/role-reveal` 경로를 만들지 않는다. `apps/web/src/app/routes.test.mjs`가 START_MATCH 직후 표면, canonical URL, router match, 기존 `/game` URL을 확인한다. `node --test apps/web/src/app/routes.test.mjs` 10/10, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 모두 루트 재실행 통과. 역할 공개 직접 URL과 session 확인 회귀도 기존 테스트에서 통과했다. 브라우저 연결 D19 재실행은 T60에 남긴다.

#### T90 — 재대기실 전환·초대 제한 공용 계약

- 상태: DONE
- 의존: T02, T72, T83 (모두 DONE)
- 파일 소유: `outputs/development-plan/02_PRODUCT_UX.md`, `outputs/development-plan/04_PROTOCOL.md`, `outputs/development-plan/07_READINESS.md`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/validation.ts`, `packages/contracts/test/**`, `packages/test-fixtures/protocol/**` (공용 계약 단독 소유자: 루트)
- 입력: 06_ACCEPTANCE_TESTS.md D17–D19; T02/T72/T83 contracts; T60 결과·D17/D18/D19 결함
- 범위: 결과 화면에서 같은 roster의 재대기실로 돌아가기 위한 owner-only room command 및 readiness reset 의미를 명문화하고 contract/parser/fixtures에 추가한다. `room:preview`가 기존 `RATE_LIMITED` + `retryAfterMs` semantics로 rate limit rejection을 정확히 표현하도록 contract를 확장한다. 운영 rate delay progression을 문서화한다.
- 제외: 서버 rate limiter/room mutation implementation, app UI/network integration, game rules, external deployment
- 산출물: strict typed RETURN_TO_LOBBY request and RATE_LIMITED preview rejection contracts, fixtures, UX/operational decisions
- 수락 기준 및 루트 재검증: strict parser는 `RETURN_TO_LOBBY` exact empty payload 및 preview `RATE_LIMITED`의 positive safe `retryAfterMs`를 승인하고 missing/extra/invalid fields를 거절한다. 완료 결과→재대기실의 owner/reset readiness 의미와 invite limiter의 5 failures/rolling 60s/IP+session, 첫 1s 이후 매 재요청 2배/최대15분, 15분 유휴·성공 invite 후 reset 기준을 UX/protocol/readiness에서 통일했다. `pnpm --filter @bang/contracts check`, `pnpm --filter @bang/contracts test` 13/13, workspace `pnpm check`가 루트 재실행에서 통과했다. 서버와 UI 동작은 후속 작업이다.

#### T91 — 완료 매치에서 새 매치 직접 시작

- 상태: DONE
- 의존: T49, T73, T74, T88, T90 (모두 DONE)
- 파일 소유: `apps/server/src/storage/room-lifecycle.ts`, `apps/server/src/rooms/service.ts`, `apps/server/test/storage/room-lifecycle.test.ts`, `apps/server/test/rooms/service.test.ts`
- 입력: `01_RULES.md` R02/R03/R30, `04_PROTOCOL.md` §3.2의 직접 재시작 결정, `06_ACCEPTANCE_TESTS.md` D18, T73 atomic start lifecycle, T74 service initialization, T88 match commit/runtime
- 범위: 기존 `START_MATCH`가 `waiting` 방에서 시작하는 동작을 유지하면서 `in_game` 방은 room lock 아래 최신 매치가 `completed`인 경우에만 재시작을 허용한다. 변경 없는 현재 roster와 전원 ready를 다시 검증하고 새 match ID·초기화 state·room version·receipt·room/match outbox를 하나의 transaction으로 저장한다. 완료되지 않은 최신 매치, 잘못된 권한/버전/멤버/준비 상태는 계속 거절한다.
- 제외: `RETURN_TO_LOBBY` 명령 구현, UI, 공유 계약 변경, 게임 규칙/초기화 정책 변경, 외부 배포
- 산출물: completed-only 직접 재시작의 저장소/서비스 구현 및 원자성·멱등성·새 매치 초기화 회귀 테스트
- 수락 기준 및 루트 재검증: waiting 방 시작은 보존된다. `in_game`에서 최신 매치가 playing/paused/recovery_required이거나 없으면 `ROOM_LOCKED`이며 방/매치/receipt/outbox가 그대로다. 최신 완료 매치가 있고 locked roster가 모두 ready이면 owner는 새 match ID와 독립 초기화 state를 시작하고 room version은 한 번 증가한다. 같은 command 재전송은 원래 match ID/outcome을 주며 매치·seat·receipt·outbox를 중복 생성하지 않는다. 동시 새 시작은 하나만 적용되고 후속 요청은 version conflict로 거절된다. 새 매치 roster는 기존 방의 같은 시계방향 seat 순환이고 완료 snapshot/event는 보존된다. seeded service test는 새 card IDs, 덱 순서, 역할 할당을 확인한다. 루트 재검증: `pnpm --filter @bang/server check` 통과; `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/storage/room-lifecycle.test.ts apps/server/test/rooms/service.test.ts` **25/25 통과**. 통합 D18 수락 케이스 재실행은 T60에 남긴다.

#### T92 — 완료 결과에서 같은 방 재대기실로 복귀

- 상태: DONE
- 의존: T49, T73, T74, T88, T90, T91 (모두 DONE이어야 배정 가능)
- 파일 소유: `apps/server/src/storage/room-lifecycle.ts`, `apps/server/src/rooms/service.ts`, `apps/server/src/main.ts`, `apps/server/test/storage/room-lifecycle.test.ts`, `apps/server/test/rooms/service.test.ts`, `apps/server/test/runtime/runtime.test.ts`
- 입력: `04_PROTOCOL.md` §3.2 `RETURN_TO_LOBBY`, `06_ACCEPTANCE_TESTS.md` D19, T73 storage transaction, T74 room service/handler, T88 room lifecycle/runtime wiring, T90 contract, T91 completed-match gate
- 범위: strict `RETURN_TO_LOBBY` room command를 서버에 연결한다. 같은 room/seat roster와 history를 보존하면서 방장만 최신 매치 완료 후 대기실 복귀를 실행할 수 있게 한다. 모든 좌석 `ready=false`; room `waiting`; version/receipt/room outbox 원자 갱신, RoomView `activeMatchId:null` 제공.
- 제외: 결과화면 버튼/프런트엔드 경로, 게임 규칙 또는 match snapshot 변경, 초대 limiter, 계약 재정의, 배포
- 산출물: owner-only completed-game room mutation, service/socket handler 연결 및 transaction/idempotency/authorization tests
- 수락 기준 및 루트 재검증: 방장은 최신 매치 completed일 때만 복귀 가능하다. 비방장/비회원/진행 중/완료 이전 stale 입력은 거절되고 방·match history·receipt/outbox에 부분 변경이 없다. 성공 후 좌석과 방장은 보존되고 모든 ready가 false, room status waiting, version +1, activeMatchId null이다. match snapshot/events와 역할 공개 완료 결과는 그대로다. 같은 command 재전송은 동일 outcome을 반환하고 version/outbox가 중복 증가하지 않는다. 복귀 후 START_MATCH는 모든 참가자가 다시 ready한 후만 허용한다. outbox ID 충돌 rollback 회귀도 확인했다. 루트 재검증: `pnpm --filter @bang/server check` 통과; `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/storage/room-lifecycle.test.ts apps/server/test/rooms/service.test.ts` **29/29 통과**; `pnpm --filter @bang/server test:runtime` **4/4 통과**. 통합 D19 브라우저 실행은 T60에 남긴다.

#### T93 — 표시명 길이·제어문자 입력 경계 일치

- 상태: DONE
- 의존: T49, T51, T75, T90 (모두 DONE이어야 배정 가능)
- 파일 소유: `apps/server/src/rooms/service.ts`, `apps/server/test/rooms/service.test.ts`, `apps/web/src/features/room-entry/model.ts`, `apps/web/src/features/room-entry/model.test.mjs`, `apps/web/src/features/room-entry/RoomEntry.tsx`, `apps/web/src/features/lobby/Lobby.test.mjs`
- 입력: `07_READINESS.md` P09, `02_PRODUCT_UX.md` §4.1, `06_ACCEPTANCE_TESTS.md` D17, T49 guest-session HTTP/service 경로, T51 room-entry UI, T75 라우트
- 범위: trim 후 1–20 Unicode code point, 제어문자 거절 정책을 서버 검증·클라이언트 사전검증·도움말에 동일 적용한다. 브라우저가 HTML 모양 표시명을 텍스트로 출력하는 회귀 테스트를 추가한다.
- 제외: 프로토콜/contracts 변경, invite-guess rate limiter, 이름 중복 제한, 인증·세션 정책 변경, 새 규칙, 배포
- 산출물: P09 일치 표시명 검증과 텍스트 렌더링 테스트
- 수락 기준 및 루트 재검증: 1–20 Unicode code point 이름을 trim 후 수용하고, 빈 이름/21+ code point/C0·C1 제어문자는 서버와 클라이언트에서 같은 경계로 처리한다. surrogate pair emoji 길이 경계, 중복 표시명 허용, `<img ...>`의 텍스트 렌더링을 확인했다. `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/rooms/service.test.ts` **12/12**, `node --experimental-strip-types --test apps/web/src/features/room-entry/model.test.mjs` **5/5**, `node --experimental-strip-types --test apps/web/src/features/lobby/Lobby.test.mjs` **3/3**, `pnpm --filter @bang/server check`, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 모두 루트 재실행 통과. D17 invite limit은 T94/T60에서 따로 검증한다.

#### T94 — 초대 코드 추측 제한 서버 적용

- 상태: DONE
- 의존: T49, T90 (모두 DONE)
- 파일 소유: `apps/server/src/socket/gateway.ts`, `apps/server/src/socket/invite-rate-limiter.ts`, `apps/server/test/socket/gateway.test.ts`, `apps/server/test/socket/invite-rate-limiter.test.ts`
- 입력: `04_PROTOCOL.md` §§2.3, 9; `07_READINESS.md` 초대 코드 정책; `06_ACCEPTANCE_TESTS.md` D17; T49 cookie-auth socket gateway/runtime; T90 strict preview `RATE_LIMITED` response contract
- 범위: 인증된 소켓의 `room:preview` 및 `JOIN` invite 실패를 동일한 메모리 기반 limiter로 제한한다. key는 raw peer IP와 서버 인증 `playerId` 조합으로 만들고 forwarded IP 헤더를 읽지 않는다. 초대 유효성 확인 전에 차단 여부를 검사하고, 틀리거나 알 수 없는 invite 실패만 누적한다. 성공 JOIN은 해당 key의 누적 실패/대기 단계를 초기화한다.
- 제외: 공유 contracts 수정, HTTP guest-session limiter, room/service 게임 규칙·저장 변경, 설정되지 않은 trusted proxy 지원, 여러 프로세스 사이 공유 limiter, UI, 배포
- 산출물: 결정적 시계 주입이 가능한 limiter와 gateway wiring 및 socket-level regression tests
- 수락 기준 및 루트 재검증: 동일 IP+player key의 invalid preview/JOIN 실패를 합쳐 rolling 60초 최대 다섯 번까지 조회하고, 한도를 채운 뒤에는 lookup 전에 `RATE_LIMITED` 및 양의 `retryAfterMs`를 반환한다. 1초 최초 지연, 허용시각 전 retry의 지수 증가와 15분 상한, 60초 rolling expiry, 마지막 invalid 입력 뒤 15분 유휴 정리, 성공 JOIN reset을 검사했다. 유효 invite state errors는 실패로 세지 않고 malformed payload는 lookup을 하지 않는다. raw peer·인증 player bucket 분리와 forwarded 헤더 무시, 틀린 JOIN의 `INVITE_INVALID` 정규화를 확인했다. `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/server/test/socket/invite-rate-limiter.test.ts apps/server/test/socket/gateway.test.ts` **24/24**, `pnpm --filter @bang/server check`, 격리 실행 `pnpm --filter @bang/server test:runtime` **4/4** 루트 재실행 통과. 한 차례 병렬 실행에서 runtime suite의 START_MATCH setup phase가 예상 `play` 대신 `draw`로 나와 3/4였으나, 이후 격리 실행은 4/4였다. D17 integrated acceptance는 T60에서 실행한다.

#### T95 — 완료 결과에서 재대기실 UI 연결

- 상태: DONE
- 의존: T75, T90, T92 (모두 DONE)
- 파일 소유: `apps/web/src/app/pages.tsx`, `apps/web/src/app/routes.test.mjs`, `apps/web/src/features/status/StatusPanel.tsx`, `apps/web/src/features/status/status.test.mjs`, `apps/web/src/features/status/status.css`
- 입력: `02_PRODUCT_UX.md` §3–4; `04_PROTOCOL.md` §3.2 `RETURN_TO_LOBBY`; `06_ACCEPTANCE_TESTS.md` D19; T75 page/router composition; T90 command 계약; T92 owner-only server lifecycle + RoomView sync
- 범위: 서버가 최신 매치를 `completed`로 투영하고 해당 viewer가 방장일 때 결과 화면에 재대기실 버튼을 제공한다. 현재 RoomView version으로 새 commandId의 `RETURN_TO_LOBBY`를 보내고 ACK 결과를 확인한 뒤 room sync를 요청한다. 성공 sync가 `waiting`/`activeMatchId:null`을 반환하면 기존 라우트 계산이 같은 방 lobby URL로 전환한다. 비방장 및 완료 전에는 명령 버튼을 노출하지 않는다.
- 제외: 서버/계약 변경, 매치 결과 또는 match snapshot 수정, 새 매치 자동 시작, 강제 재대기실 전환, T60 E2E 산출물, 배포
- 산출물: 방장 전용 결과→재대기실 action, pending/error 안내, route/component regression tests
- 수락 기준 및 루트 재검증: 완료된 MatchSnapshot과 같은 `activeMatchId`를 가진 `in_game` RoomView 및 일치하는 owner/viewer ID일 때만 복귀 버튼을 표시한다. 비방장/불일치 projection과 `waiting`/`paused`/`completed`/`closed` room에는 표시하지 않는다. exact empty `RETURN_TO_LOBBY` command를 최신 room version과 새 command ID로 1회 발행하고, RoomView ACK와 더 높은 버전의 `waiting`/`activeMatchId:null` sync를 확인한다. 단일 실행 가드, 두 번째 클릭 차단, 재시도, rejected ACK/transport error 안내와 결과 유지 테스트를 확인했다. 루트 재실행: `node --experimental-strip-types --test apps/web/src/features/status/status.test.mjs apps/web/src/app/routes.test.mjs` **22/22 통과**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. 변경은 소유된 5개 파일에 한정했다. 실제 4P/7P browser result/re-lobby는 T60에서 검증한다.

#### T96 — 완료 매치의 실제 방 상태에 맞춘 재대기실 버튼 게이트

- 상태: DONE
- 의존: T75, T90, T92, T95 (모두 DONE이어야 배정 가능)
- 파일 소유: `apps/web/src/features/status/StatusPanel.tsx`, `apps/web/src/features/status/status.test.mjs`, `apps/web/src/app/routes.test.mjs`
- 입력: `04_PROTOCOL.md` §4.1 RoomView lifecycle; `06_ACCEPTANCE_TESTS.md` D19; T92 `returnToLobby`의 `in_game` room + completed latest match gate; T95 결과 action
- 범위: 정상 완료 시 서버가 RoomView `status: in_game`과 completed MatchSnapshot을 함께 투영한다는 T92 구현 사실에 맞춰 owner result action visibility를 고친다. latest match 완료·같은 activeMatchId·viewer owner/ID 정합성 조건을 유지하면서 `in_game` RoomView에서만 표시하고, exact command/ACK/sync 흐름은 기존 구현을 보존한다.
- 제외: 서버/공용 계약 변경, room/match status transition 변경, 게임 규칙, 자동 시작/강제 이동, T60 E2E 파일, 배포
- 산출물: 서버 lifecycle과 일치하는 결과 UI 게이트 및 회귀 테스트
- 수락 기준: MatchSnapshot `completed`, RoomView `in_game`, `activeMatchId` 일치와 owner/viewer ID 일치가 모두 true이면 방장에게만 복귀 버튼이 표시된다. non-owner, non-completed match, 서로 다른 match ID, waiting/paused/completed/closed room, viewer/owner ID 불일치 projection에서는 버튼이 없다. 기존 exact empty `RETURN_TO_LOBBY`, 최신 version/new commandId, ACK 후 새 waiting/`activeMatchId:null` sync, double-click, error/retry 동작이 회귀 없이 유지된다. status 및 routes component tests, web check/build 통과. T60은 실제 4P/7P browser flow로 결과→lobby를 다시 검증한다.
- 수락 기준 및 루트 재검증: 완료 매치·일치하는 `activeMatchId`·owner/viewer ID가 일치하는 `in_game` RoomView에서만 action을 표시하고, 비방장/미완료/ID 불일치/다른 room status를 숨긴다. 기존 exact command, ACK+newer lobby sync, single-flight, 오류/재시도 동작을 보존했다. `node --experimental-strip-types --test apps/web/src/features/status/status.test.mjs apps/web/src/app/routes.test.mjs` **22/22 통과**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 루트 재실행 통과. 수정 경로는 계획된 3개 UI/test 파일뿐이다. 실제 D19 4P/7P UI flow는 T60에 남긴다.
- 진행: T60 실제 4P 결과에서 버튼 미노출을 재현했다. T92 storage는 match 완료 때 방을 `in_game`에 유지하고 `returnToLobby`도 그 상태를 받는다. 이 서버 lifecycle과 맞지 않았던 T95 gate를 수정했다.

#### T97 — 연결 중단 시 현재 판 보존 안내

- 상태: DONE
- 의존: T57, T58, T59, T75 (모두 DONE이어야 배정 가능)
- 파일 소유: `apps/web/src/app/pages.tsx`, `apps/web/src/app/routes.test.mjs`
- 입력: `02_PRODUCT_UX.md` §4.15, `04_PROTOCOL.md` 연결 상태 및 재접속 계약, `06_ACCEPTANCE_TESTS.md` D12, 완료된 T57/T58/T59/T75 산출물
- 범위: 방/게임 화면에서 transport 연결이 끊긴 상태를 명확히 보여 주고, 재접속하면 서버가 저장한 현재 입력 단계와 viewer projection을 다시 동기화한다. UX 문서의 상태 문구 `연결 끊김 · 재접속 시 현재 판을 복구합니다`를 기준으로 한다.
- 제외: 공유 계약/서버/엔진 변경, 새 게임 규칙, 자동 타이머/자동 패스/자동 탈락, 게임 진행 상태를 로컬에서 변경, T60 E2E 파일, 배포
- 산출물: 연결 중단과 재접속 안내를 포함하는 방 화면 및 route regression tests
- 수락 기준: 방의 transport가 `disconnected` 또는 같은 연결 오류를 나타낼 때 명시적이고 접근 가능한 상태 안내가 보인다. 기존 room/game 화면과 pending 선택은 서버 sync가 성공하기 전까지 추측해 진행하거나 자동 완료하지 않는다. `connected` 상태로 authoritative sync가 끝나면 안내가 사라지고 화면은 서버 projection을 따른다. 기존 guest/session 오류와 sync 거절 동작을 바꾸지 않는다. route component tests, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`를 실행하고 결과를 기록한다.

- 루트 재검증: `node --experimental-strip-types --test apps/web/src/app/routes.test.mjs` **15/15 통과**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. 접근 가능한 연결 중단 문구, initial connecting 문구 구분, room→activeMatch 순차 sync ACK, sync 성공 전 입력 잠금 및 connected+CONNECTION 오류 1회 복구를 확인했다. T60 D12 실제 브라우저 재검증 전까지 acceptance D12는 NOT RUN으로 유지한다.

#### T98 — 카드 상세 확대 및 키보드 닫기

- 상태: DONE
- 의존: T54, T55, T56, T59, T75 (모두 DONE이어야 배정 가능)
- 파일 소유: `apps/web/src/features/cards/CardFaces.tsx`, `apps/web/src/features/cards/cards.css`, `apps/web/src/features/cards/card-zoom.test.mjs`, `apps/web/src/features/actions/ActionsPanel.tsx`, `apps/web/src/features/actions/actions.css`, `apps/web/src/features/reactions/ReactionPrompt.tsx`, `apps/web/src/features/reactions/reactions.css`
- 입력: `02_PRODUCT_UX.md` UX-007/UX-022/UX-024, §4.6; `06_ACCEPTANCE_TESTS.md` D13; 완료된 T54/T55/T56/T59/T75 산출물
- 범위: 손패 행동 및 서버가 허용한 응답 카드에서 선택과 분리된 접근 가능한 상세 열기를 제공한다. 상세에는 기존에 보이는 카드의 한국어 이름, 권위 rank/suit, 기존 규칙 문구를 표시한다. 키보드와 터치로 열고 닫으며 Escape 닫기와 포커스 복귀를 지원한다. 기존 선택/명령 입력 및 비공개 projection 경계를 보존한다.
- 제외: 서버/공용 계약/엔진 변경, 새 규칙 또는 카드 효과 문구 추측, 상대의 비공개 카드 상세 노출, 자동 시간 제한, `apps/web/e2e/**` 및 T60 수락 기록, 배포
- 산출물: 손패/응답 카드 상세 dialog, 한국어 텍스트 정보와 키보드/포커스 회귀 테스트
- 수락 기준: 기존 server-issued card projection에 포함된 카드만 확대 가능하고 인스턴스의 rank/suit와 카드명이 일치한다. dialog는 접근 가능한 이름을 가지며 닫기 버튼과 Escape로 닫히고 trigger로 포커스를 돌려보낸다. 확대 버튼 조작이 기존 카드 선택·응답·제출 버튼을 대신하거나 중첩하지 않는다. 단위 테스트, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`를 실행한다. T60은 별도 browser 증거로 D13의 모바일/키보드 전체 시나리오를 판정한다.
- 완료 및 루트 재검증: 기존 server-projected 손패/허용 응답·정리 후보에 선택과 분리된 카드 상세 dialog를 연결했다. 한국어 카드명, projected rank/suit, `01_RULES.md` 기반 효과 설명과 서버 허용 대상/응답을 제공하고 Escape/닫기 및 trigger focus return을 지원한다. 키보드 trigger는 기존 선택·응답 버튼의 형제 요소이며 상대 손패 상세를 추가 투영하지 않는다. 루트 재실행 `node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test apps/web/src/features/cards/card-zoom.test.mjs apps/web/src/features/actions/actions.test.mjs apps/web/src/features/reactions/reactions.test.mjs` **19/19**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build` 통과. 브라우저에서는 360×800 iframe에서 카드 상세를 키보드로 열고 Escape로 닫은 뒤 trigger로 포커스가 돌아옴을 확인했다. 이 결과만으로 T60의 D13 전체(대상·방어·구제·순서선택, 모바일/데스크톱)를 PASS 처리하지 않는다.

## 차단 질문 등록 규칙

규칙 질문이 생기면 오케스트레이터가 이 실행 계획에 이어 붙이는 차단 질문 등록부에 다음 필드로 기록한다: 질문 ID, 관련 01_RULES.md 절/원문 출처, 막힌 작업 ID, 선택 가능한 판정, 루트 규칙 담당자의 결정, 갱신된 문서 버전. 에이전트는 자체 판단으로 질문을 종결하지 않는다. 질문과 무관한 작업은 계속할 수 있다.

| 질문 ID | 관련 규칙/출처 | 막힌 작업 | 필요한 결정 | 상태/결정 문서 |
|---|---|---|---|---|

## 완료 정의

한 작업은 구현 파일이 있다는 이유만으로 DONE이 되지 않는다. 명시된 산출물 경로만 바뀌었는지 검토하고, 각 수락 기준을 재현할 테스트/검토 증거를 작업 결과에 남기고, 파일 소유권 및 입력 문서와의 일치 여부를 게이트 담당자가 확인해야 한다. 이번 문서는 작업을 계획할 뿐 어떤 작업도 완료 상태로 표시하지 않는다.

## Sites 전용 공개 배포 이식 작업

이 섹션은 기존 Node/Socket.IO/PostgreSQL 로컬 개발 경로를 유지하면서 공개 실행 경로를 Codex Sites Worker + D1 + same-origin HTTP/SSE로 완전히 이식한다. 공용 protocol DTO의 소유자는 계속 루트(T02 계약 관리)다. Sites transport는 04_PROTOCOL §12에서 정한 기존 DTO mapping만 사용한다. Sites 작업 전용 검증은 06_ACCEPTANCE_TESTS의 S01–S09이며 기존 97개 AT 집계와 합산하지 않는다.

| 작업 | 목적 | 파일 소유권 | 상태 |
|---|---|---|---|
| T99 | Sites hosting/runtime 및 HTTP/SSE wire mapping 결정 고정 | outputs/development-plan/00_README.md, 03_ARCHITECTURE.md, 04_PROTOCOL.md, 05_EXECUTION_PLAN.md, 06_ACCEPTANCE_TESTS.md, 07_READINESS.md, data/task-index.csv | DONE |
| T100 | Sites Vinext/Worker starter를 모노레포에 생성하고 기존 React 게임 shell/assets를 Sites app route에서 렌더 | apps/site/app/**, apps/site/src/ui/**, apps/site/src/server/index.ts, apps/site/src/server/routes/index.ts, apps/site/public/**, apps/site/.openai/hosting.json, apps/site/.gitignore, apps/site/scripts/**, apps/site/vite.config.ts, apps/site/tsconfig.json, apps/site/package.json | DONE |
| T101 | Root build/workspace와 Codex Sites logical D1 manifest 연결 | package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .gitignore, .openai/hosting.json, apps/site/.openai/hosting.json, apps/site/vite.config.ts, scripts/build-sites.mjs | DONE |
| T102 | SQLite/D1 migration과 CAS/receipt/event/outbox/test adapter repository 구현 | apps/site/src/storage/**, drizzle/**, apps/site/test/storage/**, apps/site/package.json, pnpm-lock.yaml (test dependencies only) | DONE |
| T103 | Worker Web Crypto session/room service 및 guest/create/preview/join/lobby/lifecycle HTTP routes 이식 | apps/site/src/server/auth/**, apps/site/src/server/rooms/**, apps/site/src/server/routes/session.ts, apps/site/src/server/routes/rooms.ts, apps/site/test/server/session-room.test.ts | DONE |
| T108 | 기존 CommandAck/MatchSyncResponse의 strict shared response parser 추가 (root-only contract follow-up) | packages/contracts/src/validation.ts, packages/contracts/test/protocol.test.mjs, packages/test-fixtures/protocol/** | DONE |
| T104 | canonical match handler/runtime, viewer sync와 알림 전용 SSE endpoint를 Worker HTTP에 연결 | apps/site/src/server/matches/**, apps/site/src/server/index.ts, apps/site/src/server/routes/index.ts, apps/site/src/server/routes/matches.ts, apps/site/src/server/routes/sync.ts, apps/site/src/server/routes/notifications.ts, apps/site/test/server/match-sync.test.ts | DONE |
| T105 | 기존 React 경로가 transport abstraction을 쓰도록 Sites HTTP/SSE transport 구현 및 앱 조립 | apps/web/src/transport/**, apps/web/src/app/app-state.tsx, apps/web/test/** | DONE |
| T110 | D1 Drizzle schema/migration metadata, first-request bootstrap, index optimize 준비 (root-only) | package.json, pnpm-lock.yaml, db/schema.ts, drizzle.config.ts, drizzle/**, apps/site/src/storage/**, apps/site/src/server/index.ts, apps/site/test/storage/**, apps/site/test/server/** | DONE |
| T111 | 주요 방 생성/입장/게임 흐름의 WebMCP 도구 및 지원 브라우저 검증 (root-only) | apps/web/src/app/app-state.tsx, apps/web/src/app/webmcp.ts, apps/web/test/webmcp.test.mjs | DONE |
| T106 | Cloudflare-compatible isolated D1 runtime에서 S01–S08과 브라우저 4P/7P 기본 흐름 실행, 결과 기록 | apps/site/e2e/**, apps/site/README.md, outputs/development-plan/06_ACCEPTANCE_TESTS.md, outputs/development-plan/00_README.md, apps/web/e2e/sites-results.json | DONE |
| T107 | 완성한 Site를 한 번 등록하고 source push/version save/public deploy/status 확인 | .openai/hosting.json의 `project_id`, outputs/development-plan/07_READINESS.md, apps/site/README.md | REVIEW |

각 작업은 한 번에 하나만 배정하며, 의존 작업 DONE과 루트 수락 전에는 후속 작업을 시작하지 않는다. 구현 중 공용 contract가 더 필요하면 루트가 DTO/document/parser/fixture 변경을 별도 단독 작업으로 계획해 DONE한 뒤 consumer를 재개한다. Worker에서 Node PostgreSQL/Socket.IO 모듈을 import하지 않는다. 무료 배포는 현재 공식 Workers/D1 Free quota를 적용받고 한도 초과 시 동작 중지 가능성을 사용자에게 알린다.

### Sites 작업 상세 명세

#### T99 — Sites 런타임 및 HTTP/SSE 전송 계약 고정

- 상태: DONE
- 의존: T01, T02
- 파일 소유: `outputs/development-plan/00_README.md`, `03_ARCHITECTURE.md`, `04_PROTOCOL.md`, `05_EXECUTION_PLAN.md`, `06_ACCEPTANCE_TESTS.md`, `07_READINESS.md`, `data/task-index.csv`
- 입력: 사용자의 Sites 전용 이식 선택, 공식 Cloudflare Workers/D1/Streams 문서, 완료 T02/T81/T90/T94 계약
- 범위: Node/Socket.IO/PostgreSQL의 기존 로컬 경로와 Sites Worker/D1/HTTP/SSE 공개 경로를 구분하고, endpoint/body/response mapping, security, quota, D1 atomicity, acceptance gates를 기록한다.
- 제외: 앱/API 코드, shared DTO/parser 변경, Sites 등록/배포
- 산출물: architecture/protocol supplement, S01–S09 gates, T100–T107 소유권·의존 task index
- 수락: existing 97-case tally와 D06/D18 NOT RUN은 유지한다. Sites route는 기존 DTO/parser를 재사용한다. 공식 quota에 링크하고 D1 compare-and-swap, receipt replay, projection security와 SSE cursor 접근 경계를 정의한다. Root review: docs and task index inspected; no code/test status changed.

#### T100 — Sites Vinext/Worker UI starter

- 상태: DONE
- 의존: T99, T01, T50, T75
- 파일 소유: `apps/site/app/**`, `apps/site/src/ui/**`, `apps/site/src/server/index.ts`, `apps/site/src/server/routes/index.ts` (T100 완료 뒤 `routes/index.ts` 소유권은 T104로 이전), `apps/site/public/**`, `apps/site/.openai/hosting.json` (T100 완료 뒤 D1 binding 값은 T101 소유), `apps/site/.gitignore`, `apps/site/scripts/**`, `apps/site/vite.config.ts` (T100 완료 뒤 local D1 database name은 T101 소유), `apps/site/tsconfig.json`, `apps/site/package.json`
- 입력: `03_ARCHITECTURE.md §12`, `04_PROTOCOL.md §12`, `06_ACCEPTANCE_TESTS.md S01`, T50/T54/T75 UI·assets
- 범위: portable Sites Vinext starter를 `apps/site` 아래 만들고, 기존 Korean game UI를 모든 직접 URL/catch-all 경로에서 표시하며 카드/역할/인물 asset URL을 살린다. Sites 전용 favicon과 사용자 화면용 metadata를 설정한다. backend API router는 처음에는 안전한 404 stub만 둔다.
- 제외: root package/lock/hosting manifest, database/schema, HTTP business routes, web transport 변경, hosting/project registration
- 산출물: 첫 preview 가능한 Site client shell과 Cloudflare Worker default fetch entrypoint stub
- 수락: `apps/site` `npm run build` PASS (Vinext client/server/RSC/SSR, `/` 및 `/:path+` route); `npx tsc --noEmit -p tsconfig.json` PASS; Wrangler preview `/`, `/rooms/t100-smoke`, `/favicon.svg` 200, `/assets/cards/playing/01_bang.png` 200 `image/png` 116,634 bytes, `/api/t100-stub` 404 JSON; Codex in-app browser에서 홈의 게임 UI 및 `/rooms/t100-smoke` 직접 진입 UI hydrate 확인. 두 경로 모두 starter placeholder 없음. Worker output contract 및 root dist wiring은 T101에서 마무리한다.

#### T101 — Root Sites build와 D1 manifest 통합

- 상태: DONE
- 의존: T99, T100
- 파일 소유: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore`, `.openai/hosting.json`, `apps/site/.openai/hosting.json`, `apps/site/vite.config.ts`, `scripts/build-sites.mjs`
- 입력: `03_ARCHITECTURE.md §12`, Sites hosting skill/portable build instructions, 완료 T100 build output
- 범위: workspace install/build에서 starter를 재현 가능하게 연결하고 Site source를 root `dist`에 Cloudflare Worker entrypoint `dist/server/index.js`와 정적 assets로 만든다. root 및 app-local hosting manifest에 동일한 supported logical D1 binding `DB`를 선언하고 root `dist/.openai/hosting.json`에 Site packaging metadata를 포함한다. pnpm install 정책에서 esbuild, unrs-resolver, workerd와 필요한 이미지 런타임의 공식 package build script 허용 여부를 명시한다.
- 제외: apps/site UI/API/storage source, Site project ID/credential, deployment
- 산출물: frozen-lockfile root build, Site packager가 읽는 hosting manifest 및 dist shape
- 수락: `pnpm install --frozen-lockfile` PASS (required `allowBuilds` scripts enabled), `pnpm build` PASS. `dist/server/index.js` default fetch export, `dist/client` 42 card assets/favicon, matching root/app D1 `DB` binding and `dist/.openai/hosting.json` exist; root Wrangler preview serves `/` and `/rooms/t101-smoke` as HTML 200, representative Korean card PNG as 200, and API placeholder as JSON 404. Root Worker entry imports neither `pg` nor Socket.IO. T105 later made the production client tree-shake Socket.IO; S01 remains NOT RUN until T106 exercises the complete S01 gate. Root manifest contains no credential or project_id (T107 only). Root checks package and archive paths.

#### T102 — D1 migration과 원자 repository

- 상태: DONE
- 의존: T99, T100, T101
- 파일 소유: `apps/site/src/storage/**`, root `drizzle/**` (Sites packager stages these as `.openai/drizzle`), `apps/site/test/storage/**`, `apps/site/package.json`, `pnpm-lock.yaml` (test runner dependencies only; transferred from completed T100/T101 ownership for reproducible D1 tests)
- 입력: `03_ARCHITECTURE.md §§3,12`, `04_PROTOCOL.md §§4,6,12`, Node repository/lifecycle records, official D1 batch API
- 범위: Sites packager가 `.openai/drizzle`로 전달하는 root `drizzle/**` 아래의 D1 SQL migrations, typed row adapters, JSON/state schema validation, commit guard/CAS, receipts, events/outbox, guest/room/match reads/writes와 invite limiter persistence를 구현한다. 별도 isolated D1 test DB로 검증하고, 테스트 러너의 직접 의존성을 선언해 clean frozen-lockfile install에서도 재현 가능하게 한다. Existing T91/T92 lifecycle must be preserved: `START_MATCH` supports first start from a ready waiting room and direct restart only after that room's latest match is completed, atomically preserving prior match history and the locked roster.
- 제외: HTTP handlers, UI/transport, Node PostgreSQL server 변경, game rule/domain behavior, user/site deployment
- 산출물: additive D1 migration, repository interfaces/implementation, transaction regression tests, declared D1 test dependencies
- 수락 및 루트 검토: initial isolated Miniflare D1 suite **15/15** plus completed-match restart and full engine initialization coverage; root standalone run of `node --import tsx --test test/storage/d1-storage.test.ts` from `apps/site` **20/20 PASS**, and `pnpm exec tsc --noEmit -p apps/site/tsconfig.json` **PASS**. The D1 guard accepts the exact room player set on valid state seats, including Sheriff-first cyclic rotation and the Node T91 initialized snapshot at version 5/eventSeq 0 after turn-start/draw. Tests exercise that snapshot through first start, completion, direct completed-only restart, prior match/event/roster preservation, deterministic latest ordering, receipt/outbox replay, stale/in-progress no-write, concurrent single-writer and rollback. One earlier run concurrent with TSC produced two transient Miniflare `fetch failed` errors (18/20); the isolated standalone rerun passed 20/20. This repository suite is not Sites S01–S09 or existing 97-case evidence; existing **95/97**, D06/D18 NOT RUN stay unchanged. Remote Cloudflare D1 and integrated Site build remain NOT RUN. `git diff --check` is unavailable because this workspace has no Git metadata.

#### T103 — D1 세션·방 API

- 상태: DONE
- 의존: T99, T102
- 파일 소유: `apps/site/src/server/auth/**`, `apps/site/src/server/rooms/**`, `apps/site/src/server/routes/session.ts`, `apps/site/src/server/routes/rooms.ts`, `apps/site/test/server/session-room.test.ts`
- 입력: `01_RULES.md R02/R03/R30`, `02_PRODUCT_UX.md §4.1`, `04_PROTOCOL.md §§2–4/7/9/12`, T81/T90/T91/T92/T94 완료 결과
- 범위: Web Crypto guest secret/hash, T81 cookie create/restore, assigned seat recovery, T94-equivalent D1-shared invite limit, preview/create/join/ready/start/close/restart/return-to-lobby command routes. Start/restart engine initialization consumes Worker crypto RNG and persists its fresh state once.
- 제외: match command engine, match projection, SSE, browser API transport, contract/game-rule changes, arbitrary seat mutation
- 산출물: authenticated D1 session/lobby service and route handlers with canonical protocol bodies
- 수락 및 루트 검토: standalone Miniflare `node --import tsx --test test/server/session-room.test.ts` **6/6 PASS**; `pnpm exec tsc --noEmit -p apps/site/tsconfig.json` **PASS**. 별도 T102 D1 storage 회귀도 순차 재실행 **20/20 PASS**. 테스트는 cookie/session secret hash·expiry와 assigned-seat restore, invite code/secret redaction·hashed IP+guest limiter·5회 rolling window/backoff/JOIN reset, JSON content type·8 KiB·same-origin·strict parser·path ID 경계, room owner/ready/version/lifecycle guards, concurrent JOIN/START_MATCH single-writer, full engine initialization snapshot, same-command replay/hash conflict, completed-only direct restart/history preservation, RETURN_TO_LOBBY readiness reset을 확인한다. SET_RULESET 비회원 거절과 KICK_MEMBER owner guard는 Node 경로 응답과 일치한다. 수정은 T103 소유 경로에 한정했다. 이 단위 검증은 S01–S09나 기존 97개 acceptance를 통과 처리하지 않는다. S01–S08 통합/브라우저 검증은 T106, route mounting/build는 T104 이후, Remote D1/공개 배포는 미실행이며 `git diff --check`는 Git metadata 부재로 실행 불가다. 기존 **95/97**, D06/D18 NOT RUN은 유지한다.

#### T108 — 기존 응답 DTO strict parser 보완

- 상태: DONE
- 의존: T02, T103
- 파일 소유: 루트 단독 작업 — `packages/contracts/src/validation.ts`, `packages/contracts/test/protocol.test.mjs`, `packages/test-fixtures/protocol/**`
- 입력: `04_PROTOCOL.md`의 `CommandAck`/`MatchSyncResponse` 계약, `packages/contracts/src/protocol.ts` 기존 타입, 기존 viewer/action/pending/outcome 파서, Node browser transport의 현재 응답 shape 검증
- 범위: 기존 필드만 사용해 exact-key `parseCommandAck`와 `parseMatchSyncResponse`를 추가하고 valid/invalid protocol fixtures와 회귀 테스트를 둔다. MatchSyncResponse parser는 nested viewer snapshot, 공개 player/card, own-private hand shape, existing pending/legal-action/outcome parsers, event timestamp/order/cursor bounds를 확인한다.
- 제외: wire DTO 필드 변경, 게임 규칙, server/browser consumer 수정, 97-case/Sites gate 상태 변경
- 산출물: canonical shared response parsers와 fixtures
- 수락: accepted/rejected ACK 및 full match sync valid fixtures가 통과하고, 누락/추가 키, malformed nested projection, invalid event order/cursor가 거부된다. `pnpm --filter @bang/contracts check`와 `pnpm --filter @bang/contracts test` 통과. 기존 95/97 및 D06/D18 NOT RUN 유지.
- 루트 검토: contracts TypeScript check 통과, 계약 테스트 **15/15 PASS**. ACK shape와 viewer-scoped match snapshot/event cursor를 검사하고 top-level/nested 추가 필드, 누락 필드, malformed projection, 역순·범위 초과 cursor fixture 거절을 확인했다. DTO/type 및 기존 97-case acceptance 기록은 변경하지 않았다.

#### T109 — 매치 복구 거절 응답 계약 보완

- 상태: DONE
- 의존: T02, T108
- 파일 소유: 루트 단독 작업 — `packages/contracts/src/protocol.ts`, `packages/contracts/src/validation.ts`, `packages/contracts/test/protocol.test.mjs`, `packages/test-fixtures/protocol/**`, `outputs/development-plan/04_PROTOCOL.md`
- 입력: `04_PROTOCOL.md` §6.3의 미지원 schema/ruleset `RECOVERY_REQUIRED` 응답, 기존 `SyncRejectedResponse` DTO/parser, T104 root review
- 범위: 기존 sync rejection body shape를 유지하면서 `RECOVERY_REQUIRED`를 공유 strict parser/type에 추가하고 계약 fixture/test 및 HTTP mapping 설명을 맞춘다. 해당 match sync 응답은 인증된 match member의 unsupported stored match만 알려야 한다.
- 제외: 새 response 필드/게임 규칙, Node 경로 변경, 사이트 route 구현, 97-case/Sites gate 결과 변경
- 산출물: recovery-required sync rejection type/value/parser fixture와 documented semantics
- 수락: recovery code의 valid fixture를 strict parser가 받고 extra field·resource ID 누설 fixture를 계속 거부한다. contracts check/test 통과, 기존 `BAD_REQUEST`/`NOT_FOUND_OR_FORBIDDEN` behavior 유지.
- 진행: T104 root review에서 repository의 `supportedSchemaVersion` 인수가 매치 handler에 전달되지 않는 점과 sync rejection union이 `RECOVERY_REQUIRED`를 허용하지 않는 점을 발견했다. route consumer는 이 계약 작업이 DONE된 뒤 재개한다.
- 루트 검토: `pnpm --filter @bang/contracts check` 및 `pnpm --filter @bang/contracts test` **15/15 PASS**. recovery response fixture가 허용되고 extra resource ID 및 secret/error fields는 계속 거절된다. 기존 rejection cases와 95/97, D06/D18 기록은 바뀌지 않았다.

#### T104 — D1 매치 명령·sync·SSE

- 상태: DONE
- 의존: T99, T102, T103, T108, T109
- 파일 소유: `apps/site/src/server/matches/**`, `apps/site/src/server/index.ts` (Worker binding is passed to the mounted API route; transferred from completed T100 integration), `apps/site/src/server/routes/index.ts`, `apps/site/src/server/routes/matches.ts`, `apps/site/src/server/routes/sync.ts`, `apps/site/src/server/routes/notifications.ts`, `apps/site/test/server/match-sync.test.ts`
- 입력: `01_RULES.md`, `03_ARCHITECTURE.md §12`, `04_PROTOCOL.md §§3–6/12`, T02/T72/T83/T84 DTOs, T41/T66/T67/T69/T85/T88 engine/runtime outputs
- 범위: rule engine/runtime를 Site request handler로 연결하고 single batch를 통해 accepted command의 state/event/receipt/outbox를 commit한다. 기존 sync projection을 인증 D1 records에 연결하고 outbox D1 cursor SSE stream을 만든다.
- 제외: 새 rule/card behavior, canonical DTO 변경, UI event state, Node Socket transport, public deployment
- 산출물: Site authoritative match route, private room/match sync and no-private-payload SSE feed
- 수락: engine transitions/continuations, expectedVersion race, receipt replay, stale/no-write and event cursor pass. Sync strict parser accepts response; unauthorized viewers receive generic denial. SSE cursor cannot bypass membership and data allowlist excludes private content. Stream cancel/reconnect and hidden tab policy pass local Worker tests.
- 루트 검토: `node --import tsx --test test/server/match-sync.test.ts` **6/6 PASS**, `pnpm exec tsc --noEmit -p apps/site/tsconfig.json` **PASS**, `pnpm run sites:build` **PASS**. 회귀는 엔진 전이와 continuation의 원자 commit/receipt/outbox, 동시 D1 CAS single-writer, strict sync와 viewer-private projection, unsupported schema/ruleset의 member-only recovery/no-write, 미지원 snapshot 전환 뒤에도 기존 성공 receipt replay 우선 및 비회원 generic denial, SSE membership/cursor allowlist/cancel/reconnect를 확인했다. Sites build는 Worker entry, client assets, D1 `DB` binding을 staging했다. 이 focused suite는 S01–S09나 기존 97개 acceptance를 통과 처리하지 않으며 기존 **95/97**, D06/D18 NOT RUN은 유지한다. `git diff --check`는 이 workspace에 Git metadata가 없어 실행할 수 없다.

#### T105 — Sites HTTP/SSE browser transport

- 상태: DONE
- 의존: T99, T100, T103, T104
- 파일 소유: `apps/web/src/transport/**`, `apps/web/src/app/app-state.tsx`, `apps/web/test/**`
- 입력: `02_PRODUCT_UX.md`, `04_PROTOCOL.md §12`, T58 existing transport, T75 app route integration, `06_ACCEPTANCE_TESTS.md S07`
- 범위: Browser HTTP same-origin requests with cookies, exact response parser, idempotent pending command retry, command ACK immediate sync, membership SSE invalidation, reconnect cursor and visibility lifecycle. Select Sites transport by explicit build/runtime adapter while Node Vite continues using Socket.IO transport.
- 제외: protocols/contracts/engine/server rules, `apps/web/e2e/**` owned by T60, high-frequency HTTP polling, frontend-local authoritative state
- 산출물: `SitesGameTransport` implementing the existing consumer surface and tests for browser transport behavior
- 수락: all API bodies/responses use existing strict parsers. Failed requests retain the same commandId/payload on retry. SSE sends only hints then requests current sync; hidden tab closes and visible reconnect fetches authoritative state. `pnpm --filter @bang/web check/build` and Sites build pass.
- 루트 검토: Sites/Socket transport tests **11/11 PASS**, 기존 앱 route 회귀 **15/15 PASS**, `pnpm --filter @bang/web check`, `pnpm --filter @bang/web build`, `pnpm run sites:build` 모두 **PASS**. Same-payload retry, strict response validation, room HTTP mapping, SSE hint 후 authoritative sync, hidden stream close/visible cursor reconnect를 확인했다. `apps/site/dist/client`, `apps/site/dist/server`, `apps/web/dist`에 Socket.IO 및 `/socket.io` 문자열이 없는 것도 검색했다. 기존 **95/97**, D06/D18 NOT RUN은 그대로 유지한다. Git metadata가 없어 `git diff --check`는 실행하지 못했다.

#### T110 — D1 schema, generated migration and runtime bootstrap

- 상태: DONE
- 의존: T101, T102, T104
- 파일 소유: 루트 단독 후속 작업 — `package.json`, `pnpm-lock.yaml`, `db/schema.ts`, `drizzle.config.ts`, `drizzle/**`, `apps/site/src/storage/**`, `apps/site/src/server/index.ts`, `apps/site/test/storage/**`, `apps/site/test/server/**`
- 입력: Sites building/hosting skill의 D1/Drizzle 요구사항, T102 D1 schema/migrator, `apps/site/src/storage/migrations.ts`, `03_ARCHITECTURE.md §12`
- 범위: 현재 D1 도메인 표와 인덱스를 Drizzle `sqliteTable` schema로 표현하고 generated migration + `drizzle/meta` snapshot/journal을 둔다. fresh Sites DB에서 API가 안전하게 초기화되도록 Worker 첫 API 요청 경로에 migration bootstrap을 연결하고, 같은 Worker isolate의 migration은 한 번만 실행되도록 한다. 초기 migration의 인덱스 생성 뒤 `PRAGMA optimize`를 실행하고 동시 첫 요청/재시도에 안전하게 한다.
- 제외: 기존 canonical DTO/game rules 변경, 공개 배포, 사용자 데이터 seeding
- 산출물: source schema, generated D1 migration metadata, Worker-compatible idempotent migration bootstrap
- 수락: schema는 기존 11개 D1 domain table, FK/check/index 의미와 일치한다. isolated D1은 migration 1회/동시 호출 모두 성공하고 optimize 실행을 확인하며 기존 T102 storage/server 회귀가 통과한다. `drizzle-kit check` 또는 동등한 journal/schema consistency check, Site tsc/build가 통과한다. 아직 배포 DB에 적용된 migration은 없다.
- 루트 검토: Drizzle source schema는 11개 도메인 표·FK/check·14개 명명 인덱스를 표현하며 `drizzle/0000_long_iron_man.sql` 및 `drizzle/meta` journal/snapshot은 `drizzle-kit generate` 산출물이다. `pnpm run sites:db:check`, Sites TypeScript check/build PASS. 새 migration runner는 Drizzle statement breakpoint를 D1 문장으로 분리하고 CREATE/ledger를 멱등 적용하며 동시 cold bootstrap을 허용한다. Migration test 3/3, T102 D1 repository 20/20, T103 session-room 6/6, T104 match-sync 6/6 PASS. 로컬 Site Worker `GET /api/guest-sessions`는 fresh D1 첫 API 요청에서 204를 반환했다. 새 DB에 적용된 배포 migration은 없다.

#### T111 — WebMCP primary journey tools

- 상태: DONE
- 의존: T100, T103, T104, T105
- 파일 소유: 루트 단독 후속 작업 — `apps/web/src/app/app-state.tsx`, `apps/web/src/app/webmcp.ts`, `apps/web/test/webmcp.test.mjs`
- 입력: Sites building skill `references/webmcp.md`, `02_PRODUCT_UX.md`, `04_PROTOCOL.md §12`, T103/T104/T105 UI transport
- 범위: 지원 브라우저의 imperative `document.modelContext.registerTool`에 보이는 앱 행동과 같은 게스트 생성, 방 생성/초대 입장, 현재 viewer 상태 조회, 게임 명령 실행 도구를 등록한다. 입력은 exact-key/유효값을 검사하고 게임 명령은 기존 strict parser와 Sites transport를 사용한다. 등록은 client-side effect, `AbortSignal` cleanup, unsupported/failure graceful handling을 제공한다.
- 제외: 상상한 게임 규칙/게임 능력, bypassing server validation, user input 없이 secret/private opponent data 반환
- 산출물: page-scoped WebMCP tools and registration/validation tests
- 수락: 도구 이름/schema/annotations, 등록 정리, 잘못된 입력 거부와 실제 UI state/transport 변경을 테스트한다. 지원 WebMCP context가 있으면 valid action과 invalid failure를 그 context에서 직접 실행하고 state read-back 증거를 남긴다. 실행 가능한 context가 없으면 NOT RUN을 기록하고 이유를 남긴다.
- 루트 검토: `bang.get_current_state`, guest create, room create/join, ready/start, current match action의 7개 imperatively registered tool을 추가했다. 입력은 exact-key와 유효값을 검사하고 기존 `make*Command` 및 `parseRoomCommand`/`parseMatchCommand` 뒤 현재 서버 projection 선택지만 전송한다. match snapshot은 현재 viewer projection과 본인에게 허용된 response/discard 후보만 포함한다. effect cleanup은 registration `AbortSignal`을 abort한다. WebMCP tests **6/6 PASS**, web check/build PASS. 실제 tool discovery/execute는 **NOT RUN**: 확인 가능한 Codex in-app browser에는 WebMCP `ModelContext` 도구 발견·실행용 agent interface가 제공되지 않아 이 브라우저에서 native valid/invalid invocation 및 read-back을 실행할 수 없었다. Mock registration/input 검사는 완료했고 지원되지 않는 API가 UI를 막지 않는 것도 확인했다.

#### T106 — Sites runtime acceptance and evidence

- 상태: DONE
- 의존: T101, T102, T103, T104, T105, T110, T111
- 파일 소유: `apps/site/e2e/**`, `apps/site/README.md`, `apps/web/e2e/sites-results.json`, `outputs/development-plan/00_README.md`, `outputs/development-plan/06_ACCEPTANCE_TESTS.md`
- 입력: `06_ACCEPTANCE_TESTS.md S01–S08`, `01_RULES.md`, `02_PRODUCT_UX.md`, current T60 baseline
- 범위: worker-compatible local runtime plus isolated D1 tests; exercise new Site HTTP API, privacy, 4P and 7P browser start/play/result/reconnect/return flows and fault/restart boundaries.
- 제외: public sharing access changes, credentials and invite seed, false PASS for incomplete run, editing `apps/web/e2e/acceptance-results.json` or existing T60 owned runner evidence
- 산출물: reproducible Sites-specific runner/result JSON and exact gate status evidence
- 수락: each S01–S08 assertion has command/fixture/run output or browser evidence; unrun criteria remain NOT RUN; existing 97-case totals and D06/D18 are not updated by this supplemental suite.
- 루트 검토: `node e2e/run-sites-acceptance.mjs --base-url=http://127.0.0.1:8799`를 `apps/site`에서 실행. Site Miniflare **35/35**, web transport/routes **20/20**, Site typecheck/build, smoke syntax, local Wrangler start, HTTP smoke 및 process-tree stop 모두 PASS. 결과 JSON은 **29 PASS / 0 FAIL / 6 NOT RUN**(35 assertions), gate **2 PASS / 6 PARTIAL / 0 FAIL**. S01/S04 PASS; 4P·7P HTTP create/join/ready/start/sync/legal END_TURN/replay/SSE reconnect/restore 각각 확인. 루트 CUA는 한 browser context/profile의 `/`·`/rooms/new` route만 점검. full UI 4P/7P, 독립 browser context, Worker restart recovery, Worker/log secret scans 등은 NOT RUN으로 보존. 95/97 baseline 및 D06/D18 NOT RUN 불변. Worker 종료와 8799 포트 해제를 확인했다.

#### T107 — Codex Sites public save/deploy

- 상태: REVIEW
- 의존: T99, T101, T102, T103, T104, T105, T106, T110, T111
- 파일 소유: `.openai/hosting.json` `project_id` only, `outputs/development-plan/07_READINESS.md`, `apps/site/README.md`
- 입력: user-authorized free/public Sites distribution, Sites hosting skill, completed S01–S08 evidence
- 범위: create one Site, source-push exact finished workspace, save matching source/archive version, set public access, deploy and check final deployment status/URL. Never place Site credential in source or logs.
- 제외: any external provider, writing user production data, deployment before T106 review
- 산출물: one succeeded public deployment and URL plus evidence in readiness/readme
- 수락: native Sites result reports success with deployment URL and access public; visit-ready URL corresponds to exact checked source. State Workers/D1 free limits and report any S09 subconditions that could not be exercised live.
- 루트 검토: source SHA `99c2c41ad639295fd83601995c4498a0516e46e7`를 push하고 같은 SHA에서 Sites version 1 archive를 저장했다. `public` access를 확인했으며 deployment `appgdep_6abace1e94f48191b386cc77d1f97309`가 **succeeded**로 끝났고 URL은 `https://bang-online-ko.rkdwoals159.chatgpt.site`다. 공개 home `200 text/html`, 카드 이미지 `200 image/png` (116,634 bytes), guest session GET `204`를 확인했다. S09의 전체 4P/7P 브라우저 대국·결과·재접속은 production game state를 만들지 않아 NOT RUN이며 PASS로 기록하지 않았다.
## 2026-10-04 UI/UX 및 API 개선

- T112 공용 계약 — DONE. 루트 단독 소유 packages/contracts/** 및 04_PROTOCOL.md. additive unchanged/presence/version 계약, strict parser, 20/20 tests 및 contracts check 통과.
- T113 Sites 서버 조회·알림 최적화 — DONE. 의존 T112 DONE. 단독 소유 apps/site/src/server/**, apps/site/src/storage/**, apps/site/test/**. 중복 조회 제거, 회원 한정 unchanged, versioned RoomView, 빠른 활성 알림/유휴 주기, 안전한 presence. 규칙/원자성/receipt/CAS 보존. 루트가 39/39 Site tests 및 별도 격리 DB 측정 결과를 검토했다. 원래 97개 AT와 구분한다.
- T114 Sites 전송 최적화 — DONE. 루트가 전송 회귀 테스트 13/13 및 중복 조회 2→1 측정 결과를 검토했다. 의존 T112 DONE. 단독 소유 apps/web/src/transport/**, apps/web/test/sites-transport*.mjs, apps/web/src/features/actions/model.ts, apps/web/src/features/reactions/model.ts. single flight/최신 힌트/조건부 sync/presence/버전 명령 응답 적용. 재접속·같은 명령 재시도 보존.
- T115 화면 흐름 개선 — DONE. 루트 검토 및 UI 집중 테스트 56/56, 결과 보완 12/12, 웹 타입 검사/보드 fixture 통과. 의존 T112 DONE. 단독 소유 apps/web/src/app/pages.tsx, app CSS, features/game-table/**, features/actions/ActionsPanel.tsx 및 actions.css, features/reactions/ReactionPrompt.tsx 및 reactions.css, features/status/**, features/lobby/**, features/room-entry/**, 관련 web UI tests. 현재 요청 상단/손패 단일화/결과 우선/안전한 비활성 이유/공개 로그/접속 표시/사용자 문구.
- T116 통합 검증·배포 — IN_PROGRESS. 의존 T113/T114/T115 DONE. 루트 소유 통합 fixture/검증 기록/배포 산출물, 필요한 기존 Node producer 호환 보완 및 공용 계약 수정. 변경 검증과 기존 미검증 수락 케이스를 구분한다.


### T112–T118 루트 검증 기록 (2026-10-04)

T112/T113/T114/T115/T117/T118 DONE: 공용 계약 20/20, 엔진 78/78, Sites 39/39, 웹 98/98; check/build 및 local 4P/7P HTTP 전체 게임 PASS. T117 파일 소유는 root 단독 db/schema.ts, drizzle/**이며 최초 migration 변경 없이 생성된 0001과 sparse outbox query-plan을 검증했다. T118은 root 단독 app-state.tsx 및 HTTP readiness 테스트이며 신규 게스트 복구 조회 제거를 검증했다.

T116 IN_PROGRESS: 로컬 통합 검증은 완료했으나 같은 Site 버전 2 publish FAILED (existing command_receipts). 기존 SQL/DB 데이터 보존. 플랫폼 적용 기록 정리 없이 초기 migration 재작성 또는 같은 archive 반복 배포를 진행하지 않는다. 상세 결과는 outputs/review-2026-10-04/IMPLEMENTATION_REPORT.md 및 deployment-result.json. 기존 D06/D18 및 운영 S09 NOT RUN은 그대로다.
