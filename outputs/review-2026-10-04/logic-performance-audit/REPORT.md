# 로직·성능 재검토 — 2026-10-04

사용자가 요청한 맥주 사용, 카드 처리 지연, 리로드처럼 보이는 현상, 페이지 무게를 중심으로 엔진 → 저장소 → HTTP/SSE → 브라우저 상태 → 화면을 검토했다. 사용자의 최종 지시에 따라 기존 작업자를 중단하고 주 에이전트가 수정, 추가 검토, 통합 검증과 게시를 직접 진행했다.

## 발견 및 수정

| 항목 | 확인한 문제 또는 원인 | 수정 | 검증 근거 |
|---|---|---|---|
| 맥주 | R14에 따라 만피·생존자 2명일 때 사용 가능하지만 회복 0 안내가 없어 오사용하기 쉬움 | 회복 없는 이유를 표시하고 확인 체크 후 사용. 카드·선택·버전이 바뀌면 기존 확인 재사용 불가 | actions 테스트, 실제 로컬 브라우저의 선택·확인·취소·재선택·사용 |
| 경로 이동 | 각 페이지에 게임 앱을 따로 마운트해 방 생성·역할→게임 이동에서 세션 복구와 앱 초기화가 반복됨 | 공통 RootLayout에 게임 앱 1개 유지 | persistent-shell 테스트, 브라우저 화면과 도구 등록의 유지 확인 |
| 정상 카드 사용 | 일반 사용 자체의 전체 문서 리로드는 로컬에서 재현되지 않음. ACK 이후 동기화와 화면 재계산이 지연처럼 보임 | 아래 요청·계산 최적화 및 ACK 단계 표시 | 실제 맥주·야생마 사용 시 같은 화면 루트 유지, Worker 요청 로그 |
| 후보 생성 CPU | 카드마다 전체 효과를 시뮬레이션. Sid는 모든 손패 쌍마다 카드 위치 검사·버리기·회복까지 반복 | 기존 순수 명령 검증 재사용. 추가 효과 검증이 필요한 카드만 시뮬레이션. Sid 소유·위치 검사 한 번 | 기존 방식과 16인물×4/5/6/7인 64 fixture 및 추가 상황의 후보 배열 완전 일치, 실제 명령 승인 검증 |
| 명령 API | 일반 정상 명령의 D1 binding 호출 9회가 순차 누적 | 인증 1회 + 멤버십/상태/영수증 읽기 batch 1회 + 원자적 쓰기 batch 1회 = 3회 | 호출 계수 테스트. 재전송은 2회. 쿼리/SQL 문장이 3개라는 의미는 아님 |
| 동시 실행 | 빠른 경로에서도 멤버십·메타데이터 변경에 대한 원자적 보호 필요 | 쓰기 batch의 버전/eventSeq/규칙/스키마/멤버십 guard 유지·보강 | 탈퇴 경합, CAS 불일치, 롤백, 동시 명령, 영수증 재전송 테스트 |
| 재전송 | 이후 상태가 손상되거나 지원 불가가 되어도 기존 영수증을 재확인할 수 있어야 함 | 현재 멤버십 확인 뒤 영수증을 상태 decode보다 먼저 처리 | 손상·지원 불가 상태의 replay, 외부인 차단, 다른 경기 commandId 재사용 테스트 |
| 초기 API | 동시에 세션 복구/참여 방 복구를 요청하면 같은 GET 반복 | 진행 중 요청 공유 | Sites/Socket transport 테스트 |
| 중복 sync | 이미 진행 중인 일반 동기화까지 dirty로 처리하여 후속 요청이 중복 발생 | 실제로 덜 반영된 새 버전·커서 hint에만 후속 sync | 최신 hint 1회 후속 / 이미 반영된 hint 0회 후속 테스트 |
| 경기 시작·재시작 | 버전 있는 방 ACK를 적용해도 새 경기 snapshot을 즉시 가져오지 못하는 경로 | ACK의 새 activeMatchId를 연결하고 필요한 경기 projection 요청 | transport START_MATCH/RESTART_MATCH 테스트, 브라우저 시작 흐름 |
| 백그라운드 갱신 | 예전 경기 resource 추적이 남아 불필요한 polling 가능 | 화면 watch/복구된 참여/현재 방 경기 참조의 수명 관리 | transport watch 해제·경기 변경·복구 테스트 |
| 세션 캐시 | 만료 또는 새 게스트 발급 뒤 이전 참가자의 개인 snapshot이 남음 | 신원 변경/인증 상실 시 projection 초기화. 다른 viewer의 방·경기 응답 차단. 같은 신원 복구는 캐시 유지 | 만료·신원 변경·동일 신원 및 지연된 이전 게스트 HTTP sync regression 4개 |
| 로그 화면 | 이벤트 누적·접힌 로그의 DOM 렌더가 화면 비용 증가 | 보관·렌더 최근 최대 100개, 접힌 로그는 내용 미마운트, projection memo | transport/status 테스트, 실제 접힌 로그 행 0개 |
| 로그 재접속 | Site 쿼리 LIMIT 100은 오래된 커서 이후 첫 100개만 반환. 최신 eventSeq로 커서를 올려 최근 기록 누락 | 최신 100개 범위로 조회하고 잘린 재생은 full snapshot으로 명시 | 210개 이벤트, 오래된/최근/미래 커서와 private payload 제거 테스트 |
| Sid 화면 | 모든 비용 쌍을 버튼으로 렌더해 손패 n장에 O(n²) DOM | 자기 손패 선택기 2개, 서버의 실제 비용 쌍 proposal만 제출 | actions 테스트, 브라우저 동일 카드 중복 불가·정확한 쌍 선택 |
| 처리 안내 | 접수와 최신 상태 반영을 구분하지 않아 무응답처럼 보임 | 전송 → 접수됨/업데이트 중 → 완료 단계 안내 | action/reaction ACK callback 테스트 |
| 이미지·정적 파일 | 카드 디코딩 및 정적 재방문 요청 비용 | async decode. 해시 JS/CSS 1년 immutable, 안정 카드 경로 1시간 재검증 | 카드 테스트, 빌드 `_headers` 포함 검사, 로컬 Worker HTTP header 검사 |
| 첫 로딩 | 동적 게임 모듈이 준비되기 전 빈 화면 | 한국어 로딩 안내 | UI mount 및 실제 브라우저 |

맥주는 [규칙 정본 R14](../../development-plan/01_RULES.md)에 따른 동작을 유지했다. 사용자가 선택한 “규칙 유지 + 회복 없는 사용에 확인 추가”를 적용했다. 새 게임 규칙이나 임의 응답을 만들지 않았다. 공용 wire 계약 및 적용된 DB migration은 변경하지 않았다.

## 측정과 증거

최종 자동 테스트 **657/657 PASS**: 계약 20, 카탈로그 14, 엔진 365, Node 서버 91, Site 50, 웹 117. 타입 검사, private 데이터 fixture 검사, Worker 빌드 및 staging PASS. Drizzle check PASS. 로컬 실제 Worker HTTP의 4인 게임은 명령 57회/반응 19회, 7인은 명령 47회/반응 22회로 종료·역할 공개·로비 복귀를 확인했다. 명령 첫 전송의 정확한 중복 영수증 재전송도 각각 통과했다. 로컬 서버는 검사 후 종료했다.

후보 생성 CPU 비교(7인 Sid 합성 fixture, 각 10회 측정의 상위 중앙값, ms):

| 손패 | 동일한 후보 수 | 수정 전 | 수정 후 |
|---:|---:|---:|---:|
| 4장 | 9 | 1.420 | 0.074 |
| 12장 | 92 | 9.019 | 0.508 |
| 40장 | 835 | 38.938 | 1.343 |
| 80장 | 3,271 | 128.806 | 2.835 |

이는 후보 생성 함수의 로컬 CPU 비교이며 운영 카드 사용 왕복 시간과 다르다. 후보 수/순서/내용은 동일하다.

- [최종 자동 검증](verification.json): 각 명령, 입력 fingerprint, 종료 코드, 테스트 수와 빌드 기록. 재실행: `node scripts/verify-improvements.mjs --audit`.
- [운영 수정 전 표본](production-before.json): 최근 100 Worker 로그 중 카드 명령 3건의 Worker wall time 917/945/955 ms. 표본이 작고 브라우저 왕복 시간/P95가 아니다. SSE canceled와 긴 wall time은 스트림 수명으로 별도 해석했다.
- [후보 생성 CPU 비교](action-candidates.json): 동일 fixture를 이전 방식과 수정 방식으로 교차 실행하며 후보 배열의 완전 일치를 검사한다. `node --import ./apps/site/node_modules/tsx/dist/loader.mjs scripts/profile-action-candidates.mjs outputs/review-2026-10-04/logic-performance-audit/action-candidates.json`. 실제 운영 지연 감소율로 해석하면 안 된다.
- [브라우저 검사 범위](browser-verification.json), [맥주 확인 화면](beer-confirmation.jpg), [모바일 화면](mobile-after.jpg).
- 최종 4/7인 로컬 HTTP 대국, 정적 cache header 및 배포 영수증을 같은 디렉터리에 기록한다. 로컬 HTTP 대국은 복수 독립 브라우저 대국의 대체 증거가 아니다.
- [4인 HTTP 대국](full-flow-4.json), [7인 HTTP 대국](full-flow-7.json), [정적 캐시 HTTP 검사](static-headers.json): JS/CSS 경로 1년 immutable, 카드 1시간, API no-store를 빌드한 로컬 Worker에서 실제 확인했다.

## 검증 중 발견한 별도 사항

- 기존 Node recovery 테스트가 공용 계약에 없는 가상 `PLAY_BANG/privateCard` 옵션을 저장하여 실패했다. fixture를 정식 YIELD/TAKE_HIT/ACCEPT_ELIMINATION/ORDER_CARDS 옵션으로 수정하고 복구·privacy 기대를 유지했다. 운영 계약을 완화하지 않았다.
- 테스트 도중 소스가 바뀌어도 `--resume`이 명령 문자열만으로 PASS를 재사용할 수 있었다. 입력 파일 fingerprint와 실행 전후 일치 확인으로 수정했다.
- Miniflare를 사용하는 파일이 종료 대기에 머무는 현상이 재발하여 완료되지 않은 최종 시도를 별도 보존했다. Site runner에 `--test-force-exit`을 적용하고 개별 테스트 180초 및 전체 프로세스 제한을 둔다. 테스트가 실제 완료되기 전의 체크포인트는 PASS로 승격하지 않는다. `--resume`은 같은 입력 fingerprint의 이미 완료된 묶음만 재사용한다.
- 초기 병행 실행 중 Miniflare bridge fetch 실패/파일 종료 timeout이 발생했다. 초기 JSON과 TAP을 보존했다. 로컬 Worker 및 다른 무거운 suite를 중단한 독립 직렬 재실행은 49/49 PASS였고, 최근 로그 regression 추가 후 전체 검증을 다시 실행했다. 초기 실패를 통과로 덮어쓰지 않았다.

## 운영 반영

동일한 공개 Site **버전 4 게시 SUCCEEDED**, 2026-10-04T11:34:59Z. [운영 사이트](https://bang-online-ko.rkdwoals159.chatgpt.site), 소스 `0196a34eff7c99f17fdfc14f91016ab3462f05f3`. GitHub main 코드 push 성공. [배포 영수증](deployment-result.json)에 버전/배포/아카이브/검증 범위를 기록했다. 운영 DB fixture 생성 및 migration 변경 없이 게시했다. 기존 탭은 새 UI를 읽기 위해 한 번 새로고침하면 된다.

## 검증 범위와 남아 있는 제한

원래 수락 기준 **97개 중 95개 검증, D06/D18 NOT RUN**은 유지한다. 운영 환경 전체 4/7인 독립 브라우저 대국·재접속 S09도 **NOT RUN**이다. 이번 자동 테스트 합계는 원래 97개 수락 케이스 합계와 다르다.

Sid의 완전한 서버 후보 목록은 가능한 손패 쌍 수에 비례한다. 모든 80장이 한 손에 있는 합성 fixture에서 응답 데이터 약 0.5 MB는 남는다. 화면 DOM과 효과 시뮬레이션 비용을 줄였으며, 서버가 승인한 정확한 후보를 사용하는 계약은 유지했다. 이미지 원본 전체 42개 약 4.28 MiB를 축소했다고 주장하지 않는다. 실제 표시 카드의 lazy loading·캐시·decode 비용을 개선했다.

Sites의 SSE fanout은 D1 조회 주기와 네트워크 지연을 갖는다. 다른 사람 화면이 즉시 0 ms로 갱신된다고 보장하지 않는다. 새 게시 후 운영 P95는 측정되지 않았다. 로컬 브라우저 Navigation Timing의 리로드 횟수도 측정하지 않았으며, 실제 화면 루트/도구 등록 유지와 HTTP 요청을 근거로 판단했다.

모든 가능한 오류가 없다는 보장은 하지 않는다. 검토 범위에서 확인한 문제와 경합 방어를 수정하고, 통과·미실행·측정 한계를 각각 기록했다.
