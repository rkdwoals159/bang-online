# 로컬 서버

서버는 Node.js 22.12 이상과 pnpm 11이 필요합니다. 표준 `dev` 실행은 PostgreSQL을 사용합니다. PostgreSQL을 설치하지 않은 개발자는 아래의 선택형 PGlite Socket 실행을 사용할 수 있습니다. 두 실행은 migration, 연결 확인, 저장 상태 복구 검사를 끝낸 뒤 HTTP와 Socket.IO를 같은 포트에서 엽니다.

## 시작

PostgreSQL에서 `bang_online` 데이터베이스를 만들고, 로컬 사용자명과 비밀번호에 맞게 `DATABASE_URL`을 설정합니다. PowerShell 예시는 다음과 같습니다.

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/bang_online"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
$env:WEB_ORIGIN = "http://localhost:5173"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @bang/server dev
```

준비 완료 로그는 PostgreSQL URL이나 비밀값을 출력하지 않습니다. `http://127.0.0.1:3000/healthz`가 `{"status":"ok"}`를 반환하면 migration과 DB 확인이 끝난 상태입니다. Ctrl+C 또는 SIGTERM은 Socket.IO 연결, HTTP listener, PostgreSQL pool을 정리합니다.

## PostgreSQL 없이 로컬 실행

PGlite Socket 개발 모드는 별도 PostgreSQL 서비스를 띄우지 않고, PostgreSQL wire protocol로 `pg` client를 연결합니다. PGlite DB와 Socket listener는 현재 서버 프로세스가 소유하며 종료할 때 둘 다 정리합니다. DB 파일은 실행 사이에 유지됩니다. 기본 경로는 Windows에서 `$HOME\.bang-online\pglite`, macOS/Linux에서 `~/.bang-online/pglite`입니다.

PowerShell에서 실행하는 예시입니다. `PGLITE_DATA_DIR`를 지정하지 않으면 기본 경로를 사용합니다.

```powershell
$env:PGLITE_DATA_DIR = Join-Path $env:LOCALAPPDATA "BangOnline\pglite"
$env:PGLITE_PORT = "5433"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
$env:WEB_ORIGIN = "http://localhost:5173"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @bang/server dev:pglite
```

별도 PowerShell 창에서 `Invoke-RestMethod http://127.0.0.1:3000/healthz`를 실행해 `{ status: "ok" }`를 확인합니다. PGlite Socket은 DB 포트 `127.0.0.1:5433`에만 bind합니다. `PGLITE_PORT`는 `1`부터 `65535` 사이의 포트로 바꿀 수 있습니다. `PGLITE_DATA_DIR`를 지정하면 해당 경로를 사용하며, 데이터 경로는 저장소 바깥으로 설정하세요.

PGlite Socket은 단일 DB 연결에서 쿼리를 중재하는 로컬 개발 adapter이므로 앱의 해당 pool은 연결 1개로 제한됩니다. 이 모드는 HTTP/Socket.IO 조립, `pg` 연결, 로컬 migration과 재시작 간 저장 상태를 확인하는 smoke 실행입니다. 일반 PostgreSQL 서비스의 TLS, 인증, 다중 연결 잠금 동작이나 배포 호환성을 증명하지 않으며, 통합 수락 테스트의 통과로 기록하지 않습니다.

## 설정

| 변수 | 필수 | 기본값 | 설명 |
|---|---:|---|---|
| `DATABASE_URL` | 예 | 없음 | `postgres://` 또는 `postgresql://` 형식의 로컬 PostgreSQL 연결 URL. 잘못되거나 누락되면 서버가 listener를 열기 전에 설정 오류를 출력합니다. |
| `HOST` | 아니요 | `127.0.0.1` | HTTP 및 Socket.IO bind 주소. |
| `PORT` | 아니요 | `3000` | HTTP 및 Socket.IO 포트. |
| `WEB_ORIGIN` | 아니요 | `http://localhost:5173` | 로컬 웹 앱의 허용 origin. 브라우저 credential 전송을 위해 Socket.IO와 HTTP 응답에서 credentials를 허용합니다. |
| `SESSION_COOKIE_NAME` | 아니요 | `bang_session` | 게스트 세션 cookie 이름. |
| `GUEST_SESSION_TTL_MS` | 아니요 | 만료 없음 | 양의 밀리초 정수. 지정하지 않으면 게스트 세션은 자동 만료되지 않습니다. |
| `ROOM_RETENTION_MS` | 아니요 | 자동 삭제 없음 | 양의 밀리초 정수. 닫힌 방 보존 기간을 서비스에 전달합니다. 정리 worker는 이 서버에서 실행하지 않습니다. |
| `PGLITE_DATA_DIR` | PGlite 모드에서 아니요 | `$HOME/.bang-online/pglite` | 로컬 PGlite 파일의 저장 위치. `dev:pglite`에서만 읽습니다. 저장소 밖의 영속 경로를 사용하세요. |
| `PGLITE_PORT` | PGlite 모드에서 아니요 | `5433` | 로컬 PGlite Socket이 loopback에서 수신할 PostgreSQL wire port. `dev:pglite`에서만 읽습니다. |

## HTTP와 Socket.IO

`POST /api/guest-sessions`는 다음 JSON을 받고, 세션 응답 JSON과 함께 `HttpOnly; Secure; SameSite=Lax; Path=/` cookie를 설정합니다.

```json
{
  "protocolVersion": 1,
  "displayName": "강가의 여우"
}
```

응답 JSON에는 `protocolVersion`, `player`, `sessionExpiresAt`만 있으며 원본 credential은 cookie로만 전달됩니다. 서버는 세션 token 원문, 요청 본문 또는 DB 연결 URL을 로그에 남기지 않습니다. 개발 브라우저는 `localhost` 또는 `127.0.0.1`을 사용하고 credential 포함 요청을 보내야 합니다. cookie의 `Secure` 속성은 항상 켜져 있습니다.

`GET /api/guest-sessions`는 같은 cookie로 기존 공개 게스트 정보를 복원합니다. 유효한 세션은 `GuestSessionResponse`와 200, 쿠키 누락/만료/무효는 빈 204로 응답합니다. `GET /api/guest-sessions/rooms`는 인증된 게스트가 현재 속한 RoomView만 반환하고 좌석이 없으면 빈 배열을 반환합니다. 이 endpoint는 세션 cookie 없이 사용할 수 없으며 누락/무효 세션은 401 `SESSION_EXPIRED`입니다. 두 조회 응답 모두 `Cache-Control: no-store`이며 cookie credential은 응답 JSON에 넣지 않습니다. 방/매치 상태 갱신은 조회 후에도 인증된 `room:sync`/`match:sync`로 수행합니다.

Socket.IO는 `/socket.io`에서 같은 HTTP server를 공유하고 세션 cookie를 매 handshake에서 확인합니다. `room:preview`, `room:sync`, `match:sync`는 서비스 및 권한 projection에 연결되어 있습니다. DB commit 뒤 outbox의 `room:changed`/`match:changed` 무효화 신호를 해당 lobby/match 채널로 전달합니다. `room:command`는 방 생성, 입장, 준비, 시작, 자발적 폐쇄를 지원합니다. `SET_RULESET`과 대기 중 `KICK_MEMBER`는 아직 `COMMAND_UNAVAILABLE`입니다. 방에 매치가 연결된 뒤 방장 `KICK_MEMBER`는 `ROOM_LOCKED`, 방에 속하지 않은 요청자는 `NOT_FOUND_OR_FORBIDDEN`으로 거절됩니다.

`match:command`는 T46 relay의 receipt 확인 후 T41 기본판 effect registry와 T66 handler를 사용해 등록된 `PLAY_CARD`, `USE_ABILITY`, `RESPOND`를 실행합니다. `END_TURN` 및 턴 시작 효과 응답 뒤에는 서버가 T67의 다이너마이트→감옥 시작 처리와 드로우를 이어 실행합니다. 시작/드로우 상호작용은 저장된 continuation으로 재개하며, 자동 진행 결과까지 원래 명령과 함께 한 번의 매치 version, receipt, event/outbox transaction으로 커밋합니다. 등록되지 않은 실행기는 허용되지 않습니다.

## 확인 명령

```powershell
pnpm --filter @bang/server check
pnpm --filter @bang/server test:runtime
```

Runtime tests는 in-memory adapter 및 TCP PGlite Socket 경로에서 HTTP listener, `pg` 연결, migration, guest session cookie, handshake authentication, unauthenticated rejection, shutdown을 확인합니다. TCP test는 DB socket과 PGlite 인스턴스를 같은 data directory로 재시작해 migration과 세션 저장이 유지되는지도 검사합니다. 이 검증은 별도 PostgreSQL 서버의 TLS, 인증 설정, 다중 연결 잠금 경합을 대신하지 않습니다.
