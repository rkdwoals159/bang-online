import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState, ResolutionFrame, RoleId } from "../../src/state/types.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import {
  advanceElimination,
  beginElimination,
  checkVictoryAtBoundary,
} from "../../src/endgame/index.ts";
import {
  beginDeathRescue,
  beginEffectResolution,
  completeDeathRescue,
  completeEffectStep,
  finishEffectResolution,
  submitDeathRescueResponse,
  submitDiscardOrder,
} from "../../src/resolution/index.ts";

const TIMESTAMP = "2026-09-27T12:00:00.000Z";
const STANDARD_ROLES: readonly RoleId[] = ["sheriff", "outlaw", "renegade", "deputy", "outlaw"];

function randomSource(value = 0.25): RandomSource {
  return { nextFloat: () => value };
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 5 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const values = Array.from({ length: 1_000 }, (_, index) => ((index * 67 + 11) % 997) / 997);
  let cursor = 0;
  return initializeGame({
    players,
    random: {
      nextFloat() {
        assert.ok(cursor < values.length, "fixture setup requested too many random values");
        return values[cursor++]!;
      },
    },
  });
}

function assignRoles(state: GameState, roles: readonly RoleId[] = STANDARD_ROLES): void {
  assert.equal(roles.length, state.seats.length);
  state.seats = state.seats.map((seat) => {
    const playerNumber = Number(seat.public.playerId.replace("player-", ""));
    const roleId = roles[playerNumber - 1]!;
    return {
      ...seat,
      private: { ...seat.private, roleId },
      public: { ...seat.public, roleRevealed: roleId === "sheriff" },
    };
  });
}

function setCharacter(state: GameState, playerId: string, characterId: string): void {
  const seat = state.seats.find((candidate) => candidate.public.playerId === playerId);
  assert.ok(seat);
  seat.public.characterId = characterId;
}

function seat(state: GameState, playerId: string) {
  const result = state.seats.find((candidate) => candidate.public.playerId === playerId);
  assert.ok(result, `missing seat ${playerId}`);
  return result;
}

function ownedCards(state: GameState, playerId: string): string[] {
  const owner = seat(state, playerId);
  return [...owner.private.handCardInstanceIds, ...owner.public.inPlayCardInstanceIds];
}

function moveCardToInPlay(state: GameState, playerId: string, cardInstanceId: string): void {
  const target = seat(state, playerId);
  const handOwner = state.seats.find((candidate) => candidate.private.handCardInstanceIds.includes(cardInstanceId));
  if (handOwner) {
    handOwner.private.handCardInstanceIds = handOwner.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
  } else {
    const drawIndex = state.zones.drawPileCardInstanceIds.indexOf(cardInstanceId);
    const discardIndex = state.zones.discardPileCardInstanceIds.indexOf(cardInstanceId);
    const revealedIndex = state.zones.revealedPoolCardInstanceIds.indexOf(cardInstanceId);
    if (drawIndex >= 0) state.zones.drawPileCardInstanceIds.splice(drawIndex, 1);
    else if (discardIndex >= 0) state.zones.discardPileCardInstanceIds.splice(discardIndex, 1);
    else if (revealedIndex >= 0) state.zones.revealedPoolCardInstanceIds.splice(revealedIndex, 1);
    else assert.fail(`card ${cardInstanceId} does not have a movable source zone`);
  }
  target.public.inPlayCardInstanceIds.push(cardInstanceId);
}

function addCardFromDrawToInPlay(state: GameState, playerId: string): string {
  const cardId = state.zones.drawPileCardInstanceIds[0];
  assert.ok(cardId);
  moveCardToInPlay(state, playerId, cardId);
  return cardId;
}

function addDynamiteToInPlay(state: GameState, playerId: string): string {
  const dynamiteDefinitionIds = new Set(
    BASE_PHYSICAL_CARDS.filter((card) => card.typeId === "dynamite").map((card) => card.definitionId),
  );
  const cardId = Object.values(state.zones.cardsByInstanceId)
    .find((instance) => dynamiteDefinitionIds.has(instance.cardDefinitionId))?.cardInstanceId;
  assert.ok(cardId, "catalog fixture should contain a Dynamite card");
  moveCardToInPlay(state, playerId, cardId);
  return cardId;
}

function prepareDeath(
  state: GameState,
  victimPlayerId: string,
  sourcePlayerId: string | null,
  frameId = "frame-death",
): GameState {
  const victim = seat(state, victimPlayerId);
  victim.public.hp = 0;
  if (!state.resolution.continuations.some((frame) => frame.frameId === frameId)) {
    const frame: ResolutionFrame = {
      frameId,
      kind: "TEST_CARD_RESOLUTION",
      sourcePlayerId,
      sourceCardInstanceId: null,
      payload: {},
    };
    state.resolution.continuations = [...state.resolution.continuations, frame];
  }

  const opened = beginDeathRescue(state, {
    victimPlayerId,
    sourcePlayerId,
    interactionId: `rescue-${victimPlayerId}`,
    options: [{ choice: "ACCEPT_ELIMINATION", payload: {} }],
    context: {},
    resumeFrameId: frameId,
    createdAt: TIMESTAMP,
  });
  assert.equal(opened.ok, true, opened.ok ? undefined : opened.error.message);
  if (!opened.ok) throw new Error(opened.error.message);

  const response = submitDeathRescueResponse(opened.state, {
    interactionId: `rescue-${victimPlayerId}`,
    actorPlayerId: victimPlayerId,
    choice: "ACCEPT_ELIMINATION",
    payload: {},
  });
  assert.equal(response.ok, true, response.ok ? undefined : response.error.message);
  if (!response.ok) throw new Error(response.error.message);

  const closed = completeDeathRescue(response.state, victimPlayerId, "accept_elimination");
  assert.equal(closed.ok, true, closed.ok ? undefined : closed.error.message);
  if (!closed.ok) throw new Error(closed.error.message);
  return closed.state;
}

function beginForCause(
  state: GameState,
  victimPlayerId: string,
  attribution: Parameters<typeof beginElimination>[1]["attribution"],
  options: { discardInteractionId?: string } = {},
) {
  const begun = beginElimination(state, {
    victimPlayerId,
    attribution,
    ...options,
    ...(options.discardInteractionId ? { createdAt: TIMESTAMP } : {}),
  });
  assert.equal(begun.ok, true, begun.ok ? undefined : begun.error.message);
  if (!begun.ok) throw new Error(begun.error.message);
  return begun;
}

function orderCards(state: GameState, interactionId: string, ownerPlayerId: string, orderedCardInstanceIds: string[]): GameState {
  const ordered = submitDiscardOrder(state, {
    interactionId,
    actorPlayerId: ownerPlayerId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds,
  });
  assert.equal(ordered.ok, true, ordered.ok ? undefined : ordered.error.message);
  if (!ordered.ok) throw new Error(ordered.error.message);
  return ordered.state;
}

function advance(state: GameState, interactionId?: string) {
  const result = advanceElimination(state, {
    ...(interactionId ? { interactionId, createdAt: TIMESTAMP } : {}),
    random: randomSource(),
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

test("living Vulture Sam receives an outlaw's hand and equipment before the responsible player draws three", () => {
  const state = initialState();
  assignRoles(state);
  const sheriffId = "player-1";
  const victimId = "player-2";
  setCharacter(state, sheriffId, "vulture_sam");
  const inPlayId = addCardFromDrawToInPlay(state, victimId);
  const victimCards = ownedCards(state, victimId);
  const sheriffHandBefore = seat(state, sheriffId).private.handCardInstanceIds.length;
  const drawBefore = state.zones.drawPileCardInstanceIds.length;
  const atElimination = prepareDeath(state, victimId, sheriffId);

  const begun = beginForCause(atElimination, victimId, { kind: "player_effect" });
  assert.equal(begun.value.vultureSamPlayerId, sheriffId);
  assert.equal(begun.value.awaitingInteractionId, null, "Vulture Sam custody skips owner discard order");
  assert.equal(begun.value.rewardPlayerId, sheriffId);
  assert.deepEqual(seat(begun.state, sheriffId).private.handCardInstanceIds.slice(sheriffHandBefore, sheriffHandBefore + victimCards.length), victimCards);
  assert.ok(victimCards.includes(inPlayId));
  assert.deepEqual(seat(begun.state, victimId).private.handCardInstanceIds, []);
  assert.deepEqual(seat(begun.state, victimId).public.inPlayCardInstanceIds, []);
  assert.equal(seat(begun.state, victimId).public.eliminated, true);
  assert.equal(seat(begun.state, victimId).public.roleRevealed, true);

  const progressed = advance(begun.state);
  assert.equal(progressed.value.stage, "cleanup_complete");
  assert.equal(progressed.value.winCheckRequired, true);
  assert.equal(progressed.value.outcome, null);
  assert.equal(seat(progressed.state, sheriffId).private.handCardInstanceIds.length, sheriffHandBefore + victimCards.length + 3);
  assert.equal(progressed.state.zones.drawPileCardInstanceIds.length, drawBefore - 3);
});

test("Sheriff Sam first recovers the Deputy's cards, then orders all of their cards into the discard pile", () => {
  const state = initialState();
  assignRoles(state);
  const sheriffId = "player-1";
  const deputyId = "player-4";
  setCharacter(state, sheriffId, "vulture_sam");
  addCardFromDrawToInPlay(state, deputyId);
  const deputyCards = ownedCards(state, deputyId);
  const sheriffCardsBefore = ownedCards(state, sheriffId);
  const atElimination = prepareDeath(state, deputyId, sheriffId);

  const begun = beginForCause(atElimination, deputyId, { kind: "player_effect" });
  assert.equal(begun.value.vultureSamPlayerId, sheriffId);
  assert.equal(begun.value.sheriffPenaltyPlayerId, sheriffId);
  assert.equal(begun.value.awaitingInteractionId, null);
  assert.deepEqual(seat(begun.state, sheriffId).private.handCardInstanceIds.slice(sheriffCardsBefore.length), deputyCards);

  const penalty = advance(begun.state, "sheriff-discard");
  assert.equal(penalty.value.stage, "awaiting_discard");
  assert.equal(penalty.state.resolution.pendingInteraction?.actorPlayerIds[0], sheriffId);
  const allowed = penalty.state.resolution.pendingInteraction?.context.discardOrder;
  assert.ok(allowed && typeof allowed === "object" && !Array.isArray(allowed));
  const allowedIds = (allowed as { allowedCardInstanceIds: string[] }).allowedCardInstanceIds;
  assert.deepEqual(new Set(allowedIds), new Set([...sheriffCardsBefore, ...deputyCards]));

  const chosen = [...allowedIds].reverse();
  const ordered = orderCards(penalty.state, "sheriff-discard", sheriffId, chosen);
  const finished = advance(ordered);
  assert.equal(finished.value.stage, "cleanup_complete");
  assert.deepEqual(ownedCards(finished.state, sheriffId), []);
  assert.deepEqual(finished.state.zones.discardPileCardInstanceIds.slice(-chosen.length), chosen);
});

test("without Vulture Sam, the eliminated owner chooses discard top order and the killer gets the Outlaw reward", () => {
  const state = initialState();
  assignRoles(state);
  const sheriffId = "player-1";
  const victimId = "player-2";
  addCardFromDrawToInPlay(state, victimId);
  const victimCards = ownedCards(state, victimId);
  const drawBefore = state.zones.drawPileCardInstanceIds.length;
  const victimHandBefore = seat(state, victimId).private.handCardInstanceIds.length;
  const atElimination = prepareDeath(state, victimId, sheriffId);

  const begun = beginForCause(atElimination, victimId, { kind: "player_effect" }, { discardInteractionId: "victim-discard" });
  assert.equal(begun.value.vultureSamPlayerId, null);
  assert.equal(begun.value.awaitingInteractionId, "victim-discard");
  const chosen = [...victimCards].reverse();
  const restored = JSON.parse(JSON.stringify(begun.state)) as GameState;
  const ordered = orderCards(restored, "victim-discard", victimId, chosen);
  const finished = advance(ordered);

  assert.equal(finished.value.stage, "cleanup_complete");
  assert.deepEqual(finished.state.zones.discardPileCardInstanceIds.slice(-chosen.length), chosen);
  assert.equal(seat(finished.state, sheriffId).private.handCardInstanceIds.length, seat(state, sheriffId).private.handCardInstanceIds.length + 3);
  assert.equal(finished.state.zones.drawPileCardInstanceIds.length, drawBefore - 3);
  assert.equal(seat(finished.state, victimId).public.roleRevealed, true);
  assert.equal(seat(finished.state, victimId).public.eliminated, true);
  assert.equal(victimHandBefore, seat(state, victimId).private.handCardInstanceIds.length);
});

test("Dynamite has no responsible killer and is discarded before the eliminated owner's remaining cards", () => {
  const state = initialState();
  assignRoles(state);
  const victimId = "player-2";
  const dynamiteId = addDynamiteToInPlay(state, victimId);
  addCardFromDrawToInPlay(state, victimId);
  const remainingCards = ownedCards(state, victimId).filter((cardId) => cardId !== dynamiteId);
  const drawBefore = state.zones.drawPileCardInstanceIds.length;
  const atElimination = prepareDeath(state, victimId, null);

  const begun = beginForCause(atElimination, victimId, { kind: "dynamite" }, { discardInteractionId: "dynamite-victim-discard" });
  assert.deepEqual(begun.value.discardedDynamiteCardInstanceIds, [dynamiteId]);
  assert.equal(begun.value.rewardPlayerId, null);
  assert.ok(begun.state.zones.discardPileCardInstanceIds.includes(dynamiteId));
  const chosen = [...remainingCards].reverse();
  const ordered = orderCards(begun.state, "dynamite-victim-discard", victimId, chosen);
  const finished = advance(ordered);

  assert.equal(finished.value.stage, "cleanup_complete");
  assert.deepEqual(finished.state.zones.discardPileCardInstanceIds.slice(-chosen.length), chosen);
  assert.ok(finished.state.zones.discardPileCardInstanceIds.indexOf(dynamiteId) < finished.state.zones.discardPileCardInstanceIds.length - chosen.length);
  assert.equal(finished.state.zones.drawPileCardInstanceIds.length, drawBefore);
});

test("a Duel initiator who dies receives no Outlaw kill reward", () => {
  const state = initialState();
  assignRoles(state);
  const initiatorId = "player-2";
  setCharacter(state, "player-4", "vulture_sam");
  const drawBefore = state.zones.drawPileCardInstanceIds.length;
  const atElimination = prepareDeath(state, initiatorId, initiatorId);

  const begun = beginForCause(atElimination, initiatorId, {
    kind: "duel",
    initiatorPlayerId: initiatorId,
  });
  assert.equal(begun.value.rewardPlayerId, null);
  const finished = advance(begun.state);
  assert.equal(finished.value.stage, "cleanup_complete");
  assert.equal(finished.state.zones.drawPileCardInstanceIds.length, drawBefore);
});

test("victory follows R30 and reveals all roles once an allowed boundary is reached", () => {
  const state = initialState();
  assignRoles(state);
  state.seats.find((candidate) => candidate.private.roleId === "outlaw")!.public.eliminated = true;
  state.seats.find((candidate) => candidate.private.roleId === "outlaw" && !candidate.public.eliminated)!.public.eliminated = true;
  state.seats.find((candidate) => candidate.private.roleId === "renegade")!.public.eliminated = true;

  const beforeNoOutcome = initialState();
  assignRoles(beforeNoOutcome);
  const notFinished = checkVictoryAtBoundary(beforeNoOutcome);
  assert.equal(notFinished.ok, true);
  if (notFinished.ok) {
    assert.equal(notFinished.value.finished, false);
    assert.equal(notFinished.state.version, beforeNoOutcome.version, "a non-winning boundary is read-only");
  }

  const sheriffWin = checkVictoryAtBoundary(state);
  assert.equal(sheriffWin.ok, true);
  if (!sheriffWin.ok) return;
  assert.deepEqual(sheriffWin.value.outcome, {
    winningFaction: "sheriff_and_deputies",
    winningPlayerIds: state.seats
      .filter((candidate) => candidate.private.roleId === "sheriff" || candidate.private.roleId === "deputy")
      .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
      .map((candidate) => candidate.public.playerId),
  });
  assert.equal(sheriffWin.state.status, "completed");
  assert.ok(sheriffWin.state.seats.every((candidate) => candidate.public.roleRevealed));

  const renegadeState = initialState();
  assignRoles(renegadeState);
  for (const candidate of renegadeState.seats) candidate.public.eliminated = candidate.private.roleId !== "renegade";
  const renegadeWin = checkVictoryAtBoundary(renegadeState);
  assert.equal(renegadeWin.ok, true);
  if (renegadeWin.ok) {
    assert.deepEqual(renegadeWin.value.outcome, {
      winningFaction: "renegade",
      winningPlayerIds: ["player-3"],
    });
  }

  const outlawState = initialState();
  assignRoles(outlawState);
  for (const candidate of outlawState.seats) {
    candidate.public.eliminated = candidate.private.roleId === "sheriff" || candidate.private.roleId === "renegade";
  }
  const outlawWin = checkVictoryAtBoundary(outlawState);
  assert.equal(outlawWin.ok, true);
  if (outlawWin.ok) {
    assert.deepEqual(outlawWin.value.outcome, {
      winningFaction: "outlaws",
    winningPlayerIds: outlawState.seats
      .filter((candidate) => candidate.private.roleId === "outlaw")
      .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
      .map((candidate) => candidate.public.playerId),
    });
  }
});

test("multi-target elimination defers victory until the saved effect frame is finished", () => {
  const state = initialState();
  assignRoles(state);
  setCharacter(state, "player-3", "vulture_sam");
  const effectId = "gatling-effect";
  const frameId = "gatling-frame";
  const targets = ["player-1", "player-4", "player-2", "player-5"];
  const started = beginEffectResolution(state, {
    steps: targets.map((targetPlayerId) => ({
      effectId,
      kind: "GATLING_TARGET",
      sourcePlayerId: "player-3",
      targetPlayerId,
      sourceCardInstanceId: null,
      payload: {},
    })),
    continuation: {
      frameId,
      kind: "GATLING_RESOLUTION",
      sourcePlayerId: "player-3",
      sourceCardInstanceId: null,
      payload: { targetCursor: 0 },
    },
    deferredVictoryCheckEffectId: effectId,
  });
  assert.equal(started.ok, true, started.ok ? undefined : started.error.message);
  if (!started.ok) return;
  let current = started.state;

  for (const victimPlayerId of targets) {
    const prepared = prepareDeath(current, victimPlayerId, "player-3", frameId);
    const begun = beginForCause(prepared, victimPlayerId, { kind: "player_effect" });
    const progressed = advance(begun.state);
    assert.equal(progressed.value.stage, "cleanup_complete");
    assert.equal(progressed.value.winCheckRequired, false, "queued/deferred work suppresses death-local victory checks");
    assert.equal(progressed.value.victoryChecked, false);
    current = progressed.state;
    const head = current.resolution.effectQueue[0];
    assert.ok(head);
    const stepClosed = completeEffectStep(current, head);
    assert.equal(stepClosed.ok, true, stepClosed.ok ? undefined : stepClosed.error.message);
    if (!stepClosed.ok) return;
    current = stepClosed.state;
  }

  assert.equal(current.resolution.effectQueue.length, 0);
  const tooEarly = checkVictoryAtBoundary(current);
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.error.code, "NO_VICTORY_BOUNDARY");

  const finished = finishEffectResolution(current, effectId, frameId);
  assert.equal(finished.ok, true, finished.ok ? undefined : finished.error.message);
  if (!finished.ok) return;
  assert.equal(finished.value.canCheckVictory, true);
  const victory = checkVictoryAtBoundary(finished.state);
  assert.equal(victory.ok, true);
  if (victory.ok) {
    assert.deepEqual(victory.value.outcome, {
      winningFaction: "renegade",
      winningPlayerIds: ["player-3"],
    });
  }
});
