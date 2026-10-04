import type { CommandAccepted, CommandAck, CommandRejected, MatchCommand } from "../../../../../packages/contracts/src/protocol.js";
import { parseCommandAck, parseMatchCommand } from "../../../../../packages/contracts/src/validation.js";
import { BASE_DECK_RULESET_VERSION, BASE_PHYSICAL_CARDS } from "../../../../../packages/catalog/src/cards/index.js";
import { projectMatchSnapshot } from "../../../../../packages/engine/src/state/projection.js";
import { syncProjectionInternals } from "../../../../../apps/server/src/projections/sync.js";
import {
  applyMatchCommand,
  type ApplyMatchCommandContext,
  type EngineCommand,
} from "../../../../../packages/engine/src/commands/index.js";
import type { EffectEventDraft } from "../../../../../packages/engine/src/effects/api.js";
import { createEffectRegistry } from "../../../../../packages/engine/src/effects/registry.js";
import { createEffectCommandHandlers, type InteractionIdentity } from "../../../../../packages/engine/src/effects/runtime/index.js";
import type { GameState, JsonValue } from "../../../../../packages/engine/src/state/types.js";
import { webCryptoRandomSource, opaqueId, sha256Hex } from "../auth/crypto.js";
import {
  CommandIdReusedError,
  D1StorageRepository,
  D1StorageInvariantError,
  MatchNotFoundError,
  StaleMatchVersionError,
  UnsupportedMatchStateError,
  type CommandReceiptRecord,
  type MatchCommitInput,
  type MatchEventWrite,
  type MatchRecord,
  type MatchRejectionReceiptResult,
  type D1DatabaseLike,
} from "../../storage/index.js";
import { advanceTurnPhases, createTurnAwareCommandHandlers } from "../../../../../apps/server/src/commands/turn-runtime.js";
import { withTurnStartEffects } from "../../../../../packages/engine/src/turn/draw.js";

const MAX_REJECTION_REVALIDATIONS = 8;
const SUPPORTED_MATCH_SCHEMA_VERSION = 1;
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

export interface D1MatchServiceOptions {
  includeMatchProjection?: boolean;
  now?: () => Date;
  crypto?: Crypto;
}

export class SiteMatchServiceError extends Error {
  constructor(readonly code: string, readonly currentVersion?: number) {
    super(code);
    this.name = "SiteMatchServiceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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

/** Match the Node command relay's hash: protocol fields, with identity in the receipt key. */
export async function matchCommandRequestHash(command: MatchCommand, crypto?: Crypto): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize({
    protocolVersion: command.protocolVersion,
    matchId: command.matchId,
    expectedVersion: command.expectedVersion,
    type: command.type,
    payload: command.payload,
  })), crypto);
}

function rejected(
  commandId: string,
  code: string,
  options: { retryable?: boolean; currentVersion?: number } = {},
): CommandRejected {
  const messageKey = code === "BAD_REQUEST"
    ? "protocol.badRequest"
    : `match.${code.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
      .replace(/^([A-Z])/u, (letter) => letter.toLowerCase())}`;
  const ack: CommandRejected = {
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
  if (!parseCommandAck(ack).ok) throw new Error("Rejected command acknowledgement failed its shared parser.");
  return ack;
}

function staleVersion(commandId: string, currentVersion: number): CommandRejected {
  return rejected(commandId, "STALE_VERSION", { retryable: true, currentVersion });
}

function receiptOutcomeAsAck(value: JsonValue, commandId: string): CommandAck | null {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.commandId !== commandId) return null;
  const parsed = parseCommandAck(value);
  if (!parsed.ok) return null;
  if (parsed.value.status === "accepted") {
    return {
      ...parsed.value,
      duplicate: true,
    };
  }
  return parsed.value;
}

function receiptAckOrReused(
  receipt: CommandReceiptRecord,
  command: MatchCommand,
  requestHash: string,
): CommandAck {
  if (receipt.matchId !== command.matchId || receipt.roomId !== null || receipt.requestHash !== requestHash) {
    return rejected(command.commandId, "COMMAND_ID_REUSED");
  }
  return receiptOutcomeAsAck(receipt.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR");
}

function engineFailureAck(commandId: string, state: GameState, error: { code: string }): {
  ack: CommandRejected;
  persistReceipt: boolean;
} {
  if (INTERNAL_ENGINE_ERROR_CODES.has(error.code)) {
    return { ack: rejected(commandId, "INTERNAL_ERROR"), persistReceipt: false };
  }
  if (error.code === "MATCH_NOT_PLAYING") {
    if (state.status === "paused") return { ack: rejected(commandId, "MATCH_PAUSED"), persistReceipt: true };
    if (state.status === "recovery_required") return { ack: rejected(commandId, "RECOVERY_REQUIRED"), persistReceipt: true };
    return { ack: rejected(commandId, "ILLEGAL_ACTION"), persistReceipt: true };
  }
  return DIRECT_PROTOCOL_ENGINE_ERRORS.has(error.code)
    ? { ack: rejected(commandId, error.code), persistReceipt: true }
    : { ack: rejected(commandId, "ILLEGAL_ACTION"), persistReceipt: true };
}

function accepted(commandId: string, state: GameState): CommandAccepted {
  const ack: CommandAck = {
    protocolVersion: 1,
    commandId,
    status: "accepted",
    duplicate: false,
    aggregateVersion: state.version,
    eventSeq: state.eventSeq,
  };
  if (!parseCommandAck(ack).ok) throw new Error("Accepted command acknowledgement failed its shared parser.");
  return ack;
}

function eventWrites(
  drafts: readonly EffectEventDraft[],
  version: number,
  firstEventSeq: number,
  idFactory: () => string,
): MatchEventWrite[] {
  return drafts.map((draft, index) => ({
    eventId: idFactory(),
    eventSeq: firstEventSeq + index + 1,
    version,
    type: draft.type,
    actorPlayerId: draft.actorPlayerId,
    payload: draft.payload as JsonValue,
  }));
}

function actorHasSeat(match: MatchRecord, actorPlayerId: string): boolean {
  return match.players.some(({ playerId }) => playerId === actorPlayerId) &&
    match.state.seats.filter((seat) => seat.public.playerId === actorPlayerId).length === 1;
}

async function loadSupportedMatch(repository: D1StorageRepository, matchId: string): Promise<MatchRecord | null> {
  const match = await repository.getMatch(matchId, { supportedSchemaVersion: SUPPORTED_MATCH_SCHEMA_VERSION });
  if (match && match.rulesetVersion !== BASE_DECK_RULESET_VERSION) {
    throw new UnsupportedMatchStateError(match.state.schemaVersion, match.rulesetVersion);
  }
  return match;
}

type PreparedEngineContext = ApplyMatchCommandContext & {
  continueTurnPhases: (state: GameState) => { state: GameState; events: readonly EffectEventDraft[] };
};

function prepareEngineContext(matchId: string, options: D1MatchServiceOptions): PreparedEngineContext {
  const random = webCryptoRandomSource(options.crypto);
  const nextInteractionIdentity = (): InteractionIdentity => ({
    interactionId: opaqueId("interaction", options.crypto),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  });
  const runtimeOptions = withTurnStartEffects({
    registry: createEffectRegistry(),
    nextInteractionIdentity,
  });
  const turnRuntime = { matchId, random, nextInteractionIdentity, runtimeOptions };
  return {
    random,
    interaction: nextInteractionIdentity(),
    handlers: createTurnAwareCommandHandlers(createEffectCommandHandlers(runtimeOptions), turnRuntime),
    continueTurnPhases: (state) => advanceTurnPhases(state, turnRuntime),
  };
}

type RejectionSaveResult =
  | { status: "resolved"; ack: CommandAck }
  | { status: "revalidate"; match: MatchRecord };

/** Record a known-match rejection only while the observed version remains current. */
async function saveRejection(
  repository: D1StorageRepository,
  actorPlayerId: string,
  command: MatchCommand,
  requestHash: string,
  initialMatch: MatchRecord,
  initialAck: CommandRejected,
  options: D1MatchServiceOptions,
): Promise<RejectionSaveResult> {
  let observedMatch = initialMatch;
  let outcome = initialAck;
  for (let attempt = 0; attempt < MAX_REJECTION_REVALIDATIONS; attempt += 1) {
    let saved: MatchRejectionReceiptResult;
    try {
      saved = await repository.recordMatchRejection({
        matchId: command.matchId,
        observedVersion: observedMatch.version,
        markerId: opaqueId("commit", options.crypto),
        receipt: {
          actorPlayerId,
          commandId: command.commandId,
          requestHash,
          outcome: outcome as unknown as JsonValue,
        },
      });
    } catch (error) {
      if (error instanceof CommandIdReusedError) {
        return { status: "resolved", ack: rejected(command.commandId, "COMMAND_ID_REUSED") };
      }
      if (error instanceof MatchNotFoundError ||
          (error instanceof D1StorageInvariantError && error.message === "Rejection actor is not a player in this match.")) {
        return { status: "resolved", ack: rejected(command.commandId, "NOT_A_PLAYER") };
      }
      throw error;
    }
    if (saved.status === "recorded") return { status: "resolved", ack: outcome };
    if (saved.status === "duplicate") {
      return {
        status: "resolved",
        ack: receiptOutcomeAsAck(saved.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR"),
      };
    }

    let latest: MatchRecord | null;
    try {
      latest = await loadSupportedMatch(repository, command.matchId);
    } catch (error) {
      if (error instanceof UnsupportedMatchStateError) {
        return { status: "resolved", ack: rejected(command.commandId, "RECOVERY_REQUIRED") };
      }
      throw error;
    }
    if (!latest || !actorHasSeat(latest, actorPlayerId)) {
      return { status: "resolved", ack: rejected(command.commandId, "NOT_A_PLAYER") };
    }
    const prior = await repository.findCommandReceipt(actorPlayerId, command.commandId);
    if (prior) return { status: "resolved", ack: receiptAckOrReused(prior, command, requestHash) };
    if (latest.version === command.expectedVersion) return { status: "revalidate", match: latest };

    observedMatch = latest;
    outcome = staleVersion(command.commandId, latest.version);
  }
  return { status: "resolved", ack: rejected(command.commandId, "SERVER_BUSY", { retryable: true }) };
}

/** Authoritative Worker match command handler. All writes go through D1 CAS batches. */
export class D1MatchService {
  private readonly repository: D1StorageRepository;

  constructor(private readonly db: D1DatabaseLike, private readonly options: D1MatchServiceOptions = {}) {
    this.repository = new D1StorageRepository(db);
  }

  async execute(actorPlayerId: string, input: unknown): Promise<CommandAck | null> {
    const commandId = isRecord(input) && text(input.commandId) ? input.commandId : null;
    const parsed = parseMatchCommand(input);
    if (!parsed.ok) return commandId ? rejected(commandId, "BAD_REQUEST") : null;
    const command = parsed.value;
    const requestHash = await matchCommandRequestHash(command, this.options.crypto);
    let match: MatchRecord;
    try {
      const context = await this.repository.loadMatchCommandContext(
        command.matchId,
        actorPlayerId,
        command.commandId,
        { supportedSchemaVersion: SUPPORTED_MATCH_SCHEMA_VERSION },
      );
      if (context.status === "not-member") return rejected(command.commandId, "NOT_A_PLAYER");
      if (context.status === "receipt") return receiptAckOrReused(context.receipt, command, requestHash);
      match = context.match;
      if (match.rulesetVersion !== BASE_DECK_RULESET_VERSION) {
        throw new UnsupportedMatchStateError(match.state.schemaVersion, match.rulesetVersion);
      }
    } catch (error) {
      if (error instanceof UnsupportedMatchStateError) return rejected(command.commandId, "RECOVERY_REQUIRED");
      throw error;
    }
    if (!actorHasSeat(match, actorPlayerId)) return rejected(command.commandId, "NOT_A_PLAYER");
    if (match.state.version !== match.version || match.state.eventSeq !== match.eventSeq) {
      throw new D1StorageInvariantError("Stored match row metadata does not match its authoritative snapshot.");
    }

    for (let attempt = 0; attempt < MAX_REJECTION_REVALIDATIONS; attempt += 1) {
      if (attempt > 0) {
        const prior = await this.repository.findCommandReceipt(actorPlayerId, command.commandId);
        if (prior) return receiptAckOrReused(prior, command, requestHash);
      }

      if (match.version !== command.expectedVersion) {
        const saved = await saveRejection(
          this.repository,
          actorPlayerId,
          command,
          requestHash,
          match,
          staleVersion(command.commandId, match.version),
          this.options,
        );
        if (saved.status === "resolved") return saved.ack;
        match = saved.match;
        continue;
      }

      const engineContext = prepareEngineContext(command.matchId, this.options);
      const result = applyMatchCommand(
        match.state,
        actorPlayerId,
        { type: command.type, payload: command.payload } as EngineCommand,
        engineContext,
      );
      if (!result.ok) {
        const failure = engineFailureAck(command.commandId, match.state, result.error);
        if (!failure.persistReceipt) return failure.ack;
        const saved = await saveRejection(
          this.repository,
          actorPlayerId,
          command,
          requestHash,
          match,
          failure.ack,
          this.options,
        );
        if (saved.status === "resolved") return saved.ack;
        match = saved.match;
        continue;
      }

      try {
        const continuation = engineContext.continueTurnPhases(result.state);
        const candidateState: GameState = {
          ...continuation.state,
          version: result.state.version,
          eventSeq: result.state.eventSeq,
        };
        const drafts = [...result.events, ...continuation.events];
        const idFactory = () => opaqueId("evt", this.options.crypto);
        const occurredAt = this.options.now?.() ?? new Date();
        const events = eventWrites(drafts, candidateState.version, match.eventSeq, idFactory)
          .map(event => ({ ...event, createdAt: occurredAt }));
        const nextState: GameState = { ...candidateState, eventSeq: match.eventSeq + events.length };
        const ack = accepted(command.commandId, nextState);
        const reply: CommandAck = this.options.includeMatchProjection ? { ...ack, matchProjection: {
          snapshot: projectMatchSnapshot(nextState, actorPlayerId, BASE_PHYSICAL_CARDS),
          visibleEvents: events.flatMap(event => {
            const projected = syncProjectionInternals.projectEvent(event, nextState);
            return projected ? [projected] : [];
          }),
        } } : ack;
        if (!parseCommandAck(reply).ok) throw new D1StorageInvariantError("Committed viewer projection failed its contract.");
        const commit: MatchCommitInput = {
          matchId: command.matchId,
          expectedVersion: command.expectedVersion,
          expectedEventSeq: match.eventSeq,
          markerId: opaqueId("commit", this.options.crypto),
          state: nextState,
          events,
          receipt: {
            actorPlayerId,
            commandId: command.commandId,
            requestHash,
            outcome: ack as unknown as JsonValue,
          },
          outboxEventId: idFactory(),
        };
        const committed = await this.repository.commitMatch(commit);
        if (committed.status === "duplicate") {
          return receiptOutcomeAsAck(committed.outcome, command.commandId) ?? rejected(command.commandId, "INTERNAL_ERROR");
        }
        return reply;
      } catch (error) {
        if (error instanceof CommandIdReusedError) return rejected(command.commandId, "COMMAND_ID_REUSED");
        if (error instanceof MatchNotFoundError) return rejected(command.commandId, "NOT_A_PLAYER");
        if (error instanceof StaleMatchVersionError) {
          const saved = await saveRejection(
            this.repository,
            actorPlayerId,
            command,
            requestHash,
            match,
            staleVersion(command.commandId, error.currentVersion),
            this.options,
          );
          if (saved.status === "resolved") return saved.ack;
          match = saved.match;
          continue;
        }
        return rejected(command.commandId, "INTERNAL_ERROR");
      }
    }
    return rejected(command.commandId, "SERVER_BUSY", { retryable: true });
  }
}
