import type {
  GuestSessionRequest,
  MatchCommand,
  MatchSnapshotView,
  RoomCommand,
  RoomSyncResponse,
} from "../../../../packages/contracts/src/protocol.js";
import { parseMatchCommand, parseRoomCommand } from "../../../../packages/contracts/src/validation.js";
import {
  joinPreviewedInvite,
  makeCreateRoomCommand,
  makeGuestSessionRequest,
  previewInvite,
  type RoomEntryCreateResult,
  type RoomEntryPreview,
  type RoomEntryTransport,
  type RoomCapacity,
} from "../features/room-entry/model.js";
import { makeStartMatchCommand } from "../features/lobby/model.js";
import type { BrowserTransportState, GameTransport } from "../transport/types.js";
import type { SessionRecovery } from "./app-state.js";
import { navigateTo, resolveRoute } from "./router.js";

type JsonObject = Record<string, unknown>;
type ExecuteOptions = { signal?: AbortSignal };

export interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    consequentialHint?: boolean;
    debugging?: boolean;
  };
  execute(input: unknown, options?: ExecuteOptions): Promise<unknown>;
}

export interface WebMcpModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface WebMcpDocument {
  readonly modelContext?: WebMcpModelContext;
}

export interface BangWebMcpRuntime {
  transport: GameTransport;
  roomEntryTransport: RoomEntryTransport;
  getSessionRecovery(): SessionRecovery;
  getTransportState(): BrowserTransportState;
  getInviteCode(roomId: string): string | null;
  rememberCreatedRoom(result: RoomEntryCreateResult): void;
  waitForConnection(): Promise<void>;
  getLocation(): { pathname: string; origin: string };
  navigate(path: string): void;
}

export interface WebMcpRegistrationReport {
  supported: boolean;
  registered: readonly string[];
  failed: readonly string[];
}

export class WebMcpActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WebMcpActionError";
  }
}

const noInputSchema: JsonObject = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

function objectSchema(properties: JsonObject, required: string[]): JsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}

function exactRecord(input: unknown, allowedKeys: readonly string[], requiredKeys = allowedKeys): JsonObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new WebMcpActionError("BAD_REQUEST", "도구 입력은 객체여야 합니다.");
  }
  const record = input as JsonObject;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new WebMcpActionError("BAD_REQUEST", "도구 입력 필드가 올바르지 않습니다.");
  }
  return record;
}

function requiredText(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new WebMcpActionError("BAD_REQUEST", `${field} 값을 입력해 주세요.`);
  }
  return input;
}

function sessionGuest(runtime: BangWebMcpRuntime) {
  const session = runtime.getSessionRecovery();
  if (session.kind !== "ready" || !session.guest) {
    throw new WebMcpActionError("GUEST_REQUIRED", "먼저 게스트 이름을 만들거나 세션을 복구해 주세요.");
  }
  return session.guest;
}

function currentRoomId(runtime: BangWebMcpRuntime): string {
  const route = resolveRoute(runtime.getLocation().pathname);
  if (!("roomId" in route)) {
    throw new WebMcpActionError("ROOM_REQUIRED", "방 대기실 또는 게임 화면을 먼저 열어 주세요.");
  }
  return route.roomId;
}

async function currentRoom(runtime: BangWebMcpRuntime): Promise<RoomSyncResponse> {
  sessionGuest(runtime);
  await runtime.waitForConnection();
  const roomId = currentRoomId(runtime);
  const response = await runtime.transport.syncRoom(roomId);
  if (response.roomId !== roomId) {
    throw new WebMcpActionError("INVALID_RESPONSE", "현재 방 상태를 확인할 수 없습니다.");
  }
  return response;
}

function commandId(): string {
  return globalThis.crypto.randomUUID();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function snapshotSummary(snapshot: MatchSnapshotView) {
  return {
    status: snapshot.status,
    viewer: snapshot.viewer,
    publicTable: snapshot.publicTable,
    selfPrivate: snapshot.selfPrivate,
    legalActions: snapshot.legalActions ?? [],
    pendingInteraction: snapshot.pendingInteraction,
    ...(snapshot.outcome ? { outcome: snapshot.outcome } : {}),
  };
}

export function createBangWebMcpTools(runtime: BangWebMcpRuntime): WebMcpTool[] {
  const stateTool: WebMcpTool = {
    name: "bang.get_current_state",
    title: "현재 BANG! 상태",
    description: "현재 게스트 세션, 열어 둔 방, 그리고 현재 게스트에게 허용된 공개 및 개인 게임 상태를 조회합니다.",
    inputSchema: noInputSchema,
    annotations: { readOnlyHint: true },
    async execute(input) {
      exactRecord(input, []);
      const session = runtime.getSessionRecovery();
      const state = runtime.getTransportState();
      const location = runtime.getLocation();
      const route = resolveRoute(location.pathname);
      const result: JsonObject = {
        route,
        connection: state.connection,
        session: session.kind === "ready"
          ? { status: "ready", guest: session.guest, assignedRooms: session.assignedRooms }
          : { status: session.kind, ...(session.kind === "error" ? { message: session.message, expired: session.expired } : {}) },
      };

      if ("roomId" in route && session.kind === "ready" && session.guest) {
        try {
          const roomResponse = await currentRoom(runtime);
          result.room = roomResponse.room;
          result.roomVersion = roomResponse.version;
          result.inviteCode = runtime.getInviteCode(roomResponse.roomId);
          if (roomResponse.room.activeMatchId) {
            const match = await runtime.transport.syncMatch(roomResponse.room.activeMatchId);
            result.match = {
              matchId: match.matchId,
              version: match.version,
              eventSeq: match.eventSeq,
              snapshot: snapshotSummary(match.snapshot),
            };
          }
        } catch (error) {
          result.syncError = errorMessage(error);
        }
      }
      return result;
    },
  };

  const createGuestTool: WebMcpTool = {
    name: "bang.create_guest_session",
    title: "게스트 세션 만들기",
    description: "입력한 이름으로 현재 브라우저의 게스트 세션을 만듭니다.",
    inputSchema: objectSchema({
      displayName: { type: "string", minLength: 1, maxLength: 20, description: "게임에서 사용할 이름" },
    }, ["displayName"]),
    annotations: { consequentialHint: true },
    async execute(input) {
      const record = exactRecord(input, ["displayName"]);
      const displayName = requiredText(record.displayName, "displayName");
      const request: GuestSessionRequest = makeGuestSessionRequest(displayName);
      const guest = await runtime.roomEntryTransport.createGuestSession(request);
      return { guest };
    },
  };

  const createRoomTool: WebMcpTool = {
    name: "bang.create_room",
    title: "비공개 방 만들기",
    description: "현재 게스트 소유의 기본판 비공개 방을 만들고 방장에게 전달되는 초대 코드를 반환합니다.",
    inputSchema: objectSchema({
      capacity: { type: "integer", enum: [4, 5, 6, 7], description: "방의 최대 인원" },
    }, ["capacity"]),
    annotations: { consequentialHint: true },
    async execute(input) {
      const record = exactRecord(input, ["capacity"]);
      if (![4, 5, 6, 7].includes(record.capacity as number)) {
        throw new WebMcpActionError("BAD_REQUEST", "방 인원은 4명부터 7명까지 선택할 수 있습니다.");
      }
      const guest = sessionGuest(runtime);
      const command = makeCreateRoomCommand(guest.player, record.capacity as RoomCapacity, commandId());
      const parsed = parseRoomCommand(command);
      if (!parsed.ok || parsed.value.type !== "CREATE_ROOM") {
        throw new WebMcpActionError("BAD_REQUEST", "방 만들기 입력을 확인해 주세요.");
      }
      const created = await runtime.roomEntryTransport.createRoom(parsed.value);
      runtime.rememberCreatedRoom(created);
      runtime.navigate(`/rooms/${encodeURIComponent(created.roomId)}`);
      return {
        roomId: created.roomId,
        version: created.version,
        inviteCode: created.inviteCode,
        inviteUrl: created.inviteCode ? new URL(`/rooms/join?code=${encodeURIComponent(created.inviteCode)}`, runtime.getLocation().origin).toString() : null,
      };
    },
  };

  const joinRoomTool: WebMcpTool = {
    name: "bang.join_room",
    title: "초대 코드로 참가",
    description: "입력한 초대 코드를 미리 확인하고 유효한 비공개 방의 빈 좌석에 참가합니다.",
    inputSchema: objectSchema({ inviteCode: { type: "string", minLength: 1, description: "방장이 공유한 초대 코드" } }, ["inviteCode"]),
    annotations: { consequentialHint: true, untrustedContentHint: true },
    async execute(input) {
      const record = exactRecord(input, ["inviteCode"]);
      const inviteCode = requiredText(record.inviteCode, "inviteCode").trim();
      sessionGuest(runtime);
      const preview: RoomEntryPreview = await previewInvite(runtime.roomEntryTransport, inviteCode);
      const room = await joinPreviewedInvite(runtime.roomEntryTransport, preview, inviteCode, commandId());
      runtime.navigate(`/rooms/${encodeURIComponent(room.roomId)}`);
      return { room };
    },
  };

  const startMatchTool: WebMcpTool = {
    name: "bang.start_match",
    title: "현재 방에서 게임 시작",
    description: "현재 대기실의 기본판 게임 시작 요청을 서버에 전송합니다. 서버가 인원·방장·대기실 상태를 검증합니다.",
    inputSchema: noInputSchema,
    annotations: { consequentialHint: true },
    async execute(input) {
      exactRecord(input, []);
      const current = await currentRoom(runtime);
      const command = makeStartMatchCommand(current.roomId, current.version, commandId());
      const parsed = parseRoomCommand(command);
      if (!parsed.ok) throw new WebMcpActionError("BAD_REQUEST", "게임 시작 입력을 확인해 주세요.");
      const acknowledgement = await runtime.transport.sendRoomCommand(parsed.value as RoomCommand);
      const room = await runtime.transport.syncRoom(current.roomId);
      const match = room.room.activeMatchId ? await runtime.transport.syncMatch(room.room.activeMatchId) : null;
      return {
        acknowledgement,
        room: room.room,
        roomVersion: room.version,
        match: match ? { matchId: match.matchId, version: match.version, snapshot: snapshotSummary(match.snapshot) } : null,
      };
    },
  };

  const actionTool: WebMcpTool = {
    name: "bang.perform_match_action",
    title: "현재 게임에서 합법 행동 실행",
    description: "현재 게임의 최신 서버 projection에서 고른 합법 행동 또는 본인에게 열린 응답 선택지를 실행합니다. 선택 인덱스는 bang.get_current_state 결과에 표시된 배열 기준입니다.",
    inputSchema: objectSchema({
      action: {
        oneOf: [
          objectSchema({ mode: { const: "LEGAL_ACTION" }, index: { type: "integer", minimum: 0 } }, ["mode", "index"]),
          objectSchema({
            mode: { const: "RESPOND" },
            index: { type: "integer", minimum: 0 },
            orderedCardInstanceIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          }, ["mode", "index"]),
        ],
      },
    }, ["action"]),
    annotations: { consequentialHint: true },
    async execute(input) {
      const record = exactRecord(input, ["action"]);
      const actionInput = exactRecord(record.action, ["mode", "index", "orderedCardInstanceIds"], ["mode", "index"]);
      if (actionInput.mode !== "LEGAL_ACTION" && actionInput.mode !== "RESPOND") {
        throw new WebMcpActionError("BAD_REQUEST", "action mode가 올바르지 않습니다.");
      }
      if (!Number.isSafeInteger(actionInput.index) || (actionInput.index as number) < 0) {
        throw new WebMcpActionError("BAD_REQUEST", "action index는 0 이상의 정수여야 합니다.");
      }
      if (actionInput.orderedCardInstanceIds !== undefined &&
          (!Array.isArray(actionInput.orderedCardInstanceIds) ||
            !actionInput.orderedCardInstanceIds.every((id) => typeof id === "string" && id.length > 0))) {
        throw new WebMcpActionError("BAD_REQUEST", "orderedCardInstanceIds 형식이 올바르지 않습니다.");
      }

      const route = resolveRoute(runtime.getLocation().pathname);
      if (route.kind !== "game") throw new WebMcpActionError("GAME_REQUIRED", "게임판을 열어 주세요.");
      const roomResponse = await currentRoom(runtime);
      const matchId = roomResponse.room.activeMatchId;
      if (!matchId) throw new WebMcpActionError("MATCH_NOT_FOUND", "현재 방에 진행 중인 게임이 없습니다.");
      const sync = await runtime.transport.syncMatch(matchId);
      const snapshot = sync.snapshot;
      let type: MatchCommand["type"];
      let payload: MatchCommand["payload"];

      if (actionInput.mode === "LEGAL_ACTION") {
        if (actionInput.orderedCardInstanceIds !== undefined) {
          throw new WebMcpActionError("BAD_REQUEST", "일반 행동에는 버릴 카드 목록을 함께 보낼 수 없습니다.");
        }
        const proposal = snapshot.legalActions?.[actionInput.index as number];
        if (!proposal) throw new WebMcpActionError("ACTION_NOT_AVAILABLE", "최신 서버 선택지에 해당 행동이 없습니다.");
        type = proposal.type;
        payload = proposal.payload;
      } else {
        const pending = snapshot.pendingInteraction;
        if (!pending || !("responseOptions" in pending) || !pending.responseOptions ||
            pending.currentResponderPlayerId !== snapshot.viewer.playerId) {
          throw new WebMcpActionError("RESPONSE_NOT_AVAILABLE", "현재 게스트에게 열린 응답이 없습니다.");
        }
        const option = pending.responseOptions[actionInput.index as number];
        if (!option) throw new WebMcpActionError("ACTION_NOT_AVAILABLE", "최신 서버 응답 선택지에 해당 항목이 없습니다.");
        const orderingIds = actionInput.orderedCardInstanceIds as string[] | undefined;
        if (option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option)) {
          const discardOrder = "discardOrder" in pending ? pending.discardOrder : undefined;
          if (!discardOrder || !orderingIds || orderingIds.length !== discardOrder.requiredCount ||
              new Set(orderingIds).size !== orderingIds.length ||
              orderingIds.some((id) => !discardOrder.allowedCards.some((card) => card.cardInstanceId === id))) {
            throw new WebMcpActionError("INVALID_DISCARD_ORDER", "현재 서버가 제시한 카드 중 필요한 수만큼 골라 순서를 입력해 주세요.");
          }
          payload = { interactionId: option.interactionId, choice: "ORDER_CARDS", orderedCardInstanceIds: orderingIds };
        } else {
          if (orderingIds !== undefined) throw new WebMcpActionError("BAD_REQUEST", "이 응답 선택에는 orderedCardInstanceIds를 사용할 수 없습니다.");
          payload = option as MatchCommand["payload"];
        }
        type = "RESPOND";
      }

      const command = {
        protocolVersion: 1,
        commandId: commandId(),
        expectedVersion: sync.version,
        matchId,
        type,
        payload,
      };
      const parsed = parseMatchCommand(command);
      if (!parsed.ok) throw new WebMcpActionError("BAD_REQUEST", "현재 행동 명령을 엄격한 프로토콜 검사에서 거부했습니다.");
      const acknowledgement = await runtime.transport.sendMatchCommand(parsed.value);
      const updated = await runtime.transport.syncMatch(matchId);
      return {
        acknowledgement,
        matchId,
        version: updated.version,
        snapshot: snapshotSummary(updated.snapshot),
      };
    },
  };

  return [stateTool, createGuestTool, createRoomTool, joinRoomTool, startMatchTool, actionTool];
}

export async function registerBangWebMcpTools(
  target: WebMcpDocument,
  runtime: BangWebMcpRuntime,
  signal: AbortSignal,
): Promise<WebMcpRegistrationReport> {
  const modelContext = target.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return { supported: false, registered: [], failed: [] };
  }

  const registered: string[] = [];
  const failed: string[] = [];
  for (const tool of createBangWebMcpTools(runtime)) {
    if (signal.aborted) break;
    try {
      await modelContext.registerTool(tool, { signal });
      registered.push(tool.name);
    } catch {
      failed.push(tool.name);
    }
  }
  return { supported: true, registered, failed };
}

export function errorMessage(error: unknown): string {
  if (error instanceof WebMcpActionError) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "요청을 처리하지 못했습니다.";
}
