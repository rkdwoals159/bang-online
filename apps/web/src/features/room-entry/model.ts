import type {
  CreateRoomPayload,
  GuestSessionRequest,
  GuestSessionResponse,
  RoomCommand,
  RoomView,
} from "../../../../../packages/contracts/src/protocol.js";

export const ROOM_ENTRY_PROTOCOL_VERSION = 1 as const;
export const ROOM_ENTRY_RULESET_VERSION = "base4-ko-online-1.0" as const;
export const MAX_DISPLAY_NAME_CODE_POINTS = 20;
/** @deprecated Use MAX_DISPLAY_NAME_CODE_POINTS; retained for the existing feature barrel export. */
export const MAX_DISPLAY_NAME_CODE_UNITS = MAX_DISPLAY_NAME_CODE_POINTS;
const DISPLAY_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export type RoomCapacity = CreateRoomPayload["capacity"];
export type CreateRoomCommand = Extract<RoomCommand, { type: "CREATE_ROOM" }>;
export type JoinRoomCommand = Extract<RoomCommand, { type: "JOIN" }>;

export interface RoomEntryPreview {
  roomId: string;
  version: number;
  occupancy: number;
  status: RoomView["status"];
}

/** The create response contains the invite once; it never contains the session credential. */
export interface RoomEntryCreateResult {
  roomId: string;
  version: number;
  inviteCode: string | null;
  duplicate: boolean;
}

/** T58 supplies this boundary and binds the requests to the HttpOnly cookie. */
export interface RoomEntryTransport {
  /** Read the current guest from the cookie; do not expose the credential to JavaScript. */
  restoreGuestSession(): Promise<GuestSessionResponse | null>;
  /** Read assigned seats for the cookie-authenticated player after a refresh. */
  recoverAssignedSeats(): Promise<readonly RoomView[]>;
  createGuestSession(input: GuestSessionRequest): Promise<GuestSessionResponse>;
  createRoom(command: CreateRoomCommand): Promise<RoomEntryCreateResult>;
  previewInvite(inviteCode: string): Promise<RoomEntryPreview | null>;
  joinRoom(command: JoinRoomCommand): Promise<RoomView>;
}

export function normalizeDisplayName(input: string): string {
  const displayName = input.trim();
  if (displayName.length === 0) {
    throw new RangeError("이름을 입력해 주세요.");
  }
  if (DISPLAY_NAME_CONTROL_CHARACTERS.test(displayName)) {
    throw new RangeError("이름에는 제어 문자를 사용할 수 없어요.");
  }
  if (Array.from(displayName).length > MAX_DISPLAY_NAME_CODE_POINTS) {
    throw new RangeError("이름은 앞뒤 공백을 빼고 20자 이내로 입력해 주세요.");
  }
  return displayName;
}

export function makeGuestSessionRequest(displayNameInput: string): GuestSessionRequest {
  return {
    protocolVersion: ROOM_ENTRY_PROTOCOL_VERSION,
    displayName: normalizeDisplayName(displayNameInput),
  };
}

export function makeCreateRoomCommand(
  player: GuestSessionResponse["player"],
  capacity: RoomCapacity,
  commandId: string,
): CreateRoomCommand {
  return {
    protocolVersion: ROOM_ENTRY_PROTOCOL_VERSION,
    commandId,
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: {
      capacity,
      rulesetVersion: ROOM_ENTRY_RULESET_VERSION,
      displayName: player.displayName,
    },
  };
}

export function makeJoinRoomCommand(
  preview: RoomEntryPreview,
  inviteCode: string,
  commandId: string,
): JoinRoomCommand {
  return {
    protocolVersion: ROOM_ENTRY_PROTOCOL_VERSION,
    commandId,
    expectedVersion: preview.version,
    type: "JOIN",
    roomId: preview.roomId,
    payload: { inviteCode },
  };
}

export function makeInviteUrl(inviteCode: string, origin: string): string {
  const url = new URL("/rooms/join", origin);
  url.searchParams.set("code", inviteCode);
  return url.toString();
}

export function readInviteCode(search: string): string {
  return new URLSearchParams(search).get("code")?.trim() ?? "";
}

const inviteFailureCodes = new Set([
  "ALREADY_JOINED",
  "INVALID_INVITE",
  "ROOM_CLOSED",
  "ROOM_FULL",
  "ROOM_LOCKED",
  "ROOM_NOT_FOUND",
  "STALE_VERSION",
]);

export const INVALID_INVITE_MESSAGE = "초대 링크를 확인할 수 없거나 이 방에 입장할 수 없어요. 방장에게 새 링크를 요청해 주세요.";
export const CONNECTION_ERROR_MESSAGE = "서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  // Both browser adapters wrap the server rejection in REQUEST_REJECTED.
  if (code === "REQUEST_REJECTED" && "message" in error && typeof error.message === "string") return error.message;
  return typeof code === "string" ? code : null;
}

export function inviteErrorMessage(error: unknown): string {
  const code = errorCode(error);
  return code !== null && inviteFailureCodes.has(code) ? INVALID_INVITE_MESSAGE : CONNECTION_ERROR_MESSAGE;
}

function invalidInviteError(): Error {
  return Object.assign(new Error(INVALID_INVITE_MESSAGE), { code: "INVALID_INVITE" });
}

export async function previewInvite(
  transport: Pick<RoomEntryTransport, "previewInvite">,
  inviteCodeInput: string,
): Promise<RoomEntryPreview> {
  const inviteCode = inviteCodeInput.trim();
  if (inviteCode.length === 0) throw invalidInviteError();
  try {
    const preview = await transport.previewInvite(inviteCode);
    if (!preview) throw invalidInviteError();
    return preview;
  } catch (error) {
    throw new Error(inviteErrorMessage(error));
  }
}

export async function joinPreviewedInvite(
  transport: Pick<RoomEntryTransport, "joinRoom">,
  preview: RoomEntryPreview,
  inviteCodeInput: string,
  commandId: string,
): Promise<RoomView> {
  try {
    return await transport.joinRoom(makeJoinRoomCommand(preview, inviteCodeInput.trim(), commandId));
  } catch (error) {
    throw new Error(inviteErrorMessage(error));
  }
}

/** The link is UI input; the opaque token remains internal to the existing protocol. */
export function extractInviteCode(input: string, origin?: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{1,512}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const codes = url.searchParams.getAll("code");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (origin && url.origin !== new URL(origin).origin) ||
        url.pathname.replace(/\/+$/, "") !== "/rooms/join" || codes.length !== 1 ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(codes[0] ?? "")) throw invalidInviteError();
    return codes[0]!;
  } catch {
    throw invalidInviteError();
  }
}

/** One UI action resolves the invite and joins; no intermediate confirmation screen.
 * Ambiguous failures retain the exact command for idempotent retry. A definitive
 * version rejection can obtain a fresh version and command (at most two retries).
 */
export function createInviteJoiner(
  transport: Pick<RoomEntryTransport, "previewInvite" | "joinRoom" | "recoverAssignedSeats">,
  createCommandId: () => string,
) {
  let inFlight: Promise<RoomView> | null = null;
  let activeCode: string | null = null;
  let intent: { code: string; command: JoinRoomCommand } | null = null;

  async function run(code: string): Promise<RoomView> {
    if (intent?.code !== code) intent = null;
    try {
      for (let retry = 0; ; retry++) {
        if (!intent) {
          const preview = await transport.previewInvite(code);
          if (!preview) throw invalidInviteError();
          intent = { code, command: makeJoinRoomCommand(preview, code, createCommandId()) };
        }
        const command = intent.command;
        try {
          const room = await transport.joinRoom(command);
          intent = null;
          return room;
        } catch (error) {
          const failure = errorCode(error);
          if (failure === "ALREADY_JOINED" || failure === "ROOM_LOCKED") {
            const targetRoomId = command.roomId;
            const rooms = await transport.recoverAssignedSeats();
            const assigned = rooms.find(room => room.roomId === targetRoomId && room.status !== "closed");
            if (assigned) { intent = null; return assigned; }
          }
          if (failure === "STALE_VERSION" && retry < 2) { intent = null; continue; }
          if (failure !== null && inviteFailureCodes.has(failure)) intent = null;
          throw error;
        }
      }
    } catch (error) {
      throw new Error(inviteErrorMessage(error));
    }
  }

  return (input: string, origin?: string): Promise<RoomView> => {
    let code: string;
    try { code = extractInviteCode(input, origin); }
    catch (error) { return Promise.reject(error); }
    if (inFlight) return code === activeCode ? inFlight : Promise.reject(new Error("입장이 진행 중이에요. 잠시 기다려 주세요."));
    activeCode = code;
    inFlight = run(code).finally(() => { inFlight = null; activeCode = null; });
    return inFlight;
  };
}
