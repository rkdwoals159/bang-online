import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: {
    host: "0.0.0.0",
    port: 5176,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3002" },
      "/socket.io": { target: "http://127.0.0.1:3002", ws: true },
    },
  },
};
