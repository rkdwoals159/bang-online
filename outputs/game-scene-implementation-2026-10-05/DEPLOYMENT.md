# 운영 반영 기록

- 운영 버전: **17**
- 상태: **succeeded**
- 반영 시각: 2026-10-05T10:44:23.048284+00:00 (KST 2026-10-05 19:44)
- 주소: [BANG! 온라인](https://bang-online-ko.rkdwoals159.chatgpt.site)
- 소스: `726a9bce192b75669ba671d033f9780431f9f49a`
- 버전 ID: `appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_9246b1534d7481918b16168461411f7e`
- 배포 ID: `appgdep_6ac37f778178819188405bc3544803e6`
- 아카이브 해시: `sha256:b9cc6c6ce12668bd479c2cc3a460126b8a4aecc257804a4dc10c5d2785f4fbc0`
- 아카이브: 7024640 bytes / 115 files

승인된 전체 게임 씬을 실제 운영 게임에 연결했다. 4~7인 타원 테이블, 손패/HUD, 카드·인물 상세, 공동 대응/잡화점 창, 카드 이동·총격·방어·회복·폭발·탈락·승리 연출, 설정 및 기록 서랍을 반영했다.

[변경·검증 결과](IMPLEMENTATION.md)를 참고한다. 자동 테스트 629개 및 TypeScript/production build가 통과했다. 운영 게시 성공은 Sites의 이 배포 ID에 대한 succeeded 응답으로 확인했다. 로컬 제어 경기의 검증을 운영 전체 자연 대국 또는 미실행 수락 항목의 통과로 기록하지 않는다.

기존 버전 16 기록은 `../table-experience-2026-10-05/DEPLOYMENT.md`에 보존했다. 게시 소스 커밋 이후의 추가 커밋은 이 운영 기록만 포함한다.

