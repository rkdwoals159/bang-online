# Sites → 정훈서버 전면 대조 결과

검토일: 2026-10-12 KST. 요청: “전부다 대조해줘”. 작업자: 주 에이전트 단독.

## 결론

게임 엔진과 화면을 새로 만들면서 카드 기능이 대거 사라진 상황은 아니다. **기존 Sites v27과 현재 저장소의 engine·catalog·contracts·게임 화면 features 코드는 동일하다.** 22종 80장, 캐릭터 16명, 역할 4종, 한국어 이미지 42개가 유지된다.

실제 차이는 **Sites 전용 서버/브라우저 어댑터에 추가했던 복구·검증·통신 최적화를 정훈서버의 Node/Socket.IO 어댑터로 옮기지 않은 부분**에 집중된다. 정상적인 생성·입장·시작 검증만으로는 이 차이가 드러나지 않았다. 이식 완료 판단 전에 두 어댑터의 계약과 장애 복구를 대조하지 못한 것이 검증 과정의 문제다.

이번에 **기술 결함·위험 12개(F01–F12)**를 정리했다. 이 중 **10개는 격리 환경의 실행 재현, 1개는 운영 HTTP 응답으로 확인, 1개는 정적 검토만 수행**했다. 별도로 **운영 미완료 1개(O01)**와 이미 문서화된 **운영 제약 2개(O02–O03)**를 구분했다. 현재 사용자 장애의 원인을 이 모든 항목으로 단정하지 않는다.

- 전체 [기능 대조표: 132개 항목](FEATURE_MATRIX.md)
- [실행 재현 결과](reproductions.json)
- [248개 소스·배포 파일 목록과 함수 위치](source-inventory.json)
- [이전 배포와 현재 운영 기준](baseline-and-production.json)
- [42개 이미지 해시 비교](asset-parity.json)

이번 요청은 대조와 검토로 처리했다. 제품 코드는 수정하지 않았고 운영 서비스 재시작·게임 데이터 변경·배포·Sites 삭제도 수행하지 않았다. 감사용 스크립트와 결과 문서만 추가했다.

## 비교 기준과 검증 범위

| 구분 | 기준 |
|---|---|
| 마지막 Sites 배포 | v27, 소스 `fddad9b8d26f953728f86b38d456b1096bd8f331` — Sites connector 버전 목록으로 확인 |
| 현재 저장소 | `5ee8153f2437b5a0325ead32e377ffa6e3ddcd1b` |
| 정훈서버 제품 소스 | `72550cd3e3ebc56641918c76a752204b21c849e0` — 이후 HEAD 변경은 기존 검증 기록 |
| 현재 운영 릴리스 | `/Users/rkdwoals159/.bang-online/releases/2026-10-11-presence` |
| Node 번들 SHA256 | `11893b77ae836ebdaee34c06a9791aa23da47ebd7e877d80847f726681378a87` — 로컬과 SSH 서버 일치 |
| 운영 상태 | 공개 HTTPS/내부 health 정상, Node·PostgreSQL·Caddy·Tunnel 실행 확인 |
| 비교 방식 | Git 변경 비교, 전체 기능 경로 목록, 공용 계약 8개 방 명령·4개 게임 명령, 양쪽 서비스·저장소·전송 코드 대조, 회귀 테스트, 격리 DB 차등 재현 |
| 격리 재현 | Node 실제 런타임 + PGlite, Sites 실제 HTTP routes + Miniflare D1, 브라우저 어댑터 + 제어 가능한 소켓/HTTP 응답 |

공통 코드가 동일하다는 증거는 호스팅 어댑터 동작까지 같다는 뜻이 아니다. 이번 대조표에서 “양쪽 구현 확인”, “공통 코드 동일”, “실행 재현”, “정적 위험”, “운영 제약”을 구분했다. 모든 사람 수·캐릭터 조합의 운영 브라우저 E2E를 수행했다는 뜻으로 해석하면 안 된다.

## 우선 수정 항목

| ID | 우선순위 | 문제 | 근거 수준 |
|---|---|---|---|
| F01 | P1 | 응답 지연/유실 후 행동 UI가 계속 잠길 수 있음 | 실행 재현 |
| F02 | P1 | 연결은 살아 있어도 sync 한 번 실패하면 자동 복구가 멈춤 | 실행 재현 |
| F03 | P2 | 닫힌 방 복구·과거 모든 방/게임 구독·N+1 조회 | 실행 재현 + 소스 |
| F04 | P2 | 명령 ACK 최신 투영 미이식, 공용 ACK를 거부하는 별도 파서 | 실행 재현 + 소스 |
| F05 | P2 | 재접속 시 이벤트 전체 이력을 반환 | 실행 재현 |
| F06 | P2 | 세션 변경 HTTP/인증 WebSocket의 Origin 검증 차이 | 실행 재현 |
| F07 | P2 | 기존 소켓에서 세션 취소/만료를 다시 확인하지 않음 | 실행 재현 |
| F08 | P2 | 저장 스냅샷 검증과 지원 버전 처리 부족 | 실행 재현 + 소스 |
| F09 | P2 | 카드 이미지의 고정 URL에 1년 immutable 캐시 | 운영 응답 확인 |
| F10 | P2 | 접근 거부된 게임 캐시·구독을 정리하지 않음 | 실행 재현 |
| F11 | P3 | 변경 없는 sync에도 전체 snapshot 생성·반환 | 실행 재현 |
| F12 | P3 | 시작 명령 재전송에서 영수증보다 현재 인원 조건을 먼저 검사 | 정적 검토만 |

### F01 — 명령은 처리됐어도 행동 UI가 복구되지 않을 수 있음

- Node `apps/web/src/transport/client.ts:843`의 `attemptPending`은 ACK timeout 후 pending을 보존하지만 해당 시도의 늦은 ACK를 버린다. 실제 연결이 유지되는 동안 명령을 자동 재전송하는 복구 루프도 없다.
- 더 큰 차이는 `getCommandAcknowledgement`가 없다는 점이다. 공통 `features/feedback/recovery.ts:14`의 `observeCommandRecovery`는 이 accessor에서 영수증을 얻어야 버튼 잠금을 해제한다. Sites 어댑터에는 ACK 캐시/accessor와 동일 봉투 재시도가 있다.
- 재현: 15ms timeout → 늦은 정상 ACK → Node pending 유지. 이어 같은 명령 ID로 수동 재전송이 성공하여 transport pending이 사라져도 **공통 UI 복구 callback은 0회**였다. 화면의 pendingCommand를 해제할 근거가 전달되지 않는다.
- 사용자 영향: 카드 사용/대응이 멈춘 것처럼 보일 수 있다. 서버에서 중복 실행된다는 증거는 아니다. 기존 영수증 멱등성은 유지된다.
- 수정 방향: 두 어댑터의 ACK 캐시와 복구 계약 통일, 동일 ID·동일 payload 재시도와 backoff, 확정 영수증 + 권위 있는 projection 확인 뒤 UI 해제. 버튼 잠금을 무조건 해제하거나 새 ID로 재전송하면 안 된다.

### F02 — 일시적 읽기 실패가 계속되는 로딩으로 이어질 수 있음

- Node `client.ts:254` / `:653`은 변경 힌트를 저장한 다음 sync가 실패하면 오류를 삼킨다. 같은 힌트는 중복으로 보아 무시하며 별도 읽기 재시도 타이머가 없다. 소켓 재연결이나 더 새로운 변경이 없으면 그 상태가 남을 수 있다.
- Sites `sites-client.ts:1056`에는 명령 재시도와 별개의 sync retry가 있다. 화면 활성화 시 복구와 SSE 실패 시 보조 읽기도 있다.
- 재현: 첫 `match:sync` ACK 유실 → 같은 변경 힌트 재전송. **Node 읽기 1회, snapshot 없음. Sites 첫 HTTP 500 후 읽기 2회, snapshot 복구.**
- 수정 방향: 관찰 중인 방/게임 단위 읽기 재시도, 지수 backoff, visibility/online 복귀 시 sync. 권한 상실·세션 만료처럼 재시도하면 안 되는 상태는 분리한다.

### F03 — 과거 방이 늘어날수록 복구가 불필요하게 무거움

- Node `rooms/service.ts:255`는 room_players를 전부 조회하고 방마다 `roomViewForMember`를 호출한다. 닫힌 방 제외 조건이 없으며 여러 추가 조회가 발생한다. Sites `storage/repository.ts:854`는 닫힌 방을 제외하고 한 배치로 구성한다.
- Node `client.ts:420`는 복구한 모든 방과 activeMatchId를 구독 자원으로 보존하고 즉시 전부 sync한다. Sites는 목록을 먼저 채우고 실제 관찰하는 방/게임만 동기화한다.
- 재현: 방 생성 → 닫기 → 참여 정보 복구. **Node는 closed 방 1개 반환, Sites는 0개 반환.** 전 방 자동 sync/N+1 부분은 해당 코드 경로에서 확인했다.
- 사용자 영향: 과거 방이 다시 목록에 나타나거나 초기 입장 시간이 길어질 수 있다. 하나의 과거 방 조회 실패가 전체 복구 Promise를 실패시킬 수도 있다.
- 수정 방향: closed 제외, 배치 조회, 목록 복구와 구독 분리, 현재 화면 자원만 관찰. 과거 방의 게임 기록 열람 기능 자체는 보존한다.

### F04 — 카드 사용 직후의 빠른 갱신이 미이식됨

- Sites `matches/service.ts`의 `includeMatchProjection`과 `routes/matches.ts`는 ACK에 확정된 자기 projection을 포함한다. `sites-client.ts`가 cursor를 검사해 적용하므로 불필요한 추가 sync를 줄인다.
- Node `commands/index.ts:201`의 accepted는 버전/이벤트 번호만 반환한다. 공통 행동 UI가 최신 상태를 다시 읽어야 하므로 추가 왕복이 필요하다. RTT와 서버 부하가 클수록 체감 지연이 늘어난다.
- Node `client.ts:975`의 별도 `isCommandAck`는 공통 계약에 합법적인 `matchProjection` 필드를 거부한다. 실제 공용 ACK를 넣으면 `INVALID_RESPONSE`로 재현된다. 현재 Node 서버가 그 필드를 보내지 않으므로 이 파서 문제는 잠재 호환 오류다.
- 수정 방향: 서버와 클라이언트를 함께 변경하고 공용 `parseCommandAck` 사용. baseEventSeq 이전 공백과 다른 사용자의 동시 이벤트를 놓치지 않도록 Sites의 gap 복구도 함께 옮긴다.

### F05 — 오래 플레이할수록 재접속 응답이 커짐

- Node `projections/sync.ts:276`은 afterEventSeq 이후 이벤트 전체를 읽는다. Sites `routes/sync.ts:215`는 최근 raw 이벤트 100개로 제한하고 필요한 경우 full snapshot으로 표시한다.
- 같은 snapshot과 공개 이벤트 250개를 넣은 격리 DB 재현: **Node 250개 / 35,735 bytes, Sites 100개 / 15,292 bytes**. 이 수치는 측정 fixture에 대한 응답 크기이며 실서비스 지연 측정치는 아니다.
- UI가 나중에 visibleEvents를 제한해도 DB 조회·투영·직렬화·네트워크 비용은 이미 발생한다. 과거 기록은 양쪽 모두 별도 페이지 API가 있다.
- 수정 방향: 최신 이벤트 tail 상한, full snapshot/cursor 계약 유지, 예전 기록은 history paging으로 조회. 무조건 처음 100개만 반환하면 최신 이벤트를 잃으므로 안 된다.

### F06 — 일부 출처 검증이 빠짐

- Sites 세션 생성/프로필 변경은 same-Origin을 검사한다. Node `main.ts:251` / `:276`은 세션 변경에서 Origin을 검사하지 않는다.
- Socket.IO `cors` 설정은 polling의 브라우저 CORS를 다루며 WebSocket 업그레이드 출처 거부를 대신하지 않는다. Node gateway는 쿠키로 인증하지만 별도의 `allowRequest` 출처 거부가 없다.
- 재현: 외부 Origin으로 게스트 생성은 Node 201 / Sites 403. **유효 쿠키를 가진** 프로필 변경은 Node 200 / Sites 403. 유효 쿠키 + 외부 Origin의 WebSocket도 Node에서 연결됐다.
- 인증 우회나 실제 브라우저 공격이 성립했다고 단정하지 않는다. HttpOnly/SameSite=Lax와 인증은 유지되고, 일반 JSON fetch의 preflight 제약도 있다. 이번 결과는 출처 검증 계약 차이다.
- 수정 방향: 상태 변경 API와 WebSocket handshake에 명시적 허용 Origin 검사. 신뢰할 프록시와 개발 환경 정책을 정하고 실제 게임 접속을 차단하지 않게 검증한다.

### F07 — 연결 후 취소된 인증을 계속 사용할 수 있음

- Node `socket/gateway.ts`는 연결 middleware에서 인증한 playerId를 기존 소켓 context에 보존한다. 각 명령에서 멤버십은 확인하지만 세션 revoked_at/만료는 재인증하지 않는다. 클라이언트의 `session:expired` 수신 분기는 있어도 서버의 지속 세션 검사가 없다.
- Sites는 요청마다, SSE는 poll 중 인증을 다시 확인한다.
- 재현: 격리 세션으로 연결 → DB에서 해당 세션 취소 → **Node 기존 소켓 room:sync는 계속 성공**, Sites 다음 참여 정보 요청은 401.
- 수정 방향: 세션 ID를 소켓 context에 보관하고 주기적/명령 경계 유효성 검사, 만료/취소 시 제한된 오류 전송 후 끊기. 현재 기본 TTL이 매우 길다는 점과 취소 검증 누락은 별개다.

### F08 — 지원하지 않는/손상된 snapshot 처리의 차이

- Sites `storage/state-schema.ts`는 저장 상태 구조와 카드/HP/해결 상태를 검사하며 읽기 경계에 supportedSchemaVersion을 적용한다. 요청 route도 RECOVERY_REQUIRED를 안전하게 반환한다.
- Node `storage/repository.ts:418`의 `mapMatch`는 JSON을 GameState로 타입 단언한다. 시작 시 `recovery/index.ts`에서 active match의 schema/ruleset/메타데이터를 검사하는 보호는 **있지만**, 상세 구조 전체나 개별 읽기·명령 경계를 대신하지 않는다.
- 재현: 시작 이후 격리 DB의 state schema를 2로 변경. **Node는 snapshot 투영을 진행**, Sites는 RECOVERY_REQUIRED. 정상 사용 중 schema가 저절로 바뀐다는 뜻은 아니며, 데이터 손상/잘못된 릴리스에 대한 보호 차이다.
- 추가 정적 위험: gateway `invoke`는 예외를 오류 ACK나 단계 로그 없이 disconnect로 처리한다. 잘못된 저장 상태의 projection 예외가 재연결 반복처럼 보일 수 있다. 운영 데이터에 임의 오류를 주입하지 않았다.
- 수정 방향: 런타임 중립 저장 상태 validator 공유, 읽기/쓰기 계약 검사, 영수증 replay와 지원 버전 처리 순서 명시, 안전한 오류와 개인정보 없는 단계 로그.

### F09 — 카드 이미지를 교체해도 기존 이미지가 오래 남을 수 있음

- Sites `public/_headers`는 `/assets/cards/*`에 `max-age=3600, must-revalidate`를 적용한다.
- 정훈서버 `deploy/selfhost/configure-macos.py:63`와 현재 Caddyfile은 모든 `/assets/*`에 **1년 immutable**을 적용한다. hash가 없는 고정 카드 URL도 포함된다.
- 공개 `https://bang-online.site/assets/cards/playing/01_bang.png`에서 HTTP 200, `Cache-Control: public, max-age=31536000, immutable`, Cloudflare cache HIT 확인.
- 현재 파일 42개는 두 프로젝트가 byte 단위로 같다. 이번 결과는 현재 이미지가 다르다는 뜻이 아니다.
- 수정 방향: hash가 있는 빌드 JS/CSS만 장기 캐시, 카드 파일은 짧은 재검증 또는 콘텐츠 hash URL 사용. 이미 장기 캐시된 브라우저를 고려하면 URL 변경이 필요한 경우도 있다.

### F10 — 게임 접근 거부 뒤 캐시와 구독이 남음

- Node `performRoomSync`에는 최근 추가한 방 접근 상실 처리가 있다. 그러나 `client.ts:781`의 match 거부 분기는 SYNC_REJECTED만 설정하고 기존 snapshot을 없애지 않는다. retained match도 남는다.
- Sites `sites-client.ts:771`의 rejectResource는 해당 게임 캐시·구독·재시도 상태를 제거한다.
- 재현: 처음 snapshot 허용 → 다음 sync NOT_FOUND_OR_FORBIDDEN. **Node 기존 snapshot 유지, 다음 변경 힌트에 또 읽음(총 3회)**. Sites는 기존 snapshot을 제거한다.
- 사용자 영향: 접근할 수 없는 예전 게임이 화면에 남거나 재요청을 계속할 수 있다. 서버의 신규 정보 접근 제어가 우회된다는 뜻은 아니다.
- 수정 방향: 현재 방/게임별 unavailable 상태를 일관되게 적용하고 캐시·연결 자원·힌트 정리. 다른 정상 방까지 제거하지 않는다.

### F11 — 변경 없는 읽기의 축소 응답이 없음

- 공통 계약의 `acceptUnchanged`와 Sites의 `status: unchanged` 최적화가 Node 어댑터에는 없다. Node 브라우저는 opt-in을 보내지 않고 서버도 같은 cursor에서 전체 projection을 만든다.
- 같은 버전/이벤트 번호인 격리 재현: **Node snapshot 1,591 bytes / Sites unchanged 114 bytes**. 수치는 fixture에 따라 다르며 재현 JSON을 정본으로 한다.
- 수정 방향: 클라이언트가 해당 canonical snapshot을 보존한 경우에만 opt-in, 서버의 unchanged 응답, 캐시가 없어졌을 때 full snapshot fallback. F04/F05와 별개의 동일 상태 읽기 비용이다.

### F12 — 늦은 시작 명령 재전송의 결과가 달라질 수 있음

- Sites `rooms/service.ts:402`는 기존 START_MATCH 영수증을 먼저 확인한다. Node `rooms/service.ts:386`는 현재 멤버/방장/4–7인 조건을 검사한 뒤 lifecycle 영수증 검사에 도달한다.
- 예: 이미 성공한 시작 명령이 남아 있는 동안 게임 종료 → 대기실 복귀 → 추방으로 3명 → 예전 명령 재전송. Node는 ROOM_NOT_READY로 막혀 기존 확정 영수증을 반환하지 못할 수 있다.
- **이번에 해당 전체 순서를 실행 재현하지 않았다. 정적 위험으로만 집계한다.** 평상시 즉시 중복 START_MATCH는 기존 양쪽 테스트를 통과한다.
- 수정 방향: 권한/정보 노출 정책을 지키면서 기존 명령·해시 영수증 조회를 현재 roster 사전 검사보다 먼저 수행하는 계약으로 통일한다.

## 이미 고쳐진 누락 — 이번 신규 결함과 구분

| 기능 | 현재 상태 | 기존 근거 |
|---|---|---|
| 브라우저 종료 후 방장 복원 | 지속 쿠키 및 복원 시 갱신 반영 | `outputs/room-recovery-2026-10-11/STATUS.md` |
| 방장 초대 링크 재발급 | Node API·권한·출처·버전 검사 반영 | 같은 기록 및 현재 runtime 테스트 |
| 다른 사람 내보내기 | Node KICK_MEMBER 연결 및 UI/멤버십 갱신 반영 | `outputs/kick-member-2026-10-11/STATUS.md` |
| 잡화점 등에서 모두 끊기는 parser 오류 | 공통 snapshot parser 사용으로 수정 | `outputs/reconnect-2026-10-11/STATUS.md` 및 현재 transport 테스트 |
| 대기실 연결 확인 | room:presence 및 복수 소켓 집계 반영 | 같은 reconnect 기록 및 runtime/gateway 테스트 |

이 항목들은 현재 코드에 다시 없는 것으로 세지 않았다. 단, F01/F02처럼 다른 복구 결함이 남아 있어 “연결 문제 전체 해결”로 확대 해석하면 안 된다.

## 운영 미완료와 제약

### O01 — 기존 Sites는 완전히 꺼지지 않음

Sites connector의 현재 get_site 결과는 **active=true, v27, custom owner 전용 접근**이다. 일반 공개 접근 제한과 서비스 중지는 다르다. 사용자가 이전 배포를 모두 꺼도 된다고 했던 요청은 완전히 마무리되지 않은 상태다. 영구 삭제 시 D1 보존 문제를 따로 판단해야 하며 이번 대조에서는 삭제하지 않았다. 접근 우회 credential은 보고서에 저장하지 않았다.

### O02 — 서버 재부팅/로그아웃 시 무인 실행 제약

서비스가 `gui/502` 사용자 LaunchAgents다. 로그인된 동안 KeepAlive가 동작하지만, 재부팅 후 로그인 전 자동 실행은 보장되지 않는다. 현재 서버 sleep=0이고 서비스 실행은 확인했다. 이는 최초 이전 문서에 명시된 제약이며 새로 생긴 코드 누락으로 세지 않는다. 이번에는 실제 OS 재부팅/로그아웃을 수행하지 않았다. 상시 운영이 목표라면 권한을 갖춘 LaunchDaemon 또는 서버 운영 방식으로 바꿔야 한다.

### O03 — 백업이 동일 서버에만 있음

백업 서비스와 최근 dump 파일 존재는 확인했다. 외부 저장소 백업·보존 정책·완전 복원 리허설은 구성/검증되지 않았다. 장비·디스크 손실은 동일 서버 백업으로 해결할 수 없다. 기존 문서에 있던 제약이다. 이번 검토가 복구 성공 검증을 대신하지 않는다.

## 의도된 차이와 장래 호환 위험

- Cloudflare Worker/D1/SSE → Node/PostgreSQL/Socket.IO/Caddy/Tunnel 변경 자체는 정상이다. 대응 Socket 이벤트가 존재하는 API는 HTTP URL이 없다는 이유로 누락 처리하지 않았다.
- SET_RULESET은 양쪽 모두 기본판 고정으로 거부한다. 준비 버튼 제거와 자동 ready도 양쪽에 유지된다.
- 대기실 presence의 Sites lease 방식과 Node 소켓 개수 집계는 각 전송에 맞는 구현이다. Node의 로비 표시 기능 자체는 현재 존재한다.
- 이전 Sites의 D1 상태와 다른 도메인 쿠키를 PostgreSQL/새 도메인으로 자동 이전하지 않은 것은 이전 문서에 명시돼 있다. 현재 방장 복원 결함과 이 범위 결정을 혼동하지 않는다.
- 동일 게임 명령의 request hash는 두 어댑터가 객체 키 순서를 다르게 직렬화해 다르다(`D-HASH` 실행 확인). 현재는 데이터베이스가 달라 곧바로 장애를 만들지 않는다. 향후 영수증까지 이전하거나 어댑터를 바꿀 때는 공용 canonical serializer가 필요하다.
- Node 초대 제한 키는 `[peerAddress, playerId]`이다. 프록시 주소가 같다고 다른 플레이어의 실패 횟수가 곧바로 합쳐지는 구조는 아니므로 공용 IP 차단 결함으로 세지 않았다. Sites의 영속 제한과 Node 메모리 제한 차이는 남는다.
- Node HTTP 프로필 입력 오류는 크기/형식 오류를 400으로 정규화하는 등 Sites와 일부 오류 코드 차이가 있다. 일반 정상 화면의 기능 누락은 아니며 공용 HTTP 경계 정책으로 정리할 수 있다.

## 테스트 결과와 한계

| 그룹 | PASS | FAIL | 실행 결과 |
|---|---:|---:|---|
| catalog + contracts + engine | 420 | 0 | `shared-tests.json` |
| Node/Socket.IO 서버 | 106 | 0 | `node-tests.json` |
| Sites/D1 서버·마이그레이션·mount | 67 | 0 | `site-tests.json` |
| 공통 화면·두 전송 어댑터·WebMCP | 256 | 0 | `web-tests.json` |
| **합계** | **849** | **0** | 기존 테스트의 현재 실행 결과 |

별도 차등 스크립트의 **12개 관찰 레코드**는 F01–F08/F10/F11, F06의 WebSocket 관찰, D-HASH를 포함한다. “프로그램 정상 통과”가 아니라 **의도한 차이/결함이 재현됐다는 assertion**이다. F09는 실제 운영 헤더, F12는 소스 검토 근거다.

처음에는 Node strip-only loader로 parameter property/enum/TSX import를 처리하지 못하는 실행기 오류가 있었다. Sites/Web은 기존 설치된 tsx loader로 최종 재실행했고 위 표는 그 최종 결과만 사용한다. 중간 loader 실패를 제품 결함으로 집계하지 않았다. 원시 TAP는 로컬 `logs/`에 남기고 Git 추적에서 제외했다.

**미검증 항목:** 이번 변경 없는 감사에서 4–7인 실사용 브라우저의 모든 카드/캐릭터 조합, 모바일 기기 실측, 실제 효과음 청취, 장시간 절전/느린 회선, 운영 OS 재부팅, DB 재해 복원, 이전 Sites 전체 데이터 이전은 실행하지 않았다. F12 전체 시나리오도 미실행이다.

기존 **97개 수락 케이스의 95/97 기록과 D06/D18 미검증 상태를 변경하지 않았다.** 이번 849개 단위·서비스 회귀 통과를 그 두 시나리오의 통과로 환산하지 않는다. 사용자 제보 당시 모든 플레이어가 끊긴 사건의 로그를 이번 재현만으로 다시 확정하지도 않는다.

## 수정 순서 권고

1. **F01/F02:** ACK 영수증 복구와 읽기 재시도부터 수정한다. “서버 반영 후 응답 유실”, “연결은 유지·sync만 유실”, “재연결 성공 후 버튼 잠금 해제”를 양쪽 어댑터 공용 테스트로 고정한다.
2. **F03/F10:** 과거 자원 구독, closed 복구, 권한 상실 정리를 수정한다. 방 하나의 실패가 전체 초기화를 막지 않게 한다.
3. **F04/F05/F11:** inline projection, 최근 tail, unchanged 응답을 함께 설계하되 cursor gap·비공개 이벤트 누락·역행을 검사한다. 파서 중복을 제거한다.
4. **F06/F07/F08/F12:** 출처·세션·저장 상태·영수증 조회 순서를 공용 계약으로 정리한다. 예상 밖 예외의 오류 ACK/단계 로그를 추가한다.
5. **F09/O01:** 캐시 정책과 이전 Sites 중지를 마무리한다. O02/O03은 상시 운영 조건에 맞춰 별도 운영 작업으로 처리한다.
6. 배포 게이트에 **두 어댑터 동등성 테스트**를 포함한다. 모든 방 명령·최소 각 카드/캐릭터 효과·명령 중복/유실·닫힌 방·접근 상실·잡화점·광역 동시 응답·재시작 복구를 검증하고 미실행을 PASS로 처리하지 않는다.

## 재실행

저장소 루트에서 기존 설치 의존성을 사용한다. 모든 재현은 임시 격리 DB를 만들고 종료하며 운영 DB/서비스를 사용하지 않는다.

```powershell
node scripts/audit-migration-parity.mjs inventory
node scripts/audit-migration-parity.mjs shared
node scripts/audit-migration-parity.mjs node
node scripts/audit-migration-parity.mjs site
node scripts/audit-migration-parity.mjs web
node --experimental-transform-types --loader ./packages/engine/test/setup/ts-source-loader.mjs scripts/audit-migration-probes.mjs
node --experimental-transform-types --loader ./packages/engine/test/setup/ts-source-loader.mjs scripts/audit-migration-matrix.mjs
```

`audit-migration-matrix.mjs`의 운영/Sites 메타데이터는 이번 read-only 확인값이다. 이 스크립트를 다시 실행하는 것만으로 외부 운영 상태를 재검증하는 것은 아니다. 제품 수정 후에는 결함이 재현되리라 기대하는 probe assertion을 올바른 동등성 테스트로 바꾸어야 한다.
