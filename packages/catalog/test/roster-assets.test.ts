import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { characters } from "../src/characters/index.ts";
import { rosterAssets } from "../src/assets/roster-assets.ts";
import { roles } from "../src/roles/index.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = input.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
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
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...data] = rows;
  assert.ok(header, "CSV header is required");
  return data.map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])),
  );
}

function readCsv(path: string): Record<string, string>[] {
  return parseCsv(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

test("imports role IDs, asset paths, and counts for 4–7 players from the source JSON", () => {
  const source = readJson("outputs/development-plan/data/roles.json") as {
    types: { roleId: string; assetPath: string }[];
    countOrder: string[];
    countsByPlayers: Record<"4" | "5" | "6" | "7", number[]>;
  };

  const expected = source.types.map((entry) => {
    const roleIndex = source.countOrder.indexOf(entry.roleId);
    assert.notEqual(roleIndex, -1, `missing count order for ${entry.roleId}`);
    return {
      id: entry.roleId,
      assetPath: entry.assetPath,
      countsByPlayerCount: {
        4: source.countsByPlayers["4"][roleIndex],
        5: source.countsByPlayers["5"][roleIndex],
        6: source.countsByPlayers["6"][roleIndex],
        7: source.countsByPlayers["7"][roleIndex],
      },
    };
  });
  assert.deepEqual(
    roles.map(({ id, assetPath, countsByPlayerCount }) => ({ id, assetPath, countsByPlayerCount })),
    expected,
  );

  for (const playerCount of [4, 5, 6, 7] as const) {
    assert.equal(
      roles.reduce((total, role) => total + role.countsByPlayerCount[playerCount], 0),
      playerCount,
      `role distribution for ${playerCount} players must total ${playerCount}`,
    );
  }
  assert.deepEqual(
    roles.map((role) => role.countsByPlayerCount[7]),
    [1, 2, 3, 1],
    "the seven-player role cards must be Sheriff 1, Deputy 2, Outlaw 3, Renegade 1",
  );
  assert.equal(roles.reduce((total, role) => total + role.countsByPlayerCount[7], 0), 7);
});

test("imports all 16 character IDs and static fields from the source JSON", () => {
  const source = readJson("outputs/development-plan/data/characters.json") as {
    characterId: string;
    nameEn: string;
    baseMaxHp: number;
    ruleId: string;
    assetPath: string;
  }[];

  assert.equal(characters.length, 16);
  assert.deepEqual(
    characters.map(({ id, name, baseHealth, ruleId, assetPath }) => ({
      id,
      name,
      baseHealth,
      ruleId,
      assetPath,
    })),
    source.map(({ characterId, nameEn, baseMaxHp, ruleId, assetPath }) => ({
      id: characterId,
      name: nameEn,
      baseHealth: baseMaxHp,
      ruleId,
      assetPath,
    })),
  );
});

test("maps roster asset URLs and attribution to the extracted source inventory", () => {
  const sourceRows = readCsv("outputs/assets/extracted_source_manifest.csv").filter(
    (row) => row.category === "roles" || row.category === "characters",
  );
  const manifestRows = readCsv("outputs/assets/asset_manifest.csv");
  const characterSource = readJson("outputs/development-plan/data/characters.json") as {
    nameEn: string;
  }[];
  const attributionDocument = readFileSync(
    resolve(repositoryRoot, "outputs/assets/ATTRIBUTION.md"),
    "utf8",
  );

  assert.equal(rosterAssets.length, 20);
  assert.equal(sourceRows.length, 20);
  assert.equal(new Set(rosterAssets.map((asset) => asset.id)).size, 20);
  const assetsByPath = new Map(rosterAssets.map((asset) => [asset.assetPath, asset]));
  assert.deepEqual(
    [...rosterAssets.map((asset) => asset.assetPath)].sort(),
    [...roles, ...characters].map((definition) => definition.assetPath).sort(),
  );
  for (const role of roles) {
    assert.equal(assetsByPath.get(role.assetPath)?.id, `role-${role.id}`);
  }
  for (const character of characters) {
    assert.equal(assetsByPath.get(character.assetPath)?.id, `character-${character.id}`);
  }

  for (const asset of rosterAssets) {
    const source = sourceRows.find((row) => row.local_path === asset.assetPath.replace(/^\.\.\/assets\//, ""));
    assert.ok(source, `missing source inventory row for ${asset.assetPath}`);
    assert.equal(asset.fileName, source.source_filename);
    assert.equal(asset.publicUrl, `/assets/${source.local_path}`);
    assert.equal(asset.attribution.sourceUrl, source.source_url);
    assert.equal(asset.attribution.sourceImagePath, source.source_image_path);
    assert.equal(asset.attribution.license, source.license);
    assert.equal(asset.attribution.changes, source.changes);
    assert.equal(asset.sha256, source.sha256);
    assert.equal(asset.widthPx, Number(source.width_px));
    assert.equal(asset.heightPx, Number(source.height_px));
    assert.equal(asset.mimeType, "image/png");
    assert.ok(asset.attribution.creator.length > 0);
    assert.ok(asset.attribution.sourceTitle.length > 0);
    assert.ok(asset.attribution.creditLine.length > 0);
    assert.ok(asset.attribution.gameArtworkRightsNote.length > 0);
    if (asset.category === "role") {
      assert.equal(asset.attribution.creator, "푸실 (Pusil)");
      assert.equal(asset.attribution.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
      assert.ok(attributionDocument.includes("https://stopnow.tistory.com/24"));
      assert.ok(attributionDocument.includes("푸실(Pusil)"));
    } else {
      assert.equal(asset.attribution.creator, "모노폴리 가이드 (Monopoly Guide)");
      assert.equal(asset.attribution.originalSource, "q3c273 Tistory / 닌자토끼 (http://q3c273.tistory.com/258)");
      assert.equal(asset.attribution.licenseUrl, undefined);
      assert.ok(attributionDocument.includes("https://m.blog.naver.com/monopolygame/20134581005"));
      assert.ok(attributionDocument.includes("네이버 글에서 별도의 CC 라이선스 표시는 확인되지 않았습니다."));
    }
  }

  const roleManifestRows = manifestRows.filter((row) => row.asset_group === "role_card");
  const characterManifestRows = manifestRows.filter((row) => row.asset_group === "character_card");
  assert.equal(roleManifestRows.length, 4);
  assert.equal(roleManifestRows.reduce((total, row) => total + Number(row.quantity), 0), 7);
  assert.equal(characterManifestRows.length, 16);
  assert.equal(characterManifestRows.reduce((total, row) => total + Number(row.quantity), 0), 16);
  assert.deepEqual(
    characterManifestRows.map((row) => row.item_or_type).sort(),
    characterSource.map((character) => character.nameEn).sort(),
  );
});
