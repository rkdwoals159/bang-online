import type { CardRank, RoleId, Suit } from "../../../../packages/catalog/src/schema.js";
import type { GameState, JsonValue, WinningFaction } from "../../../../packages/engine/src/state/types.js";

const ROLE_IDS: ReadonlySet<RoleId> = new Set(["sheriff", "deputy", "outlaw", "renegade"]);
const CARD_SUITS: ReadonlySet<Suit> = new Set(["SPADES", "HEARTS", "DIAMONDS", "CLUBS"]);
const WINNING_FACTIONS: ReadonlySet<WinningFaction> = new Set([
  "sheriff_and_deputies", "outlaws", "renegade",
]);

function isCardRank(value: unknown): value is CardRank {
  return (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && ["A", "J", "Q", "K"].includes(value));
}

export class StoredDataInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredDataInvariantError";
  }
}

export class UnsupportedMatchStateError extends StoredDataInvariantError {
  readonly schemaVersion: number;
  readonly rulesetVersion: string;

  constructor(schemaVersion: number, rulesetVersion: string) {
    super(`Stored match uses unsupported schema/ruleset ${schemaVersion}/${rulesetVersion}.`);
    this.name = "UnsupportedMatchStateError";
    this.schemaVersion = schemaVersion;
    this.rulesetVersion = rulesetVersion;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assertJson(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoredDataInvariantError(`${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) throw new StoredDataInvariantError(`${path} is not JSON data.`);
  for (const [key, entry] of Object.entries(value)) assertJson(entry, `${path}.${key}`);
}

function requireSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new StoredDataInvariantError(`${field} must be a safe integer >= ${minimum}.`);
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoredDataInvariantError(`${field} must be a non-empty string.`);
  }
}

function requireNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new StoredDataInvariantError(`${field} must be a string or null.`);
  }
}

function requireStringRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new StoredDataInvariantError(`${field} must be a JSON object.`);
}

function validateEffectStep(value: unknown, field: string): void {
  if (!isObject(value)) throw new StoredDataInvariantError(`${field} must be an object.`);
  requireString(value.effectId, `${field}.effectId`);
  requireString(value.kind, `${field}.kind`);
  requireNullableString(value.sourcePlayerId, `${field}.sourcePlayerId`);
  requireNullableString(value.targetPlayerId, `${field}.targetPlayerId`);
  requireNullableString(value.sourceCardInstanceId, `${field}.sourceCardInstanceId`);
  requireStringRecord(value.payload, `${field}.payload`);
}

function validateResolutionFrame(value: unknown, field: string): void {
  if (!isObject(value)) throw new StoredDataInvariantError(`${field} must be an object.`);
  requireString(value.frameId, `${field}.frameId`);
  requireString(value.kind, `${field}.kind`);
  requireNullableString(value.sourcePlayerId, `${field}.sourcePlayerId`);
  requireNullableString(value.sourceCardInstanceId, `${field}.sourceCardInstanceId`);
  requireStringRecord(value.payload, `${field}.payload`);
}

function validatePendingInteraction(value: unknown): void {
  if (!isObject(value)) throw new StoredDataInvariantError("resolution.pendingInteraction must be an object or null.");
  requireString(value.interactionId, "resolution.pendingInteraction.interactionId");
  requireString(value.kind, "resolution.pendingInteraction.kind");
  if (!isStringArray(value.actorPlayerIds)) {
    throw new StoredDataInvariantError("resolution.pendingInteraction.actorPlayerIds must be strings.");
  }
  if (!Array.isArray(value.options)) throw new StoredDataInvariantError("resolution.pendingInteraction.options must be an array.");
  value.options.forEach((option, index) => {
    const field = `resolution.pendingInteraction.options[${index}]`;
    if (!isObject(option)) throw new StoredDataInvariantError(`${field} must be an object.`);
    requireString(option.choice, `${field}.choice`);
    requireStringRecord(option.payload, `${field}.payload`);
  });
  requireStringRecord(value.context, "resolution.pendingInteraction.context");
  requireNullableString(value.resumeFrameId, "resolution.pendingInteraction.resumeFrameId");
  requireString(value.createdAt, "resolution.pendingInteraction.createdAt");
}

function validatePendingDeath(value: unknown): void {
  if (!isObject(value)) throw new StoredDataInvariantError("resolution.pendingDeath must be an object or null.");
  requireString(value.victimPlayerId, "resolution.pendingDeath.victimPlayerId");
  requireNullableString(value.sourcePlayerId, "resolution.pendingDeath.sourcePlayerId");
  if (!isStringArray(value.rescueResponderIds)) {
    throw new StoredDataInvariantError("resolution.pendingDeath.rescueResponderIds must be strings.");
  }
  requireSafeInteger(value.rescueCursor, "resolution.pendingDeath.rescueCursor");
  if (!new Set(["rescue", "elimination", "cleanup", "win_check"]).has(String(value.consequenceStage))) {
    throw new StoredDataInvariantError("resolution.pendingDeath.consequenceStage is invalid.");
  }
  requireNullableString(value.resumeFrameId, "resolution.pendingDeath.resumeFrameId");
}

function validateStateShape(value: unknown): asserts value is GameState {
  assertJson(value, "match state");
  if (!isObject(value)) throw new StoredDataInvariantError("Match state must be a JSON object.");
  requireSafeInteger(value.schemaVersion, "schemaVersion", 1);
  requireString(value.rulesetVersion, "rulesetVersion");
  if (!new Set(["playing", "paused", "completed", "recovery_required"]).has(String(value.status))) {
    throw new StoredDataInvariantError("Match state status is invalid.");
  }
  if (value.pauseReason !== null && value.pauseReason !== "RULE_RESOURCE_EXHAUSTED") {
    throw new StoredDataInvariantError("Match state pauseReason is invalid.");
  }
  requireSafeInteger(value.version, "version");
  requireSafeInteger(value.eventSeq, "eventSeq");
  if (!Array.isArray(value.seats) || value.seats.length < 1 || value.seats.length > 7) {
    throw new StoredDataInvariantError("Match state seats must contain between 1 and 7 entries.");
  }
  const players = new Set<string>();
  for (const [index, seat] of value.seats.entries()) {
    if (!isObject(seat) || !isObject(seat.public) || !isObject(seat.private)) {
      throw new StoredDataInvariantError(`seats[${index}] must contain public and private objects.`);
    }
    const player = seat.public;
    requireString(player.playerId, `seats[${index}].public.playerId`);
    requireString(player.displayName, `seats[${index}].public.displayName`);
    requireSafeInteger(player.seatIndex, `seats[${index}].public.seatIndex`);
    requireString(player.characterId, `seats[${index}].public.characterId`);
    requireSafeInteger(player.hp, `seats[${index}].public.hp`);
    requireSafeInteger(player.maxHp, `seats[${index}].public.maxHp`, 1);
    if (typeof player.eliminated !== "boolean" || typeof player.roleRevealed !== "boolean" ||
        !isStringArray(player.inPlayCardInstanceIds)) {
      throw new StoredDataInvariantError(`seats[${index}].public flags/card IDs are invalid.`);
    }
    if (players.has(player.playerId)) throw new StoredDataInvariantError("Match state contains duplicate player IDs.");
    players.add(player.playerId);
    if (!ROLE_IDS.has(seat.private.roleId as RoleId)) {
      throw new StoredDataInvariantError(`seats[${index}].private.roleId is not a supported catalog role.`);
    }
    if (!isStringArray(seat.private.handCardInstanceIds)) {
      throw new StoredDataInvariantError(`seats[${index}].private.handCardInstanceIds must be strings.`);
    }
  }
  if (!isObject(value.zones) || !isObject(value.zones.cardsByInstanceId) ||
      !isStringArray(value.zones.drawPileCardInstanceIds) ||
      !isStringArray(value.zones.discardPileCardInstanceIds) ||
      !isStringArray(value.zones.revealedPoolCardInstanceIds)) {
    throw new StoredDataInvariantError("Match state card zones are invalid.");
  }
  for (const [id, card] of Object.entries(value.zones.cardsByInstanceId)) {
    if (!isObject(card) || card.cardInstanceId !== id || typeof card.cardDefinitionId !== "string" ||
        card.cardDefinitionId.length === 0 || !isCardRank(card.rank) || !CARD_SUITS.has(card.suit as Suit)) {
      throw new StoredDataInvariantError(`Card instance '${id}' has an invalid stored shape.`);
    }
  }
  if (!isObject(value.turn)) throw new StoredDataInvariantError("Match state turn is invalid.");
  requireString(value.turn.currentPlayerId, "turn.currentPlayerId");
  if (!new Set(["start", "draw", "play", "discard"]).has(String(value.turn.phase))) {
    throw new StoredDataInvariantError("Match state turn phase is invalid.");
  }
  requireSafeInteger(value.turn.bangCardPlaysThisTurn, "turn.bangCardPlaysThisTurn");
  requireSafeInteger(value.turn.turnNumber, "turn.turnNumber");
  if (!isObject(value.resolution) || !Array.isArray(value.resolution.effectQueue) ||
      !Array.isArray(value.resolution.continuations) ||
      !(value.resolution.pendingInteraction === null || isObject(value.resolution.pendingInteraction)) ||
      !(value.resolution.pendingDeath === null || isObject(value.resolution.pendingDeath)) ||
      !(value.resolution.victoryCheckDeferredByEffectId === null ||
        typeof value.resolution.victoryCheckDeferredByEffectId === "string")) {
    throw new StoredDataInvariantError("Match state resolution is invalid.");
  }
  value.resolution.effectQueue.forEach((step, index) => validateEffectStep(step, `resolution.effectQueue[${index}]`));
  value.resolution.continuations.forEach((frame, index) => validateResolutionFrame(frame, `resolution.continuations[${index}]`));
  if (value.resolution.pendingInteraction !== null) validatePendingInteraction(value.resolution.pendingInteraction);
  if (value.resolution.pendingDeath !== null) validatePendingDeath(value.resolution.pendingDeath);
  if (value.outcome !== null && !isObject(value.outcome)) {
    throw new StoredDataInvariantError("Match state outcome must be null or an object.");
  }
  if (value.outcome !== null) {
    if (!WINNING_FACTIONS.has(value.outcome.winningFaction as WinningFaction) ||
        !isStringArray(value.outcome.winningPlayerIds)) {
      throw new StoredDataInvariantError("Match state outcome has an invalid faction or winner list.");
    }
  }
}

/** Validate and return the full private server snapshot; never use on browser input. */
export function parseMatchState(value: unknown, supportedSchemaVersion?: number): GameState {
  validateStateShape(value);
  if (supportedSchemaVersion !== undefined && value.schemaVersion !== supportedSchemaVersion) {
    throw new UnsupportedMatchStateError(value.schemaVersion, value.rulesetVersion);
  }
  return value;
}

export function decodeMatchState(value: unknown): GameState {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new StoredDataInvariantError("Stored match state is not valid JSON.");
    }
  }
  return parseMatchState(parsed);
}

export function encodeJson(value: unknown, label = "Stored JSON"): string {
  assertJson(value, label);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new StoredDataInvariantError(`${label} could not be serialized.`);
  return encoded;
}

export function decodeJson(value: unknown, label = "Stored JSON"): JsonValue {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new StoredDataInvariantError(`${label} is not valid JSON.`);
    }
  }
  assertJson(parsed, label);
  return parsed;
}
