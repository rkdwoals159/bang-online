import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { parseMatchSyncResponse } from "../../../contracts/src/validation.ts";
import { projectMatchSnapshot } from "../../src/state/projection.ts";
import { findCard, playerId, runEngineAcceptanceScenario } from "../../../test-fixtures/engine/index.ts";
import { buildLegalActionCandidates } from "../../src/actions/index.ts";

test("P03 compact Sid projection represents every allowed pair with one cost set", () => {
  runEngineAcceptanceScenario({ id: "review-P03", seats: {
    A: { characterId: "sid_ketchum", hp: 2, hand: ["bang", "beer", "missed", "mustang"].map(typeId => ({ typeId })) },
  } }, session => {
    const exact = buildLegalActionCandidates(session.state, playerId("A")).filter(action => action.type === "USE_ABILITY");
    assert.equal(exact.length, 6);
    const view = projectMatchSnapshot(session.state, playerId("A"), BASE_PHYSICAL_CARDS);
    const compact = view.legalActions!.filter(action => action.type === "USE_ABILITY");
    assert.equal(compact.length, 1);
    assert.equal(compact[0]!.costSelection?.allowedCardInstanceIds.length, 4);
    assert.ok(validView(view));
    for (const action of exact) for (const id of action.payload.cardInstanceIds) {
      assert.ok(compact[0]!.costSelection!.allowedCardInstanceIds.includes(id));
    }
  });
});

function validView(snapshot: ReturnType<typeof projectMatchSnapshot>) {
  return parseMatchSyncResponse({ protocolVersion: 1, requestId: "review", matchId: "review", version: 0,
    eventSeq: 0, requiresFullSnapshot: true, snapshot, visibleEvents: [] }).ok;
}

test("R01 a Duel initiator's elimination advances exactly one seat and permits the next draw", () => {
  runEngineAcceptanceScenario({ id: "review-R01", currentPlayer: "B", seats: {
    B: { hp: 1, hand: [{ typeId: "duel" }, { typeId: "bang" }] }, C: { hand: [{ typeId: "bang" }] },
  } }, session => {
    assert.ok(session.play("B", findCard(session.state, "duel", { player: "B", zone: "hand" }), "C").ok);
    assert.ok(session.respond("C", "PLAY_BANG", { cardInstanceId: findCard(session.state, "bang", { player: "C", zone: "hand" }) }).ok);
    const yielded = session.respond("B", "YIELD");
    assert.ok(yielded.ok, JSON.stringify(yielded));
    assert.ok(session.respondCurrent("ACCEPT_ELIMINATION").ok);
    if (session.state.resolution.pendingInteraction?.kind === "DISCARDS_ORDER") {
      const order = session.state.resolution.pendingInteraction.options[0]!;
      const cleanup = session.respondCurrent(order.choice, { ...order.payload,
        orderedCardInstanceIds: [...session.state.seats[1]!.private.handCardInstanceIds,
          ...session.state.seats[1]!.public.inPlayCardInstanceIds] });
      assert.ok(cleanup.ok, JSON.stringify(cleanup));
    }
    assert.equal(session.state.seats[1]!.public.eliminated, true);
    assert.equal(session.state.turn.currentPlayerId, playerId("C"));
    assert.equal(session.state.turn.phase, "start");
    assert.ok(session.startTurn().ok);
    assert.ok(session.drawTurn().ok);
    assert.equal(session.state.turn.phase, "play");
  });
});

test("R02 Lucky's failed Jail judgment skips the turn, with public faces and a valid DTO", () => {
  runEngineAcceptanceScenario({ id: "review-R02", currentPlayer: "B", phase: "start", seats: {
    B: { characterId: "lucky_duke", inPlay: [{ typeId: "jail" }] },
  }, drawTop: [{ typeId: "bang", suit: "SPADES" }, { typeId: "bang", suit: "DIAMONDS" }] }, session => {
    assert.ok(session.startTurn().ok);
    for (const seat of session.state.seats) {
      const view = projectMatchSnapshot(session.state, seat.public.playerId, BASE_PHYSICAL_CARDS);
      assert.equal(view.publicTable.luckyJudgment?.cards.length, 2);
      assert.equal(view.publicTable.luckyJudgment?.sourceKind, "jail");
      assert.ok(validView(view));
    }
    const option = session.state.resolution.pendingInteraction!.options[0]!;
    assert.ok(session.respond("B", option.choice, option.payload).ok);
    assert.equal(session.state.turn.currentPlayerId, playerId("C"));
    assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 0);
    assert.ok(session.startTurn().ok);
    assert.ok(session.drawTurn().ok);
    assert.equal(session.state.turn.currentPlayerId, playerId("C"));
  });
});

test("R03 Kit's three choice faces appear only in Kit's private responder DTO", () => {
  runEngineAcceptanceScenario({ id: "review-R03", phase: "draw", seats: {
    A: { characterId: "kit_carlson" },
  }, drawTop: [{ typeId: "bang" }, { typeId: "beer" }, { typeId: "missed" }] }, session => {
    assert.ok(session.drawTurn().ok);
    const candidates = session.state.zones.revealedPoolCardInstanceIds;
    assert.equal(candidates.length, 3);
    for (const seat of session.state.seats) {
      const view = projectMatchSnapshot(session.state, seat.public.playerId, BASE_PHYSICAL_CARDS);
      assert.ok(validView(view));
      if (seat.public.playerId === playerId("A")) {
        assert.ok(view.pendingInteraction && "choiceCards" in view.pendingInteraction);
        assert.deepEqual(view.pendingInteraction.choiceCards?.map(card => card.cardInstanceId).sort(), [...candidates].sort());
      } else for (const id of candidates) assert.ok(!JSON.stringify(view).includes(id));
    }
    const option = session.state.resolution.pendingInteraction!.options[0]!;
    assert.ok(session.respondDraw("A", option.choice, option.payload).ok);
    assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 2);
  });
});

for (const effect of ["panic", "cat_balou"] as const) test(`R04 Suzy draws after ${effect} removes her last hand card`, () => {
  runEngineAcceptanceScenario({ id: `review-R04-${effect}`, seats: {
    A: { hand: [{ typeId: effect }] }, B: { characterId: "suzy_lafayette", hand: [{ typeId: "beer" }] },
  } }, session => {
    const oldCard = session.state.seats[1]!.private.handCardInstanceIds[0]!;
    assert.ok(session.play("A", findCard(session.state, effect, { player: "A", zone: "hand" }), "B", { targetZone: "HAND" }).ok);
    assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1);
    assert.ok(!session.state.seats[1]!.private.handCardInstanceIds.includes(oldCard));
  });
});

test("R04 opposing Suzy waits until Duel ends before replenishing her empty hand", () => {
  runEngineAcceptanceScenario({ id: "review-R04-Duel", seats: {
    A: { hand: [{ typeId: "duel" }, { typeId: "bang" }] }, B: { characterId: "suzy_lafayette", hand: [{ typeId: "bang" }] },
  } }, session => {
    assert.ok(session.play("A", findCard(session.state, "duel", { player: "A", zone: "hand" }), "B").ok);
    assert.ok(session.respond("B", "PLAY_BANG", { cardInstanceId: findCard(session.state, "bang", { player: "B", zone: "hand" }) }).ok);
    assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 0);
    assert.ok(session.respond("A", "YIELD").ok);
    assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1);
  });
});

test("R04 Suzy replenishes after Jesse steals her last card during draw", () => {
  runEngineAcceptanceScenario({ id: "review-R04-Jesse", phase: "draw", seats: {
    A: { characterId: "jesse_jones" }, B: { characterId: "suzy_lafayette", hand: [{ typeId: "bang" }] },
  } }, session => {
    assert.ok(session.drawTurn().ok);
    const option = session.state.resolution.pendingInteraction!.options.find(option => option.choice === "TAKE_FROM_HAND" && option.payload.sourcePlayerId === playerId("B"))!;
    assert.ok(option);
    assert.ok(session.respondDraw("A", option.choice, option.payload).ok);
    assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 2);
    assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1);
  });
});
