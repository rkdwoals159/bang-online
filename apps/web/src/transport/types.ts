import type {
  CommandAck,
  GuestSessionRequest,
  GuestSessionResponse,
  MatchCommand,
  MatchSyncResponse,
  MatchSnapshotView,
  PublicMatchEvent,
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
}

export interface MatchProjectionState {
  readonly version: number;
  readonly eventSeq: number;
  readonly snapshot: MatchSnapshotView;
  readonly visibleEvents: readonly PublicMatchEvent[];
  readonly requiresFullSnapshot: boolean;
}

export interface BrowserTransportState {
  readonly connection: TransportConnectionState;
  readonly authenticated: boolean | null;
  readonly rooms: Readonly<Record<string, RoomProjectionState>>;
  readonly matches: Readonly<Record<string, MatchProjectionState>>;
  readonly pendingCommandIds: readonly string[];
  readonly lastError: "CONNECTION" | "SESSION_EXPIRED" | "SYNC_REJECTED" | "INVALID_RESPONSE" | null;
}

/** Consumer contract shared by the local Socket.IO and Sites HTTP/SSE adapters. */
export interface GameTransport {
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
  createGuestSession(input: GuestSessionRequest): Promise<GuestSessionResponse>;
  restoreGuestSession(): Promise<GuestSessionResponse | null>;
  recoverAssignedSeats(): Promise<readonly RoomView[]>;
  createRoom(command: Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<RoomEntryCreateResult>;
  previewInvite(inviteCode: string): Promise<RoomEntryPreview | null>;
  joinRoom(command: Extract<RoomCommand, { type: "JOIN" }>): Promise<RoomView>;
  sendRoomCommand(command: RoomCommand): Promise<unknown>;
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  retryPendingCommand(commandId: string): Promise<unknown>;
}
