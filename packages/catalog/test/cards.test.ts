import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BASE_CARD_ASSET_PATHS,
  BASE_CARD_DEFINITIONS,
  BASE_DECK_CATALOG,
  BASE_DECK_RULESET_VERSION,
  BASE_PHYSICAL_CARDS,
} from "../src/cards/index.ts";
import type { Catalog, CardRank, PhysicalCard } from "../src/schema.ts";
import { validateCatalog } from "../src/validate.ts";

interface PreparedPhysicalCard {
  definitionId: string;
  typeId: string;
  rank: string;
  suit: string;
  copyIndex: number;
}

interface PreparedCardType {
  typeId: string;
  nameEn: string;
  count: number;
  border: "BLUE" | "BROWN";
  assetPath: string;
  source: string;
}

interface AssetManifestRow {
  asset_group: string;
  item_or_type: string;
  quantity: string;
  folder: string;
  status: string;
  notes: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDirectory = join(repositoryRoot, "outputs", "development-plan", "data");

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function readCsvRecords<T extends object>(path: string): T[] {
  const [rawHeader, ...rows] = parseCsv(readFileSync(path, "utf8"));
  assert.ok(rawHeader, `CSV header missing: ${path}`);
  const header = rawHeader.map((column) => column.replace(/^\uFEFF/, ""));
  return rows.map((values) =>
    Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""])) as T,
  );
}

function parseRank(rank: string): CardRank {
  return /^[0-9]+$/.test(rank) ? Number(rank) : (rank as CardRank);
}

function normalizePreparedAssetPath(assetPath: string): string {
  const prefix = "../assets/";
  assert.ok(assetPath.startsWith(prefix), `Unexpected prepared asset path: ${assetPath}`);
  return assetPath.slice(prefix.length);
}

const sourceDeck = JSON.parse(
  readFileSync(join(dataDirectory, "base-deck.json"), "utf8"),
) as { rulesetVersion: string; cards: PreparedPhysicalCard[] };
const sourceTypes = JSON.parse(
  readFileSync(join(dataDirectory, "card-types.json"), "utf8"),
) as PreparedCardType[];

test("prepared JSON and CSV agree on all 80 physical card identifiers, ranks, and suits", () => {
  const csvRows = readCsvRecords<Omit<PreparedPhysicalCard, "copyIndex"> & { copyIndex: string }>(
    join(dataDirectory, "base-deck.csv"),
  ).map((card) => ({ ...card, copyIndex: Number(card.copyIndex) }));
  const jsonRows = sourceDeck.cards.map((card) => ({ ...card }));

  assert.equal(jsonRows.length, 80);
  assert.equal(csvRows.length, 80);
  assert.deepEqual(jsonRows, csvRows);
});

test("imports all 22 prepared card definitions and the exact 80-card JSON deck", () => {
  assert.equal(BASE_DECK_RULESET_VERSION, sourceDeck.rulesetVersion);
  assert.equal(BASE_DECK_CATALOG.rulesetVersion, sourceDeck.rulesetVersion);
  assert.equal(BASE_CARD_DEFINITIONS.length, 22);
  assert.equal(BASE_PHYSICAL_CARDS.length, 80);
  assert.equal(new Set(BASE_CARD_DEFINITIONS.map(({ typeId }) => typeId)).size, 22);
  assert.equal(new Set(BASE_PHYSICAL_CARDS.map(({ definitionId }) => definitionId)).size, 80);

  const expectedDefinitions = sourceTypes.map((cardType) => ({
    typeId: cardType.typeId,
    name: cardType.nameEn,
    quantity: cardType.count,
    color: cardType.border === "BLUE" ? "blue" : "brown",
    assetPath: normalizePreparedAssetPath(cardType.assetPath),
  }));
  assert.deepEqual(BASE_CARD_DEFINITIONS, expectedDefinitions);

  const expectedPhysicalCards: PhysicalCard[] = sourceDeck.cards.map((card) => ({
    definitionId: card.definitionId,
    typeId: card.typeId,
    rank: parseRank(card.rank),
    suit: card.suit as PhysicalCard["suit"],
    copyIndex: card.copyIndex,
  }));
  assert.deepEqual(BASE_PHYSICAL_CARDS, expectedPhysicalCards);

  const actualCounts = new Map<string, number>();
  for (const card of BASE_PHYSICAL_CARDS) {
    actualCounts.set(card.typeId, (actualCounts.get(card.typeId) ?? 0) + 1);
  }
  for (const definition of BASE_CARD_DEFINITIONS) {
    assert.equal(actualCounts.get(definition.typeId), definition.quantity, definition.typeId);
  }
  assert.deepEqual(
    [...actualCounts.keys()].sort(),
    BASE_CARD_DEFINITIONS.map(({ typeId }) => typeId).sort(),
  );
});

test("every card asset key maps to the matching inventory item, quantity, folder, and file", () => {
  const inventory = readCsvRecords<AssetManifestRow>(
    join(repositoryRoot, "outputs", "assets", "asset_manifest.csv"),
  ).filter((row) => row.asset_group === "playing_card_front");

  assert.equal(inventory.length, 22);
  assert.deepEqual(BASE_CARD_ASSET_PATHS, BASE_CARD_DEFINITIONS.map(({ assetPath }) => assetPath));

  for (const sourceType of sourceTypes) {
    const inventoryRow = inventory.find(
      (row) => row.item_or_type.toLowerCase() === sourceType.nameEn.toLowerCase(),
    );
    assert.ok(inventoryRow, `No playing-card inventory row for ${sourceType.nameEn}`);
    assert.equal(Number(inventoryRow.quantity), sourceType.count, sourceType.typeId);

    const assetPath = normalizePreparedAssetPath(sourceType.assetPath);
    assert.equal(assetPath.slice(0, assetPath.lastIndexOf("/")), inventoryRow.folder, sourceType.typeId);
    assert.ok(
      existsSync(join(repositoryRoot, "outputs", "assets", assetPath)),
      `Missing inventory asset file: ${assetPath}`,
    );
  }
});

test("imported deck passes the shared catalog schema with manifest-backed asset keys", () => {
  const roleFixtureAssetPath = "test/role-fixture.png";
  const catalog: Catalog = {
    ...BASE_DECK_CATALOG,
    roles: [
      {
        id: "sheriff",
        name: "Schema fixture",
        countsByPlayerCount: { 4: 4, 5: 5, 6: 6, 7: 7 },
        assetPath: roleFixtureAssetPath,
      },
    ],
    characters: [],
  };
  const result = validateCatalog(catalog, {
    knownAssetPaths: [...BASE_CARD_ASSET_PATHS, roleFixtureAssetPath],
  });

  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues, null, 2));
});
