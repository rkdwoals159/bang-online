import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let Lobby;

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ Lobby } = await vite.ssrLoadModule("/src/features/lobby/Lobby.tsx"));
});

after(async () => {
  await vite?.close();
});

function room({ status = "waiting", count = 4, capacity = 4, owner = true, ready = true, connectionState } = {}) {
  const members = Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: index === 0 ? "<img src=x onerror=alert(1)>" : `Guest ${index + 1}`,
    seatIndex: index,
    ready,
    ...(connectionState ? { connectionState } : {}),
  }));
  return {
    roomId: "room-123",
    status,
    ownerPlayerId: "player-1",
    capacity,
    rulesetVersion: "base4-ko-online-1.0",
    members,
    viewer: { playerId: owner ? "player-1" : "player-2", isOwner: owner },
  };
}

function markup(roomView, viewerConnectionState) {
  return renderToStaticMarkup(createElement(Lobby, {
    room: roomView,
    roomVersion: 12,
    inviteCode: "invite-value",
    viewerConnectionState,
    origin: "https://game.example",
    onCommand() {},
    createCommandId: () => "command-1",
  }));
}

test("renders HTML-like server guest names as text without readiness controls and with explicit room status", () => {
  const html = markup(room({ ready: false }));

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img(?:\s|>)/i);
  assert.doesNotMatch(html, /onerror="/i);
  assert.match(html, /게스트/);
  assert.doesNotMatch(html, /준비 완료|준비 취소|아직 준비 전|room-lobby__ready/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>게임 시작<\/button>/);
  assert.match(html, /대기 중/);
  assert.equal((html.match(/class="room-lobby__seat(?:\s|"|$)/g) ?? []).length, 4);
});

test("renders disabled start and locked seat actions once the server room has started", () => {
  const html = markup(room({ status: "in_game", ready: true }));

  assert.match(html, /게임이 시작되어 새 참가와 강퇴를 할 수 없어요\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>게임 시작<\/button>/);
  assert.doesNotMatch(html, /내보내기/);
  assert.doesNotMatch(html, /room-lobby-invite-url/);
});

test("shows owner controls only to the owner and keeps full rooms closed to invites", () => {
  const guestHtml = markup(room({ owner: false, ready: true }));
  const fullHtml = markup(room({ capacity: 7, count: 7, ready: true }));

  assert.match(guestHtml, /게임 시작은 방장만 할 수 있어요\./);
  assert.doesNotMatch(guestHtml, /내보내기/);
  assert.match(fullHtml, /방 정원이 찼어요\. 추가 참가를 받을 수 없어요\./);
  assert.doesNotMatch(fullHtml, /room-lobby-invite-url/);
  assert.equal((fullHtml.match(/방 정원이 찼어요\. 추가 참가를 받을 수 없어요\./g) ?? []).length, 1);
});

test("shows explicit presence and never treats a missing status as connected", () => {
  const unknown = markup(room({ connectionState: undefined }));
  const disconnected = markup(room({ connectionState: "disconnected" }));
  const reconnectingViewer = markup(room(), "connecting");

  assert.match(unknown, /연결 상태 확인 중/);
  assert.doesNotMatch(unknown, /연결됨/);
  assert.match(disconnected, /연결 끊김 · 기다리는 중/);
  assert.match(disconnected, /좌석은 유지돼요/);
  assert.match(reconnectingViewer, /다시 연결 중/);
});
