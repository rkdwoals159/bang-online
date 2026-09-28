import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import type { RoleId } from "../../../catalog/src/schema.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState, InteractionOption } from "../../src/state/types.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import { applyMatchCommand, type EngineCommand, type PlayCardExecutionInput } from "../../src/commands/index.ts";
import { beginEffectResolution, openPendingInteraction } from "../../src/resolution/index.ts";

const FIXED_ROLES: readonly RoleId[] = ["sheriff", "deputy", "outlaw", "renegade", "outlaw"];

function fixedRandom(): RandomSource {
  return { nextFloat: () => 0.25 };
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 5 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.seats = state.seats
    .map((entry, index) => {
      const playerNumber = Number(entry.public.playerId.slice("player-".length));
      const roleId = FIXED_ROLES[playerNumber - 1]!;
      return {
        ...entry,
        private: { ...entry.private, roleId },
        public: { ...entry.public, seatIndex: index, roleRevealed: roleId === "sheriff" },
      };
    })
    .sort((left, right) => left.public.playerId.localeCompare(right.public.playerId))
    .map((entry, seatIndex) => ({ ...entry, public: { ...entry.public, seatIndex } }));
  state.turn.currentPlayerId = "player-1";
  state.turn.phase = "play";
  state.turn.bangCardPlaysThisTurn = 0;
  // Keep the default quota tests independent of which character setup assigned.
  seat(state, "player-1").public.characterId = "bart_cassidy";
  return state;
}

function seat(state: GameState, playerId: string) {
  const found = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(found, `missing ${playerId}`);
  return found;
}

function physicalType(state: GameState, cardInstanceId: string): string {
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  assert.ok(instance, `missing card ${cardInstanceId}`);
  const definition = BASE_PHYSICAL_CARDS.find((entry) => entry.definitionId === instance.cardDefinitionId);
  assert.ok(definition, `unknown definition for ${cardInstanceId}`);
  return definition.typeId;
}

function takeFromDrawPile(state: GameState, playerId: string, typeId: string): string {
  const definitionIds = new Set(BASE_PHYSICAL_CARDS
    .filter((definition) => definition.typeId === typeId)
    .map((definition) => definition.definitionId));
  const drawIndex = state.zones.drawPileCardInstanceIds.findIndex((cardId) =>
    definitionIds.has(state.zones.cardsByInstanceId[cardId]!.cardDefinitionId));
  assert.ok(drawIndex >= 0, `no ${typeId} remains in draw pile`);
  const [cardInstanceId] = state.zones.drawPileCardInstanceIds.splice(drawIndex, 1);
  assert.ok(cardInstanceId);
  seat(state, playerId).private.handCardInstanceIds.push(cardInstanceId);
  return cardInstanceId;
}

function copyState(state: unknown): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function successfulCardHandler(input: PlayCardExecutionInput) {
  const next = copyState(input.state);
  const cardInstanceId = input.command.payload.cardInstanceId;
  const owner = seat(next, input.actorPlayerId);
  owner.private.handCardInstanceIds = owner.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
  next.zones.discardPileCardInstanceIds.push(cardInstanceId);
  return { ok: true as const, output: { state: next, events: [], value: null } };
}

function playBang(cardInstanceId: string): EngineCommand {
  return { type: "PLAY_CARD", payload: { cardInstanceId, targetPlayerId: "player-2" } };
}

function runSuccessfulPlay(state: GameState, cardInstanceId: string) {
  return applyMatchCommand(state, "player-1", playBang(cardInstanceId), {
    random: fixedRandom(),
    handlers: { playCard: successfulCardHandler },
  });
}

test("a successful physical BANG increments once and T11 rejects the next ordinary BANG", () => {
  const state = initialState();
  const firstBang = takeFromDrawPile(state, "player-1", "bang");
  const first = runSuccessfulPlay(state, firstBang);

  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.state.turn.bangCardPlaysThisTurn, 1);
  assert.equal(state.turn.bangCardPlaysThisTurn, 0, "the input state remains unchanged");

  const secondBang = takeFromDrawPile(first.state, "player-1", "bang");
  let executions = 0;
  const rejected = applyMatchCommand(first.state, "player-1", playBang(secondBang), {
    random: fixedRandom(),
    handlers: {
      playCard(input) {
        executions += 1;
        return successfulCardHandler(input);
      },
    },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "BANG_LIMIT_REACHED");
  assert.equal(executions, 0, "a quota-rejected command never reaches the effect handler");
  assert.equal(first.state.turn.bangCardPlaysThisTurn, 1);
});

test("a successful Calamity Missed-to-BANG conversion increments the effective BANG quota", () => {
  const state = initialState();
  seat(state, "player-1").public.characterId = "calamity_janet";
  const missedId = takeFromDrawPile(state, "player-1", "missed");
  let effectiveType = "";
  const result = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD",
    payload: { cardInstanceId: missedId, targetPlayerId: "player-2", asCardType: "bang" },
  }, {
    random: fixedRandom(),
    handlers: {
      playCard(input) {
        effectiveType = input.cardTypeId;
        return successfulCardHandler(input);
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(effectiveType, "bang");
  if (result.ok) assert.equal(result.state.turn.bangCardPlaysThisTurn, 1);
  assert.equal(physicalType(state, missedId), "missed", "the physical card remains Missed");
  assert.equal(state.turn.bangCardPlaysThisTurn, 0);
});

test("rejected and failed BANG commands leave the quota unchanged", () => {
  const state = initialState();
  const bangId = takeFromDrawPile(state, "player-1", "bang");
  const before = copyState(state);
  let executions = 0;
  const failed = applyMatchCommand(state, "player-1", playBang(bangId), {
    random: fixedRandom(),
    handlers: {
      playCard() {
        executions += 1;
        return { ok: false as const, error: { code: "INVALID_STATE" as const, message: "fixture failure" } };
      },
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(executions, 1);
  assert.deepEqual(state, before);

  const illegalTarget = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD",
    payload: { cardInstanceId: bangId, targetPlayerId: "player-1" },
  }, {
    random: fixedRandom(),
    handlers: { playCard: () => assert.fail("illegal command reached the effect handler") },
  });
  assert.equal(illegalTarget.ok, false);
  assert.equal(state.turn.bangCardPlaysThisTurn, 0);
});

test("successful non-BANG PLAY_CARD commands do not change the BANG quota", () => {
  const state = initialState();
  const beerId = takeFromDrawPile(state, "player-1", "beer");
  const result = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD",
    payload: { cardInstanceId: beerId },
  }, {
    random: fixedRandom(),
    handlers: { playCard: successfulCardHandler },
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.state.turn.bangCardPlaysThisTurn, 0);
});

test("Volcanic and Willy keep accumulating successful BANG uses while unlimited", () => {
  let volcanicState = initialState();
  const volcanicId = takeFromDrawPile(volcanicState, "player-1", "volcanic");
  const volcanicOwner = seat(volcanicState, "player-1");
  volcanicOwner.private.handCardInstanceIds = volcanicOwner.private.handCardInstanceIds.filter((id) => id !== volcanicId);
  volcanicOwner.public.inPlayCardInstanceIds.push(volcanicId);

  for (let count = 1; count <= 2; count += 1) {
    const bangId = takeFromDrawPile(volcanicState, "player-1", "bang");
    const result = runSuccessfulPlay(volcanicState, bangId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    volcanicState = result.state;
    assert.equal(volcanicState.turn.bangCardPlaysThisTurn, count);
  }

  const currentVolcanicOwner = seat(volcanicState, "player-1");
  currentVolcanicOwner.public.inPlayCardInstanceIds = currentVolcanicOwner.public.inPlayCardInstanceIds.filter((id) => id !== volcanicId);
  volcanicState.zones.discardPileCardInstanceIds.push(volcanicId);
  const thirdBang = takeFromDrawPile(volcanicState, "player-1", "bang");
  const afterLosingVolcanic = runSuccessfulPlay(volcanicState, thirdBang);
  assert.equal(afterLosingVolcanic.ok, false);
  if (!afterLosingVolcanic.ok) assert.equal(afterLosingVolcanic.error.code, "BANG_LIMIT_REACHED");
  assert.equal(volcanicState.turn.bangCardPlaysThisTurn, 2);

  let willyState = initialState();
  seat(willyState, "player-1").public.characterId = "willy_the_kid";
  for (let count = 1; count <= 2; count += 1) {
    const bangId = takeFromDrawPile(willyState, "player-1", "bang");
    const result = runSuccessfulPlay(willyState, bangId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    willyState = result.state;
    assert.equal(willyState.turn.bangCardPlaysThisTurn, count);
  }
});

test("Duel and Indians BANG response submissions do not count as PLAY_CARD uses", () => {
  for (const kind of ["DUEL_RESPONSE", "INDIANS_RESPONSE"] as const) {
    const state = initialState();
    state.turn.bangCardPlaysThisTurn = 1;
    const responderBang = takeFromDrawPile(state, "player-2", "bang");
    const otherBang = takeFromDrawPile(state, "player-3", "bang");
    const started = beginEffectResolution(state, {
      steps: [{
        effectId: `response-${kind}`,
        kind: "WAIT_FOR_DISCARD",
        sourcePlayerId: "player-1",
        targetPlayerId: "player-2",
        sourceCardInstanceId: null,
        payload: {},
      }],
      continuation: {
        frameId: `response-${kind}:frame`,
        kind: "TEST_EFFECT",
        sourcePlayerId: "player-1",
        sourceCardInstanceId: null,
        payload: {},
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const bangOption = (cardInstanceId: string): InteractionOption => ({
      choice: "PLAY_BANG",
      payload: { cardInstanceId },
    });
    const opened = openPendingInteraction(started.state, {
      interactionId: `response-${kind}:window`,
      kind,
      responders: [
        { playerId: "player-2", options: [bangOption(responderBang), { choice: "YIELD", payload: {} }] },
        { playerId: "player-3", options: [bangOption(otherBang), { choice: "YIELD", payload: {} }] },
      ],
      context: {},
      resumeFrameId: `response-${kind}:frame`,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const response = applyMatchCommand(opened.state, "player-2", {
      type: "RESPOND",
      payload: { interactionId: `response-${kind}:window`, choice: "PLAY_BANG", cardInstanceId: responderBang },
    }, { random: fixedRandom() });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.value.kind, "response");
    if (response.value.kind === "response") assert.equal(response.value.completed, false);
    assert.equal(response.state.turn.bangCardPlaysThisTurn, 1);
  }
});
