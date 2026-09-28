import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localServer = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: localServer },
      "/socket.io": { target: localServer, ws: true },
    },
  },
});
