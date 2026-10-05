# BANG Table 디자인 기준

## 목적

친구들과 한국어 BANG! 기본판을 진행하는 실제 게임 화면. 현재 응답, 손패, 상대 상태를 빨리 파악한다. 첫 화면에서 방 생성 또는 초대 참가를 바로 선택한다.

## 스킬 적용

설치: `C:/Users/user/.codex/skills/ui-ux-pro-max`. 원본: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill, `.claude/skills/ui-ux-pro-max`.

- `multiplayer board game tabletop --design-system --density 8 --variance 4`: Minimalism, felt green + gold 게임 팔레트가 게임 맥락에 맞음을 확인했다.
- 결과의 Feature-Rich Showcase는 홍보 페이지 패턴이므로 실제 게임 화면에 적용하지 않는다. `tabletop gaming interface` 재검색에서도 홍보 패턴과 비용 높은 3D 권고가 나왔다. 아래 작업 화면 구조는 기존 게임 흐름과 스킬의 일반 접근성/성능 지침을 바탕으로 직접 정했다. 이 구조를 검색으로 검증된 패턴이라고 기록하지 않는다.
- `responsive touch card selection --domain ux`: Web Touch Friendly와 8px+ 터치 간격.
- `derived state stable keys --stack react`: 안정적인 목록 키, 파생 값의 불필요한 state/effect 금지.
- quick-reference 접근성, 입력, 성능, 반응형, 타이포그래피 기준 적용.

## 전역 토큰

`apps/web/src/app/tokens.css`가 실제 정본이다. canvas #F2EFE6, surface #FFFDF7, ink #20372E, muted #596B61, forest #193D30, felt #133D30, felt edge #102B24, brass #E8BD69, brass ink #77551B. 어두운 게임판에는 #F6F2E7 본문과 #B8CCBF 보조 텍스트. 밝은 패널에는 ink/muted 사용.

기본 글꼴: system-ui / Malgun Gothic. 별도 폰트 요청 없음. 본문 14–16px, 보조 라벨 최소 12px, line-height 1.5 이상. 제목만 balance와 좁은 tracking. 간격 4/8/12/16/24/32, 모서리 8/12/20. 상호작용 150ms 색 변화. reduced-motion 존중. 추가 효과 라이브러리 없음.

## 화면

- 데스크톱 게임: 전체 폭 턴/응답 배너, 왼쪽 공개 테이블, 오른쪽 손패/응답, 테이블 아래 접힌 공개 기록.
- 1100px 이하: 턴 배너 → 행동/응답 → 공개 테이블 → 기록. 손패는 충분한 크기의 가로 스크롤. 공개 정보는 겹치지 않는 grid.
- 4/7인 모두 좌석 순서와 상대 역할 비공개를 유지한다. 공개 인물 그림만 표시한다.
- 시작/초대/대기실: 직접적인 핵심 작업, 짧은 안내, 읽기 쉬운 입력과 좌석 상태.
- 역할: 역할/인물 설명을 보존하고 모바일 세로 배열. 결과: 승리 진영/역할 공개/대기실 복귀를 우선 표시.

## 상호작용

44px 이상 주요 버튼, 8px 이상 간격, 눈에 보이는 focus, 색과 텍스트를 함께 사용. 상세 창 Escape/초점 복귀 보존. 숨겨진 카드를 보여주지 않는다. 버릴 순서는 기존 버튼/선택지로 조절한다. 드래그 전용 조작 없음. 게임 규칙/API/영수증 의미 변경 없음.
