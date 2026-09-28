export type GameTransportAdapter = "sites-http-sse" | "socket-io";

/** Production bundles are the Sites Worker path; local Vite stays on Socket.IO. */
export function selectGameTransportAdapter(mode: string): GameTransportAdapter {
  return mode === "production" ? "sites-http-sse" : "socket-io";
}
