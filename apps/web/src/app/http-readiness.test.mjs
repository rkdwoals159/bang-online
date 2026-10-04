import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let waitForTransportConnection;
before(async () => {
  vite = await createServer({ configFile: "apps/web/vite.config.ts", root: "apps/web", appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  ({ waitForTransportConnection } = await vite.ssrLoadModule("/src/app/app-state.tsx"));
});
after(async () => { await vite?.close(); });

test("HTTP readiness does not wait for a failed notification stream", async () => {
  const transport = {
    writesAvailableWhileDisconnected: true,
    getSnapshot: () => ({ connection: "disconnected" }),
    subscribe: () => { throw new Error("HTTP readiness must not subscribe to SSE"); },
    connect: () => { throw new Error("HTTP readiness must not await SSE reconnect"); },
  };
  await waitForTransportConnection(transport);
});

test("expired sessions remain rejected even for independent HTTP writes", async () => {
  await assert.rejects(waitForTransportConnection({ writesAvailableWhileDisconnected: true, getSnapshot: () => ({ connection: "expired" }) }), (error) => error.code === "SESSION_EXPIRED");
});

test("Socket.IO readiness still awaits connection", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  let listener;
  let connection = "disconnected";
  let connects = 0;
  try {
    await waitForTransportConnection({
      getSnapshot: () => ({ connection }),
      subscribe: (callback) => { listener = callback; return () => {}; },
      connect: () => { connects++; connection = "connected"; listener(); },
    });
    assert.equal(connects, 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
