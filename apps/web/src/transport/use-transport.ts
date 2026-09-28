import { useSyncExternalStore } from "react";
import type { BrowserTransportState, GameTransport } from "./types.js";

/** Subscribe React views to the transport's server-authoritative projections. */
export function useBrowserTransportState(transport: GameTransport): BrowserTransportState {
  return useSyncExternalStore(
    transport.subscribe,
    transport.getSnapshot,
    transport.store.getServerSnapshot,
  );
}
