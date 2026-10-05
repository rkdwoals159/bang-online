# 운영 배포 v22

- 완료: 2026-10-05 23:24 KST
- URL: https://bang-online-ko.rkdwoals159.chatgpt.site
- 프로젝트: appgprj_6abacbd5c54c8191abdbb8c55b15de64
- 버전: 22
- 저장 버전: appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_748222bde7248191a4576c1fa1e21022
- 배포: appgdep_6ac3b2fe598c8191836453265819b123
- 소스: 334165f4328564cdb0f6f7ef480fc65a57671d81
- 결과: succeeded, failure_message=null.
- 기존 public 범위 유지. DB·환경변수 변경 없음.

장착 카드창과 설정창은 `닫기` 하나로 완전히 닫으며 재열기 패널을 남기지 않는다. 장착 확인창은 별도 inspection host에 표시한다. Escape/중첩 상세창/원래 버튼의 포커스 복원과 모바일 가로 넘침 부재를 확인했다.

전체 웹 테스트 216 PASS(관련 22개는 부분집합), Web TypeScript/프로덕션 빌드 PASS. 고정 스냅샷 QA를 사용했으며 전체 자연 게임과 기존 D06/D18/S09는 새롭게 통과 처리하지 않는다. 이 기록을 포함하는 이후 문서 커밋과 위 배포 소스 커밋은 구분한다.
