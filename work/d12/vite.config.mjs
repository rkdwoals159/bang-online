import { createRequire } from "node:module";
import { resolve } from "node:path";

const appRoot = resolve("C:/Users/user/Documents/Codex/2026-09-27/new-chat-2/apps/web");
const require = createRequire(resolve(appRoot, "package.json"));
const react = require("@vitejs/plugin-react").default;
const backend = "http://127.0.0.1:3005";
const canonicalOrigin = "http://127.0.0.1:5177";
const blockedOrigins = new Set();
const socketsByOrigin = new Map();
const browserOrigins = new Set([60, 61, 62, 63].map((n) => `http://127.0.0.${n}:5177`));

function isSocketPath(path) {
  return path === "/socket.io" || path.startsWith("/socket.io/");
}

function addSocket(origin, socket) {
  if (!origin || !browserOrigins.has(origin)) return;
  let sockets = socketsByOrigin.get(origin);
  if (!sockets) socketsByOrigin.set(origin, sockets = new Set());
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
    if (!sockets.size) socketsByOrigin.delete(origin);
  });
}

const connectionControl = {
  name: "d12-isolated-per-client-connection-control",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "").split("?", 1)[0];
      if (path === "/__d13/mobile") {
        const roomId = "r_WFCubFK898xuLKQF-fBx-n8q";
        const host = String(req.headers.host ?? "127.0.0.61:5177").split(":", 1)[0];
        const origin = `http://${host}:5177`;
        const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D13 mobile viewport</title><style>html,body{margin:0;min-height:100%;background:#16221a;color:#eee;font:16px/1.4 system-ui,sans-serif}h1{margin:0;padding:.5rem;font-size:1rem}iframe{display:block;width:360px;height:800px;border:2px solid #d8d1b7;background:#fff}</style></head><body><h1>앱 iframe viewport: 360 × 800 CSS px</h1><iframe title="360 CSS px BANG! game view" src="${origin}/rooms/${roomId}/game"></iframe></body></html>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (path === "/__d12/network") {
        const url = new URL(req.url ?? "/", canonicalOrigin);
        const origin = url.searchParams.get("origin");
        const mode = url.searchParams.get("mode");
        if (!origin || !browserOrigins.has(origin) || !["offline", "online"].includes(mode)) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("invalid test control request");
          return;
        }
        if (mode === "offline") {
          blockedOrigins.add(origin);
          for (const socket of socketsByOrigin.get(origin) ?? []) socket.destroy();
        } else {
          blockedOrigins.delete(origin);
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ origin, mode, activeSockets: socketsByOrigin.get(origin)?.size ?? 0 }));
        return;
      }

      if (path.startsWith("/api/") || isSocketPath(path)) {
        const origin = req.headers.origin;
        if (isSocketPath(path) && origin && blockedOrigins.has(origin)) {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("test guest connection is offline");
          return;
        }
        if (origin && browserOrigins.has(origin)) req.headers.origin = canonicalOrigin;
      }
      next();
    });

    return () => {
      if (!server.httpServer) throw new Error("D12 Vite test proxy has no HTTP server");
      server.httpServer.prependListener("upgrade", (req, socket) => {
        if (!isSocketPath((req.url ?? "").split("?", 1)[0])) return;
        const origin = req.headers.origin;
        if (origin && blockedOrigins.has(origin)) {
          socket.destroy();
          return;
        }
        addSocket(origin, socket);
        if (origin && browserOrigins.has(origin)) req.headers.origin = canonicalOrigin;
      });
      console.log("D12 isolated connection control installed for .60-.63:5177");
    };
  },
};

export default {
  root: appRoot,
  plugins: [react(), connectionControl],
  server: {
    host: "0.0.0.0",
    port: 5177,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/socket.io": { target: backend, changeOrigin: true, ws: true },
    },
  },
};
