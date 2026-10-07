# 정훈서버 운영

## 구성

`bang-online.site` → Cloudflare Tunnel → 정훈서버 `127.0.0.1:8088` (Caddy) → 정적 웹 / `127.0.0.1:3080` (Node + Socket.IO) → `127.0.0.1:55432` (PostgreSQL).

- SSH: `rkdwoals159@100.124.235.102` (Tailscale)
- 설치 경로: `/Users/rkdwoals159/.bang-online`
- 사용자 LaunchAgents: `site.bang-online.postgres`, `.server`, `.web`, `.tunnel`, `.backup`
- 기존 서버의 다른 서비스 및 시스템 Homebrew는 수정하지 않는다.
- 설정/인증 정보는 서버 `config`에만 저장한다. 저장소에 토큰이나 DB 비밀번호를 넣지 않는다.

## 빌드와 설치

워크스페이스 의존성을 설치한 상태에서 `node scripts/build-selfhost.mjs`로 `dist/selfhost`를 생성한다. 프런트엔드는 Socket.IO를 명시적으로 사용한다. Sites 진입점은 기존 HTTP/SSE 어댑터를 계속 사용한다.

`dist/selfhost`를 `bang-selfhost-release.tar.gz`로 묶어 서버 홈에 전송한다. 최초 설치는 `install-runtime-macos.sh`, `configure-macos.py` 순서로 실행한다. 후자는 이 이전의 릴리스 디렉터리 `2026-10-08`을 사용한다. 향후 릴리스는 새 디렉터리를 사용하고, 백업 후 서비스의 실행 경로와 `current` 링크를 전환한다. 실행 중인 릴리스 디렉터리를 덮어쓰지 않는다.

Node 22.23.3, Caddy 2.11.7, cloudflared 2026.10.0, Postgres.app 2.9.6 / PostgreSQL 18.6을 사용한다. Node/Caddy는 공식 배포 체크섬을 확인한다. Postgres.app은 공식 GitHub 릴리스에서 받아 macOS 코드 서명을 검증한다. 런타임 npm 의존성은 `package-lock.json`과 `npm ci`로 고정한다.

번들 엔트리는 `server/storage/main.mjs`이며 `migrations/`의 상대 경로를 유지한다. Node 엔트리는 릴리스의 실제 경로로 실행한다. 심볼릭 링크 경로를 직접 실행하면 기존 엔트리 판별 때문에 서버가 시작되지 않을 수 있다.

## 서비스 관리

```sh
launchctl print gui/502/site.bang-online.server
launchctl kickstart -k gui/502/site.bang-online.server
launchctl kickstart -k gui/502/site.bang-online.web
launchctl kickstart -k gui/502/site.bang-online.tunnel
curl -fsS http://127.0.0.1:8088/healthz
```

Caddy의 관리 API는 꺼져 있으므로 `caddy reload` 대신 웹 서비스를 재시작한다. 정상 게임 중 서버 재시작은 접속을 끊으므로 유지보수 시간에 진행한다. 게임 상태와 세션은 PostgreSQL에서 복구된다.

로그는 `logs/server.log`, `server.error.log`, `postgres.error.log`, `web.error.log`, `tunnel.error.log`, `backup.error.log`에 남는다.

사용자 LaunchAgents는 해당 macOS 사용자가 로그인된 동안 실행되고 장애 시 다시 시작한다. 부팅 직후 로그인 전 자동 실행은 관리자 권한의 LaunchDaemon이 필요한 별도 설정이다. 이 계정에는 관리자 권한이 없어 설치하지 않았다. 현재 서버의 잠자기 설정은 `sleep 0`이다.

## 백업

매일 오전 04:00 서버 시각에 `backup.py`가 PostgreSQL custom-format 백업을 `backups/`에 생성한다. 수동 실행:

```sh
python3 ~/.bang-online/backup.py
~/.bang-online/runtime/Postgres.app/Contents/Versions/18/bin/pg_restore --list <백업파일>
```

백업은 동일 서버에 저장된다. 디스크 손실에 대비한 외부 저장소 백업은 아직 구성하지 않았다. 백업 파일은 자동 삭제하지 않으므로 용량을 관리해야 한다. 기존 Sites의 D1 데이터는 Sites에 그대로 보존하며 새 PostgreSQL로 이관하지 않았다. 이전 도메인의 브라우저 세션과 진행 중 방은 새 도메인으로 자동 이전되지 않는다.

## 외부 연결

- Cloudflare 계정 내 터널: `bang-online-jeonghun`
- 터널 ID: `50b0b2a9-564c-4b33-9ea4-3e9218823192`
- 공개 경로: `bang-online.site`, 서비스 `http://127.0.0.1:8088`
- 가비아 네임서버: `rayne.ns.cloudflare.com`, `sage.ns.cloudflare.com`
- 서버 포트는 루프백에서만 수신한다. 공개 TLS는 Cloudflare가 처리한다.
- Cloudflare Universal SSL 활성화 및 Always Use HTTPS 설정을 완료했다.
- `www.bang-online.site`는 별도로 구성하지 않았다. 기본 주소는 `https://bang-online.site`이다.

## 검증

`node scripts/verify-selfhost.mjs`는 기본적으로 공개 도메인에서 상태 응답, SPA 직접 경로, 보안 쿠키, 4인 WebSocket 인증/입장/시작/개인 게임 정보, 닉네임 변경을 검증한다. HTTPS일 때 fetch의 기본 인증서 검증을 사용한다.

`BANG_VERIFY_RESTART=1`을 지정하면 **정훈서버의 게임 프로세스를 재시작**해 세션과 게임 복구까지 검증한다. 운영 중에는 유지보수 시간에만 사용한다. 검증용 방과 플레이어를 새로 생성한다.

DNS 전파 전에는 SSH 로컬 포워딩 `5210:127.0.0.1:8088`을 열고 `BANG_VERIFY_ORIGIN=http://localhost:5210`, `BANG_VERIFY_WEB_ORIGIN=https://bang-online.site`로 서버 내부 경로를 검증할 수 있다. 이 검증은 공개 DNS/HTTPS 검증을 대신하지 않는다.
