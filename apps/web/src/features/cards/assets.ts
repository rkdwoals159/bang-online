import { BASE_CARD_DEFINITIONS, BASE_PHYSICAL_CARDS } from "../../../../../packages/catalog/src/cards/index.js";
import { characters } from "../../../../../packages/catalog/src/characters/index.js";
import { roles } from "../../../../../packages/catalog/src/roles/index.js";
import type { Suit } from "../../../../../packages/catalog/src/schema.js";
import type { CardFaceView } from "../../../../../packages/contracts/src/protocol.js";

const PLAYING_CARD_NAMES: Readonly<Record<string, string>> = {
  bang: "뱅!",
  missed: "빗나감!",
  beer: "맥주",
  saloon: "술집",
  stagecoach: "역마차",
  wells_fargo: "웰스 파고",
  general_store: "잡화점",
  panic: "패닉!",
  cat_balou: "캣 벌루",
  gatling: "개틀링",
  indians: "인디언!",
  duel: "결투",
  barrel: "술통",
  jail: "감옥",
  dynamite: "다이너마이트",
  mustang: "머스탱",
  scope: "조준경",
  volcanic: "볼캐닉",
  schofield: "스코필드",
  remington: "레밍턴",
  carabine: "레밍턴 카빈",
  winchester: "윈체스터",
};

const CHARACTER_NAMES: Readonly<Record<string, string>> = {
  bart_cassidy: "바트 캐시디",
  black_jack: "블랙 잭",
  calamity_janet: "캘러미티 재닛",
  el_gringo: "엘 그링고",
  jesse_jones: "제시 존스",
  jourdonnais: "주르도네",
  kit_carlson: "킷 칼슨",
  lucky_duke: "럭키 듀크",
  paul_regret: "폴 레그레",
  pedro_ramirez: "페드로 라미레스",
  rose_doolan: "로즈 둘런",
  sid_ketchum: "시드 케첨",
  slab_the_killer: "슬랩 더 킬러",
  suzy_lafayette: "수지 라파예트",
  vulture_sam: "벌처 샘",
  willy_the_kid: "윌리 더 키드",
};

const ROLE_NAMES: Readonly<Record<string, string>> = {
  sheriff: "보안관",
  deputy: "부관",
  outlaw: "무법자",
  renegade: "배신자",
};

const SUIT_MARKS: Readonly<Record<Suit, string>> = {
  SPADES: "♠",
  HEARTS: "♥",
  DIAMONDS: "♦",
  CLUBS: "♣",
};

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  SPADES: "스페이드",
  HEARTS: "하트",
  DIAMONDS: "다이아몬드",
  CLUBS: "클럽",
};

/**
 * Convert a prepared catalog asset path into a root-relative Vite public URL.
 * T05 card paths are under `cards/`; roster paths retain `../assets/`.
 */
export function publicAssetPathFromCatalog(assetPath: string): string | undefined {
  const normalized = assetPath.replace(/\\/g, "/");
  let publicPath: string;
  if (normalized.startsWith("cards/")) {
    publicPath = `assets/${normalized}`;
  } else if (normalized.startsWith("../assets/cards/")) {
    publicPath = normalized.slice(3);
  } else {
    return undefined;
  }

  if (publicPath.split("/").some((segment) => segment === ".." || segment === ".")) return undefined;
  return `/${publicPath}`;
}

export const CARD_ASSET_MANIFEST = {
  playing: Object.fromEntries(
    BASE_CARD_DEFINITIONS.map((definition) => [
      definition.typeId,
      publicAssetPathFromCatalog(definition.assetPath),
    ]),
  ) as Readonly<Record<string, string | undefined>>,
  characters: Object.fromEntries(
    characters.map((character) => [
      character.id,
      publicAssetPathFromCatalog(character.assetPath),
    ]),
  ) as Readonly<Record<string, string | undefined>>,
  roles: Object.fromEntries(
    roles.map((role) => [role.id, publicAssetPathFromCatalog(role.assetPath)]),
  ) as Readonly<Record<string, string | undefined>>,
} as const;

/** One image per card type; physical card data below retains each copy's face. */
export const PHYSICAL_CARD_ASSET_MANIFEST = BASE_PHYSICAL_CARDS.map((card) => ({
  ...card,
  assetUrl: CARD_ASSET_MANIFEST.playing[card.typeId],
}));

export interface PlayingCardPresentation {
  cardName: string;
  assetUrl: string | undefined;
  imageAlt: string;
  fallbackText: string;
  accessibleLabel: string;
  rankText: string;
  suitMark: string;
  suitName: string;
}

export function getPlayingCardPresentation(card: CardFaceView): PlayingCardPresentation {
  const cardName = PLAYING_CARD_NAMES[card.typeId] ?? "카드";
  const rankText = String(card.rank);
  const suitName = SUIT_NAMES[card.suit] ?? "무늬";
  return {
    cardName,
    assetUrl: CARD_ASSET_MANIFEST.playing[card.typeId],
    imageAlt: `${cardName} 카드 그림`,
    fallbackText: `${cardName} 이미지 없음`,
    accessibleLabel: `${cardName}, ${rankText} ${suitName}`,
    rankText,
    suitMark: SUIT_MARKS[card.suit] ?? "",
    suitName,
  };
}

export interface RosterCardPresentation {
  name: string;
  assetUrl: string | undefined;
  imageAlt: string;
  fallbackText: string;
}

export function getCharacterCardPresentation(characterId: string): RosterCardPresentation {
  const name = CHARACTER_NAMES[characterId] ?? characters.find((entry) => entry.id === characterId)?.name ?? "인물 카드";
  return {
    name,
    assetUrl: CARD_ASSET_MANIFEST.characters[characterId],
    imageAlt: `${name} 인물 카드`,
    fallbackText: `${name} 인물 카드 이미지 없음`,
  };
}

export function getRoleCardPresentation(roleId: string): RosterCardPresentation {
  const name = ROLE_NAMES[roleId] ?? roles.find((entry) => entry.id === roleId)?.name ?? "역할 카드";
  return {
    name,
    assetUrl: CARD_ASSET_MANIFEST.roles[roleId],
    imageAlt: `${name} 역할 카드`,
    fallbackText: `${name} 역할 카드 이미지 없음`,
  };
}

export function getOpponentHandBackAlt(): string {
  return "비공개 손패 카드 뒷면";
}
