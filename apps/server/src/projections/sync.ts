import { BASE_PHYSICAL_CARDS } from "../../../../packages/catalog/src/cards/index.js";
import type {
  MatchSyncRequest,
  MatchSyncResponse,
  PublicMatchEvent,
  RoomSyncRequest,
  RoomSyncResponse,
  SyncRejectedResponse,
} from "../../../../packages/contracts/src/protocol.js";
import { projectMatchSnapshot } from "../../../../packages/engine/src/state/projection.js";
import type { GameState, JsonValue } from "../../../../packages/engine/src/state/types.js";
import type { AuthenticatedSocketContext, GatewayAck, GatewayHandlers } from "../socket/gateway.js";
import type { MatchEventRecord, StorageRepository } from "../storage/repository.js";

type SyncHandlers = Pick<GatewayHandlers, "roomSync" | "matchSync">;
type SyncContext = Pick<AuthenticatedSocketContext, "playerId" | "roomMembership" | "matchMembership">;
type SyncStorage = Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;

export interface SyncProjectionDependencies {
  readonly storage: SyncStorage;
}

const REJECTED_NOT_FOUND: SyncRejectedResponse["error"]["code"] = "NOT_FOUND_OR_FORBIDDEN";

function reject(requestId: string, ack: GatewayAck): void {
  const response: SyncRejectedResponse = {
    protocolVersion: 1,
    requestId,
    status: "rejected",
    error: { code: REJECTED_NOT_FOUND },
  };
  ack(response);
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function projectPayloadFields(
  payload: JsonValue,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      projected[field] = value;
    } else if ((field === "targetPlayerIds" || field === "healedPlayerIds") && strings(value)) {
      projected[field] = strings(value);
    }
  }
  return projected;
}

/**
 * Only event kinds with deliberately public meaning are projected. Their
 * payloads are copied field-by-field; unknown events and private hand events
 * are omitted by default.
 */
const PUBLIC_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  BANG_ATTACKED: ["targetPlayerId"],
  BANG_HIT: ["targetPlayerId", "damage"],
  BANG_MISSED: ["targetPlayerId"],
  GATLING_STARTED: ["targetPlayerIds"],
  GATLING_HIT: ["targetPlayerId", "damage"],
  GATLING_MISSED: ["targetPlayerId"],
  INDIANS_STARTED: ["targetPlayerIds"],
  INDIANS_HIT: ["targetPlayerId", "damage"],
  INDIANS_DEFENDED: ["targetPlayerId", "convertedFromMissed"],
  DUEL_STARTED: ["initiatorPlayerId", "targetPlayerId"],
  DUEL_YIELDED: ["initiatorPlayerId", "playerId", "damage"],
  DUEL_BANG_PLAYED: ["initiatorPlayerId", "responderPlayerId", "cardType", "asCardType"],
  BEER_USED: ["mode", "healed"],
  SALOON_USED: ["healedPlayerIds"],
  PLAYER_HEALED: ["targetPlayerId", "amount", "cause"],
  DYNAMITE_EXPLODED: ["targetPlayerId", "damage", "responsiblePlayerId"],
  DYNAMITE_PASSED: ["fromPlayerId", "toPlayerId"],
  BARREL_CHECK_REQUESTED: ["attackKind", "defenseSource", "targetPlayerId"],
  BARREL_JUDGMENT_REVEALED: ["rank", "suit"],
  DYNAMITE_JUDGMENT_REVEALED: ["rank", "suit"],
  JAIL_JUDGMENT_REVEALED: ["rank", "suit"],
  BARREL_CHECK_RESOLVED: ["attackKind", "defenseSource", "targetPlayerId", "succeeded", "successfulMisses", "requiredMisses"],
  JAIL_JUDGMENT_RESOLVED: ["suit", "heart", "turnSkipped"],
  GENERAL_STORE_CARD_REVEALED: [],
});

const PUBLIC_CARD_REVEAL_EVENTS = new Set([
  "GENERAL_STORE_CARD_REVEALED",
  "BARREL_JUDGMENT_REVEALED",
  "DYNAMITE_JUDGMENT_REVEALED",
  "JAIL_JUDGMENT_REVEALED",
]);

function projectEvent(
  event: MatchEventRecord,
  state: GameState,
): PublicMatchEvent | undefined {
  const blackJackReveal = event.type === "CARD_DRAWN" && isRecord(event.payload) &&
    event.payload.visibility === "public" && event.payload.reason === "BLACK_JACK_SECOND_DRAW" &&
    state.seats.some(seat => seat.public.playerId === event.actorPlayerId && seat.public.characterId === "black_jack");
  const fields = blackJackReveal ? ["rank", "suit"] : PUBLIC_EVENT_FIELDS[event.type];
  if (!fields) return undefined;

  const payload = projectPayloadFields(event.payload, fields);
  if (event.actorPlayerId !== null) payload.actorPlayerId = event.actorPlayerId;

  if ((blackJackReveal || PUBLIC_CARD_REVEAL_EVENTS.has(event.type)) && isRecord(event.payload)) {
    const cardInstanceId = typeof event.payload.cardInstanceId === "string"
      ? event.payload.cardInstanceId
      : event.payload.judgmentCardInstanceId;
    if (typeof cardInstanceId === "string") {
      const card = state.zones.cardsByInstanceId[cardInstanceId];
      const definition = card && BASE_PHYSICAL_CARDS.find(({ definitionId }) => definitionId === card.cardDefinitionId);
      if (card && definition) {
        payload.card = {
          cardInstanceId: card.cardInstanceId,
          typeId: definition.typeId,
          rank: String(card.rank),
          suit: card.suit,
        };
      }
    }
  }

  return {
    eventSeq: event.eventSeq,
    type: blackJackReveal ? "BLACK_JACK_CARD_REVEALED" : event.type,
    occurredAt: event.createdAt.toISOString(),
    payload,
  };
}

function cursorIsReplayable(
  afterEventSeq: number,
  currentEventSeq: number,
  events: readonly MatchEventRecord[],
): boolean {
  if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0 || afterEventSeq > currentEventSeq) return false;
  const expectedCount = currentEventSeq - afterEventSeq;
  return events.length === expectedCount && events.every((event, index) => event.eventSeq === afterEventSeq + index + 1);
}

function roomRecordMatchesView(
  record: Awaited<ReturnType<SyncStorage["getRoom"]>>,
  view: Awaited<ReturnType<SyncContext["roomMembership"]>>,
): boolean {
  if (!record || !view || record.id !== view.roomId || record.status !== view.status ||
      record.ownerPlayerId !== view.ownerPlayerId || record.capacity !== view.capacity ||
      record.players.length !== view.members.length) return false;

  const membersBySeat = [...view.members].sort((left, right) => left.seatIndex - right.seatIndex);
  const playersBySeat = [...record.players].sort((left, right) => left.seatIndex - right.seatIndex);
  return playersBySeat.every((player, index) => {
    const member = membersBySeat[index];
    return member !== undefined && player.playerId === member.playerId &&
      player.seatIndex === member.seatIndex && player.ready === member.ready;
  });
}

/** Build server sync callbacks for T45's authenticated gateway context. */
export function createSyncProjectionHandlers(dependencies: SyncProjectionDependencies): SyncHandlers {
  return {
    roomSync: async (context: SyncContext, request: RoomSyncRequest, ack: GatewayAck) => {
      const memberView = await context.roomMembership(request.roomId);
      const roomRecord = await dependencies.storage.getRoom(request.roomId);
      const actorIsMember = roomRecord?.players.some(({ playerId }) => playerId === context.playerId) ?? false;
      const viewMatchesActor = memberView?.roomId === request.roomId &&
        memberView.viewer.playerId === context.playerId &&
        memberView.members.some(({ playerId }) => playerId === context.playerId);
      if (!roomRecord || !memberView || !actorIsMember || !viewMatchesActor ||
          !roomRecordMatchesView(roomRecord, memberView)) {
        reject(request.requestId, ack);
        return;
      }

      const response: RoomSyncResponse = {
        protocolVersion: 1,
        requestId: request.requestId,
        roomId: request.roomId,
        version: roomRecord.version,
        requiresFullSnapshot: request.knownVersion !== roomRecord.version,
        room: memberView,
      };
      ack(response);
    },

    matchSync: async (context: SyncContext, request: MatchSyncRequest, ack: GatewayAck) => {
      const membershipIsCurrent = await context.matchMembership(request.matchId);
      if (!membershipIsCurrent) {
        reject(request.requestId, ack);
        return;
      }

      const match = await dependencies.storage.getMatch(request.matchId);
      if (!match || !match.players.some(({ playerId }) => playerId === context.playerId)) {
        reject(request.requestId, ack);
        return;
      }

      const matchEvents = request.afterEventSeq <= match.eventSeq
        ? await dependencies.storage.listMatchEvents(request.matchId, request.afterEventSeq)
        : [];
      const replayable = cursorIsReplayable(request.afterEventSeq, match.eventSeq, matchEvents);
      const visibleEvents = matchEvents.flatMap((event) => {
        const projected = projectEvent(event, match.state);
        return projected ? [projected] : [];
      });

      const response: MatchSyncResponse = {
        protocolVersion: 1,
        requestId: request.requestId,
        matchId: request.matchId,
        version: match.version,
        eventSeq: match.eventSeq,
        requiresFullSnapshot: !replayable,
        snapshot: projectMatchSnapshot(match.state, context.playerId, BASE_PHYSICAL_CARDS),
        visibleEvents,
      };
      ack(response);
    },
  };
}

/** Public for focused cursor and event privacy tests. */
export const syncProjectionInternals = Object.freeze({ cursorIsReplayable, projectEvent });
