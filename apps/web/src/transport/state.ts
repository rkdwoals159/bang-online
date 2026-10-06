import type {
  MatchSyncResponse,
  MatchHistoryResponse,
  PublicMatchEvent,
  RoomPresenceView,
  RoomSyncResponse,
  RoomView,
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
  unavailableRooms: Object.freeze([]),
  unavailableMatches: Object.freeze([]),
});

const MAX_VISIBLE_EVENTS = 100;

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
  return [...bySequence.values()]
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .slice(-MAX_VISIBLE_EVENTS);
}

/** Small immutable store shared by the Socket.IO client and React hook. */
export class BrowserTransportStore {
  private current = INITIAL_STATE;
  private viewerPlayerId: string | null | undefined;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): BrowserTransportState => this.current;
  readonly getServerSnapshot = (): BrowserTransportState => INITIAL_STATE;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setConnection(connection: TransportConnectionState, authenticated: boolean | null): void {
    if (authenticated === false) this.setViewerPlayerId(null);
    this.update({ connection, authenticated, lastError: connection === "expired" ? "SESSION_EXPIRED" : null });
  }

  /** Cookie-derived projections must never survive a change of guest identity. */
  setViewerPlayerId(playerId: string | null): void {
    if (playerId === this.viewerPlayerId) return;
    this.viewerPlayerId = playerId;
    this.update({ rooms: Object.freeze({}), matches: Object.freeze({}), pendingCommandIds: Object.freeze([]),
      unavailableRooms: Object.freeze([]), unavailableMatches: Object.freeze([]) });
  }

  isCurrentViewer(playerId: string): boolean {
    return this.viewerPlayerId === undefined || this.viewerPlayerId === playerId;
  }

  setError(error: BrowserTransportState["lastError"]): void {
    if (this.current.lastError === error) return;
    this.update({ lastError: error });
  }

  setResourceUnavailable(kind: "room" | "match", id: string): void {
    if (kind === "room") {
      const { [id]: _removed, ...rooms } = this.current.rooms;
      this.update({ rooms: Object.freeze(rooms),
        unavailableRooms: Object.freeze([...new Set([...(this.current.unavailableRooms ?? []), id])]),
        lastError: "SYNC_REJECTED" });
    } else {
      const { [id]: _removed, ...matches } = this.current.matches;
      this.update({ matches: Object.freeze(matches),
        unavailableMatches: Object.freeze([...new Set([...(this.current.unavailableMatches ?? []), id])]),
        lastError: "SYNC_REJECTED" });
    }
  }

  restoreResourceAccess(kind: "room" | "match", id: string): void {
    if (kind === "room") this.update({ unavailableRooms: Object.freeze((this.current.unavailableRooms ?? []).filter(value => value !== id)) });
    else this.update({ unavailableMatches: Object.freeze((this.current.unavailableMatches ?? []).filter(value => value !== id)) });
  }

  setPendingCommandIds(ids: readonly string[]): void {
    const pendingCommandIds = [...ids];
    if (sameIds(this.current.pendingCommandIds, pendingCommandIds)) return;
    this.update({ pendingCommandIds: Object.freeze(pendingCommandIds) });
  }

  applyRoomSync(response: RoomSyncResponse): boolean {
    if (!this.isCurrentViewer(response.room.viewer.playerId)) return false;
    const previous = this.current.rooms[response.roomId];
    if (previous && response.version < previous.version) {
      this.setError(null);
      return false;
    }
    if (previous && response.version === previous.version) {
      if (previous.requiresFullSnapshot === response.requiresFullSnapshot) {
        this.setError(null);
        return false;
      }
      const next = Object.freeze({ ...previous, requiresFullSnapshot: response.requiresFullSnapshot });
      this.update({
        rooms: Object.freeze({ ...this.current.rooms, [response.roomId]: next }),
        lastError: null,
      });
      return true;
    }

    const room = preserveRoomPresence(response.room, previous?.room);
    const next: RoomProjectionState = Object.freeze({
      version: response.version,
      room,
      requiresFullSnapshot: response.requiresFullSnapshot,
      ...(previous?.presenceObservedAt ? { presenceObservedAt: previous.presenceObservedAt } : {}),
    });
    this.update({
      rooms: Object.freeze({ ...this.current.rooms, [response.roomId]: next }),
      lastError: null,
    });
    return true;
  }

  /** Apply a canonical room-command projection only when it carries its source version. */
  applyRoomCommand(room: RoomView): boolean {
    if (!this.isCurrentViewer(room.viewer.playerId)) return false;
    if (room.version === undefined) return false;
    const previous = this.current.rooms[room.roomId];
    if (previous && room.version <= previous.version) return false;
    const next: RoomProjectionState = Object.freeze({
      version: room.version,
      room: preserveRoomPresence(room, previous?.room),
      requiresFullSnapshot: false,
      ...(previous?.presenceObservedAt ? { presenceObservedAt: previous.presenceObservedAt } : {}),
    });
    this.update({
      rooms: Object.freeze({ ...this.current.rooms, [room.roomId]: next }),
      lastError: null,
    });
    return true;
  }

  /** Apply a membership-scoped, volatile presence observation without changing room.version. */
  applyRoomPresence(view: RoomPresenceView): boolean {
    const previous = this.current.rooms[view.roomId];
    if (!previous) return false;
    const observedAt = Date.parse(view.observedAt);
    if (!Number.isFinite(observedAt) ||
        (previous.presenceObservedAt && observedAt <= Date.parse(previous.presenceObservedAt))) return false;
    const knownMembers = new Set(previous.room.members.map((member) => member.playerId));
    const states = new Map(view.members
      .filter((member) => knownMembers.has(member.playerId))
      .map((member) => [member.playerId, member.connectionState] as const));
    if (states.size === 0) return false;
    const members = previous.room.members.map((member) => {
      const connectionState = states.get(member.playerId);
      return connectionState === undefined || connectionState === member.connectionState
        ? member
        : { ...member, connectionState };
    });
    const next: RoomProjectionState = Object.freeze({
      ...previous,
      room: { ...previous.room, members },
      presenceObservedAt: view.observedAt,
    });
    this.update({ rooms: Object.freeze({ ...this.current.rooms, [view.roomId]: next }) });
    return true;
  }

  appendMatchHistory(matchId: string, events: readonly PublicMatchEvent[], page?: MatchHistoryResponse): void {
    const previous = this.current.matches[matchId];
    if (!previous) return;
    const historyEvents = mergeHistoryEvents(previous.historyEvents ?? previous.visibleEvents,
      events.filter(event => event.eventSeq <= previous.eventSeq));
    this.update({ matches: Object.freeze({ ...this.current.matches,
      [matchId]: Object.freeze({ ...previous, historyEvents: Object.freeze(historyEvents),
        ...(page && page.beforeEventSeq === previous.historyNextBeforeEventSeq
          ? { historyNextBeforeEventSeq: page.nextBeforeEventSeq } : {}) }) }) });
  }

  applyMatchSync(response: MatchSyncResponse): boolean {
    if (!this.isCurrentViewer(response.snapshot.viewer.playerId)) return false;
    const previous = this.current.matches[response.matchId];
    if (previous && (response.version < previous.version || response.eventSeq < previous.eventSeq)) {
      this.setError(null);
      return false;
    }

    const sameCursor = previous?.version === response.version && previous.eventSeq === response.eventSeq;
    if (sameCursor && previous && !response.requiresFullSnapshot) {
      if (!previous.requiresFullSnapshot) {
        this.setError(null);
        return false;
      }
      const next = Object.freeze({ ...previous, requiresFullSnapshot: false });
      this.update({
        matches: Object.freeze({ ...this.current.matches, [response.matchId]: next }),
        lastError: null,
      });
      return true;
    }

    const historyEvents = mergeHistoryEvents(previous?.historyEvents ?? previous?.visibleEvents ?? [], response.visibleEvents);
    const historyNextBeforeEventSeq = !previous || (response.requiresFullSnapshot && response.eventSeq - previous.eventSeq > 100)
      ? response.visibleEvents[0]?.eventSeq ?? response.eventSeq + 1
      : previous.historyNextBeforeEventSeq;
    const visibleEvents = response.requiresFullSnapshot || !previous
      ? response.visibleEvents.slice(-MAX_VISIBLE_EVENTS)
      : mergeEvents(previous.visibleEvents, response.visibleEvents);
    const next: MatchProjectionState = Object.freeze({
      version: response.version,
      eventSeq: response.eventSeq,
      snapshot: response.snapshot,
      visibleEvents: Object.freeze(visibleEvents),
      historyEvents: Object.freeze(historyEvents),
      historyNextBeforeEventSeq,
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

function mergeHistoryEvents(previous: readonly PublicMatchEvent[], received: readonly PublicMatchEvent[]): PublicMatchEvent[] {
  const events = new Map(previous.map(event => [event.eventSeq, event]));
  for (const event of received) if (!events.has(event.eventSeq)) events.set(event.eventSeq, event);
  return [...events.values()].sort((a, b) => a.eventSeq - b.eventSeq);
}

function preserveRoomPresence(incoming: RoomView, previous?: RoomView): RoomView {
  if (!previous) return incoming;
  const previousByPlayer = new Map(previous.members.map((member) => [member.playerId, member] as const));
  const members = incoming.members.map((member) => {
    const prior = previousByPlayer.get(member.playerId);
    return prior?.connectionState === undefined ? member : { ...member, connectionState: prior.connectionState };
  });
  return { ...incoming, members };
}
