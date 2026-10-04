import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import type { LegalActionProposal } from "../../../contracts/src/protocol.ts";
import { parseLegalActionProposal } from "../../../contracts/src/validation.ts";
import { applyMatchCommand } from "../../src/commands/index.ts";
import { buildLegalActionCandidates } from "../../src/actions/index.ts";
import { createEffectCommandHandlers } from "../../src/effects/runtime/index.ts";
import { createEffectRegistry } from "../../src/effects/registry.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState } from "../../src/state/types.ts";
import { buildReferenceActionCandidates } from "./reference-probe.ts";
import { characters } from "../../../catalog/src/characters/index.ts";

function fixedRandom() {
  return { nextFloat: () => 0.5 };
}

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.turn.currentPlayerId = "player-1";
  state.turn.phase = "play";
  return state;
}

function moveCardToHand(state: GameState, typeId: string, playerId: string): string {
  const physical = BASE_PHYSICAL_CARDS.find((candidate) => candidate.typeId === typeId);
  assert.ok(physical, `fixture needs a ${typeId} physical card`);
  const instance = Object.values(state.zones.cardsByInstanceId).find((card) => card.cardDefinitionId === physical.definitionId);
  assert.ok(instance, `fixture needs a ${typeId} instance`);
  const cardInstanceId = instance.cardInstanceId;

  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.seats.find((seat) => seat.public.playerId === playerId)!.private.handCardInstanceIds.push(cardInstanceId);
  return cardInstanceId;
}

function emptyActorHand(state: GameState): void {
  const actor = state.seats.find((seat) => seat.public.playerId === state.turn.currentPlayerId)!;
  state.zones.drawPileCardInstanceIds.unshift(...actor.private.handCardInstanceIds);
  actor.private.handCardInstanceIds = [];
}

function assertFullDeckInvariant(state: GameState): void {
  const zoneIds = [
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
    ...state.seats.flatMap((seat) => seat.private.handCardInstanceIds),
    ...state.seats.flatMap((seat) => seat.public.inPlayCardInstanceIds),
  ];
  assert.equal(zoneIds.length, 80);
  assert.equal(new Set(zoneIds).size, 80);
  assert.deepEqual(new Set(zoneIds), new Set(Object.keys(state.zones.cardsByInstanceId)));
}

function commandContext() {
  let nextInteraction = 0;
  return {
    random: fixedRandom(),
    interaction: {
      interactionId: "candidate-test-turn-discard",
      createdAt: "2000-01-01T00:00:00.000Z",
    },
    handlers: createEffectCommandHandlers({
      registry: createEffectRegistry(),
      nextInteractionIdentity: () => ({
        interactionId: `candidate-test-${++nextInteraction}`,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    }),
  };
}

function assertEveryCandidatePassesT14(state: GameState, candidates: readonly LegalActionProposal[]): void {
  for (const candidate of candidates) {
    assert.equal(parseLegalActionProposal(candidate).ok, true, JSON.stringify(candidate));
    assert.equal(
      applyMatchCommand(state, state.turn.currentPlayerId, candidate, commandContext()).ok,
      true,
      JSON.stringify(candidate),
    );
  }
}

test("candidate builder returns complete proposals accepted by T14 without changing state", () => {
  const state = makeState();
  emptyActorHand(state);
  const bangId = moveCardToHand(state, "bang", "player-1");
  moveCardToHand(state, "stagecoach", "player-1");
  const before = structuredClone(state);

  const candidates = buildLegalActionCandidates(state, "player-1");

  assert.ok(candidates.some((candidate) => candidate.type === "PLAY_CARD" && candidate.payload.cardInstanceId === bangId && candidate.payload.targetPlayerId === "player-2"));
  assert.ok(!candidates.some((candidate) => candidate.type === "PLAY_CARD" && candidate.payload.cardInstanceId === bangId && candidate.payload.targetPlayerId === "player-3"));
  assert.ok(candidates.some((candidate) => candidate.type === "PLAY_CARD" && candidate.payload.cardInstanceId !== bangId));
  assert.ok(candidates.some((candidate) => candidate.type === "END_TURN"));
  assert.deepEqual(buildLegalActionCandidates(state, "player-1"), candidates);
  assertEveryCandidatePassesT14(state, candidates);
  assert.deepEqual(state, before);
  assertFullDeckInvariant(state);
});

test("targets use only public zones and legal distance while preserving target selection payloads", () => {
  const state = makeState();
  emptyActorHand(state);
  const catId = moveCardToHand(state, "cat_balou", "player-1");
  const panicId = moveCardToHand(state, "panic", "player-1");
  const targetHandId = state.seats[1]!.private.handCardInstanceIds[0]!;
  const targetEquipment = moveCardToHand(state, "mustang", "player-3");
  state.seats[2]!.private.handCardInstanceIds = state.seats[2]!.private.handCardInstanceIds.filter((id) => id !== targetEquipment);
  state.seats[2]!.public.inPlayCardInstanceIds.push(targetEquipment);

  const candidates = buildLegalActionCandidates(state, "player-1");
  const payloads = candidates.filter((candidate) => candidate.type === "PLAY_CARD").map((candidate) => candidate.payload);

  assert.ok(payloads.some((payload) => payload.cardInstanceId === catId && payload.targetPlayerId === "player-2" && payload.targetZone === "HAND" && !("targetCardInstanceId" in payload)));
  assert.ok(payloads.some((payload) => payload.cardInstanceId === catId && payload.targetPlayerId === "player-3" && payload.targetZone === "IN_PLAY" && payload.targetCardInstanceId === targetEquipment));
  assert.ok(payloads.some((payload) => payload.cardInstanceId === panicId && payload.targetPlayerId === "player-2" && payload.targetZone === "HAND"));
  assert.ok(payloads.some((payload) => payload.cardInstanceId === catId && payload.targetPlayerId === "player-3"));
  assert.ok(!payloads.some((payload) => payload.cardInstanceId === panicId && payload.targetPlayerId === "player-3"));
  assert.equal(JSON.stringify(candidates).includes(targetHandId), false);
  assertEveryCandidatePassesT14(state, candidates);
  assertFullDeckInvariant(state);
});

test("Calamity Janet receives only the supported Missed-as-BANG proposal", () => {
  const state = makeState();
  emptyActorHand(state);
  state.seats[0]!.public.characterId = "calamity_janet";
  const missedId = moveCardToHand(state, "missed", "player-1");

  const candidates = buildLegalActionCandidates(state, "player-1");
  const converted = candidates.filter((candidate) => candidate.type === "PLAY_CARD" && candidate.payload.cardInstanceId === missedId);

  assert.ok(converted.length > 0);
  assert.ok(converted.every((candidate) => candidate.type === "PLAY_CARD" && candidate.payload.asCardType === "bang"));
  assertEveryCandidatePassesT14(state, candidates);
  assertFullDeckInvariant(state);
});

test("Sid card-pair actions are complete and no actions are proposed outside an idle play turn", () => {
  const state = makeState();
  emptyActorHand(state);
  state.seats[0]!.public.characterId = "sid_ketchum";
  const first = moveCardToHand(state, "bang", "player-1");
  const second = moveCardToHand(state, "beer", "player-1");
  const sidCandidates = buildLegalActionCandidates(state, "player-1");

  assert.ok(sidCandidates.some((candidate) => candidate.type === "USE_ABILITY" &&
    candidate.payload.abilityId === "sid-ketchum" &&
    candidate.payload.cardInstanceIds[0] === first && candidate.payload.cardInstanceIds[1] === second));
  assertEveryCandidatePassesT14(state, sidCandidates);
  assert.deepEqual(buildLegalActionCandidates(state, "player-2"), []);
  assert.deepEqual(buildLegalActionCandidates({ ...state, turn: { ...state.turn, phase: "draw" } }, "player-1"), []);
  assert.deepEqual(buildLegalActionCandidates({
    ...state,
    resolution: { ...state.resolution, continuations: [{ frameId: "f", kind: "pending", sourcePlayerId: null, sourceCardInstanceId: null, payload: {} }] },
  }, "player-1"), []);
  assertFullDeckInvariant(state);
});

test("optimized action projection exactly matches full effect probes across all characters and 4–7 seats", () => {
  for (const capacity of [4, 5, 6, 7]) {
    for (const character of characters) {
      const state = initializeGame({
        players: Array.from({ length: capacity }, (_, index) => ({ playerId: `p${index}`, displayName: `P${index}` })),
        random: fixedRandom(),
      });
      const actor = state.seats[0]!;
      actor.public.characterId = character.id;
      state.turn.currentPlayerId = actor.public.playerId;
      state.turn.phase = "play";
      // Every physical type is represented. The other seats retain their hands.
      const hand = new Set(actor.private.handCardInstanceIds);
      for (const definition of BASE_PHYSICAL_CARDS) {
        if ([...hand].some((id) => state.zones.cardsByInstanceId[id]?.cardDefinitionId === definition.definitionId)) continue;
        const instance = Object.values(state.zones.cardsByInstanceId).find((card) => card.cardDefinitionId === definition.definitionId)!;
        if (!state.zones.drawPileCardInstanceIds.includes(instance.cardInstanceId)) continue;
        actor.private.handCardInstanceIds.push(instance.cardInstanceId);
        state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== instance.cardInstanceId);
        hand.add(instance.cardInstanceId);
      }
      const before = structuredClone(state);
      assert.deepEqual(buildLegalActionCandidates(state, actor.public.playerId), buildReferenceActionCandidates(state, actor.public.playerId), `${capacity} players: ${character.id}`);
      assert.deepEqual(state, before);
    }
  }
});

test("Sid projection never proposes a duplicate or multiply located cost card", () => {
  const state = makeState();
  state.seats[0]!.public.characterId = "sid_ketchum";
  const first = state.seats[0]!.private.handCardInstanceIds[0]!;
  state.zones.discardPileCardInstanceIds.push(first);
  assert.ok(buildLegalActionCandidates(state, "player-1").filter((action) => action.type === "USE_ABILITY")
    .every((action) => action.type === "USE_ABILITY" && !action.payload.cardInstanceIds.includes(first)));
});

test("pure gates match effect probes with equipment, BANG quota, healing and eliminated seats", () => {
  for (const scenario of ["equipment", "quota", "volcanic", "willy", "conversion-quota", "two-survivors", "damaged"]) {
    const state = makeState();
    emptyActorHand(state);
    for (const type of ["bang", "missed", "beer", "duel", "jail", "barrel", "dynamite", "scope", "mustang", "winchester"]) {
      moveCardToHand(state, type, "player-1");
    }
    const equip = (type: string, player: string) => {
      const id = moveCardToHand(state, type, player);
      const seat = state.seats.find((seat) => seat.public.playerId === player)!;
      seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((cardId) => cardId !== id);
      seat.public.inPlayCardInstanceIds.push(id);
    };
    if (scenario === "equipment") {
      for (const type of ["barrel", "dynamite", "scope", "mustang", "winchester"]) equip(type, "player-1");
      equip("mustang", "player-2");
      equip("jail", "player-3");
    }
    if (["quota", "volcanic", "willy", "conversion-quota"].includes(scenario)) state.turn.bangCardPlaysThisTurn = 1;
    if (scenario === "volcanic") equip("volcanic", "player-1");
    if (scenario === "willy") state.seats[0]!.public.characterId = "willy_the_kid";
    if (scenario === "conversion-quota") state.seats[0]!.public.characterId = "calamity_janet";
    if (scenario === "damaged") state.seats[0]!.public.hp -= 1;
    if (scenario === "two-survivors") {
      for (const seat of state.seats.slice(2)) {
        seat.public.eliminated = true;
        seat.public.hp = 0;
        state.zones.discardPileCardInstanceIds.push(...seat.private.handCardInstanceIds);
        seat.private.handCardInstanceIds = [];
      }
    }
    const before = structuredClone(state);
    const proposals = buildLegalActionCandidates(state, "player-1");
    assert.deepEqual(proposals, buildReferenceActionCandidates(state, "player-1"), scenario);
    assertEveryCandidatePassesT14(state, proposals);
    assert.deepEqual(state, before);
    assertFullDeckInvariant(state);
  }
});
