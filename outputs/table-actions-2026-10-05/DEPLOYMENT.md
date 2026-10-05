# 운영 반영 기록

- 운영 버전: **18**
- 상태: **succeeded**
- 반영 시각: 2026-10-05T11:25:04.131514+00:00 (KST 2026-10-05 20:25)
- 주소: [BANG! 온라인](https://bang-online-ko.rkdwoals159.chatgpt.site)
- 소스: `127bbd862c8be6c8c0e7335a560e5eb5c9b78085`
- 버전 ID: `appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_93867c70280481918f39e7e9bbc7e0f4`
- 배포 ID: `appgdep_6ac388fff32081919ce54223957e9c90`
- 아카이브 해시: `sha256:dffc446c4257d8f1640b58ba93468388a503eb731b903a279481e98d6d23b878`

액션 요청·선택·비용·버리기·게임 종료 결과를 모달에서 테이블 중앙의 일반 영역으로 옮겼다. 배경을 가리거나 닫기/다시 열기 단계를 요구하지 않는다.

변경 및 검증 범위는 [CHANGES.md](CHANGES.md)에 기록했다. 웹 테스트 194개, TypeScript 검사, 최종 production build가 통과했다. 배포 성공은 Sites의 해당 배포 ID에 대한 succeeded 응답으로 확인했다.

기존 97개 수락 기준의 미실행 항목은 통과로 바꾸지 않았다. 이 배포의 성공은 운영 전체 자연 대국 검증을 뜻하지 않는다. 소스 커밋 이후 추가 커밋은 이 운영 기록만 포함한다.

