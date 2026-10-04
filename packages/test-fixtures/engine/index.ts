import assert from "node:assert/strict";
import {
  BASE_PHYSICAL_CARDS,
} from "../../catalog/src/cards/index.js";
import { characters } from "../../catalog/src/characters/index.js";
import type { CardRank, RoleId, Suit } from "../../catalog/src/schema.js";
import { applyMatchCommand, type EngineCommand } from "../../engine/src/commands/index.js";
import { createEffectCommandHandlers } from "../../engine/src/effects/runtime/index.js";
import { createEffectRegistry } from "../../engine/src/effects/registry.js";
import { executeTurnDraw, resolveTurnStart, withTurnStartEffects } from "../../engine/src/turn/draw.js";
import type { InteractionIdentity, EffectRuntimeOptions } from "../../engine/src/effects/runtime/index.js";
import { initializeGame, type SetupPlayer } from "../../engine/src/setup/initialize.js";
import { projectMatchSnapshot } from "../../engine/src/state/projection.js";
import { submitInteractionResponse } from "../../engine/src/resolution/index.js";
import type { GameState } from "../../engine/src/state/types.js";
import type { RandomSource } from "../../engine/src/random/shuffle.js";

const PLAYER_KEYS = ["A", "B", "C", "D", "E", "F", "G"] as const;
const DEFAULT_ROLES: Record<4 | 5 | 6 | 7, readonly RoleId[]> = {
  4: ["sheriff", "outlaw", "outlaw", "renegade"],
  5: ["sheriff", "deputy", "outlaw", "outlaw", "renegade"],
  6: ["sheriff", "deputy", "outlaw", "outlaw", "outlaw", "renegade"],
  7: ["sheriff", "deputy", "deputy", "outlaw", "outlaw", "outlaw", "renegade"],
};

export type ScenarioPlayerKey = typeof PLAYER_KEYS[number];
export type ScenarioCardSpec = {
  readonly typeId: string;
  readonly rank?: CardRank;
  readonly suit?: Suit;
};

export interface ScenarioSeatSetup {
  readonly characterId?: string;
  readonly roleId?: RoleId;
  readonly hp?: number;
  readonly maxHp?: number;
  readonly eliminated?: boolean;
  readonly hand?: readonly ScenarioCardSpec[];
  readonly inPlay?: readonly ScenarioCardSpec[];
}

export interface EngineScenarioFixtureOptions {
  readonly id: string;
  readonly playerCount?: 4 | 5 | 6 | 7;
  readonly currentPlayer?: ScenarioPlayerKey;
  readonly phase?: GameState["turn"]["phase"];
  readonly bangPlays?: number;
  readonly seats?: Partial<Record<ScenarioPlayerKey, ScenarioSeatSetup>>;
  /** Discard inputs are ordered first discarded to current top. */
  readonly discard?: readonly ScenarioCardSpec[];
  /** Draw inputs are ordered top first. */
  readonly drawTop?: readonly ScenarioCardSpec[];
}

function stableSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

export function fixedRandom(seed: number): RandomSource {
  let value = seed >>> 0 || 0x9e3779b9;
  return {
    nextFloat() {
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      return (value >>> 0) / 0x1_0000_0000;
    },
  };
}

export function playerId(key: ScenarioPlayerKey): string {
  return `player-${key}`;
}

export function playerKey(id: string): ScenarioPlayerKey {
  const key = id.replace(/^player-/, "") as ScenarioPlayerKey;
  assert.ok(PLAYER_KEYS.includes(key), `unknown scenario player '${id}'`);
  return key;
}

const TYPE_BY_DEFINITION = new Map(BASE_PHYSICAL_CARDS.map((card) => [card.definitionId, card.typeId]));

function idsInState(state: GameState): string[] {
  return [
    ...state.seats.flatMap((seat) => seat.private.handCardInstanceIds),
    ...state.seats.flatMap((seat) => seat.public.inPlayCardInstanceIds),
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
  ];
}

export function cardTypeId(state: GameState, cardInstanceId: string): string {
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  assert.ok(instance, `card '${cardInstanceId}' is not in the physical catalog`);
  const typeId = TYPE_BY_DEFINITION.get(instance.cardDefinitionId);
  assert.ok(typeId, `card definition '${instance.cardDefinitionId}' has no catalog type`);
  return typeId;
}

export function findCard(
  state: GameState,
  typeId: string,
  location?: { readonly player?: ScenarioPlayerKey; readonly zone?: "hand" | "inPlay" | "draw" | "discard" },
  face?: { readonly rank?: CardRank; readonly suit?: Suit },
): string {
  const ownerIds = (key: ScenarioPlayerKey, zone: "hand" | "inPlay") => {
    const seat = state.seats.find((entry) => entry.public.playerId === playerId(key));
    assert.ok(seat, `missing seat ${key}`);
    return zone === "hand" ? seat.private.handCardInstanceIds : seat.public.inPlayCardInstanceIds;
  };
  let candidates: readonly string[];
  if (location?.player && location.zone) candidates = ownerIds(location.player, location.zone);
  else if (location?.zone === "draw") candidates = state.zones.drawPileCardInstanceIds;
  else if (location?.zone === "discard") candidates = state.zones.discardPileCardInstanceIds;
  else if (location?.player) candidates = ownerIds(location.player, "hand");
  else candidates = idsInState(state);
  const match = candidates.find((id) => {
    const card = state.zones.cardsByInstanceId[id];
    return cardTypeId(state, id) === typeId &&
      (face?.rank === undefined || card?.rank === face.rank) &&
      (face?.suit === undefined || card?.suit === face.suit);
  });
  assert.ok(match, `no ${typeId}${face?.suit ? ` ${face.suit}` : ""}${face?.rank ? ` ${face.rank}` : ""} card in requested zone`);
  return match;
}

export function assertEngineStateInvariants(state: GameState): void {
  const zoneIds = idsInState(state);
  const catalogIds = Object.keys(state.zones.cardsByInstanceId);
  assert.equal(catalogIds.length, 80, "fixture must retain the complete 80-card base catalog");
  assert.equal(zoneIds.length, 80, "every physical card must have exactly one owner");
  assert.equal(new Set(zoneIds).size, 80, "card instance must not have duplicate zone ownership");
  assert.deepEqual(new Set(zoneIds), new Set(catalogIds), "no physical card may be missing from a zone");
  for (const id of catalogIds) {
    const instance = state.zones.cardsByInstanceId[id];
    assert.equal(instance?.cardInstanceId, id, "card map keys and opaque IDs must match");
    assert.ok(BASE_PHYSICAL_CARDS.some((card) => card.definitionId === instance?.cardDefinitionId), "instance must refer to a base physical card");
  }
  for (const seat of state.seats) {
    assert.ok(seat.private.handCardInstanceIds.length >= 0);
    if (state.resolution.pendingInteraction) {
      assert.ok(state.resolution.pendingInteraction.actorPlayerIds.every((id) => state.seats.some((candidate) => candidate.public.playerId === id)), "pending responders must own seats");
    }
  }
}

export function assertEngineProjectionPrivacy(state: GameState): void {
  const visibleDiscardTop = state.zones.discardPileCardInstanceIds.at(-1);
  const allHands = new Map(state.seats.map((seat) => [seat.public.playerId, new Set(seat.private.handCardInstanceIds)]));
  const publiclyVisibleInPlay = new Set(state.seats.flatMap((seat) => seat.public.inPlayCardInstanceIds));
  for (const seat of state.seats) {
    const viewerId = seat.public.playerId;
    const view = projectMatchSnapshot(state, viewerId, BASE_PHYSICAL_CARDS);
    const json = JSON.stringify(view);
    assert.equal(view.viewer.playerId, viewerId);
    assert.equal(view.publicTable.deckCount, state.zones.drawPileCardInstanceIds.length, "D09 deck count is public");
    assert.equal(view.publicTable.publicDiscard.count, state.zones.discardPileCardInstanceIds.length);
    assert.equal(view.publicTable.publicDiscard.topCard?.cardInstanceId ?? null, visibleDiscardTop ?? null);
    assert.deepEqual(
      view.selfPrivate?.hand.map(({ cardInstanceId }) => cardInstanceId) ?? [],
      seat.public.eliminated ? [] : seat.private.handCardInstanceIds,
      "only an active viewer receives their own hand faces",
    );
    for (const other of state.seats) {
      const projected = view.publicTable.players.find((candidate) => candidate.playerId === other.public.playerId);
      assert.ok(projected);
      const revealRole = other.public.roleRevealed || state.status === "completed";
      assert.equal(projected.role, revealRole ? other.private.roleId : null, "unrevealed roles stay hidden");
      if (other.public.playerId !== viewerId) {
        for (const hiddenCardId of allHands.get(other.public.playerId) ?? []) {
          assert.ok(!json.includes(hiddenCardId), `projection leaked opponent hand card ${hiddenCardId}`);
        }
      }
    }
    const ownHand = allHands.get(viewerId) ?? new Set<string>();
    const ownsPrivateReveal = state.resolution.pendingInteraction?.actorPlayerIds.includes(viewerId) ?? false;
    const isGeneralStore = state.resolution.pendingInteraction?.kind === "GENERAL_STORE_PICK";
    const isLuckyJudgment = state.resolution.pendingInteraction?.kind === "LUCKY_DRAW";
    if (isLuckyJudgment) {
      assert.deepEqual(view.publicTable.luckyJudgment?.cards.map(card => card.cardInstanceId),
        state.zones.revealedPoolCardInstanceIds, "C08 both Lucky judgment faces are public");
    } else assert.equal("luckyJudgment" in view.publicTable, false);
    if (isGeneralStore) {
      assert.deepEqual(view.publicTable.generalStoreCards, state.zones.revealedPoolCardInstanceIds.map(id => {
        const card = state.zones.cardsByInstanceId[id]!;
        return { cardInstanceId: id, typeId: cardTypeId(state, id), rank: String(card.rank), suit: card.suit };
      }), "R17 remaining General Store pool faces are public to every seat");
    } else assert.equal("generalStoreCards" in view.publicTable, false, "private selections must not become a public pool");
    const hiddenIds = [
      ...state.zones.drawPileCardInstanceIds,
      ...state.zones.discardPileCardInstanceIds.filter((id) => id !== visibleDiscardTop),
      ...(ownsPrivateReveal || isGeneralStore || isLuckyJudgment ? [] : state.zones.revealedPoolCardInstanceIds),
      ...[...allHands.entries()].flatMap(([owner, ids]) => owner === viewerId ? [] : [...ids]),
    ].filter((id) => !ownHand.has(id) && !publiclyVisibleInPlay.has(id) && id !== visibleDiscardTop);
    for (const hiddenCardId of hiddenIds) {
      assert.ok(!json.includes(hiddenCardId), `projection leaked hidden card ${hiddenCardId}`);
    }
    for (const other of state.seats) {
      if (other.public.playerId !== viewerId && !other.public.roleRevealed && state.status !== "completed") {
        assert.ok(!json.includes(`\"roleId\":\"${other.private.roleId}\"`), "projection leaked an unrevealed role field");
      }
    }
  }
}

function assertStage(state: GameState): void {
  assertEngineStateInvariants(state);
  assertEngineProjectionPrivacy(state);
}

export function buildEngineScenarioFixture(options: EngineScenarioFixtureOptions): GameState {
  const playerCount = options.playerCount ?? 4;
  const players: SetupPlayer[] = PLAYER_KEYS.slice(0, playerCount).map((key) => ({
    playerId: playerId(key),
    displayName: `Seat ${key}`,
  }));
  const seed = stableSeed(options.id);
  const state = initializeGame({ players, random: fixedRandom(seed) });
  const allIds = [
    ...state.zones.drawPileCardInstanceIds,
    ...state.seats.flatMap((seat) => seat.private.handCardInstanceIds),
  ];
  const allIdsByType = new Map<string, string[]>();
  for (const id of allIds) {
    const typeId = cardTypeId(state, id);
    allIdsByType.set(typeId, [...(allIdsByType.get(typeId) ?? []), id]);
  }
  const used = new Set<string>();
  const take = (spec: ScenarioCardSpec): string => {
    const candidates = allIdsByType.get(spec.typeId) ?? [];
    const selected = candidates.find((id) => {
      if (used.has(id)) return false;
      const card = state.zones.cardsByInstanceId[id]!;
      return (spec.rank === undefined || card.rank === spec.rank) &&
        (spec.suit === undefined || card.suit === spec.suit);
    });
    assert.ok(selected, `fixture requested unavailable card ${JSON.stringify(spec)}`);
    used.add(selected);
    return selected;
  };

  const roleDeck = DEFAULT_ROLES[playerCount];
  const characterDeck = characters.slice(0, playerCount);
  const canonicalSeats = [...state.seats].sort((left, right) =>
    PLAYER_KEYS.indexOf(playerKey(left.public.playerId)) - PLAYER_KEYS.indexOf(playerKey(right.public.playerId)),
  );
  state.seats = canonicalSeats.map((seat, index) => {
    const key = PLAYER_KEYS[index]!;
    const setup = options.seats?.[key] ?? {};
    const roleId = setup.roleId ?? roleDeck[index]!;
    const characterId = setup.characterId ?? characterDeck[index]!.id;
    const character = characters.find((entry) => entry.id === characterId);
    assert.ok(character, `unknown scenario character '${characterId}'`);
    const maxHp = setup.maxHp ?? character.baseHealth + Number(roleId === "sheriff");
    const inPlayCardInstanceIds = (setup.inPlay ?? []).map(take);
    const handCardInstanceIds = (setup.hand ?? []).map(take);
    return {
      public: {
        ...seat.public,
        seatIndex: index,
        characterId,
        hp: setup.hp ?? maxHp,
        maxHp,
        eliminated: setup.eliminated ?? false,
        roleRevealed: roleId === "sheriff" || setup.eliminated === true,
        inPlayCardInstanceIds,
      },
      private: { roleId, handCardInstanceIds },
    };
  });
  const discardPileCardInstanceIds = (options.discard ?? []).map(take);
  const drawTopCardInstanceIds = (options.drawTop ?? []).map(take);
  const drawPileCardInstanceIds = [
    ...drawTopCardInstanceIds,
    ...allIds.filter((id) => !used.has(id)),
  ];
  state.zones = {
    ...state.zones,
    drawPileCardInstanceIds,
    discardPileCardInstanceIds,
    revealedPoolCardInstanceIds: [],
  };
  state.turn = {
    ...state.turn,
    currentPlayerId: playerId(options.currentPlayer ?? "A"),
    phase: options.phase ?? "play",
    bangCardPlaysThisTurn: options.bangPlays ?? 0,
    turnNumber: 1,
  };
  state.resolution = {
    effectQueue: [],
    continuations: [],
    pendingInteraction: null,
    pendingDeath: null,
    victoryCheckDeferredByEffectId: null,
  };
  state.outcome = null;
  state.status = "playing";
  state.pauseReason = null;
  state.version = 0;
  state.eventSeq = 0;
  assertStage(state);
  return state;
}

export interface ScenarioObservation {
  readonly state: GameState;
  readonly events: readonly unknown[];
  readonly trace: readonly unknown[];
}

export interface EngineScenarioSession {
  state: GameState;
  readonly events: unknown[];
  readonly trace: unknown[];
  readonly handlers: ReturnType<typeof createEffectCommandHandlers>;
  readonly random: RandomSource;
  readonly nextInteractionIdentity: () => InteractionIdentity;
  readonly submit: (actor: ScenarioPlayerKey, command: EngineCommand) => ReturnType<typeof applyMatchCommand>;
  readonly play: (actor: ScenarioPlayerKey, card: string, target?: ScenarioPlayerKey, extra?: Record<string, unknown>) => ReturnType<typeof applyMatchCommand>;
  readonly respond: (actor: ScenarioPlayerKey, choice: string, extra?: Record<string, unknown>) => ReturnType<typeof applyMatchCommand>;
  readonly respondCurrent: (choice: string, extra?: Record<string, unknown>) => ReturnType<typeof applyMatchCommand>;
  readonly startTurn: () => ReturnType<typeof resolveTurnStart>;
  readonly drawTurn: () => ReturnType<typeof executeTurnDraw>;
  readonly respondDraw: (actor: ScenarioPlayerKey, choice: string, extra?: Record<string, unknown>) => ReturnType<typeof executeTurnDraw>;
  readonly snapshot: () => ScenarioObservation;
}

function makeSession(options: EngineScenarioFixtureOptions): EngineScenarioSession {
  let state = buildEngineScenarioFixture(options);
  const random = fixedRandom(stableSeed(`${options.id}:commands`));
  let interactionIndex = 0;
  const nextInteractionIdentity = (): InteractionIdentity => {
    interactionIndex += 1;
    return {
      interactionId: `${options.id}:interaction:${interactionIndex}`,
      createdAt: "2026-09-28T00:00:00.000Z",
    };
  };
  const runtimeOptions: EffectRuntimeOptions = withTurnStartEffects({
    registry: createEffectRegistry(),
    nextInteractionIdentity,
  });
  const handlers = createEffectCommandHandlers(runtimeOptions);
  const events: unknown[] = [];
  const trace: unknown[] = [];
  const submit = (actor: ScenarioPlayerKey, command: EngineCommand) => {
    assertStage(state);
    const before = structuredClone(state);
    const result = applyMatchCommand(state, playerId(actor), command, {
      handlers,
      random,
      interaction: nextInteractionIdentity(),
    });
    if (result.ok) {
      state = result.state;
      events.push(...result.events);
    } else {
      assert.deepEqual(state, before, "a rejected engine command must not mutate the fixture state");
    }
    trace.push({ command, result: structuredClone(result), state: structuredClone(state) });
    assertStage(state);
    return result;
  };
  const play = (actor: ScenarioPlayerKey, card: string, target?: ScenarioPlayerKey, extra: Record<string, unknown> = {}) => submit(actor, {
    type: "PLAY_CARD",
    payload: {
      cardInstanceId: card,
      ...(target ? { targetPlayerId: playerId(target) } : {}),
      ...extra,
    },
  } as EngineCommand);
  const respond = (actor: ScenarioPlayerKey, choice: string, extra: Record<string, unknown> = {}) => {
    const pending = state.resolution.pendingInteraction;
    assert.ok(pending, "a response requires a saved pending interaction");
    return submit(actor, {
      type: "RESPOND",
      payload: { interactionId: pending.interactionId, choice, ...extra },
    } as EngineCommand);
  };
  const respondCurrent = (choice: string, extra: Record<string, unknown> = {}) => {
    const responderId = state.resolution.pendingInteraction?.actorPlayerIds[0];
    assert.ok(responderId, "a response requires a current responder");
    return respond(playerKey(responderId), choice, extra);
  };
  const runPhase = <T extends ReturnType<typeof resolveTurnStart> | ReturnType<typeof executeTurnDraw>>(
    label: string,
    action: () => T,
  ): T => {
    assertStage(state);
    const before = structuredClone(state);
    const result = action();
    if (result.ok) {
      state = result.output.state;
      events.push(...result.output.events);
    } else {
      assert.deepEqual(state, before, `${label} failure must not mutate state`);
    }
    trace.push({ phase: label, result: structuredClone(result), state: structuredClone(state) });
    assertStage(state);
    return result;
  };
  const startTurn = () => runPhase("turn-start", () => resolveTurnStart({
    state,
    actorPlayerId: state.turn.currentPlayerId,
    random,
    nextInteractionIdentity,
    runtimeOptions,
    continuationFrameId: `${options.id}:turn-start`,
  }));
  const drawTurn = () => runPhase("turn-draw", () => executeTurnDraw({
    state,
    actorPlayerId: state.turn.currentPlayerId,
    random,
    nextInteractionIdentity,
    continuationFrameId: `${options.id}:turn-draw`,
  }));
  const respondDraw = (actor: ScenarioPlayerKey, choice: string, extra: Record<string, unknown> = {}) => {
    const pending = state.resolution.pendingInteraction;
    assert.ok(pending, "a draw response requires a saved pending interaction");
    assertStage(state);
    const before = structuredClone(state);
    const submitted = submitInteractionResponse(state, {
      interactionId: pending.interactionId,
      actorPlayerId: playerId(actor),
      choice,
      payload: extra as Record<string, import("../../engine/src/state/types.js").JsonValue>,
    });
    if (!submitted.ok) {
      assert.deepEqual(state, before, "a rejected draw response must not mutate state");
      trace.push({ phase: "draw-response-rejected", result: structuredClone(submitted), state: structuredClone(state) });
      return { ok: false, error: submitted.error } as ReturnType<typeof executeTurnDraw>;
    }
    // T67 draw continuations are advanced by executeTurnDraw after the validated
    // T12 interaction cursor records the response in the saved frame.
    state = submitted.state;
    trace.push({ phase: "draw-response", interactionId: pending.interactionId, choice, state: structuredClone(state) });
    assertStage(state);
    const resumed = runPhase("turn-draw-resume", () => executeTurnDraw({
      state,
      actorPlayerId: state.turn.currentPlayerId,
      random,
      nextInteractionIdentity,
      continuationFrameId: `${options.id}:turn-draw`,
    }));
    return resumed;
  };
  return {
    get state() { return state; },
    set state(value: GameState) { state = value; assertStage(state); },
    events,
    trace,
    handlers,
    random,
    nextInteractionIdentity,
    submit,
    play,
    respond,
    respondCurrent,
    startTurn,
    drawTurn,
    respondDraw,
    snapshot() {
      assertStage(state);
      return { state: structuredClone(state), events: structuredClone(events), trace: structuredClone(trace) };
    },
  };
}

/**
 * Runs each acceptance scenario twice with fixed setup RNG, command RNG, and
 * interaction identities. This compares every persisted step, final state,
 * and ordered event draft stream while checking projections and all 80 zones.
 */
export function runEngineAcceptanceScenario(
  options: EngineScenarioFixtureOptions,
  scenario: (session: EngineScenarioSession) => void,
): ScenarioObservation {
  const runOnce = (): ScenarioObservation => {
    const session = makeSession(options);
    scenario(session);
    return session.snapshot();
  };
  const first = runOnce();
  const replay = runOnce();
  assert.deepEqual(replay, first, `${options.id} must reproduce state, events, and intermediate snapshots`);
  return first;
}
