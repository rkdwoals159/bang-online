import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "../src/schema.ts";
import { validateCatalog } from "../src/validate.ts";

const knownAssetPaths = new Set([
  "../assets/cards/playing/01_bang.png",
  "../assets/cards/roles/01_sceriffo.png",
  "../assets/cards/characters/01_bartcassidy.png",
]);

const makeCatalog = (): Catalog => ({
  rulesetVersion: "base4-ko-online-1.0",
  cardDefinitions: [
    {
      typeId: "bang",
      name: "BANG!",
      quantity: 2,
      color: "brown",
      assetPath: "../assets/cards/playing/01_bang.png",
    },
  ],
  physicalCards: [
    { definitionId: "bang-spades-a", typeId: "bang", rank: "A", suit: "SPADES", copyIndex: 0 },
    { definitionId: "bang-hearts-2", typeId: "bang", rank: 2, suit: "HEARTS", copyIndex: 1 },
  ],
  roles: [
    { id: "sheriff", name: "Sheriff", countsByPlayerCount: { 4: 1, 5: 1, 6: 1, 7: 1 }, assetPath: "../assets/cards/roles/01_sceriffo.png" },
    { id: "deputy", name: "Deputy", countsByPlayerCount: { 4: 0, 5: 1, 6: 1, 7: 2 }, assetPath: "../assets/cards/roles/01_sceriffo.png" },
    { id: "outlaw", name: "Outlaw", countsByPlayerCount: { 4: 2, 5: 2, 6: 3, 7: 3 }, assetPath: "../assets/cards/roles/01_sceriffo.png" },
    { id: "renegade", name: "Renegade", countsByPlayerCount: { 4: 1, 5: 1, 6: 1, 7: 1 }, assetPath: "../assets/cards/roles/01_sceriffo.png" },
  ],
  characters: [
    {
      id: "bart-cassidy",
      name: "Bart Cassidy",
      baseHealth: 4,
      ruleId: "C01",
      assetPath: "../assets/cards/characters/01_bartcassidy.png",
    },
  ],
});

test("accepts valid static catalog data and known asset paths", () => {
  const result = validateCatalog(makeCatalog(), { knownAssetPaths });
  assert.equal(result.ok, true);
});

test("rejects duplicate physical card identifiers", () => {
  const catalog = makeCatalog();
  catalog.physicalCards[1]!.definitionId = catalog.physicalCards[0]!.definitionId;

  const result = validateCatalog(catalog, { knownAssetPaths });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === "DUPLICATE_ID"));
});

test("rejects numeric card ranks outside 2 through 10", () => {
  for (const rank of [1, 11, 12, 13]) {
    const catalog = makeCatalog();
    catalog.physicalCards[0]!.rank = rank;

    const result = validateCatalog(catalog, { knownAssetPaths });
    assert.equal(result.ok, false, `rank ${rank} should be rejected`);
    if (!result.ok) {
      assert.ok(result.issues.some((entry) => entry.path === "$.physicalCards[0].rank" && entry.code === "INVALID_VALUE"));
    }
  }
});

test("rejects asset paths missing from the known asset set", () => {
  const catalog = makeCatalog();
  catalog.characters[0]!.assetPath = "../assets/cards/characters/not-in-manifest.png";

  const result = validateCatalog(catalog, { knownAssetPaths });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_ASSET_PATH"));
});

test("rejects negative card and role counts", () => {
  const catalog = makeCatalog();
  catalog.cardDefinitions[0]!.quantity = -1;
  catalog.roles[1]!.countsByPlayerCount[4] = -1;

  const result = validateCatalog(catalog, { knownAssetPaths });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((entry) => entry.path.endsWith(".quantity") && entry.code === "INVALID_VALUE"));
    assert.ok(result.issues.some((entry) => entry.path.endsWith(".countsByPlayerCount.4") && entry.code === "INVALID_VALUE"));
  }
});

test("rejects unknown fields and unresolved physical card type references", () => {
  const catalog = makeCatalog() as Catalog & { ignoredField?: boolean };
  catalog.ignoredField = true;
  catalog.physicalCards[0]!.typeId = "missing-type";

  const result = validateCatalog(catalog, { knownAssetPaths });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_FIELD" && entry.path === "$.ignoredField"));
    assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_REFERENCE"));
  }
});

test("rejects role distributions that do not total the player count", () => {
  const catalog = makeCatalog();
  catalog.roles[2]!.countsByPlayerCount[4] = 1;

  const result = validateCatalog(catalog, { knownAssetPaths });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === "INCONSISTENT_COUNT"));
});
