import { createHash, randomBytes } from "node:crypto";
import type {
  CommandAck,
  CommandRejected,
  MatchCommand,
} from "../../../../packages/contracts/src/protocol.js";
import { parseMatchCommand } from "../../../../packages/contracts/src/validation.js";
import {
  applyMatchCommand,
  type ApplyMatchCommandContext,
  type EngineCommand,
} from "../../../../packages/engine/src/commands/index.js";
import type { EffectEventDraft } from "../../../../packages/engine/src/effects/api.js";
import { isConcurrentTablewideResponse } from "../../../../packages/engine/src/effects/runtime/index.js";
import type { GameState, JsonValue } from "../../../../packages/engine/src/state/types.js";
import type { AuthenticatedSocketContext, GatewayAck, GatewayHandlers } from "../socket/gateway.js";
import {
  CommandIdReusedError,
  MatchMembershipRequiredError,
  MatchNotFoundError,
  StaleMatchVersionError,
  type MatchCommandReceiptInput,
  type MatchRecord,
  type StorageRepository,
} from "../storage/repository.js";

type MatchCommandStorage = Pick<
  StorageRepository,
  "getMatch" | "findCommandReceipt" | "commitMatch" | "recordMatchRejection"
>;

export interface PreparedMatchCommand {
  readonly matchId: string;
  readonly actorPlayerId: string;
  readonly command: MatchCommand;
  readonly state: GameState;
}

export interface MatchCommandContinuation {
  readonly state: GameState;
  readonly events: readonly EffectEventDraft[];
}

/** Server-only phase work folded into the same command aggregate commit. */
export interface PreparedMatchCommandContext extends ApplyMatchCommandContext {
  readonly continueTurnPhases?: (state: GameState) => MatchCommandContinuation;
}

export interface MatchCommandRelayDependencies {
  readonly storage: MatchCommandStorage;
  /** Supply replayable RNG and server-owned continuation metadata for this one evaluation. */
  readonly prepareEngineContext: (input: PreparedMatchCommand) => PreparedMatchCommandContext | Promise<PreparedMatchCommandContext>;
  /** Unique IDs for stored event and outbox rows. */
  readonly newEventId?: () => string;
}

const MAX_REJECTION_REVALIDATIONS = 8;
const INTERNAL_ENGINE_ERROR_CODES = new Set([
  "INVALID_STATE",
  "COMMAND_EXECUTOR_UNAVAILABLE",
  "INTERACTION_METADATA_REQUIRED",
]);
const DIRECT_PROTOCOL_ENGINE_ERRORS = new Set([
  "NOT_YOUR_TURN",
  "NO_PENDING_INTERACTION",
  "WRONG_INTERACTION",
  "INVALID_CHOICE",
  "RULE_RESOURCE_EXHAUSTED",
]);
const matchCommandQueues = new WeakMap<MatchCommandRelayDependencies, Map<string, Promise<void>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function commandIdFrom(input: unknown): string | undefined {
  return isRecord(input) && text(input.commandId) ? input.commandId : undefined;
}

function rejected(
  commandId: string,
  code: string,
  options: { retryable?: boolean; currentVersion?: number } = {},
): CommandRejected {
  const messageKey = code === "BAD_REQUEST"
    ? "protocol.badRequest"
    : `match.${code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()).replace(/^([A-Z])/, (letter) => letter.toLowerCase())}`;
  return {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: {
      code,
      messageKey,
      retryable: options.retryable ?? false,
      ...(options.currentVersion === undefined ? {} : { currentVersion: options.currentVersion }),
    },
  };
}

function staleVersion(commandId: string, currentVersion: number): CommandRejected {
  return rejected(commandId, "STALE_VERSION", { retryable: true, currentVersion });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = canonicalize(value[key]);
  }
  return normalized;
}

/** Hashes only protocol command fields; authenticated identity is the receipt key, never client data. */
export function matchCommandRequestHash(command: MatchCommand): string {
  const request = {
    protocolVersion: command.protocolVersion,
    matchId: command.matchId,
    expectedVersion: command.expectedVersion,
    type: command.type,
    payload: canonicalize(command.payload),
  };
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function newId(): string {
  return `evt_${randomBytes(18).toString("base64url")}`;
}

function receiptOutcomeAsAck(value: JsonValue, commandId: string): CommandAck | null {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.commandId !== commandId) return null;
  if (value.status === "accepted") {
    if (typeof value.duplicate !== "boolean" ||
        !Number.isSafeInteger(value.aggregateVersion) || (value.aggregateVersion as number) < 0 ||
        !Number.isSafeInteger(value.eventSeq) || (value.eventSeq as number) < 0) return null;
    return {
      protocolVersion: 1,
      commandId,
      status: "accepted",
      duplicate: true,
      aggregateVersion: value.aggregateVersion as number,
      eventSeq: value.eventSeq as number,
    };
  }
  if (value.status === "rejected" && isRecord(value.error) &&
      typeof value.error.code === "string" && typeof value.error.messageKey === "string" &&
      typeof value.error.retryable === "boolean" &&
      (value.error.currentVersion === undefined ||
        (Number.isSafeInteger(value.error.currentVersion) && (value.error.currentVersion as number) >= 0)) &&
      (value.error.retryAfterMs === undefined ||
        (Number.isSafeInteger(value.error.retryAfterMs) && (value.error.retryAfterMs as number) >= 0))) {
    return {
      protocolVersion: 1,
      commandId,
      status: "rejected",
      error: {
        code: value.error.code,
        messageKey: value.error.messageKey,
        retryable: value.error.retryable,
        ...(value.error.currentVersion === undefined ? {} : { currentVersion: value.error.currentVersion as number }),
        ...(value.error.retryAfterMs === undefined ? {} : { retryAfterMs: value.error.retryAfterMs as number }),
      },
    };
  }
  return null;
}

function receiptAckOrReused(
  receipt: { matchId: string | null; requestHash: string; outcome: JsonValue },
  command: MatchCommand,
  requestHash: string,
): CommandAck {
  if (receipt.matchId !== command.matchId || receipt.requestHash !== requestHash) {
    return rejected(command.commandId, "COMMAND_ID_REUSED");
  }
  return receiptOutcomeAsAck(receipt.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR");
}

function engineFailureAck(
  commandId: string,
  state: GameState,
  error: { code: string },
): { ack: CommandRejected; persistReceipt: boolean } {
  if (INTERNAL_ENGINE_ERROR_CODES.has(error.code)) {
    return { ack: rejected(commandId, "INTERNAL_ERROR"), persistReceipt: false };
  }
  if (error.code === "MATCH_NOT_PLAYING") {
    if (state.status === "paused") return { ack: rejected(commandId, "MATCH_PAUSED"), persistReceipt: true };
    if (state.status === "recovery_required") return { ack: rejected(commandId, "RECOVERY_REQUIRED"), persistReceipt: true };
    return { ack: rejected(commandId, "ILLEGAL_ACTION"), persistReceipt: true };
  }
  if (DIRECT_PROTOCOL_ENGINE_ERRORS.has(error.code)) {
    return { ack: rejected(commandId, error.code), persistReceipt: true };
  }
  return { ack: rejected(commandId, "ILLEGAL_ACTION"), persistReceipt: true };
}

function accepted(commandId: string, state: GameState): CommandAck {
  return {
    protocolVersion: 1,
    commandId,
    status: "accepted",
    duplicate: false,
    aggregateVersion: state.version,
    eventSeq: state.eventSeq,
  };
}

function actorHasSeat(match: MatchRecord, actorPlayerId: string): boolean {
  const registered = match.players.some((player) => player.playerId === actorPlayerId);
  const stateSeats = match.state.seats.filter((seat) => seat.public.playerId === actorPlayerId);
  return registered && stateSeats.length === 1;
}

async function loadAuthorizedMatch(
  context: Pick<AuthenticatedSocketContext, "playerId" | "matchMembership">,
  matchId: string,
  storage: MatchCommandStorage,
): Promise<MatchRecord | null> {
  if (!text(context.playerId) || !(await context.matchMembership(matchId))) return null;
  const match = await storage.getMatch(matchId);
  if (!match || !actorHasSeat(match, context.playerId)) return null;
  if (match.state.version !== match.version || match.state.eventSeq !== match.eventSeq) {
    throw new Error("Stored match row metadata does not match its authoritative snapshot.");
  }
  return match;
}

function eventWrites(
  drafts: readonly EffectEventDraft[],
  version: number,
  firstEventSeq: number,
  idFactory: () => string,
): { eventId: string; eventSeq: number; version: number; type: string; actorPlayerId: string | null; payload: JsonValue }[] {
  return drafts.map((draft, index) => ({
    eventId: idFactory(),
    eventSeq: firstEventSeq + index + 1,
    version,
    type: draft.type,
    actorPlayerId: draft.actorPlayerId,
    payload: draft.payload as JsonValue,
  }));
}

async function findPriorOutcome(
  context: Pick<AuthenticatedSocketContext, "playerId">,
  command: MatchCommand,
  requestHash: string,
  storage: MatchCommandStorage,
): Promise<CommandAck | null> {
  const receipt = await storage.findCommandReceipt(context.playerId, command.commandId);
  return receipt ? receiptAckOrReused(receipt, command, requestHash) : null;
}

type RejectionSaveResult =
  | { readonly status: "resolved"; readonly ack: CommandAck }
  | { readonly status: "revalidate"; readonly match: MatchRecord };

/** Save a known-match rejection, returning to evaluation if a race made the expected version current. */
async function saveRejection(
  context: Pick<AuthenticatedSocketContext, "playerId" | "matchMembership">,
  command: MatchCommand,
  requestHash: string,
  initialMatch: MatchRecord,
  initialAck: CommandRejected,
  storage: MatchCommandStorage,
): Promise<RejectionSaveResult> {
  let observedMatch = initialMatch;
  let outcome = initialAck;

  for (let attempt = 0; attempt < MAX_REJECTION_REVALIDATIONS; attempt += 1) {
    let result;
    try {
      result = await storage.recordMatchRejection({
        matchId: command.matchId,
        observedVersion: observedMatch.version,
        receipt: {
          actorPlayerId: context.playerId,
          commandId: command.commandId,
          requestHash,
          outcome: outcome as unknown as JsonValue,
        },
      });
    } catch (error) {
      if (error instanceof CommandIdReusedError) {
        return { status: "resolved", ack: rejected(command.commandId, "COMMAND_ID_REUSED") };
      }
      if (error instanceof MatchMembershipRequiredError || error instanceof MatchNotFoundError) {
        return { status: "resolved", ack: rejected(command.commandId, "NOT_A_PLAYER") };
      }
      throw error;
    }
    if (result.status === "recorded") return { status: "resolved", ack: outcome };
    if (result.status === "duplicate") {
      return {
        status: "resolved",
        ack: receiptOutcomeAsAck(result.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR"),
      };
    }

    const latest = await loadAuthorizedMatch(context, command.matchId, storage);
    if (!latest) return { status: "resolved", ack: rejected(command.commandId, "NOT_A_PLAYER") };
    const prior = await findPriorOutcome(context, command, requestHash, storage);
    if (prior) return { status: "resolved", ack: prior };
    if (latest.version === command.expectedVersion) {
      return { status: "revalidate", match: latest };
    }
    observedMatch = latest;
    outcome = staleVersion(command.commandId, latest.version);
  }

  return {
    status: "resolved",
    ack: rejected(command.commandId, "SERVER_BUSY", { retryable: true }),
  };
}

function engineCommand(command: MatchCommand): EngineCommand {
  return { type: command.type, payload: command.payload } as EngineCommand;
}

async function serializeMatchCommand<T>(
  dependencies: MatchCommandRelayDependencies,
  matchId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = matchCommandQueues.get(dependencies);
  if (!queues) {
    queues = new Map();
    matchCommandQueues.set(dependencies, queues);
  }
  const previous = queues.get(matchId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => next);
  queues.set(matchId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(matchId) === tail) queues.delete(matchId);
  }
}

/**
 * Validates, authorizes, evaluates once, and atomically persists a match command.
 * It does not send projections or broadcasts; callers ACK only after this resolves.
 */
export async function processMatchCommand(
  context: Pick<AuthenticatedSocketContext, "playerId" | "matchMembership">,
  input: unknown,
  dependencies: MatchCommandRelayDependencies,
): Promise<CommandAck | null> {
  const requestCommandId = commandIdFrom(input);
  const parsed = parseMatchCommand(input);
  if (!parsed.ok) return requestCommandId ? rejected(requestCommandId, "BAD_REQUEST") : null;

  const command = parsed.value;
  return serializeMatchCommand(dependencies, command.matchId, async () => {
    const requestHash = matchCommandRequestHash(command);
    let match = await loadAuthorizedMatch(context, command.matchId, dependencies.storage);
    if (!match) return rejected(command.commandId, "NOT_A_PLAYER");

    for (let attempt = 0; attempt < MAX_REJECTION_REVALIDATIONS; attempt += 1) {
      const prior = await findPriorOutcome(context, command, requestHash, dependencies.storage);
      if (prior) return prior;

      if (match.version !== command.expectedVersion && !(command.expectedVersion < match.version && isConcurrentTablewideResponse(match.state, context.playerId, command))) {
        const saved = await saveRejection(
          context,
          command,
          requestHash,
          match,
          staleVersion(command.commandId, match.version),
          dependencies.storage,
        );
        if (saved.status === "resolved") return saved.ack;
        match = saved.match;
        continue;
      }

      const engineContext = await dependencies.prepareEngineContext({
        matchId: command.matchId,
        actorPlayerId: context.playerId,
        command,
        state: match.state,
      });
      const result = applyMatchCommand(match.state, context.playerId, engineCommand(command), engineContext);
      if (!result.ok) {
        const failure = engineFailureAck(command.commandId, match.state, result.error);
        if (!failure.persistReceipt) return failure.ack;
        const saved = await saveRejection(context, command, requestHash, match, failure.ack, dependencies.storage);
        if (saved.status === "resolved") return saved.ack;
        match = saved.match;
        continue;
      }

      let candidateState = result.state;
      let candidateEvents = [...result.events];
      if (engineContext.continueTurnPhases) {
        try {
          const continuation = engineContext.continueTurnPhases(result.state);
          candidateState = {
            ...continuation.state,
            // T67 may make several pure reducer transitions. They remain one
            // accepted client command and therefore share T14's version.
            version: result.state.version,
            eventSeq: result.state.eventSeq,
          };
          candidateEvents = [...candidateEvents, ...continuation.events];
        } catch {
          // Do not persist a partially advanced command if a phase runner
          // finds a malformed saved continuation or unsupported engine state.
          return rejected(command.commandId, "INTERNAL_ERROR");
        }
      }

      const idFactory = dependencies.newEventId ?? newId;
      const events = eventWrites(candidateEvents, candidateState.version, match.eventSeq, idFactory);
      const nextState: GameState = {
        ...candidateState,
        eventSeq: match.eventSeq + events.length,
      };
      const response = accepted(command.commandId, nextState);
      const receipt: MatchCommandReceiptInput = {
        actorPlayerId: context.playerId,
        commandId: command.commandId,
        requestHash,
        outcome: response as unknown as JsonValue,
      };

      try {
        const commit = await dependencies.storage.commitMatch({
          matchId: command.matchId,
          expectedVersion: match.version,
          state: nextState,
          events,
          receipt,
          outboxEventId: idFactory(),
        });
        if (commit.status === "duplicate") {
          return receiptOutcomeAsAck(commit.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR");
        }
        return response;
      } catch (error) {
        if (error instanceof CommandIdReusedError) return rejected(command.commandId, "COMMAND_ID_REUSED");
        if (error instanceof MatchMembershipRequiredError || error instanceof MatchNotFoundError) {
          return rejected(command.commandId, "NOT_A_PLAYER");
        }
        if (error instanceof StaleMatchVersionError) {
          const latest = await loadAuthorizedMatch(context, command.matchId, dependencies.storage);
          if (latest && command.expectedVersion <= latest.version && isConcurrentTablewideResponse(latest.state, context.playerId, command)) {
            match = latest;
            continue;
          }
          const saved = await saveRejection(
            context,
            command,
            requestHash,
            match,
            staleVersion(command.commandId, error.currentVersion),
            dependencies.storage,
          );
          if (saved.status === "resolved") return saved.ack;
          match = saved.match;
          continue;
        }
        throw error;
      }
    }

    return rejected(command.commandId, "SERVER_BUSY", { retryable: true });
  });
}

/** Adapter for the T45 gateway; it ACKs only after the storage transaction resolves. */
export function createMatchCommandHandler(
  dependencies: MatchCommandRelayDependencies,
): GatewayHandlers["matchCommand"] {
  return async (context, command, ack: GatewayAck) => {
    const response = await processMatchCommand(context, command, dependencies);
    if (response) ack(response);
  };
}
