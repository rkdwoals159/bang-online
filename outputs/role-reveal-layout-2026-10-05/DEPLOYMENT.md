# 역할·인물 소개 레이아웃 배포 기록

| 항목 | 결과 |
|---|---|
| 운영 URL | https://bang-online-ko.rkdwoals159.chatgpt.site |
| Sites 버전 | v14 |
| 소스 커밋 | `c2afd4f596ff2bdfaa499e163a37ed61b73d460d` |
| 버전 ID | `appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_a6395043c3d081918fd8396b5ab12bee` |
| 배포 ID | `appgdep_6ac3632e09d88191b1a420b7b2d6d658` |
| 네이티브 상태 | succeeded |
| 완료 시각 | 2026-10-05 17:43:41 KST |
| 아카이브 SHA-256 | `sha256:4d0f6c31456fc9c1c543085354bf216b70b37bcf9e888f8649a97c7038a2e972` |
| 아카이브 | 6942720 bytes · 115 files |
| 웹 테스트 | 175/175 PASS |
| 프로덕션 빌드 / Sites 산출물 | PASS / PASS |

이미지 상세보기 래퍼로 인해 인물 설명이 이미지 너비에 배치되는 문제를 수정했다. 320·375·1022·1280px 실제 너비의 로컬 SSR fixture에서 설명 너비와 카드 가로 넘침을 확인했다. 운영 게임 진행 검증이나 상세보기 상호작용 검증을 추가로 수행한 것은 아니다. 원본 수락 상태 95/97 및 D06/D18/S09 NOT RUN을 유지한다.

기존 공개 범위를 유지하고 네이티브 succeeded 응답으로 배포 완료를 확인했다. 완료 확인용 운영 요청은 추가하지 않았다. 소스와 후속 기록을 GitHub main에 반영한다.
