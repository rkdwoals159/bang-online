import type { CommandAck, MatchCommand, MatchSyncResponse } from "../../../../../packages/contracts/src/protocol.js";
import type { BrowserTransportState } from "../../transport/types.js";

export interface RecoveryTransport {
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
  getSnapshot?: () => BrowserTransportState;
  subscribe?: (listener: () => void) => () => void;
  getCommandAcknowledgement?(commandId: string): CommandAck | undefined;
}

/** Release a command only after its receipt and an authoritative projection arrive. */
export function observeCommandRecovery(
  transport: RecoveryTransport,
  command: MatchCommand,
  onRecovered: (ack: CommandAck, projection: MatchSyncResponse) => void,
): () => void {
  let stopped = false;
  let checking = false;
  let delivered = false;
  const check = async () => {
    if (stopped || checking || delivered) return;
    const ack = transport.getCommandAcknowledgement?.(command.commandId);
    if (!ack) return;
    checking = true;
    try {
      const cached = transport.getSnapshot?.().matches[command.matchId];
      const projection = ack.status === "accepted" && cached && cached.version >= ack.aggregateVersion
        ? { protocolVersion: 1 as const, requestId: command.commandId, matchId: command.matchId,
          version: cached.version, eventSeq: cached.eventSeq, requiresFullSnapshot: cached.requiresFullSnapshot,
          snapshot: cached.snapshot, visibleEvents: cached.visibleEvents }
        : await transport.syncMatch(command.matchId);
      if (stopped || projection.matchId !== command.matchId ||
          (ack.status === "accepted" && projection.version < ack.aggregateVersion)) return;
      delivered = true;
      onRecovered(ack, projection);
    } catch {
      // A watched resource retries reads; another store update will check its receipt again.
    } finally { checking = false; }
  };
  const unsubscribe = transport.subscribe?.(() => { void check(); });
  void check();
  return () => { stopped = true; unsubscribe?.(); };
}

export const CONNECTION_NOTICE_DELAY_MS = 10_000;

export function startConnectionNoticeTimer(show: () => void): () => void {
  const timer = setTimeout(show, CONNECTION_NOTICE_DELAY_MS);
  return () => clearTimeout(timer);
}
