# 뱅! 기본판 에셋 목록

## 현재 이미지

| 분류 | 이미지 파일 수 | 게임 구성 수 | 상태 |
|---|---:|---:|---|
| 기본 카드 앞면 | 22 | 80장 | 한국어 카드면을 개별 PNG로 추출 |
| 인물 카드 | 16 | 16종 | 한국어 능력 설명 카드 이미지 |
| 역할 카드 | 4 | 7장 | 한국어 역할 카드 이미지 |
| 출처 원본 이미지 | 28 | — | STOPNOW 합성 이미지 12장 + 네이버 인물 카드 JPG 16장 보존 |

`cards/playing/`의 22개 이미지는 카드 종류당 1장씩이며, 기본 덱의 실제 장수는 `asset_manifest.csv`에 기록했습니다. 인물 카드 16종과 역할 카드 4종도 각각 이미지가 있습니다. 파일별 출처·크기·SHA-256·변환 정보는 `extracted_source_manifest.csv`에서 확인할 수 있습니다.

## 한국어 카드 이미지 출처

- 플레이 카드 22종: [STOPNOW, 뱅 카드 설명 글](https://stopnow.tistory.com/25)의 합성 이미지에서 개별 크롭했습니다. 원본 합성 10장은 `source_images/stopnow_article25/`에 있습니다.
- 인물 카드 16종: [모노폴리 가이드, 뱅 캐릭터 평가](https://m.blog.naver.com/monopolygame/20134581005)에 실린 카드별 JPG 이미지를 PNG로 변환했습니다. 원본 JPG는 `source_images/naver_blog_monopolygame_20134581005/`에 있습니다. 네이버 글은 원 출처로 q3c273 Tistory의 닌자토끼 블로그를 표기합니다.
- 역할 카드 4종: [STOPNOW, 뱅 룰 규칙 설명 글](https://stopnow.tistory.com/24)의 카드 합성 이미지에서 보안관, 부관, 무법자, 배신자를 개별 크롭했습니다. 원본 합성 2장은 `source_images/stopnow_article24/`에 있습니다.

STOPNOW 글의 라이선스와 변경사항은 `ATTRIBUTION.md`에 기록했습니다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 알려준 범위에 따라 사용합니다.

## 남은 미확보 이미지

카드 뒷면, 개인 보드, 요약 카드, 총알 토큰, 별도 로고는 아직 별도 이미지가 없습니다. 상태와 수량은 `asset_manifest.csv`를 확인하세요.

## 폴더

- `cards/playing/` — 한국어 기본 플레이 카드 22종
- `cards/characters/` — 한국어 인물 카드 16종
- `cards/roles/` — 한국어 역할 카드 4종
- `cards/backs/`, `boards/`, `tokens/` — 승인된 별도 파일용 폴더
- `source_images/` — 출처 대조를 위한 원본 이미지 28장
- `preview/` — 카드 미리보기 시트
- `ui/` — UI 아이콘과 배경용 폴더
