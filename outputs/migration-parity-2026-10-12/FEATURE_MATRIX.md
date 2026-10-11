# Sites ↔ 정훈서버 기능 대조표

기준: Sites v27 / 현재 저장소 및 정훈서버 2026-10-11-presence. **공통 코드 동일**은 소스·공용 회귀 검증이며 모든 운영 E2E를 통과했다는 뜻이 아니다. 결함의 우선순위·재현·조치는 REPORT.md 참고.

## 인증

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M001 | 닉네임으로 게스트 생성 | 양쪽 구현 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정 |
| M002 | 쿠키로 동일 게스트 복원 | 양쪽 구현 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정 |
| M003 | 지속 쿠키·복원 시 갱신 | 양쪽 구현 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정 |
| M004 | 명시적 TTL 만료 | 양쪽 구현 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정 |
| M005 | 닉네임 변경 및 기존 좌석 유지 | 양쪽 구현 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정 |
| M006 | 참여 방 복구 및 조회량 | 차이/결함 확인 | D1RoomService.recoverAssignedSeats / listRoomsForPlayer | RoomService.recoverAssignedSeats / BrowserGameTransport.performRecoverAssignedSeats | F03: 닫힌 방 포함, N+1 조회, 모든 과거 방·게임 자동 동기화 |
| M007 | 변경 API와 WebSocket Origin 검증 | 차이/결함 확인 | apps/site/src/server/routes/session.ts | apps/server/src/main.ts | F06: 격리 서버에서 외부 Origin 차등 재현 |
| M008 | 이미 연결된 세션 취소 반영 | 차이/결함 확인 | routes/notifications.ts / 매 요청 authenticate | socket/gateway.ts / 연결 시 authenticate | F07: 취소 후 기존 소켓 읽기 지속 재현 |

## 방

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M009 | CREATE_ROOM | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M010 | JOIN | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M011 | SET_READY (레거시 API) | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M012 | START_MATCH | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M013 | RETURN_TO_LOBBY | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M014 | CLOSE_ROOM | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M015 | KICK_MEMBER | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M016 | 초대 링크 미리조회 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M017 | 방장 초대 링크 재발급 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M018 | 4–7명 정원·빈자리·중복 입장 검사 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M019 | 방장·현재 멤버·버전 검사 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M020 | 게임 중 입장·추방 제한 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M021 | 종료 후 새 게임 및 이전 기록 보존 | 양쪽 구현 확인 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완 |
| M022 | SET_RULESET | 동일한 의도적 제한 | apps/site/src/server/routes/rooms.ts / rooms/service.ts | apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts | 양쪽 모두 기본판 ruleset 고정; 기능 누락으로 집계하지 않음 |
| M023 | 입장하면 자동 준비·즉시 대기실 | 공통 코드 동일 | apps/web/src/features/room-entry / lobby | 같은 React 컴포넌트 | 준비 버튼/방 미리열기 제거 유지; 서버 JOIN ready=true |
| M024 | 시작 명령 영수증 재조회 순서 | 정적 위험 확인 | rooms/service.ts:402 prior receipt 우선 | rooms/service.ts:386 현재 인원 검사 우선 | F12: 기존 시작 명령 재전송 전 방 인원이 바뀐 드문 경우; 이번 실행 재현 없음 |
| M025 | 대기실 연결 상태·복수 탭 | 양쪽 구현 확인 | routes/notifications.ts 45초 lease | socket/presence.ts 소켓 수 및 room:presence | 의도된 전송 차이; Node presence 회귀 테스트. 원래 누락은 10/11 수정 |

## 게임 명령

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M026 | PLAY_CARD | 공통 코드 동일 | D1MatchService → packages/engine/src/commands | commands/index.ts → 같은 engine | 공통 계약 파서·턴 런타임·효과 레지스트리; 각 어댑터 쓰기 경계는 별도 |
| M027 | RESPOND | 공통 코드 동일 | D1MatchService → packages/engine/src/commands | commands/index.ts → 같은 engine | 공통 계약 파서·턴 런타임·효과 레지스트리; 각 어댑터 쓰기 경계는 별도 |
| M028 | USE_ABILITY | 공통 코드 동일 | D1MatchService → packages/engine/src/commands | commands/index.ts → 같은 engine | 공통 계약 파서·턴 런타임·효과 레지스트리; 각 어댑터 쓰기 경계는 별도 |
| M029 | END_TURN | 공통 코드 동일 | D1MatchService → packages/engine/src/commands | commands/index.ts → 같은 engine | 공통 계약 파서·턴 런타임·효과 레지스트리; 각 어댑터 쓰기 경계는 별도 |

## 규칙

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M030 | 80장 구성·랭크·무늬·셔플 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M031 | 4/5/6/7인 역할 배분 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M032 | 보안관 첫 차례 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M033 | 보안관 캐릭터 기본 HP +1 및 초기 손패 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M034 | 차례 시작 다이너마이트·감옥·드로우 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M035 | 턴 종료 현재 HP 초과분 버리기 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M036 | 거리·사거리·장비 및 탈락자 제외 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M037 | 만피 맥주 허용·회복 0 확인 UX 유지 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M038 | 빈사 구제·자동 탈락 카드 정리 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M039 | 보상·보안관 페널티·승리 판정 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |
| M040 | 동시 광역 응답 접수와 순차 엔진 정산 | 공통 코드 동일 | packages/engine/src / server/commands/turn-runtime.ts | 같은 파일 | Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음 |

## 카드

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M041 | barrel (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M042 | dynamite (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M043 | jail (3장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M044 | mustang (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M045 | remington (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M046 | carabine (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M047 | schofield (3장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M048 | scope (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M049 | volcanic (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M050 | winchester (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M051 | bang (25장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M052 | beer (6장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M053 | cat_balou (4장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M054 | duel (3장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M055 | gatling (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M056 | general_store (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M057 | indians (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M058 | missed (12장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M059 | panic (4장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M060 | saloon (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M061 | stagecoach (2장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |
| M062 | wells_fargo (1장) | 공통 코드 동일 | packages/catalog/src/cards/index.ts / engine/src/effects/cards | 동일 catalog·registry·effect handler | 22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행 |

## 캐릭터

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M063 | bart_cassidy (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M064 | black_jack (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M065 | calamity_janet (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M066 | el_gringo (기본 HP 3) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M067 | jesse_jones (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M068 | jourdonnais (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M069 | kit_carlson (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M070 | lucky_duke (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M071 | paul_regret (기본 HP 3) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M072 | pedro_ramirez (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M073 | rose_doolan (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M074 | sid_ketchum (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M075 | slab_the_killer (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M076 | suzy_lafayette (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M077 | vulture_sam (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |
| M078 | willy_the_kid (기본 HP 4) | 공통 코드 동일 | packages/catalog/src/characters/index.ts / engine/src/effects/characters | 동일 roster·ability handler | 16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트 |

## 역할

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M079 | sheriff | 공통 코드 동일 | packages/catalog/src/roles/index.ts / engine/src/endgame | 동일 역할 데이터·승리 엔진 | 4–7명 역할 분포 및 엔진 코드 동일 |
| M080 | deputy | 공통 코드 동일 | packages/catalog/src/roles/index.ts / engine/src/endgame | 동일 역할 데이터·승리 엔진 | 4–7명 역할 분포 및 엔진 코드 동일 |
| M081 | outlaw | 공통 코드 동일 | packages/catalog/src/roles/index.ts / engine/src/endgame | 동일 역할 데이터·승리 엔진 | 4–7명 역할 분포 및 엔진 코드 동일 |
| M082 | renegade | 공통 코드 동일 | packages/catalog/src/roles/index.ts / engine/src/endgame | 동일 역할 데이터·승리 엔진 | 4–7명 역할 분포 및 엔진 코드 동일 |

## 정합성

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M083 | 커맨드 ID·내용 불변 재전송 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M084 | 중복 명령 쓰기 멱등성 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M085 | 같은 버전 동시 명령 한 건만 확정 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M086 | 상태·이벤트·영수증·outbox 원자성 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M087 | 시청자별 손패·역할·legalActions 투영 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M088 | outbox는 공개 변경 힌트만 전송 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M089 | 현재 멤버 확인·외부인 조회 거부 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M090 | 낡은 버전·이벤트 역행 방지 | 양쪽 구현 확인 | D1StorageRepository / D1MatchService / shared validation | StorageRepository / commands / shared validation | D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트 |
| M091 | 저장된 스냅샷 전체 형태·지원 버전 검사 | 차이/결함 확인 | storage/state-schema.ts / supportedSchemaVersion | storage/repository.ts / recovery/index.ts | F08: Node 시작 시 메타데이터 점검은 있음; 요청 경계 검증은 약함. schema 2 차등 재현 |
| M092 | 명령 request hash | 장래 호환 위험 | matches/service.ts | commands/index.ts | D-HASH: 동일 봉투의 키 순서 차이로 해시 상이. 현재 서로 다른 DB에서는 직접 장애 아님 |

## 통신

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M093 | 늦은 ACK·응답 유실·UI 잠금 복구 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F01: 차등 실행 재현; REPORT 참고 |
| M094 | 일시적 sync 실패 자동 재시도 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F02: 차등 실행 재현; REPORT 참고 |
| M095 | 명령 ACK에 최신 투영 포함 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F04: 차등 실행 재현; REPORT 참고 |
| M096 | 오래된 이벤트 sync 상한 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F05: 차등 실행 재현; REPORT 참고 |
| M097 | 권한 잃은 게임 캐시·구독 폐기 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F10: 차등 실행 재현; REPORT 참고 |
| M098 | 변경 없는 sync 응답 축소 | 차이/결함 확인 | apps/web/src/transport/sites-client.ts / site server routes | apps/web/src/transport/client.ts / server projections | F11: 차등 실행 재현; REPORT 참고 |
| M099 | SSE/HTTP → Socket.IO polling/WebSocket | 의도된 구현 차이 | SitesGameTransport | BrowserGameTransport | 전송 기술 변경 자체는 누락 아님; 어댑터 의미 차이가 문제 |
| M100 | 탭 숨김·다시 활성화 | 의도 차이 및 보완 권고 | visibility handler가 스트림 종료·복귀 sync | Socket.IO 연결 유지, 복귀용 별도 sync 없음 | 공통 F02 재시도/가시성 복구로 보완 권고; 브라우저 장시간 절전 E2E 미실행 |
| M101 | 예상 밖 조회 오류 | 정적 위험 확인 | routes/sync.ts 안전 오류·단계 로그 | socket/gateway.ts:316 invoke disconnect | F08 연관: 오류 ACK/진단 없이 disconnect될 수 있음; 임의 운영 오류 주입 없음 |

## 화면/연출

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M102 | 4–7인 원형 테이블·거리 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M103 | 작은 손패 카드 아이콘 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M104 | 카드·캐릭터·장착 상세 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M105 | 중앙 행동 무대 및 대응 카드 배치 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M106 | 잡화점 공개 선택 무대 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M107 | 인디언·개틀링 효과·각 플레이어 결과 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M108 | 총격·방어·결투 애니메이션 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M109 | 다이너마이트 폭발 이펙트 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M110 | 강제 버림·탈취 이펙트 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M111 | 드로우·사용·이동 효과음 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M112 | 음량·효과 설정·reduced motion | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M113 | 빈 손패 UI·중복 닫기 제거 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M114 | 불필요한 기술 알림 억제 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M115 | 모바일 반응형·접근성 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |
| M116 | WebMCP 도구 및 실패 시 UI 유지 | 공통 코드 동일 | apps/web/src/features / app/webmcp.ts | 동일 React·CSS·audio/motion 코드 | Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행 |

## 기록

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M117 | 최신순 hh:mm:ss 및 60초 이상 분 표시 | 양쪽 구현 확인 | routes/history.ts + shared status / public projector | match:history + 같은 status / public projector | Node/Sites history 회귀 및 공통 UI; F05는 동기화 전송량의 차이 |
| M118 | 열린 패널 상대 시각 고정 | 양쪽 구현 확인 | routes/history.ts + shared status / public projector | match:history + 같은 status / public projector | Node/Sites history 회귀 및 공통 UI; F05는 동기화 전송량의 차이 |
| M119 | 오래된 기록 페이지 추가 조회 | 양쪽 구현 확인 | routes/history.ts + shared status / public projector | match:history + 같은 status / public projector | Node/Sites history 회귀 및 공통 UI; F05는 동기화 전송량의 차이 |
| M120 | 카드 이동·버림·탈취 공개 기록과 비공개 정보 제거 | 양쪽 구현 확인 | routes/history.ts + shared status / public projector | match:history + 같은 status / public projector | Node/Sites history 회귀 및 공통 UI; F05는 동기화 전송량의 차이 |

## 에셋

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M121 | 한국어 카드 22 + 인물 16 + 역할 4 이미지 | 공통 코드 동일 | apps/site/public/assets/cards | apps/web/public/assets/cards | 42개 상대 경로·SHA256 비교; asset-parity.json |
| M122 | 안정된 카드 이미지 URL 캐시 | 차이/결함 확인 | public/_headers 1시간 재검증 | Caddy /assets/* 1년 immutable | F09: 운영 HTTPS 응답에서도 확인 |

## 운영

| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |
|---|---|---|---|---|---|
| M123 | HTTPS·도메인·터널·정적 SPA 직접 경로 | 운영 확인 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | 현재 공개 health 200; 기존 배포 검증 기록. TLS 종단은 Cloudflare |
| M124 | 실행 중 릴리스·서버 번들 | 운영 확인 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | SSH release 2026-10-11-presence, 로컬/서버 SHA256 일치 |
| M125 | 프로세스 장애 자동 재시작 | 구현 확인 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | LaunchAgent KeepAlive. 현재 Node/Caddy/Postgres/Tunnel 실행 상태 확인 |
| M126 | OS 재부팅·로그아웃 뒤 무인 실행 | 운영 제약 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | O02: gui/502 LaunchAgents이므로 로그인 필요; 실제 서버 재부팅 미실행 |
| M127 | DB 백업·디스크 재해 복구 | 운영 제약 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | O03: 동일 서버 백업 존재, 외부 복제 없음. 전체 복원 리허설 미실행 |
| M128 | 이전 Sites 서비스 완전 중지 | 차이/결함 확인 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | O01: get_site active=true, owner 전용. 공개 접근 제한과 서비스 중지는 다름 |
| M129 | 기존 D1 데이터·다른 도메인 쿠키 이전 | 의도된 범위 제외 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | 이전 문서에 미이관 명시; 데이터 유실로 단정하지 않음 |
| M130 | www 별칭 | 의도된 미구성 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | 정본 bang-online.site만 연결; www 요구 없었음 |
| M131 | HTTP 보안 헤더·요청 크기·초대 제한 | 구현 차이 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | 양쪽 제한 존재; Origin은 F06, Node profile 오류 코드 정규화는 보완 가능 |
| M132 | 배포 게이트·어댑터 계약 회귀 | 과정 누락 확인 | Sites managed hosting / D1 | deploy/selfhost / PostgreSQL / Caddy / Tunnel | 정상 흐름 중심 검증으로 F01/F02 등 통신 차이 놓침. parity 테스트 게이트 필요 |
