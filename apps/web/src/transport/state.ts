import type {
  MatchSyncResponse,
  PublicMatchEvent,
  RoomSyncResponse,
} from "../../../../packages/contracts/src/protocol.js";
import type {
  BrowserTransportState,
  MatchProjectionState,
  RoomProjectionState,
  TransportConnectionState,
} from "./types.js";

const INITIAL_STATE: BrowserTransportState = Object.freeze({
  connection: "idle",
  authenticated: null,
  rooms: Object.freeze({}),
  matches: Object.freeze({}),
  pendingCommandIds: Object.freeze([]),
  lastError: null,
});

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mergeEvents(
  previous: readonly PublicMatchEvent[],
  received: readonly PublicMatchEvent[],
): readonly PublicMatchEvent[] {
  const bySequence = new Map<number, PublicMatchEvent>();
  for (const event of previous) bySequence.set(event.eventSeq, event);
  for (const event of received) bySequence.set(event.eventSeq, event);
  return [...bySequence.values()].sort((left, right) => left.eventSeq - right.eventSeq);
}

/** Small immutable store shared by the Socket.IO client and React hook. */
export class BrowserTransportStore {
  private current = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): BrowserTransportState => this.current;
  readonly getServerSnapshot = (): BrowserTransportState => INITIAL_STATE;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setConnection(connection: TransportConnectionState, authenticated: boolean | null): void {
    this.update({ connection, authenticated, lastError: connection === "expired" ? "SESSION_EXPIRED" : null });
  }

  setError(error: BrowserTransportState["lastError"]): void {
    this.update({ lastError: error });
  }

  setPendingCommandIds(ids: readonly string[]): void {
    const pendingCommandIds = [...ids];
    if (sameIds(this.current.pendingCommandIds, pendingCommandIds)) return;
    this.update({ pendingCommandIds: Object.freeze(pendingCommandIds) });
  }

  applyRoomSync(response: RoomSyncResponse): boolean {
    const previous = this.current.rooms[response.roomId];
    if (previous && response.version < previous.version) return false;
    if (previous && response.version === previous.version) {
      if (previous.requiresFullSnapshot === response.requiresFullSnapshot) return false;
      const next = Object.freeze({ ...previous, requiresFullSnapshot: response.requiresFullSnapshot });
      this.update({
        rooms: Object.freeze({ ...this.current.rooms, [response.roomId]: next }),
        lastError: null,
      });
      return true;
    }

    const next: RoomProjectionState = Object.freeze({
      version: response.version,
      room: response.room,
      requiresFullSnapshot: response.requiresFullSnapshot,
    });
    this.update({
      rooms: Object.freeze({ ...this.current.rooms, [response.roomId]: next }),
      lastError: null,
    });
    return true;
  }

  applyMatchSync(response: MatchSyncResponse): boolean {
    const previous = this.current.matches[response.matchId];
    if (previous && (response.version < previous.version || response.eventSeq < previous.eventSeq)) return false;

    const sameCursor = previous?.version === response.version && previous.eventSeq === response.eventSeq;
    if (sameCursor && previous && !response.requiresFullSnapshot) {
      if (!previous.requiresFullSnapshot) return false;
      const next = Object.freeze({ ...previous, requiresFullSnapshot: false });
      this.update({
        matches: Object.freeze({ ...this.current.matches, [response.matchId]: next }),
        lastError: null,
      });
      return true;
    }

    const visibleEvents = response.requiresFullSnapshot || !previous
      ? [...response.visibleEvents]
      : mergeEvents(previous.visibleEvents, response.visibleEvents);
    const next: MatchProjectionState = Object.freeze({
      version: response.version,
      eventSeq: response.eventSeq,
      snapshot: response.snapshot,
      visibleEvents: Object.freeze(visibleEvents),
      requiresFullSnapshot: response.requiresFullSnapshot,
    });
    this.update({
      matches: Object.freeze({ ...this.current.matches, [response.matchId]: next }),
      lastError: null,
    });
    return true;
  }

  private update(patch: Partial<BrowserTransportState>): void {
    this.current = Object.freeze({ ...this.current, ...patch });
    for (const listener of this.listeners) listener();
  }
}
