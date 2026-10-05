# 운영 배포 v19

- 완료: 2026-10-05 22:48 KST
- URL: https://bang-online-ko.rkdwoals159.chatgpt.site
- 프로젝트: appgprj_6abacbd5c54c8191abdbb8c55b15de64
- 버전: 19
- 저장 버전: appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_39e9657d73c08191b61b0afc01a381b8
- 배포: appgdep_6ac3aaa59d508191b48c735f42b8891e
- 소스: 4a674afbea5539f007afce4dd1cffccb999e68b0
- 결과: Sites 네이티브 배포 응답 succeeded, failure_message=null.
- 공개 범위: 기존 public 유지. 환경변수·DB 스키마 변경 없음.

효과음 26종, 즉시 오디오 예약, 음량 조절과 직전 상세 설명 잘림 수정(4d9e95c)을 포함한다. 207개 웹 테스트 PASS 및 최종 효과음 테스트 29개 PASS, TypeScript PASS, 프로덕션 빌드 PASS. 패키징 가능한 로컬 Worker/클라이언트 빌드 결과를 소스 푸시 후 저장·배포했다.

배포 후 문서 정정: CHANGES.md의 로컬 검증 실패 원인을 API 제한이라고 확정하지 않는다. 스냅샷 없는 응답 및 새 5인 fixture 생성 시 API 500을 관측했다. 첫 4인 역마차 효과음과 음량 조절 검증은 완료됐지만 추가 자연 게임 및 실제 스피커 청취 검증은 완료되지 않았다.

이 문서 이후 기록을 담은 GitHub 커밋과 위 배포 소스 커밋은 구분한다. 운영 전체 자연 게임, D06/D18, S09는 이번 변경으로 새롭게 통과 처리하지 않는다.
