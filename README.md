# 뱅! 온라인

한국어 BANG! 기본판 4–7인 온라인 플레이 프로젝트입니다.

- 운영 환경: Codex Sites Worker, D1, same-origin HTTP/SSE
- 개발 환경: pnpm 모노레포, React 웹 UI, 공용 게임 엔진/계약
- 실행·호스팅 안내: [Sites README](apps/site/README.md)
- 규칙·구현 결정: [기능 계획서](outputs/development-plan/00_README.md)
- UI/API 개선 및 검증 범위: [개선 결과](outputs/review-2026-10-04/IMPLEMENTATION_REPORT.md)
- 최신 로직·성능 재검토: [수정 목록과 증거](outputs/review-2026-10-04/logic-performance-audit/REPORT.md)

## 설치 및 빌드

저장소에 지정된 Node.js/pnpm 버전을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm run sites:db:check
pnpm run sites:build
node scripts/verify-improvements.mjs
node scripts/verify-improvements.mjs --audit
```

로컬 빌드 실행 전에는 로컬 DB를 준비합니다. 아래 명령은 `--local`로만
실행하며 운영 DB에 접근하지 않습니다.

```sh
pnpm --filter @bang/site db:local
pnpm --filter @bang/site start
```

`.openai/hosting.json`은 기존 Site의 식별자와 논리 DB binding을 포함합니다.
자격 증명이나 운영 데이터는 저장소에 포함하지 않습니다.
실행·검증 상세 명령은 각 앱 README와 기록된 검증 JSON을 참고하세요.

## DB 마이그레이션

배포가 `drizzle/`의 스키마 SQL을 적용합니다. 요청 시에는 스키마 준비 상태만
확인하며 테이블을 생성하거나 변경하지 않습니다. 과거 앱 초기화에서 적용한
SQL 원본과 체크섬은 [db/legacy](db/legacy/README.md)에 보존했습니다.
성공적으로 게시된 마이그레이션과 metadata는 변경하지 않고 새 파일을 추가합니다.

## 검증 상태

원래 97개 통합 수락 기준 중 95개가 검증됐으며 D06/D18은 NOT RUN입니다.
로컬 API/브라우저 검사와 운영 환경의 전체 대국 검증을 구분해 기록합니다.
운영 전체 4인·7인 브라우저 대국 및 재접속 S09는 NOT RUN을 유지합니다.

카드/인물/역할 이미지는 이 프로젝트에 대해 사용자에게 허가된 에셋입니다.
원작 게임 및 에셋에 대한 별도의 재배포·사용 허가를 이 저장소에서 부여하지 않습니다.
