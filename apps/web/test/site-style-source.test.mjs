import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Sites development and production explicitly use the Worker HTTP adapter", async () => {
  const mount = await readFile(new URL("../../site/src/ui/GameAppMount.tsx", import.meta.url), "utf8");
  assert.match(mount, /<App transportAdapter="sites-http-sse"/);
});

test("Sites imports the same app stylesheet as the local browser entry", async () => {
  const siteWrapper = new URL("../../site/app/game-ui.css", import.meta.url);
  const [wrapper, browserEntry, sharedStyle] = await Promise.all([
    readFile(siteWrapper, "utf8"),
    readFile(new URL("../src/app/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/app.css", import.meta.url), "utf8"),
  ]);
  const imported = wrapper.match(/@import\s+"([^"]+)"/);
  assert.ok(imported);
  assert.equal(new URL(imported[1], siteWrapper).href, new URL("../src/app/app.css", import.meta.url).href);
  assert.match(browserEntry, /import "\.\/app\.css"/);
  assert.match(sharedStyle, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(sharedStyle, /\.match-request\s*\{\s*position: sticky/);
});
