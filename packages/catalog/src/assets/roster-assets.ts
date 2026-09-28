export type RosterAssetCategory = "role" | "character";

export interface RosterAssetAttribution {
  creator: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceImagePath: string;
  license: string;
  licenseUrl?: string;
  originalSource?: string;
  changes: string;
  creditLine: string;
  gameArtworkRightsNote: string;
}

/** A prepared roster image and its target URL under apps/web/public/assets/cards/. */
export interface RosterAsset {
  id: string;
  category: RosterAssetCategory;
  /** Path format required by the shared catalog schema. */
  assetPath: string;
  /** Browser URL once T54 copies the image into the web public directory. */
  publicUrl: string;
  fileName: string;
  mimeType: "image/png";
  widthPx: number;
  heightPx: number;
  sha256: string;
  attribution: RosterAssetAttribution;
}

/** Role and character file metadata sourced from extracted_source_manifest.csv and ATTRIBUTION.md. */
export const rosterAssets = [
  {
    "id": "character-bart_cassidy",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_bartcassidy.png",
    "publicUrl": "/assets/cards/characters/01_bartcassidy.png",
    "fileName": "01_bartcassidy.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "042cd8d8bf1b02ac8688ed508a2f887a1574d3f413e9b9903579bda2e5280a3f",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_01.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-black_jack",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_blackjack.png",
    "publicUrl": "/assets/cards/characters/01_blackjack.png",
    "fileName": "01_blackjack.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "9309aecdad5145a5712a3ba6ea50fc26d954c5815dda3f7e07a397ecd18f975a",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_02.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-calamity_janet",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_calamityjanet.png",
    "publicUrl": "/assets/cards/characters/01_calamityjanet.png",
    "fileName": "01_calamityjanet.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "e4a1ecf667463efb6457c25d98a7cd05843ec6e7c7e7169520f8af5dae1f7846",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_03.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-el_gringo",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_elgringo.png",
    "publicUrl": "/assets/cards/characters/01_elgringo.png",
    "fileName": "01_elgringo.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "5368b69731d0acdd52ed9832b61258d81e0da7e7b464654cfe8a36e7af142193",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_04.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-jesse_jones",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_jessejones.png",
    "publicUrl": "/assets/cards/characters/01_jessejones.png",
    "fileName": "01_jessejones.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "76260a4d49b20bf8cc6e9b51c36a4fc1e1b861c879d8996a31df97c76b4c6818",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_05.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-jourdonnais",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_jourdonnais.png",
    "publicUrl": "/assets/cards/characters/01_jourdonnais.png",
    "fileName": "01_jourdonnais.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "981cf0c3e2f9b3232fccbf040386ca6ddfc9550f6119810cf006d4be15e67fcd",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_06.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-kit_carlson",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_kitcarlson.png",
    "publicUrl": "/assets/cards/characters/01_kitcarlson.png",
    "fileName": "01_kitcarlson.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "9eab50d6278381009b2cdbbbc7e7ff2641a96a697398301d5149fad2e12de4e0",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_07.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-lucky_duke",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_luckyduke.png",
    "publicUrl": "/assets/cards/characters/01_luckyduke.png",
    "fileName": "01_luckyduke.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "05b421387dc6575079bed1eeb078cf5b34ef1cdc515f499d59677b2eb0cfe11e",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_08.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-paul_regret",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_paulregret.png",
    "publicUrl": "/assets/cards/characters/01_paulregret.png",
    "fileName": "01_paulregret.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "dbd179c036e30666e60ef3ba7c4acefca57a6704525b68dfe20b66b30cea14c2",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_09.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-pedro_ramirez",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_pedroramirez.png",
    "publicUrl": "/assets/cards/characters/01_pedroramirez.png",
    "fileName": "01_pedroramirez.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "5cb6b6978f1e40961a9414d23a4ead8e23f29bbd0585773933de14ae2efc7785",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_10.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-rose_doolan",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_rosedoolan.png",
    "publicUrl": "/assets/cards/characters/01_rosedoolan.png",
    "fileName": "01_rosedoolan.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "312a004388f45dd36bb581ae5317d087be5e61a4f966e0f8fb077323a901f3fc",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_11.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-sid_ketchum",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_sidketchum.png",
    "publicUrl": "/assets/cards/characters/01_sidketchum.png",
    "fileName": "01_sidketchum.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "728a46a6a73cbb5479e6da0d59e3decc6b0a0f6382b35cd45e43b8a759f063ea",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_12.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-slab_the_killer",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_slab.png",
    "publicUrl": "/assets/cards/characters/01_slab.png",
    "fileName": "01_slab.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "ca5e29a82f86998c8bd4a8b5609dc994cdfefe39fca583769c8df5bd295649c3",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_13.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-suzy_lafayette",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_suzylafayette.png",
    "publicUrl": "/assets/cards/characters/01_suzylafayette.png",
    "fileName": "01_suzylafayette.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "bed1203648ccf40dc28116c07e799a148c213f8f448cd2194f04a2c193a6d5aa",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_14.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-vulture_sam",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_vulturesam.png",
    "publicUrl": "/assets/cards/characters/01_vulturesam.png",
    "fileName": "01_vulturesam.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "be8ad98e9af27784565c7cc4c616ebbe8701a64aa33ec5caf7d6d86a06a0878e",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_15.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "character-willy_the_kid",
    "category": "character",
    "assetPath": "../assets/cards/characters/01_willythekid.png",
    "publicUrl": "/assets/cards/characters/01_willythekid.png",
    "fileName": "01_willythekid.png",
    "mimeType": "image/png",
    "widthPx": 210,
    "heightPx": 326,
    "sha256": "c9b9bbb272f458efbd0d77ced8ef604b7b6bfc700305912ffccbde9833103231",
    "attribution": {
      "creator": "모노폴리 가이드 (Monopoly Guide)",
      "sourceTitle": "보드게임 뱅 - 캐릭터 평가",
      "sourceUrl": "https://m.blog.naver.com/monopolygame/20134581005",
      "sourceImagePath": "source_images/naver_blog_monopolygame_20134581005/character_16.jpg",
      "license": "User reports Korea Boardgames permission for the game card artwork; Naver article does not visibly state a separate CC license. Source credit recorded in ATTRIBUTION.md.",
      "changes": "Converted the article JPG to PNG to preserve the existing asset filename/path; no card content edits.",
      "creditLine": "인물 카드 이미지: 모노폴리 가이드, 「보드게임 뱅 - 캐릭터 평가」, https://m.blog.naver.com/monopolygame/20134581005. 글에 적힌 원 출처: q3c273 Tistory / 닌자토끼, http://q3c273.tistory.com/258.",
      "gameArtworkRightsNote": "네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았다. 게임 카드 아트워크는 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "originalSource": "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)"
    }
  },
  {
    "id": "role-deputy",
    "category": "role",
    "assetPath": "../assets/cards/roles/01_vice.png",
    "publicUrl": "/assets/cards/roles/01_vice.png",
    "fileName": "01_vice.png",
    "mimeType": "image/png",
    "widthPx": 200,
    "heightPx": 312,
    "sha256": "65126385e0fff2e1053696f7b14951aa023111e314815e7265d73907da65d453",
    "attribution": {
      "creator": "푸실 (Pusil)",
      "sourceTitle": "[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15",
      "sourceUrl": "https://stopnow.tistory.com/24",
      "sourceImagePath": "source_images/stopnow_article24/image_05.png",
      "license": "CC BY 4.0 for blog-authored composite; game artwork separately under Korea Boardgames permission reported by user (https://creativecommons.org/licenses/by/4.0/)",
      "changes": "Individual Korean role-card face cropped from composite; existing filename and path preserved.",
      "creditLine": "역할 카드 이미지: 푸실(Pusil), 「[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15」, CC BY 4.0, https://stopnow.tistory.com/24. 원본 합성 이미지에서 개별 역할 카드면을 잘라 편집했습니다.",
      "gameArtworkRightsNote": "카드 그림과 디자인 권리는 블로그 이미지 라이선스와 별개이며, 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/"
    }
  },
  {
    "id": "role-outlaw",
    "category": "role",
    "assetPath": "../assets/cards/roles/01_fuorilegge.png",
    "publicUrl": "/assets/cards/roles/01_fuorilegge.png",
    "fileName": "01_fuorilegge.png",
    "mimeType": "image/png",
    "widthPx": 199,
    "heightPx": 310,
    "sha256": "c4d5912c75b3f420ae0031b54a04940559d45db329b47db78010b14dd91575a2",
    "attribution": {
      "creator": "푸실 (Pusil)",
      "sourceTitle": "[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15",
      "sourceUrl": "https://stopnow.tistory.com/24",
      "sourceImagePath": "source_images/stopnow_article24/image_06.png",
      "license": "CC BY 4.0 for blog-authored composite; game artwork separately under Korea Boardgames permission reported by user (https://creativecommons.org/licenses/by/4.0/)",
      "changes": "Individual Korean role-card face cropped from composite; existing filename and path preserved.",
      "creditLine": "역할 카드 이미지: 푸실(Pusil), 「[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15」, CC BY 4.0, https://stopnow.tistory.com/24. 원본 합성 이미지에서 개별 역할 카드면을 잘라 편집했습니다.",
      "gameArtworkRightsNote": "카드 그림과 디자인 권리는 블로그 이미지 라이선스와 별개이며, 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/"
    }
  },
  {
    "id": "role-renegade",
    "category": "role",
    "assetPath": "../assets/cards/roles/01_rinnegato.png",
    "publicUrl": "/assets/cards/roles/01_rinnegato.png",
    "fileName": "01_rinnegato.png",
    "mimeType": "image/png",
    "widthPx": 202,
    "heightPx": 308,
    "sha256": "ec405a6c54c786df19ab73ac60a88d9445206647ef204cac8c3e083e2eb07a32",
    "attribution": {
      "creator": "푸실 (Pusil)",
      "sourceTitle": "[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15",
      "sourceUrl": "https://stopnow.tistory.com/24",
      "sourceImagePath": "source_images/stopnow_article24/image_06.png",
      "license": "CC BY 4.0 for blog-authored composite; game artwork separately under Korea Boardgames permission reported by user (https://creativecommons.org/licenses/by/4.0/)",
      "changes": "Individual Korean role-card face cropped from composite; existing filename and path preserved.",
      "creditLine": "역할 카드 이미지: 푸실(Pusil), 「[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15」, CC BY 4.0, https://stopnow.tistory.com/24. 원본 합성 이미지에서 개별 역할 카드면을 잘라 편집했습니다.",
      "gameArtworkRightsNote": "카드 그림과 디자인 권리는 블로그 이미지 라이선스와 별개이며, 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/"
    }
  },
  {
    "id": "role-sheriff",
    "category": "role",
    "assetPath": "../assets/cards/roles/01_sceriffo.png",
    "publicUrl": "/assets/cards/roles/01_sceriffo.png",
    "fileName": "01_sceriffo.png",
    "mimeType": "image/png",
    "widthPx": 199,
    "heightPx": 312,
    "sha256": "641999333ac6a05fdd803e34393b1a2499b483e72e012b17235e900c277d1abd",
    "attribution": {
      "creator": "푸실 (Pusil)",
      "sourceTitle": "[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15",
      "sourceUrl": "https://stopnow.tistory.com/24",
      "sourceImagePath": "source_images/stopnow_article24/image_05.png",
      "license": "CC BY 4.0 for blog-authored composite; game artwork separately under Korea Boardgames permission reported by user (https://creativecommons.org/licenses/by/4.0/)",
      "changes": "Individual Korean role-card face cropped from composite; existing filename and path preserved.",
      "creditLine": "역할 카드 이미지: 푸실(Pusil), 「[보드게임] 뱅 (BANG) 룰 규칙 설명 - NO.15」, CC BY 4.0, https://stopnow.tistory.com/24. 원본 합성 이미지에서 개별 역할 카드면을 잘라 편집했습니다.",
      "gameArtworkRightsNote": "카드 그림과 디자인 권리는 블로그 이미지 라이선스와 별개이며, 사용자가 코리아보드게임즈로부터 허가받았다고 보고한 범위에 따른다. 실제 배포 조건은 사용자가 받은 허가 이메일을 따른다.",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/"
    }
  }
] satisfies readonly RosterAsset[];

export type RosterAssetId = (typeof rosterAssets)[number]["id"];

export function getRosterAssetByPath(assetPath: string): RosterAsset | undefined {
  return rosterAssets.find((asset) => asset.assetPath === assetPath);
}
