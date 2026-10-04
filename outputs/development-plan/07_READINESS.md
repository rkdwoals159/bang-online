# 07. 결정 기록과 구현 착수 준비

## 고정 결정

| ID | 결정 | 소유/후속 |
|---|---|---|
| P01 | 규칙셋 `base4-ko-online-1.0`, 4~7인 기본판, S5 일반 FAQ 보충 | 규칙 변경은 루트가 출처+버전+수락 케이스 동시 수정 |
| P02 | React/Vite + Node/Socket.IO + PostgreSQL, TypeScript 모노레포 | T01에서 당시 지원 버전 확인 후 lockfile 고정 |
| P03 | 단일 Node 서버, DB를 권위 저장소로 사용, Redis/분산 큐 제외 | T43–49. 다중 인스턴스는 후속 범위 |
| P04 | 비공개 초대, 게스트 쿠키 신원, 중간 참가 없음, 타이머 OFF | T44–48. 쿠키 분실하면 원래 자리의 권한 자동 복구 불가 |
| P05 | 채팅/음성 내장 안 함, 외부 대화 사용 | 탈락자는 정보 전달 없이 관전한다는 안내 표시 |
| P06 | 종료시 모든 역할 공개, 손패·덱은 계속 비공개 | UX/Projection. 공개 리플레이 기능 제외 |
| P07 | 임의 호스팅에 즉시 배포하지 않음 | 로컬 완성 후 운영 환경 선택 및 배포 단계 |
| P08 | 종료 후 재대기실 이동은 방장만 실행하고 같은 좌석을 유지하되 전원 ready를 초기화한다. 종료된 매치에서 direct `START_MATCH`는 기존 roster와 모든 ready가 유지된 경우에만 새 match로 허용한다. | `RETURN_TO_LOBBY` room command; 04_PROTOCOL §3.2; D18/D19 |
| P09 | 표시명은 앞뒤 공백 정리 후 1–20 Unicode code point를 허용하며 제어 문자를 거절한다. React 화면은 문자열을 HTML로 해석하지 않는다. | D17. 기존 02_PRODUCT_UX §4.1의 1–256 UTF-16 코드 단위 문구와 충돌해 더 구체적인 게스트 운영 기본값으로 이 기준을 선택하고 §4.1을 정정했다. 게임 규칙이 아니다. |

## 운영 기본값 제안

다음은 공식 게임 규칙이 아니라 운영 설정이다. 구현시 상수로 한 곳에 두고 서버·UI에서 동일하게 사용한다.

- 게스트 표시명: 공백 정리 후 1~20 Unicode code point, 제어문자 금지, HTML로 해석하지 않음. 표시명 중복 허용, 신원은 서버 playerId로 구분.
- 초대 코드: 서버 CSPRNG로 생성한 최소64bit 엔트로피, URL 및 수동입력 지원. 만료/없는방/권한없음은 정보 최소화 오류. 틀린 초대 preview/JOIN 실패는 IP+세션별 rolling 60초 최대5회, 여섯 번째부터 1초 지연을 시작해 재시도마다 2배, 최대15분으로 제한한다. 15분 유휴 또는 유효 초대의 성공한 입장 뒤 limiter 상태를 지운다. trusted proxy가 없으면 socket peer IP를 쓴다. 이는 게임 규칙이 아닌 운영 기준이다.
- 대기실 방장 이탈: 명시적으로 나갈 때 남은 좌석 중 가장 먼저 입장한 참가자에게 이양. 연결 끊김만으로는 이양/탈락하지 않음. 전원 명시 퇴장하면 대기실 닫기.
- 진행 중 나가기: 연결 해제로만 처리하고 재접속 대기. 판을 끝내려면 전원 합의 중단 기능을 후속 범위로 두며, MVP 방장에게 임의 종료 권한을 부여하지 않음.
- guest session 유효기간: 마지막 사용 후30일 제안. 만료보다 긴 비활성 게임은 운영 관리 대상. 장기 보관된 진행 상태의 자동 승패 판정 없음.
- 종료 match snapshot/receipt/events 보관: 30일 제안. 보관 만료 후 일괄 삭제, 개인정보/비밀 상태를 일반 로그에 남기지 않음. 활성 매치는 이 기간만으로 삭제하지 않음.
- 백업 및 복구: DB 일1회 백업 제안, 복원 절차 문서화. 원본 비밀 snapshot은 공개 정적 파일/클라이언트 로그에 보관하지 않음.

보관·호스팅 기본값은 출시 환경에 따라 최종 조정할 수 있다. 게임 엔진 개발을 막는 미정 요소는 아니다. 금액·동시접속 성능·가용성 목표는 측정 전에 보장하지 않는다.

## 에셋 통합

기존 `../assets` 폴더의 플레이22/인물16/역할4 이미지를 재사용한다. 현재 이미지42개를 80장의 서로 다른 카드 그림이라고 설명하지 않는다.

T54는 카드 type별 원본 숫자·무늬 영역을 확인해 마스크 좌표를 기록하거나 삽화 영역만 추출하여 UI 프레임을 구성한다. 새 표시는 rank/suit 카탈로그 기준. 이미지 원본의 잘못된 숫자와 새 숫자가 동시에 보이지 않아야 한다. 뒷면/HP 총알/버튼/접속 상태/아이콘은 자체 UI 도형으로 만들 수 있다. 원본이미지 누락시 텍스트 대체를 제공한다.

사용자 제공 허가 맥락을 유지하고 기존 ATTRIBUTION.md와 source manifest를 앱 크레딧에 연결한다. 추가 이미지 수집이나 외부 이메일 발송은 이 계획에 포함하지 않는다.

## 구현 착수 전 문서 검토 결과

- UX, 기술, 실행 계획의 패키지명을 `packages/contracts`, `packages/catalog`로 통일.
- 서버 outbox는 버전 무효화 통지, 클라이언트는 인증된 sync로 개인 projection 획득.
- 버림더미 전체배열 공개 대신 top+count 계약.
- 다중대상 공격은 전체 효과 해결 후 승리판정; 진행 cursor 저장.
- 카드별 rank/suit는 공식 목록에서 옮긴80장 카탈로그로 준비.
- 구현 작업 상태의 기준은 [05_EXECUTION_PLAN.md](05_EXECUTION_PLAN.md)와 [data/task-index.csv](data/task-index.csv)다. 수락 시나리오97개의 미검증 항목은 통과로 기록하지 않는다.

## 출시 전 남는 실제 작업

1. 기존 97-case 통합 기준의 남은 두 항목 D06/D18 및 공개 Sites에서의 실제 4인·7인 브라우저 대국, 재접속과 Worker 재시작 복구를 검증한다.
2. 42개 이미지의 한국어 카드명 및 숫자 마스크 좌표 시각 검토.
3. 배포된 Sites D1의 백업·복원 절차, 사용량 관찰, 운영 연락 경로를 정한다.
4. 게임 중 응답자가 장기간 돌아오지 않으면 판이 기다리는 제품 특성 고지. 타이머/봇/강제중단을 추가하려면 별도 온라인 규칙과 수락 케이스를 먼저 정의.

## 작업 결과 보고 포맷

```text
Task: Txx
Status: REVIEW / BLOCKED
Changed files:
Implemented rule / UX IDs:
Acceptance scenario IDs:
Commands actually run + results:
Unverified items:
Shared contract change requested:
Known failure / reproduction:
```

수락 ID를 코드/이슈에 기록할 때 `AT-A01`처럼 AT 접두사를 사용한다. 01_RULES의 인물 C01 또는 결정 D01과 06 문서의 케이스 C01/D01을 혼동하지 않도록 한다.

# Sites 무료 공개 배포 readiness

- 배포 대상은 Codex Sites Worker 호환 런타임과 Sites 관리 D1 binding으로 고정한다. 외부 플랫폼/DB/socket service로 우회하지 않는다.
- 기존 97개 통합 수락 기준은 현재 95/97 검증이며 D06/D18은 NOT RUN으로 유지한다. Sites S01–S09는 별도 집계한다.
- T106에서 S01–S08 로컬 evidence를 기록했고 T107에서 Sites 공개 배포를 마쳤다. S09는 배포·HTTP smoke 부분만 확인했으므로 실제 4인/7인 브라우저 대국과 재접속이 검증될 때까지 full online game release readiness는 미완료로 유지한다.
- 무료 이용량은 Cloudflare Workers Free 및 D1 Free 정책에 따른다. 현재 공식 수치는 Workers 100,000 requests/day, D1 5,000,000 rows read/day, 100,000 rows written/day, 5 GB total이다. 한도를 넘으면 관련 요청이 초기화까지 실패할 수 있다.
- 새 Site는 단 한 번 등록한다. `project_id` 외에 API credential, session secret 또는 production invite를 repo/workspace에 기록하지 않는다.

## T107 실제 공개 배포 결과 (2026-09-29)

- 배포 플랫폼은 Codex Sites Worker와 Sites 관리 D1 binding만 사용했다. 새 Site는 한 번만 등록했고 공개 권한은 사용자가 요청한 대로 `public`이다.
- URL: [https://bang-online-ko.rkdwoals159.chatgpt.site](https://bang-online-ko.rkdwoals159.chatgpt.site/)
- 배포 상태: **succeeded**. Sites version **1**, deployment `appgdep_6abace1e94f48191b386cc77d1f97309`.
- 배포 소스 SHA는 `99c2c41ad639295fd83601995c4498a0516e46e7`이며 이 SHA를 Sites 원격 `main`으로 push한 뒤 같은 SHA에서 빌드한 archive와 함께 저장했다. 단기 Git 토큰은 push에만 사용했으며 repository나 로그에 저장하지 않았다.
- 공개 URL smoke: `GET /` 및 `GET /rooms/new` → `200 text/html`; `GET /assets/cards/playing/01_bang.png` → `200 image/png`, 116,634 bytes; `GET /api/guest-sessions` → `204`. 이 확인을 위해 production room, guest identity, match 또는 게임 카드를 생성하지 않았다.
- S09는 **PARTIAL**이다. 공개 access/version/deployment와 HTTP 경로는 확인했지만 4인·7인 전체 브라우저 대국, 승패 결과, 재접속·복귀는 **NOT RUN**이다. T106의 local Sites 결과와 기존 95/97 통합 수락 tally 및 D06/D18 NOT RUN은 변경하지 않는다.
- 무료 운영량은 Cloudflare Workers Free의 100,000 requests/day 및 10 ms CPU/invocation, D1의 5,000,000 rows read/day·100,000 rows written/day·5 GB total 기준이다. 일일 한도를 넘으면 Worker 요청 또는 D1 query가 실패할 수 있다. 공식 문서: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 free-tier enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).


## UI/API 개선 후속 상태 (2026-10-04)

T112/T113/T114/T115/T117/T118 코드 수정 및 로컬 검증 완료. 계약 20, 엔진 78, Sites 39, 웹 98개로 자동 테스트 235/235 PASS, 타입 검사와 Sites 빌드 PASS. 로컬 실제 Worker HTTP의 4인/7인 게임 종료·역할 공개·복귀 및 실제 브라우저의 시작·게임판·확대·새로고침·모바일/데스크톱 화면을 확인했다. 측정값과 범위는 [개선 결과 보고서](../review-2026-10-04/IMPLEMENTATION_REPORT.md)에 있다. 기존 97-case 95/97, D06/D18 NOT RUN과 운영 S09 NOT RUN을 유지한다.

T116은 IN_PROGRESS: 동일 공개 Site 버전 2 게시가 기존 command_receipts 테이블 생성 충돌로 실패했다. 새 소스는 푸시/저장됐지만 운영 반영은 확인되지 않았다. 기존 SQL과 데이터는 보존했다. Sites 스킬의 적용 이력 불확실 시 중단 지시에 따라 플랫폼 마이그레이션 기록 정리가 선행되어야 한다. [배포 실패 근거](../review-2026-10-04/deployment-result.json)를 확인한다.
