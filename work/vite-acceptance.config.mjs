import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL("../apps/web/", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001" },
      "/socket.io": { target: "http://127.0.0.1:3001", ws: true },
    },
  },
};
