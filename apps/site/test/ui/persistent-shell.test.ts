import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("game mount belongs to the persistent layout instead of route page segments", async () => {
  const [layout, home, catchAll] = await Promise.all([
    readFile(new URL("../../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/[...path]/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /<GameAppMount\s*\/>/);
  assert.match(layout, /\{children\}/);
  for (const segment of [home, catchAll]) {
    assert.equal(segment.includes("GameAppMount"), false, "route replacement must never recreate the game root");
    assert.match(segment, /return null;/);
  }
});
