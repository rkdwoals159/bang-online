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
- 공개 `https://bang-online.site`에서 상태 응답, SPA 경로, Secure/HttpOnly 쿠키, 4명 WebSocket 인증, 방 생성/입장/시작, 개인별 게임 정보, 닉네임 변경 검증 통과.
- Cloudflare Universal SSL Active 확인. HTTP 접속의 HTTPS 301 전환 확인.
- 기존 Sites 접근 정책 revision 3, custom / 소유자 1명 / 그룹 0개 확인. 익명 홈페이지와 API 접근 모두 HTTP 401 확인.

검증 스크립트의 초기 재시작 검사에서 matchId를 snapshot 내부에서 찾는 잘못된 기대값이 실패했다. 공용 계약에 따라 응답 최상위 matchId를 검사하도록 수정한 뒤 전체 재시작 검증 통과.

## 전환 결과

- 최초 DNS 전파 대기 중 SERVFAIL 및 SSL handshake 실패를 관측했으나, Cloudflare 활성화/인증서 발급 이후 공개 검증 통과.
- 기존 Sites는 소유자 전용으로 전환해 일반 이용자의 공개 접속을 종료함. Sites 호스팅 리소스의 undeploy/suspend 도구는 제공되지 않아 리소스 자체는 active 상태로 보존.
- 기존 Sites D1 데이터는 보존 중이며 PostgreSQL로 이관되지 않음. 기존 세션/진행 중 방이 새 도메인으로 자동 이전되는 것은 아님.
- 기존 수락 케이스 95/97 상태를 이 배포 검증만으로 올리지 않음.

## 배포 출처

- 구현 커밋: `a5a16c1545a98dc18fd468199d5b1016b7a80b31` (GitHub main 업로드 확인).
- Node 번들 SHA256: `673f9f68b74ae9ce336696f4f8f23bbc1d279ae9113fa88c163e80b5fe45e84e`.
- 웹 index SHA256: `78a6d450a27c6df4431bf999c70b6b39a3d282483e62b71e11a66e11b7918e49`.
- 로컬 산출물과 서버 파일의 SHA256 일치 확인.

향후 서버 재부팅 전 로그인 이후 사용자 LaunchAgents 실행 조건 및 동일 서버 백업의 한계를 운영 문서에서 확인한다.

운영 설명: `deploy/selfhost/README.md`.
