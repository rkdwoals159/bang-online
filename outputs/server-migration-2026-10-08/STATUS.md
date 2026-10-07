# 정훈서버 이전 진행 기록

## 완료

- Tailscale SSH 연결, macOS arm64 서버/권한/기존 서비스 확인.
- 사용자 홈에 Node, PostgreSQL, Caddy, cloudflared 설치.
- PostgreSQL 영속 DB, 루프백 전용 API와 정적 웹 프록시 설치.
- 프런트엔드 독립 진입점을 Socket.IO로 고정하고 실제 운영 번들 생성.
- 사용자 LaunchAgents로 게임/DB/웹/터널 재시작 구성, 매일 04:00 DB 백업 구성.
- PostgreSQL 백업 생성 및 pg_restore 목록 읽기 확인.
- Cloudflare 무료 도메인 및 게임 전용 터널 생성. 터널 Healthy 확인.
- 가비아 소유자 인증 후 Cloudflare 네임서버 2개 적용 완료 화면 확인.

## 검증 결과

- 웹 TypeScript 검사 통과.
- 기존 Node 서버 런타임 테스트 4/4 통과.
- SSH 포워딩을 통한 실제 정훈서버 검증 통과: 상태 응답, SPA 직접 경로, Secure/HttpOnly 쿠키, 4명 WebSocket 인증, 방 생성/입장, 게임 시작, 개인별 게임 정보, 닉네임 변경.
- 정훈서버의 게임 서버 재시작 후 4명 세션과 개인 게임 정보 복구 확인.
- Postgres.app macOS 코드 서명 검증 통과.

검증 스크립트의 초기 재시작 검사에서 matchId를 snapshot 내부에서 찾는 잘못된 기대값이 실패했다. 공용 계약에 따라 응답 최상위 matchId를 검사하도록 수정한 뒤 전체 재시작 검증 통과.

## 현재 대기

- Cloudflare: `Waiting for your registrar to propagate your new nameservers`.
- 일반 DNS 질의는 아직 SERVFAIL로 공개 HTTPS 접속을 검증하지 못함.
- 새 도메인 검증 전에는 기존 Sites의 공개 서비스를 중지하지 않음.
- 기존 Sites D1 데이터는 보존 중이며 PostgreSQL로 이관되지 않음.
- 기존 수락 케이스 95/97 상태를 이 배포 검증만으로 올리지 않음.

## 남은 전환 순서

1. 공개 DNS가 Cloudflare로 반영되고 HTTPS 인증서가 유효한지 확인.
2. 공개 도메인에서 verify-selfhost.mjs 실행 및 브라우저 게임 화면 확인.
3. 실제 정상 동작 확인 후 기존 Sites 공개 운영 중지. 제공된 Sites 도구에는 호스팅 중단 기능이 없으므로 공개 접근 제한으로 대체 가능한지 확인하고 실제 적용 결과를 구분해서 기록.

운영 설명: `deploy/selfhost/README.md`.
