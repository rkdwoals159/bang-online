# 자동 준비 대기실 배포 기록

| 항목 | 결과 |
|---|---|
| 운영 URL | https://bang-online-ko.rkdwoals159.chatgpt.site |
| Sites 버전 | v13 |
| 소스 커밋 | `779116849ee85b0697358afbe4d56a45ae444b57` |
| 버전 ID | `appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_d334fc030eec8191ad7527854c9042d8` |
| 배포 ID | `appgdep_6ac360ab88cc8191be1bbd430e5cca8c` |
| 네이티브 상태 | succeeded |
| 완료 시각 | 2026-10-05 17:32:59 KST |
| 아카이브 SHA-256 | `sha256:d48739ea6e66e07844e7d3485c5c1b1874642d147932efe9a6bfb16135e663c7` |
| 아카이브 | 6942720 bytes · 115 files |
| 웹 / Sites 대기실·저장소 / Sites 매치 / PostgreSQL 대기실 | 174/174 · 30/30 · 16/16 · 30/30 PASS |
| 웹 / Sites / 서버 타입 검사 | 모두 PASS |
| 프로덕션 빌드 / 산출물 | PASS / PASS |

입장 자체가 준비라는 사용자 요청 D12를 적용했다. UI 준비 버튼·배지·WebMCP 도구를 제거하고 D1/PostgreSQL의 생성·JOIN·복귀 저장 및 시작 guard를 수정했다. 기존 준비 플래그는 시작 차단 조건으로 쓰지 않는다. 별도 DB 마이그레이션과 공용 프로토콜 변경은 없다. 기존 공개 범위를 유지했다.

로컬에서 준비 요청 없이 4인 시작과 종료 상태 fixture 후 실제 대기실 복귀/즉시 재시작을 확인했다. 전체 자연 게임을 완료한 검증은 아니다. 원본 95/97 및 D06/D18/S09 NOT RUN을 유지한다. 상세 내용은 REPORT.md를 참고한다.

네이티브 succeeded 응답을 배포 완료 근거로 기록했다. 완료 확인을 위한 운영 요청은 추가하지 않았다. GitHub main에는 소스와 이 후속 배포 기록을 반영한다.

