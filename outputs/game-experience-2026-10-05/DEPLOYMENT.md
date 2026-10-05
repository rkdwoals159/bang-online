# 전체 게임 경험 배포 기록

| 항목 | 결과 |
|---|---|
| 운영 URL | https://bang-online-ko.rkdwoals159.chatgpt.site |
| Sites 버전 | v11 |
| 소스 커밋 | `dc2604b8232648a9377ea561f383ebcb2e8c4c84` |
| 버전 ID | `appgprj_6abacbd5c54c8191abdbb8c55b15de64~appgver_129927b447bc8191a9e53d03b5c5251d` |
| 배포 ID | `appgdep_6ac3513f155081918ed3511a9cf7b7c0` |
| 네이티브 상태 | succeeded |
| 완료 시각 | 2026-10-05 16:27:10 KST |
| 아카이브 SHA-256 | `sha256:7a713d0531a5f9948f90eae6770fa90ea3a011651ba9d5dbdb4927125fdc2248` |
| 아카이브 | 6942720 bytes · 114 files |
| 최종 웹 / 서버 projection / Sites 매치 테스트 | 167/167 · 9/9 · 16/16 PASS |
| 웹 / Sites 타입 검사 | PASS / PASS |
| Sites 빌드 / 루트 산출물 | PASS / PASS |

기존 공개 사이트의 접근 범위를 유지했다. DB 스키마·게임 규칙·명령 계약 변경은 없다. 서버 projection에는 비공개 카드 정보를 포함하지 않는 Panic/Cat 표현 이벤트가 추가됐다. 네이티브 succeeded 응답을 배포 완료 근거로 기록한다. 완료 확인만을 위한 운영 요청은 추가하지 않았다.

이번 결과는 로컬 회귀 테스트와 통제 fixture 검토다. 전체 운영 게임·모든 인물 조합·새 모바일 모달 실측이 완료됐다는 뜻이 아니다. 원본 95/97 및 D06/D18/S09 NOT RUN을 유지한다. 상세 제한은 REPORT.md를 참고한다.

GitHub main에 위 소스 커밋과 이 배포 기록의 후속 문서 커밋을 반영한다.
