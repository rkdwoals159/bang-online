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
  assert.match(survivorMarkup, /버림더미/);
  assert.match(survivorMarkup, /9장/);
  assert.match(survivorMarkup, /내 손패/);
  assert.match(survivorMarkup, /맥주/);
  assert.match(survivorMarkup, /현재 차례/);
  assert.match(survivorMarkup, /카드 사용/);
  assert.match(survivorMarkup, /남은 덱/);
  assert.match(survivorMarkup, /57장/);
  assert.doesNotMatch(survivorMarkup, /<button\b/);

  const eliminatedMarkup = renderToStaticMarkup(
    React.createElement(GameTable, { snapshot: eliminatedSnapshot }),
  );
  assert.match(eliminatedMarkup, /탈락한 플레이어/);
  assert.match(eliminatedMarkup, /부관/);
  assert.match(eliminatedMarkup, /손패 3장/);
  assert.match(eliminatedMarkup, /63장/);
  assert.doesNotMatch(eliminatedMarkup, /내 손패/);
  assert.doesNotMatch(eliminatedMarkup, /<button\b/);

  for (const sentinel of forbiddenSentinels) {
    assert.equal(survivorMarkup.includes(sentinel), false, `survivor leaked ${sentinel}`);
    assert.equal(eliminatedMarkup.includes(sentinel), false, `eliminated leaked ${sentinel}`);
  }

  for (const markup of [survivorMarkup, eliminatedMarkup]) {
    assert.doesNotMatch(markup, /\b(?:sheriff|deputy|outlaw|renegade)\b/);
    assert.doesNotMatch(markup, /\b(?:bang|beer|mustang|scope)\b/);
    assert.doesNotMatch(markup, /\bdata-[\w-]+=/);
  }

  process.stdout.write("Survivor and eliminated projection render checks passed.\n");
} finally {
  await vite.close();
}
