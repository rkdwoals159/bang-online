import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../../packages/catalog/src/cards/index.ts";
import {
  CARD_ASSET_MANIFEST,
  PHYSICAL_CARD_ASSET_MANIFEST,
  getCharacterCardPresentation,
  getOpponentHandBackAlt,
  getPlayingCardPresentation,
  getRoleCardPresentation,
} from "./assets.ts";

test("prepared asset paths map to all 22 card, 16 character, and 4 role files in public", () => {
  assert.equal(Object.keys(CARD_ASSET_MANIFEST.playing).length, 22);
  assert.equal(Object.keys(CARD_ASSET_MANIFEST.characters).length, 16);
  assert.equal(Object.keys(CARD_ASSET_MANIFEST.roles).length, 4);

  for (const url of Object.values(CARD_ASSET_MANIFEST).flatMap((category) => Object.values(category))) {
    assert.ok(url, "every catalog item must resolve to a public URL");
    const publicPath = resolve("apps/web/public", `.${url}`);
    const sourcePath = resolve("outputs/assets", url.replace(/^\/assets\//, ""));
    assert.ok(existsSync(publicPath), `missing public asset ${url}`);
    assert.deepEqual(readFileSync(publicPath), readFileSync(sourcePath), `public asset differs from prepared source ${url}`);
  }
});

test("all 80 physical card records keep their own rank and suit over one type image", () => {
  assert.equal(PHYSICAL_CARD_ASSET_MANIFEST.length, 80);
  assert.deepEqual(
    PHYSICAL_CARD_ASSET_MANIFEST.map(({ definitionId, typeId, rank, suit, copyIndex }) => ({
      definitionId,
      typeId,
      rank,
      suit,
      copyIndex,
    })),
    BASE_PHYSICAL_CARDS,
  );
  assert.ok(PHYSICAL_CARD_ASSET_MANIFEST.every((card) => card.assetUrl));

  const stagecoachCopies = BASE_PHYSICAL_CARDS.filter((card) => card.typeId === "stagecoach");
  assert.deepEqual(stagecoachCopies, [
    { definitionId: "stagecoach_01", typeId: "stagecoach", rank: 9, suit: "SPADES", copyIndex: 1 },
    { definitionId: "stagecoach_02", typeId: "stagecoach", rank: 9, suit: "SPADES", copyIndex: 2 },
  ]);

  const stagecoachFaces = stagecoachCopies.map((card) => getPlayingCardPresentation({
    cardInstanceId: `instance-${card.definitionId}`,
    typeId: card.typeId,
    rank: String(card.rank),
    suit: card.suit,
  }));
  assert.equal(stagecoachFaces[0].accessibleLabel, "역마차, 9 스페이드");
  assert.equal(stagecoachFaces[1].accessibleLabel, "역마차, 9 스페이드");
  assert.equal(stagecoachFaces[0].assetUrl, stagecoachFaces[1].assetUrl);
  assert.notEqual(stagecoachCopies[0].definitionId, stagecoachCopies[1].definitionId);
});

test("missing images have visible fallback labels and nonempty alternative text", () => {
  const missingCard = getPlayingCardPresentation({
    cardInstanceId: "unknown-instance",
    typeId: "not-in-catalog",
    rank: "A",
    suit: "SPADES",
  });
  const missingCharacter = getCharacterCardPresentation("not-a-character");
  const missingRole = getRoleCardPresentation("not-a-role");

  for (const presentation of [missingCard, missingCharacter, missingRole]) {
    assert.equal(presentation.assetUrl, undefined);
    assert.ok(presentation.fallbackText.trim().length > 0);
    assert.ok(presentation.imageAlt.trim().length > 0);
  }
});

test("opponent hand back accessibility text exposes no rank, suit, or card identity", () => {
  const alt = getOpponentHandBackAlt();
  assert.equal(alt, "비공개 손패 카드 뒷면");
  assert.doesNotMatch(alt, /[0-9A-Z♠♥♦♣]/);
});
