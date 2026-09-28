// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import type {
  BlackJackDrawSlotHookInput,
  CharacterAbilityInput,
} from "../../../src/effects/character-api.ts";
import { blackJackAbility } from "../../../src/effects/characters/black-jack.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CardInstance, GameState } from "../../../src/state/types.ts";

interface Fixture {
  readonly state: GameState;
  readonly exposedCard: CardInstance;
  readonly bonusCardInstanceId: string;
}

function fixture(suit: CardInstance["suit"]): Fixture {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const actor = state.seats.find((seat) => seat.public.playerId === "player-1");
  assert.ok(actor, "fixture needs the Black Jack player");
  actor.public.characterId = "black_jack";
  state.turn.currentPlayerId = actor.public.playerId;
  state.turn.phase = "draw";

  const exposedCardId = state.zones.drawPileCardInstanceIds.find(
    (cardInstanceId) => state.zones.cardsByInstanceId[cardInstanceId]?.suit === suit,
  );
  assert.ok(exposedCardId, `fixture needs a ${suit} card in the draw pile`);
  const exposedCard = state.zones.cardsByInstanceId[exposedCardId];
  assert.ok(exposedCard);

  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter(
    (cardInstanceId) => cardInstanceId !== exposedCardId,
  );
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter(
    (cardInstanceId) => cardInstanceId !== exposedCardId,
  );
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter(
    (cardInstanceId) => cardInstanceId !== exposedCardId,
  );
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter(
      (cardInstanceId) => cardInstanceId !== exposedCardId,
    );
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter(
      (cardInstanceId) => cardInstanceId !== exposedCardId,
    );
  }
  actor.private.handCardInstanceIds.push(exposedCardId);

  const bonusCardInstanceId = state.zones.drawPileCardInstanceIds[0];
  assert.ok(bonusCardInstanceId, "fixture needs a card remaining in the deck");
  return { state, exposedCard, bonusCardInstanceId };
}

function makeHook(card: CardInstance): BlackJackDrawSlotHookInput {
  return {
    kind: "draw_slot",
    timing: "after",
    distribution: { kind: "normal_turn", position: "second" },
    source: { kind: "draw_pile" },
    visibility: "public",
    card,
  };
}

function makeInput(
  fixtureValue: Fixture,
  options: { readonly hook?: BlackJackDrawSlotHookInput; readonly random?: RandomSource } = {},
): CharacterAbilityInput<"black_jack"> {
  return {
    characterId: "black_jack",
    playerId: "player-1",
    state: fixtureValue.state,
    continuationFrameId: "frame-black-jack",
    random: options.random ?? { nextFloat: () => 0 },
    completedInteractions: [],
    hook: options.hook ?? makeHook(fixtureValue.exposedCard),
  };
}

test("Heart and Diamond on the public second turn draw grant one private deck card", () => {
  for (const suit of ["HEARTS", "DIAMONDS"] as const) {
    const current = fixture(suit);
    const before = structuredClone(current.state);

    const result = blackJackAbility(makeInput(current));

    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") continue;
    assert.deepEqual(result.events, [{
      type: "CARD_DRAWN",
      actorPlayerId: "player-1",
      payload: {
        sourceCardInstanceId: null,
        cardInstanceId: current.bonusCardInstanceId,
        playerId: "player-1",
        fromZone: "draw_pile",
        toZone: "hand",
      },
    }]);
    assert.deepEqual(result.steps, [], "the bonus card must not schedule a repeated Black Jack hook or a Draw! judgment");
    assert.deepEqual(current.state, before, "the character module returns event drafts without mutating the snapshot");
  }
});

test("Spade and Club on the public second turn draw do not grant a card", () => {
  for (const suit of ["SPADES", "CLUBS"] as const) {
    const current = fixture(suit);
    const result = blackJackAbility(makeInput(current, {
      random: { nextFloat: () => { throw new Error("a non-red card must not draw or shuffle"); } },
    }));

    assert.deepEqual(result, { kind: "applied", events: [], steps: [] }, suit);
  }
});

test("only a matching living Black Jack player can resolve the bonus", () => {
  const current = fixture("HEARTS");
  const base = makeInput(current);

  assert.deepEqual(
    blackJackAbility({ ...base, playerId: "player-2" }),
    { kind: "applied", events: [], steps: [] },
    "input actor must own the Black Jack seat",
  );

  const actor = current.state.seats.find((seat) => seat.public.playerId === "player-1");
  assert.ok(actor);
  actor.public.characterId = "bart_cassidy";
  assert.deepEqual(
    blackJackAbility(base),
    { kind: "applied", events: [], steps: [] },
    "another character does not resolve Black Jack's ability",
  );

  actor.public.characterId = "black_jack";
  actor.public.eliminated = true;
  assert.deepEqual(
    blackJackAbility(base),
    { kind: "applied", events: [], steps: [] },
    "an eliminated character does not use its ability",
  );
});

test("an empty draw and discard supply pauses without inventing a bonus card", () => {
  const current = fixture("DIAMONDS");
  current.state.zones.drawPileCardInstanceIds = [];
  current.state.zones.discardPileCardInstanceIds = [];

  const result = blackJackAbility(makeInput(current));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events.map((event) => event.type), ["RULE_RESOURCE_EXHAUSTED"]);
  assert.equal(result.events[0]?.payload.requestedCount, 1);
  assert.equal(result.events[0]?.payload.fulfilledCount, 0);
  assert.equal(result.events[0]?.payload.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.deepEqual(result.steps, []);
});

test("an empty draw pile uses T70 reshuffle and still keeps the bonus private", () => {
  const current = fixture("HEARTS");
  current.state.zones.discardPileCardInstanceIds = [
    ...current.state.zones.discardPileCardInstanceIds,
    ...current.state.zones.drawPileCardInstanceIds,
  ];
  current.state.zones.drawPileCardInstanceIds = [];
  let randomCalls = 0;

  const result = blackJackAbility(makeInput(current, {
    random: { nextFloat: () => { randomCalls += 1; return 0; } },
  }));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events.map((event) => event.type), ["DRAW_PILE_RESHUFFLED", "CARD_DRAWN"]);
  assert.equal(result.events[1]?.payload.toZone, "hand");
  assert.equal(result.events[1]?.payload.sourceCardInstanceId, null);
  assert.ok(randomCalls > 0, "the injected random source is used for the R08 reshuffle");
  assert.deepEqual(result.steps, [], "a reshuffled bonus card does not recursively trigger this ability");
});

test("malformed hook context cannot widen the second public draw trigger", () => {
  const current = fixture("HEARTS");
  const base = makeInput(current);
  const invalidHooks = [
    { ...base.hook, distribution: { kind: "normal_turn", position: "first" } },
    { ...base.hook, visibility: "recipient_only" },
    { ...base.hook, source: { kind: "opponent_hand", playerId: "player-2" } },
  ];

  for (const hook of invalidHooks) {
    assert.deepEqual(
      blackJackAbility({ ...base, hook } as unknown as CharacterAbilityInput<"black_jack">),
      { kind: "applied", events: [], steps: [] },
    );
  }
});
