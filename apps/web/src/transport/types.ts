import type {
  CommandAck,
  GuestSessionRequest,
  GuestSessionResponse,
  MatchCommand,
  MatchSyncResponse,
  MatchSnapshotView,
  PublicMatchEvent,
  MatchHistoryResponse,
  RoomCommand,
  RoomSyncResponse,
  RoomView,
} from "../../../../packages/contracts/src/protocol.js";
import type { RoomEntryCreateResult, RoomEntryPreview } from "../features/room-entry/model.js";

export type TransportConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "expired";

export interface RoomProjectionState {
  readonly version: number;
  readonly room: RoomView;
  readonly requiresFullSnapshot: boolean;
  /** Wall-clock observation ordering for ephemeral SSE presence, not a game version. */
  readonly presenceObservedAt?: string;
}

export interface MatchProjectionState {
  readonly version: number;
  readonly eventSeq: number;
  readonly snapshot: MatchSnapshotView;
  readonly visibleEvents: readonly PublicMatchEvent[];
  /** Separate from the bounded animation feed; retained and paged on demand. */
  readonly historyEvents?: readonly PublicMatchEvent[];
  readonly historyNextBeforeEventSeq?: number | null;
  readonly requiresFullSnapshot: boolean;
}

export interface BrowserTransportState {
  readonly connection: TransportConnectionState;
  readonly authenticated: boolean | null;
  readonly rooms: Readonly<Record<string, RoomProjectionState>>;
  readonly matches: Readonly<Record<string, MatchProjectionState>>;
  readonly pendingCommandIds: readonly string[];
  readonly lastError: "CONNECTION" | "SERVER_ERROR" | "SESSION_EXPIRED" | "SYNC_REJECTED" | "INVALID_RESPONSE" | null;
  readonly unavailableRooms?: readonly string[];
  readonly unavailableMatches?: readonly string[];
}

/** Consumer contract shared by the local Socket.IO and Sites HTTP/SSE adapters. */
export interface GameTransport {
  /** Sites JSON commands remain writable while its optional SSE channel reconnects. */
  readonly writesAvailableWhileDisconnected?: boolean;
  readonly store: {
    readonly getServerSnapshot: () => BrowserTransportState;
  };
  readonly getSnapshot: () => BrowserTransportState;
  readonly subscribe: (listener: () => void) => () => void;
  connect(): void;
  disconnect(): void;
  watchRoom(roomId: string): () => void;
  watchMatch(matchId: string): () => void;
  syncRoom(roomId: string): Promise<RoomSyncResponse>;
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
  getMatchHistory?(matchId: string, beforeEventSeq?: number): Promise<MatchHistoryResponse>;
  createGuestSession(input: GuestSessionRequest): Promise<GuestSessionResponse>;
  updateGuestName(input: GuestSessionRequest): Promise<GuestSessionResponse>;
  restoreGuestSession(): Promise<GuestSessionResponse | null>;
  recoverAssignedSeats(): Promise<readonly RoomView[]>;
  createRoom(command: Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<RoomEntryCreateResult>;
  reissueRoomInvite?(roomId: string, expectedVersion: number): Promise<RoomEntryCreateResult>;
  previewInvite(inviteCode: string): Promise<RoomEntryPreview | null>;
  joinRoom(command: Extract<RoomCommand, { type: "JOIN" }>): Promise<RoomView>;
  sendRoomCommand(command: RoomCommand): Promise<unknown>;
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  getCommandAcknowledgement?(commandId: string): CommandAck | undefined;
  retryPendingCommand(commandId: string): Promise<unknown>;
}
