import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { survivorSnapshot, eliminatedSnapshot, forbiddenSentinels } from '../src/features/game-table/game-table.fixtures.mjs';

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
let vite, GameTable, CharacterPortrait, ActionsPanel;
before(async () => {
  vite = await createServer({ configFile: 'apps/web/vite.config.ts', root: 'apps/web', appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  ({ GameTable } = await vite.ssrLoadModule('/src/features/game-table/GameTable.tsx'));
  ({ CharacterPortrait } = await vite.ssrLoadModule('/src/features/cards/CardFaces.tsx'));
  ({ ActionsPanel } = await vite.ssrLoadModule('/src/features/actions/ActionsPanel.tsx'));
});
after(async () => { await vite?.close(); });

test('design: public portraits open character details and preserve role/hand privacy', () => {
  for (const snapshot of [survivorSnapshot, eliminatedSnapshot]) {
    const markup = renderToStaticMarkup(createElement(GameTable, { snapshot }));
    for (const sentinel of forbiddenSentinels) assert.equal(markup.includes(sentinel), false);
    assert.equal((markup.match(/class="character-portrait" aria-hidden="true"/g) ?? []).length, snapshot.publicTable.players.length);
    assert.doesNotMatch(markup.replace(/ data-player-seat="[^"]*"/g, ""), /내 손패|\bdata-[\w-]+=/);
    for (const player of snapshot.publicTable.players) assert.ok(markup.includes(`data-player-seat="${player.playerId}"`));
  }
  const markup = renderToStaticMarkup(createElement(GameTable, { snapshot: survivorSnapshot }));
  assert.match(markup, /내 역할 배신자/);
  assert.match(markup, /역할 비공개/);
  assert.ok(markup.indexOf('바람</strong>') < markup.indexOf('은하</strong>'), 'viewer relative seat order remains intact');
});

test('design: decorative portrait retains fallback and lazy image loading', () => {
  const known = renderToStaticMarkup(createElement(CharacterPortrait, { characterId: 'sid_ketchum' }));
  assert.match(known, /loading="lazy"/);
  assert.match(known, /alt=""/);
  const unknown = renderToStaticMarkup(createElement(CharacterPortrait, { characterId: 'unknown' }));
  assert.match(unknown, /card-artwork--fallback/);
});

test('design: hand count and visible card status complement the detailed accessible names', () => {
  const snapshot = { ...survivorSnapshot, pendingInteraction: null, legalActions: [{ type: 'END_TURN', payload: {} }] };
  snapshot.publicTable = { ...snapshot.publicTable, turn: { currentPlayerId: snapshot.viewer.playerId, phase: 'play' } };
  const markup = renderToStaticMarkup(createElement(ActionsPanel, { matchId: 'design-match', version: 1, snapshot, transport: {} }));
  assert.match(markup, /손패 1장/);
  assert.match(markup, /맥주/);
  assert.match(markup, /사용 불가/);
  assert.match(markup, /카드 상세 보기/);
});

test('design: a single main landmark is reachable by skip link', async () => {
  const [app, lobby, entry] = await Promise.all([source('app/app.tsx'), source('features/lobby/Lobby.tsx'), source('features/room-entry/RoomEntry.tsx')]);
  assert.match(app, /href="#main-content"/);
  assert.match(app, /<main className="main-content" id="main-content" tabIndex=\{-1\}/);
  assert.doesNotMatch(lobby + entry, /<main\b/);
});

test('design: desktop/tablet/mobile layouts avoid absolute seat positioning', async () => {
  const [app, table, reactions] = await Promise.all([source('app/app.css'), source('features/game-table/game-table.css'), source('features/reactions/reactions.css')]);
  assert.match(app, /"request" "table" "controls" "log"/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(table, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(table, /:nth-child\(7\)/);
  assert.doesNotMatch(table, /translate\(|--seat-x|--seat-y/);
  assert.match(reactions, /\.app-shell \.reaction-prompt \.reaction-prompt__options/);
});

test('design: principal text combinations meet WCAG AA 4.5:1', async () => {
  const css = await source('app/tokens.css');
  const colors = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]));
  const luminance = (hex) => hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((total, c, i) => total + c * [.2126, .7152, .0722][i], 0);
  for (const [foreground, background] of [['ink','surface'], ['muted','surface'], ['muted','canvas'], ['on-felt','felt'], ['on-felt-muted','felt'], ['on-felt','forest'], ['brass','felt'], ['brass-ink','brass-soft'], ['danger','danger-soft'], ['positive','positive-soft']]) {
    const values = [luminance(colors[foreground]), luminance(colors[background])].sort((a,b) => b-a);
    const ratio = (values[0] + .05) / (values[1] + .05);
    assert.ok(ratio >= 4.5, `${foreground}/${background}: ${ratio.toFixed(2)}`);
  }
});

test('design: shared tokens require no external fonts or animation dependencies', async () => {
  const css = await source('app/app.css');
  assert.match(css, /@import "\.\/tokens.css"/);
  assert.doesNotMatch(css, /fonts\.googleapis|@font-face|backdrop-filter/);
  assert.match(await source('features/actions/actions.css'), /\.game-actions__end-turn/);
  assert.match(await source('features/game-table/game-table.css'), /\.character-portrait__artwork img/);
});
