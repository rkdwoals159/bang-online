import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  eliminatedSnapshot,
  forbiddenSentinels,
  survivorSnapshot,
} from "./game-table.fixtures.mjs";

const featureDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(featureDirectory, "../../..");
const vite = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const { GameTable } = await vite.ssrLoadModule("/src/features/game-table/GameTable.tsx");

  const survivorMarkup = renderToStaticMarkup(
    React.createElement(GameTable, { snapshot: survivorSnapshot }),
  );
  assert.match(survivorMarkup, /보안관/);
  assert.match(survivorMarkup, /역할 비공개/);
  assert.match(survivorMarkup, /손패 2장/);
  assert.doesNotMatch(survivorMarkup, /버림더미|남은 덱/);
  assert.doesNotMatch(survivorMarkup, /9장/);
  assert.doesNotMatch(survivorMarkup, /내 손패/);
  assert.doesNotMatch(survivorMarkup, /맥주/);
  assert.match(survivorMarkup, /현재 차례/);
  assert.match(survivorMarkup, /캐릭터 상세 보기/);

  assert.doesNotMatch(survivorMarkup, /57장/);
  assert.match(survivorMarkup, /aria-haspopup="dialog"/);

  const eliminatedMarkup = renderToStaticMarkup(
    React.createElement(GameTable, { snapshot: eliminatedSnapshot }),
  );
  assert.match(eliminatedMarkup, /탈락한 플레이어/);
  assert.match(eliminatedMarkup, /부관/);
  assert.match(eliminatedMarkup, /손패 3장/);
  assert.doesNotMatch(eliminatedMarkup, /63장/);
  assert.doesNotMatch(eliminatedMarkup, /내 손패/);
  assert.match(eliminatedMarkup, /aria-haspopup="dialog"/);

  for (const sentinel of forbiddenSentinels) {
    assert.equal(survivorMarkup.includes(sentinel), false, `survivor leaked ${sentinel}`);
    assert.equal(eliminatedMarkup.includes(sentinel), false, `eliminated leaked ${sentinel}`);
  }

  for (const [markup, snapshot] of [[survivorMarkup, survivorSnapshot], [eliminatedMarkup, eliminatedSnapshot]]) {
    const publicIds = new Set(snapshot.publicTable.players.map(p => p.playerId));
    for (const match of markup.matchAll(/ data-player-seat="([^"]*)"/g)) assert.ok(publicIds.has(match[1]));
    const content = markup.replace(/ data-player-seat="[^"]*"/g, "");
    assert.doesNotMatch(content, /\b(?:sheriff|deputy|outlaw|renegade)\b/);
    assert.doesNotMatch(content, /\b(?:bang|beer|mustang|scope)\b/);
    assert.doesNotMatch(content, /\bdata-[\w-]+=/);
  }

  process.stdout.write("Survivor and eliminated projection render checks passed.\n");
} finally {
  await vite.close();
}
