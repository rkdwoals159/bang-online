// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { BangQuotaQueryHookInput, CharacterAbilityInput } from "../../../src/effects/character-api.ts";
import { willyTheKidAbility } from "../../../src/effects/characters/willy-the-kid.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import { checkPlayCardLegality } from "../../../src/rules/legality.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";

type WillyInput = CharacterAbilityInput<"willy_the_kid">;

interface Fixture {
  state: GameState;
  actor: SeatState;
  nearTarget: SeatState;
  farTarget: SeatState;
  bangCardInstanceId: string;
}

function moveCard(state: GameState, cardInstanceId: string, destination: "hand" | "in_play", seat: SeatState): void {
  for (const candidate of state.seats) {
    candidate.private.handCardInstanceIds = candidate.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    candidate.public.inPlayCardInstanceIds = candidate.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  if (destination === "hand") seat.private.handCardInstanceIds.push(cardInstanceId);
  else seat.public.inPlayCardInstanceIds.push(cardInstanceId);
}

function fixture(): Fixture {
  const players: SetupPlayer[] = Array.from({ length: 7 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const actor = state.seats.find((seat) => seat.public.seatIndex === 0)!;
  const nearTarget = state.seats.find((seat) => seat.public.seatIndex === 1)!;
  const farTarget = state.seats.find((seat) => seat.public.seatIndex === 3)!;
  actor.public.characterId = "willy_the_kid";
  state.turn.currentPlayerId = actor.public.playerId;
  state.turn.phase = "play";

  const bangDefinitionIds = new Set(BASE_PHYSICAL_CARDS
    .filter((card) => card.typeId === "bang")
    .map((card) => card.definitionId));
  const bangCard = Object.values(state.zones.cardsByInstanceId)
    .find((card) => bangDefinitionIds.has(card.cardDefinitionId));
  assert.ok(bangCard, "fixture needs a physical BANG card");
  moveCard(state, bangCard.cardInstanceId, "hand", actor);
  return { state, actor, nearTarget, farTarget, bangCardInstanceId: bangCard.cardInstanceId };
}

function quotaInput(
  f: Fixture,
  overrides: Partial<Pick<BangQuotaQueryHookInput, "turnPlayerId" | "bangCardPlaysThisTurn" | "volcanicEquipped">> = {},
): WillyInput {
  const hook: BangQuotaQueryHookInput = {
    kind: "bang_quota_query",
    turnPlayerId: f.state.turn.currentPlayerId,
    card: {
      cardInstanceId: f.bangCardInstanceId,
      physicalCardTypeId: "bang",
      effectCardTypeId: "bang",
    },
    bangCardPlaysThisTurn: f.state.turn.bangCardPlaysThisTurn,
    volcanicEquipped: false,
    ...overrides,
  };
  return {
    characterId: "willy_the_kid",
    playerId: f.actor.public.playerId,
    state: f.state,
    continuationFrameId: "willy-frame",
    random: { nextFloat: () => { throw new Error("Willy the Kid must not consume randomness"); } },
    completedInteractions: [],
    hook,
  };
}

test("Willy has an unlimited own-turn BANG quota and preserves the accumulated count", () => {
  const f = fixture();
  f.state.turn.bangCardPlaysThisTurn = 3;
  const before = structuredClone(f.state);

  for (const volcanicEquipped of [false, true]) {
    const result = willyTheKidAbility(quotaInput(f, { volcanicEquipped }));
    assert.deepEqual(result, { kind: "bang_quota_query", maximumPerTurn: "unlimited" });
  }

  assert.equal(f.state.turn.bangCardPlaysThisTurn, 3, "the quota query does not reset or increment T71's counter");
  assert.deepEqual(f.state, before, "the query leaves the state untouched");
});

test("Willy's unlimited quota applies only to a valid own-turn BANG quota query", () => {
  const f = fixture();
  const standard = { kind: "bang_quota_query", maximumPerTurn: 1 } as const;

  assert.deepEqual(willyTheKidAbility(quotaInput(f, { turnPlayerId: "player-2" })), standard);
  assert.deepEqual(willyTheKidAbility({
    ...quotaInput(f),
    state: { ...f.state, turn: { ...f.state.turn, phase: "draw" } },
  }), standard);
  assert.deepEqual(willyTheKidAbility({
    ...quotaInput(f),
    state: { ...f.state, seats: f.state.seats.map((seat) => seat.public.playerId === f.actor.public.playerId
      ? { ...seat, public: { ...seat.public, characterId: "bart_cassidy" } }
      : seat) },
  }), standard);
  assert.deepEqual(willyTheKidAbility(quotaInput(f, { bangCardPlaysThisTurn: 2 })), standard);

  const nonBangQuery = {
    ...quotaInput(f),
    hook: {
      ...quotaInput(f).hook,
      card: { ...quotaInput(f).hook.card, effectCardTypeId: "missed" },
    },
  } as unknown as WillyInput;
  assert.deepEqual(willyTheKidAbility(nonBangQuery), standard);

  f.actor.public.eliminated = true;
  assert.deepEqual(willyTheKidAbility(quotaInput(f)), standard);
});

test("Willy keeps ordinary target and range restrictions, and other characters keep the one-BANG limit", () => {
  const f = fixture();
  f.state.turn.bangCardPlaysThisTurn = 2;

  assert.deepEqual(checkPlayCardLegality(f.state, {
    actorPlayerId: f.actor.public.playerId,
    cardInstanceId: f.bangCardInstanceId,
    targetPlayerId: f.nearTarget.public.playerId,
  }), { ok: true, cardTypeId: "bang" });

  const outOfRange = checkPlayCardLegality(f.state, {
    actorPlayerId: f.actor.public.playerId,
    cardInstanceId: f.bangCardInstanceId,
    targetPlayerId: f.farTarget.public.playerId,
  });
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.equal(outOfRange.error.code, "TARGET_OUT_OF_RANGE");

  const selfTarget = checkPlayCardLegality(f.state, {
    actorPlayerId: f.actor.public.playerId,
    cardInstanceId: f.bangCardInstanceId,
    targetPlayerId: f.actor.public.playerId,
  });
  assert.equal(selfTarget.ok, false);
  if (!selfTarget.ok) assert.equal(selfTarget.error.code, "TARGET_IS_SELF");

  const otherCharacterState = structuredClone(f.state);
  otherCharacterState.seats[0]!.public.characterId = "bart_cassidy";
  const limited = checkPlayCardLegality(otherCharacterState, {
    actorPlayerId: f.actor.public.playerId,
    cardInstanceId: f.bangCardInstanceId,
    targetPlayerId: f.nearTarget.public.playerId,
  });
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.error.code, "BANG_LIMIT_REACHED");
});
