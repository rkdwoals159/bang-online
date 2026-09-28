import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const stylesheetPath = fileURLToPath(new URL("../../styles/accessibility.css", import.meta.url));
const stylesheet = await readFile(stylesheetPath, "utf8");

test("keyboard controls receive a visible focus indicator", () => {
  assert.match(stylesheet, /\):focus-visible\s*\{/);
  assert.match(stylesheet, /outline:\s*3px solid/);
  assert.match(stylesheet, /box-shadow:/);
  assert.match(stylesheet, /button[\s\S]*a\[href\][\s\S]*\[tabindex\]/);
});

test("narrow hand and response rows can scroll horizontally", () => {
  assert.match(stylesheet, /@media\s*\(max-width:\s*600px\)/);
  assert.match(stylesheet, /\.game-table \.game-table__hand-list\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/s);
  assert.match(stylesheet, /\.reaction-prompt \.reaction-prompt__options\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s);
  assert.match(stylesheet, /\.game-actions__cards/);
});

test("AccessibleButton renders a named native keyboard control", async () => {
  const vite = await createServer({
    configFile: fileURLToPath(new URL("../../../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });

  try {
    const { AccessibleButton } = await vite.ssrLoadModule("/src/components/accessibility/AccessibleButton.tsx");
    const { AccessibilityStyles } = await vite.ssrLoadModule("/src/components/accessibility/AccessibilityStyles.tsx");
    const markup = renderToStaticMarkup(
      React.createElement(AccessibleButton, { accessibleName: "선택 취소", title: "닫기" }, "×"),
    );
    assert.match(markup, /^<button\b/);
    assert.match(markup, /aria-label="선택 취소"/);
    assert.match(markup, />×<\/button>$/);
    assert.equal(renderToStaticMarkup(React.createElement(AccessibilityStyles)), "");

    assert.throws(
      () => renderToStaticMarkup(React.createElement(AccessibleButton, { accessibleName: "   " }, "×")),
      /non-empty accessibleName/,
    );
  } finally {
    await vite.close();
  }
});
