import { useEffect, useRef, useState } from "react";
import type { CommandAck, MatchCommand, MatchSyncResponse } from "../../../../../packages/contracts/src/protocol.js";
import { startConnectionNoticeTimer, observeCommandRecovery, type RecoveryTransport } from "./recovery.js";

export function useDelayedConnectionNotice(message: string | null, scope: string): string | null {
  const active = message !== null;
  const [visibleScope, setVisibleScope] = useState<string | null>(null);
  useEffect(() => {
    setVisibleScope(null);
    if (!active) return;
    return startConnectionNoticeTimer(() => setVisibleScope(scope));
  }, [active, scope]);
  return active && visibleScope === scope ? message : null;
}

export function useCommandRecovery(
  transport: RecoveryTransport,
  command: MatchCommand | null,
  busy: boolean,
  onRecovered: (ack: CommandAck, projection: MatchSyncResponse) => void,
): void {
  const callback = useRef(onRecovered);
  useEffect(() => { callback.current = onRecovered; });
  useEffect(() => {
    if (!command || busy) return;
    return observeCommandRecovery(transport, command, (ack, projection) => callback.current(ack, projection));
  }, [transport, command, busy]);
}
