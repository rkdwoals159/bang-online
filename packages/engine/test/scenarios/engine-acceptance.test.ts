import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import { characters } from "../../../catalog/src/characters/index.js";
import type { RoleId } from "../../../catalog/src/schema.js";
import {
  assertEngineProjectionPrivacy,
  assertEngineStateInvariants,
  buildEngineScenarioFixture,
  cardTypeId,
  findCard,
  fixedRandom,
  playerId,
  runEngineAcceptanceScenario,
  type EngineScenarioSession,
  type ScenarioCardSpec,
  type ScenarioPlayerKey,
} from "../../../test-fixtures/engine/index.js";
import { applyMatchCommand, type EngineCommand } from "../../src/commands/index.js";
import { checkPlayCardLegality } from "../../src/rules/legality.js";
import { calculateBaseDistance, calculateDistance, getMaxBangRange } from "../../src/rules/distance.js";
import { initializeGame } from "../../src/setup/initialize.js";
import { projectMatchSnapshot } from "../../src/state/projection.js";
import type { GameState } from "../../src/state/types.js";

type Scenario = (session: EngineScenarioSession) => void;

function scenario(
  id: string,
  setup: Omit<Parameters<typeof buildEngineScenarioFixture>[0], "id">,
  run: Scenario,
): void {
  test(`${id} deterministic engine acceptance scenario`, () => {
    runEngineAcceptanceScenario({ id, ...setup }, run);
  });
}

function accepted<T extends { ok: boolean }>(result: T, label: string): asserts result is T & { ok: true } {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
}

function rejected(result: { ok: boolean; error?: { code?: string } }, code?: string): void {
  assert.equal(result.ok, false, `expected a rejected command${code ? ` (${code})` : ""}`);
  if (code) assert.equal(result.error?.code, code);
}

function handCard(session: EngineScenarioSession, player: ScenarioPlayerKey, typeId: string, face?: { rank?: number | "A" | "J" | "Q" | "K"; suit?: "SPADES" | "HEARTS" | "DIAMONDS" | "CLUBS" }): string {
  return findCard(session.state, typeId, { player, zone: "hand" }, face);
}

function inPlayCard(session: EngineScenarioSession, player: ScenarioPlayerKey, typeId: string): string {
  return findCard(session.state, typeId, { player, zone: "inPlay" });
}

function resolveHitResponses(session: EngineScenarioSession): void {
  for (let guard = 0; session.state.resolution.pendingInteraction && guard < 12; guard += 1) {
    const kind = session.state.resolution.pendingInteraction.kind;
    assert.ok(kind === "BANG_RESPONSE" || kind === "GATLING_RESPONSE", "helper handles sequential BANG and Gatling responses");
    accepted(session.respondCurrent("TAKE_HIT"), "take hit");
  }
  assert.equal(session.state.resolution.pendingInteraction, null, "all tablewide BANG responses should finish");
}

function initialStateForSeed(count: 4 | 5 | 6 | 7, seed: number): GameState {
  const players = ["A", "B", "C", "D", "E", "F", "G"].slice(0, count).map((letter) => ({
    playerId: `player-${letter}`,
    displayName: `Seat ${letter}`,
  }));
  return initializeGame({ players, random: fixedRandom(seed) });
}

function matchingSetup(count: 4 | 5 | 6 | 7, predicate: (state: GameState) => boolean): { state: GameState; seed: number } {
  for (let seed = 1; seed <= 400; seed += 1) {
    const state = initialStateForSeed(count, seed);
    if (predicate(state)) return { state, seed };
  }
  assert.fail(`no deterministic ${count}-player setup matched within 400 seeds`);
}

function roleCounts(state: GameState): Record<RoleId, number> {
  return state.seats.reduce((counts, seat) => {
    counts[seat.private.roleId] += 1;
    return counts;
  }, { sheriff: 0, deputy: 0, outlaw: 0, renegade: 0 });
}

function moveAllBut(session: EngineScenarioSession, keepDraw: readonly string[]): void {
  const keep = new Set(keepDraw);
  const returned = session.state.zones.drawPileCardInstanceIds.filter((id) => !keep.has(id));
  session.state.zones.drawPileCardInstanceIds = [...keepDraw];
  session.state.zones.discardPileCardInstanceIds.push(...returned);
}

function command(type: string, payload: Record<string, unknown>): EngineCommand {
  return { type, payload } as EngineCommand;
}

function faceSpec(suit: "SPADES" | "HEARTS" | "DIAMONDS" | "CLUBS", rank: number | "A" | "J" | "Q" | "K"): ScenarioCardSpec {
  const card = BASE_PHYSICAL_CARDS.find((entry) => entry.suit === suit && entry.rank === rank);
  assert.ok(card, `base deck has no ${suit} ${rank} card`);
  return { typeId: card.typeId, suit, rank };
}

test("AT-A01 4–7 player setup role composition, private roles, and distinct characters", () => {
  runEngineAcceptanceScenario({ id: "AT-A01" }, (session) => {
    const outputs: GameState[] = [];
    for (const count of [4, 5, 6, 7] as const) {
      const state = initialStateForSeed(count, 4100 + count);
      const expected = {
        4: { sheriff: 1, deputy: 0, outlaw: 2, renegade: 1 },
        5: { sheriff: 1, deputy: 1, outlaw: 2, renegade: 1 },
        6: { sheriff: 1, deputy: 1, outlaw: 3, renegade: 1 },
        7: { sheriff: 1, deputy: 2, outlaw: 3, renegade: 1 },
      }[count];
      assert.deepEqual(roleCounts(state), expected);
      assert.equal(new Set(state.seats.map((seat) => seat.public.characterId)).size, count);
      assert.equal(state.seats[0]?.private.roleId, "sheriff");
      assert.equal(state.seats[0]?.public.roleRevealed, true);
      assert.ok(state.seats.slice(1).every((seat) => !seat.public.roleRevealed));
      assertEngineStateInvariants(state);
      assertEngineProjectionPrivacy(state);
      const serializedViews = state.seats.map((seat) => JSON.stringify(projectMatchSnapshot(state, seat.public.playerId, BASE_PHYSICAL_CARDS)));
      for (const [viewerIndex, rawView] of serializedViews.entries()) {
        const view = JSON.parse(rawView) as ReturnType<typeof projectMatchSnapshot>;
        for (const seat of state.seats) {
          const projected = view.publicTable.players.find((entry) => entry.playerId === seat.public.playerId)!;
          assert.equal(projected.role, seat.public.roleRevealed ? seat.private.roleId : null, `viewer ${viewerIndex} only receives revealed roles`);
        }
      }
      outputs.push(state);
    }
    session.trace.push({ setupStates: outputs });
  });
});

test("AT-A02 Paul Regret has 4 HP as Sheriff and 3 HP otherwise at setup", () => {
  runEngineAcceptanceScenario({ id: "AT-A02" }, (session) => {
    const sheriffPaul = matchingSetup(7, (state) => state.seats[0]?.public.characterId === "paul_regret");
    const regularPaul = matchingSetup(7, (state) => state.seats.some((seat) => seat.public.characterId === "paul_regret" && seat.private.roleId !== "sheriff"));
    const sheriff = sheriffPaul.state.seats.find((seat) => seat.public.characterId === "paul_regret");
    const regular = regularPaul.state.seats.find((seat) => seat.public.characterId === "paul_regret" && seat.private.roleId !== "sheriff");
    assert.ok(sheriff && regular);
    assertEngineStateInvariants(sheriffPaul.state);
    assertEngineProjectionPrivacy(sheriffPaul.state);
    assertEngineStateInvariants(regularPaul.state);
    assertEngineProjectionPrivacy(regularPaul.state);
    assert.equal(sheriff.public.maxHp, 4);
    assert.equal(sheriff.public.hp, 4);
    assert.equal(sheriff.private.handCardInstanceIds.length, 4);
    assert.equal(regular.public.maxHp, 3);
    assert.equal(regular.public.hp, 3);
    assert.equal(regular.private.handCardInstanceIds.length, 3);
    session.trace.push({ sheriffSeed: sheriffPaul.seed, regularSeed: regularPaul.seed, sheriffPaul: sheriffPaul.state, regularPaul: regularPaul.state });
  });
});

scenario("AT-A03", { playerCount: 6, phase: "start" }, (session) => {
  const state = initialStateForSeed(6, 4303);
  assertEngineStateInvariants(state);
  assertEngineProjectionPrivacy(state);
  assert.equal(state.turn.currentPlayerId, state.seats[0]?.public.playerId);
  assert.equal(state.turn.phase, "start");
  const sheriff = state.seats[0]!;
  assert.equal(sheriff.private.roleId, "sheriff");
  assert.equal(sheriff.private.handCardInstanceIds.length, sheriff.public.hp);
  const inputOrder = ["A", "B", "C", "D", "E", "F"];
  for (let index = 1; index < state.seats.length; index += 1) {
    const previous = state.seats[index - 1]!;
    const current = state.seats[index]!;
    assert.equal(current.public.seatIndex, previous.public.seatIndex + 1);
    assert.equal(current.private.handCardInstanceIds.length, current.public.hp);
    const previousInputIndex = inputOrder.indexOf(previous.public.playerId.slice(-1));
    const currentInputIndex = inputOrder.indexOf(current.public.playerId.slice(-1));
    assert.equal(currentInputIndex, (previousInputIndex + 1) % state.seats.length, "Sheriff rotation preserves the supplied clockwise order");
  }
  assert.equal(state.zones.drawPileCardInstanceIds.length + state.seats.reduce((n, seat) => n + seat.private.handCardInstanceIds.length, 0), 80);
});

scenario("AT-A04", { playerCount: 5 }, (session) => {
  const state = session.state;
  for (const viewer of state.seats) {
    const view = projectMatchSnapshot(state, viewer.public.playerId, BASE_PHYSICAL_CARDS);
    assert.deepEqual(view.selfPrivate?.hand.map((card) => card.cardInstanceId), viewer.private.handCardInstanceIds);
    for (const other of state.seats) {
      const publicSeat = view.publicTable.players.find((candidate) => candidate.playerId === other.public.playerId)!;
      assert.equal(publicSeat.role, other.public.roleRevealed ? other.private.roleId : null);
      if (other.public.playerId !== viewer.public.playerId) {
        for (const hiddenId of other.private.handCardInstanceIds) assert.ok(!JSON.stringify(view).includes(hiddenId));
      }
    }
  }
});

scenario("AT-A05", {
  seats: { A: { hand: [{ typeId: "bang" }, { typeId: "beer" }, { typeId: "missed" }], hp: 2, maxHp: 4 } },
  phase: "start",
  drawTop: [{ typeId: "saloon" }, { typeId: "stagecoach" }],
}, (session) => {
  const before = session.state.seats[0]!.private.handCardInstanceIds.length;
  accepted(session.startTurn(), "resolve ordinary turn start");
  assert.equal(session.state.turn.phase, "draw");
  const drawn = session.drawTurn();
  accepted(drawn, "draw two normal cards");
  assert.equal(session.state.turn.phase, "play");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, before + 2);
  accepted(session.submit("A", command("END_TURN", {})), "end turn with excess hand");
  assert.equal(session.state.turn.phase, "discard");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DISCARDS_ORDER");
});

scenario("AT-A06", {
  seats: { A: { hand: ["bang", "beer", "missed", "panic", "stagecoach"].map((typeId) => ({ typeId })), hp: 3, maxHp: 4 } },
}, (session) => {
  const ordered = [...session.state.seats[0]!.private.handCardInstanceIds.slice(0, 2)];
  accepted(session.submit("A", command("END_TURN", {})), "open exact two-card discard");
  const pending = session.state.resolution.pendingInteraction!;
  assert.equal(pending.kind, "DISCARDS_ORDER");
  assert.equal(pending.options[0]?.payload.requiredCount, undefined, "required discard count is saved in private context");
  accepted(session.respond("A", "ORDER_CARDS", { orderedCardInstanceIds: ordered }), "submit selected discard order");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 3);
  assert.deepEqual(session.state.zones.discardPileCardInstanceIds.slice(-2), ordered);
  assert.equal(session.state.zones.discardPileCardInstanceIds.at(-1), ordered.at(-1));
  assert.equal(session.state.turn.currentPlayerId, "player-B");
});

scenario("AT-A07", { seats: { A: { hand: [{ typeId: "bang" }], hp: 4, maxHp: 4 } }, phase: "play" }, (session) => {
  const card = handCard(session, "A", "bang");
  const before = structuredClone(session.state);
  rejected(session.submit("A", command("RESPOND", { interactionId: "no-discard-window", choice: "ORDER_CARDS", orderedCardInstanceIds: [card] })));
  assert.deepEqual(session.state, before);
});

scenario("AT-A08", { playerCount: 6 }, (session) => {
  session.state.seats[1]!.public.eliminated = true;
  session.state.seats[2]!.public.eliminated = true;
  const actual = calculateBaseDistance(session.state, playerId("A"), playerId("D"));
  assert.equal(actual, 1, "survivor ring A,D,E,F uses shortest distance");
  assert.equal(calculateDistance(session.state, playerId("A"), playerId("D"))?.distance, 1);
});

scenario("AT-A09", {
  seats: {
    A: { characterId: "rose_doolan", inPlay: [{ typeId: "scope" }] },
    B: { characterId: "paul_regret", inPlay: [{ typeId: "mustang" }] },
  },
}, (session) => {
  const ab = calculateDistance(session.state, playerId("A"), playerId("B"));
  const ba = calculateDistance(session.state, playerId("B"), playerId("A"));
  assert.equal(ab?.baseDistance, 1);
  assert.equal(ab?.distance, 1, "distance is clamped after +2 and -2");
  assert.equal(ba?.distance, 1, "the reverse query applies its own target and source modifiers");
  assert.equal(ba?.targetPaulRegretBonus, 0);
  assert.equal(ba?.sourceScopeReduction, 0);
});

scenario("AT-A10", {
  seats: { A: { hand: [{ typeId: "panic" }, { typeId: "bang" }], inPlay: [{ typeId: "winchester" }] } },
}, (session) => {
  const panic = handCard(session, "A", "panic");
  const rejectedPanic = session.play("A", panic, "C", { targetZone: "HAND" });
  rejected(rejectedPanic, "TARGET_OUT_OF_RANGE");
  const bang = handCard(session, "A", "bang");
  accepted(session.play("A", bang, "C"), "Winchester-range BANG at distance two");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
});

scenario("AT-A11", { seats: { A: { hand: [{ typeId: "stagecoach" }] } }, drawTop: [{ typeId: "beer" }] }, (session) => {
  const stagecoach = handCard(session, "A", "stagecoach");
  const onlyTop = session.state.zones.drawPileCardInstanceIds[0]!;
  moveAllBut(session, [onlyTop]);
  const beforeHand = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.play("A", stagecoach), "Stagecoach draws from deck and its own reshuffle");
  const newCards = session.state.seats[0]!.private.handCardInstanceIds.filter((id) => !beforeHand.includes(id));
  assert.equal(newCards.length, 2);
  const reshuffle = session.events.find((event) => (event as { type?: string }).type === "DRAW_PILE_RESHUFFLED") as { payload?: { cardInstanceIds?: string[] } } | undefined;
  assert.ok(reshuffle?.payload?.cardInstanceIds?.includes(stagecoach), "used Stagecoach must enter the reshuffle supply");
  assert.equal(session.state.zones.discardPileCardInstanceIds.includes(stagecoach), false);
});

scenario("AT-A12", {
  seats: { A: { characterId: "pedro_ramirez" } },
  phase: "draw",
  discard: [{ typeId: "beer" }],
  drawTop: [{ typeId: "bang" }, { typeId: "missed" }],
}, (session) => {
  const discardTop = session.state.zones.discardPileCardInstanceIds.at(-1)!;
  const deckSecond = session.state.zones.drawPileCardInstanceIds[0]!;
  const opened = session.drawTurn();
  accepted(opened, "Pedro starts first draw choice");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "PEDRO_DISCARD_TOP");
  const option = session.state.resolution.pendingInteraction!.options.find((entry) => entry.choice === "SELECT_SOURCE" && entry.payload.source === "DISCARD_TOP");
  assert.ok(option);
  accepted(session.respondDraw("A", option.choice, option.payload), "Pedro chooses discard top");
  const added = session.state.seats[0]!.private.handCardInstanceIds;
  assert.ok(added.includes(discardTop));
  assert.ok(added.includes(deckSecond));
  assert.ok(!session.state.zones.discardPileCardInstanceIds.includes(discardTop));
});

scenario("AT-A13", { phase: "draw" }, (session) => {
  const drawIds = [...session.state.zones.drawPileCardInstanceIds];
  session.state.seats[1]!.private.handCardInstanceIds.push(...drawIds);
  session.state.zones.drawPileCardInstanceIds = [];
  session.state.zones.discardPileCardInstanceIds = [];
  const result = session.drawTurn();
  accepted(result, "exhausted draw pauses instead of synthesizing cards");
  assert.equal(session.state.status, "paused");
  assert.equal(session.state.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.ok(session.events.some((event) => (event as { type?: string }).type === "RULE_RESOURCE_EXHAUSTED"));
});

scenario("AT-A14", {
  currentPlayer: "B",
  phase: "start",
  seats: { B: { inPlay: [{ typeId: "jail" }] } },
  drawTop: [{ typeId: "beer", suit: "HEARTS" }],
}, (session) => {
  const actor = session.state.seats.find((seat) => seat.public.playerId === playerId("B"))!;
  const hpBefore = actor.public.hp;
  const handBefore = [...actor.private.handCardInstanceIds];
  accepted(session.startTurn(), "resolve Jail judgment using a Draw!");
  assert.equal(session.state.seats.find((seat) => seat.public.playerId === playerId("B"))!.public.hp, hpBefore);
  assert.deepEqual(session.state.seats.find((seat) => seat.public.playerId === playerId("B"))!.private.handCardInstanceIds, handBefore);
  const beer = session.state.zones.discardPileCardInstanceIds.at(-2);
  assert.ok(beer);
  assert.equal(cardTypeId(session.state, beer), "beer");
  assert.ok(!session.state.seats.some((seat) => seat.private.handCardInstanceIds.includes(beer)));
});

scenario("AT-A15", { seats: { A: { hand: [{ typeId: "stagecoach" }] } } }, (session) => {
  const before = structuredClone(session.state);
  const result = session.play("A", handCard(session, "A", "stagecoach"));
  accepted(result, "same-seed Stagecoach command");
  assert.notDeepEqual(session.state, before);
  assert.ok(session.events.length > 0);
  // runEngineAcceptanceScenario repeats this entire seeded setup and command,
  // comparing final snapshot, every stage, and the complete ordered event list.
});

// B and C cases continue below; each label remains a first-class Node test name.

scenario("AT-B01", {
  seats: { A: { hand: [{ typeId: "bang" }] }, B: { hand: [{ typeId: "missed" }] } },
}, (session) => {
  const bang = handCard(session, "A", "bang");
  const missed = handCard(session, "B", "missed");
  const beforeHp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", bang, "B"), "BANG opens a response");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: missed }), "defend with Missed");
  assert.equal(session.state.seats[1]!.public.hp, beforeHp);
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(bang));
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(missed));
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 1);
});

scenario("AT-B02", { seats: { A: { hand: [{ typeId: "bang" }, { typeId: "bang" }] } } }, (session) => {
  const first = handCard(session, "A", "bang");
  accepted(session.play("A", first, "B"), "first BANG is within quota");
  accepted(session.respond("B", "TAKE_HIT"), "resolve first target response");
  const second = session.state.seats[0]!.private.handCardInstanceIds.find((id) => cardTypeId(session.state, id) === "bang")!;
  const before = structuredClone(session.state);
  rejected(session.play("A", second, "B"), "BANG_LIMIT_REACHED");
  assert.deepEqual(session.state, before, "rejected second BANG does not change hand, HP, or quota");
});

scenario("AT-B03", {
  seats: {
    A: { hand: [{ typeId: "bang" }, { typeId: "bang" }, { typeId: "bang" }, { typeId: "schofield" }], inPlay: [{ typeId: "volcanic" }] },
    D: { characterId: "willy_the_kid" },
  },
}, (session) => {
  const initialBangs = session.state.seats[0]!.private.handCardInstanceIds.filter((id) => cardTypeId(session.state, id) === "bang");
  assert.equal(initialBangs.length, 3, "fixture retains three distinct physical BANG cards");
  for (const target of ["B", "D"] as const) {
    const bang = handCard(session, "A", "bang");
    accepted(session.play("A", bang, target), "Volcanic BANG");
    accepted(session.respond(target, "TAKE_HIT"), "resolve Volcanic response");
  }
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 2);
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(initialBangs[2]!), `the two legal Volcanic plays consume only two physical BANG cards; remaining hand=${JSON.stringify(session.state.seats[0]!.private.handCardInstanceIds)}; movements=${JSON.stringify(session.events.filter((event) => (event as { type?: string }).type === "CARD_DISCARDED" || (event as { type?: string }).type === "CARD_TRANSFERRED"))}`);
  const oldWeapon = inPlayCard(session, "A", "volcanic");
  accepted(session.play("A", handCard(session, "A", "schofield")), "replace Volcanic with another weapon");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(oldWeapon));
  const before = structuredClone(session.state);
  rejected(session.play("A", handCard(session, "A", "bang"), "B"), "BANG_LIMIT_REACHED");
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 2);
  assert.equal(session.state.zones.cardsByInstanceId[handCard(session, "A", "bang")]?.cardInstanceId, handCard(session, "A", "bang"));
  assert.equal(session.state.version, before.version);
});

scenario("AT-B04", { seats: { A: { hand: [{ typeId: "bang" }] } } }, (session) => {
  const bang = handCard(session, "A", "bang");
  for (const [target, code] of [["C", "TARGET_OUT_OF_RANGE"], ["A", "TARGET_IS_SELF"]] as const) {
    rejected(session.play("A", bang, target), code);
  }
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(bang));
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 0);
  session.state = buildEngineScenarioFixture({
    id: "AT-B04-dead-target",
    seats: { A: { hand: [{ typeId: "bang" }] }, B: { eliminated: true } },
  });
  const deadTargetBang = handCard(session, "A", "bang");
  rejected(session.play("A", deadTargetBang, "B"), "TARGET_NOT_ALIVE");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(deadTargetBang));
});

scenario("AT-B05", {
  seats: { A: { hand: [{ typeId: "bang" }] }, B: { inPlay: [{ typeId: "barrel" }] } },
  drawTop: [faceSpec("HEARTS", 2)],
}, (session) => {
  const bang = handCard(session, "A", "bang");
  const heart = session.state.zones.drawPileCardInstanceIds[0]!;
  const targetHp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", bang, "B"), "open Barrel reaction window");
  accepted(session.respond("B", "USE_BARREL"), "Barrel heart succeeds");
  assert.equal(session.state.seats[1]!.public.hp, targetHp);
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(heart));
  assert.equal(session.state.resolution.pendingInteraction, null);

  session.state = buildEngineScenarioFixture({
    id: "AT-B05-failure",
    seats: { A: { hand: [{ typeId: "bang" }] }, B: { inPlay: [{ typeId: "barrel" }] } },
    drawTop: [faceSpec("SPADES", 10)],
  });
  const failedBang = handCard(session, "A", "bang");
  const spade = session.state.zones.drawPileCardInstanceIds[0]!;
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", failedBang, "B"), "second Barrel scenario opens response");
  accepted(session.respond("B", "USE_BARREL"), "non-heart Barrel fails");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  accepted(session.respond("B", "TAKE_HIT"), "take damage after failed Barrel");
  assert.equal(session.state.seats[1]!.public.hp, hp - 1);
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(spade));
});

scenario("AT-B06", {
  seats: {
    A: { characterId: "slab_the_killer", hand: [{ typeId: "bang" }] },
    B: { inPlay: [{ typeId: "barrel" }], hand: [{ typeId: "missed" }] },
  },
  drawTop: [faceSpec("HEARTS", 2)],
}, (session) => {
  const targetHp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Slab BANG creates enhanced defense");
  accepted(session.respond("B", "USE_BARREL"), "Barrel heart contributes one successful defense");
  const remainingMissed = handCard(session, "B", "missed");
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: remainingMissed }), "one Missed completes Slab defense with Barrel");
  assert.equal(session.state.seats[1]!.public.hp, targetHp);
  assert.equal(session.state.resolution.pendingInteraction, null);

  session.state = buildEngineScenarioFixture({
    id: "AT-B06-barrel-only",
    seats: { A: { characterId: "slab_the_killer", hand: [{ typeId: "bang" }] }, B: { inPlay: [{ typeId: "barrel" }] } },
    drawTop: [faceSpec("HEARTS", 3)],
  });
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Barrel-only defense is started");
  accepted(session.respond("B", "USE_BARREL"), "Barrel itself satisfies only one Slab defense unit");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  accepted(session.respond("B", "TAKE_HIT"), "one successful Barrel alone leaves Slab attack active");
  assert.equal(session.state.seats[1]!.public.hp, hp - 1);
});

scenario("AT-B07", {
  seats: { A: { characterId: "slab_the_killer", hand: [{ typeId: "bang" }] }, B: { hand: [{ typeId: "missed" }] } },
}, (session) => {
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Slab physical BANG starts");
  const missed = handCard(session, "B", "missed");
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: missed }), "one Missed is consumed but not enough");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(missed));
  assert.equal(session.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  accepted(session.respond("B", "TAKE_HIT"), "decline second Missed and take damage");
  assert.equal(session.state.seats[1]!.public.hp, hp - 1);
});

scenario("AT-B08", {
  seats: {
    A: { hand: [{ typeId: "gatling" }, { typeId: "bang" }] },
    B: { characterId: "black_jack" },
    C: { characterId: "jesse_jones" },
    D: { characterId: "willy_the_kid" },
  },
}, (session) => {
  const unusedBang = handCard(session, "A", "bang");
  accepted(session.play("A", handCard(session, "A", "gatling")), "Gatling resolves before BANG quota use");
  resolveHitResponses(session);
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 0);
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(unusedBang), `Gatling leaves the unrelated BANG in hand; actor hand=${JSON.stringify(session.state.seats[0]!.private.handCardInstanceIds)}; movements=${JSON.stringify(session.events.filter((event) => (event as { type?: string }).type === "CARD_DISCARDED" || (event as { type?: string }).type === "CARD_TRANSFERRED"))}`);
  accepted(session.play("A", unusedBang, "B"), "normal BANG remains available after Gatling");
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 1);
});

scenario("AT-B09", {
  seats: {
    A: { characterId: "slab_the_killer", hand: [{ typeId: "gatling" }] },
    B: { hand: [{ typeId: "missed" }] },
  },
}, (session) => {
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "gatling")), "Slab Gatling uses ordinary attack defense");
  const missed = handCard(session, "B", "missed");
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: missed }), "Gatling needs only one Missed for Slab");
  assert.equal(session.state.seats[1]!.public.hp, hp);
  resolveHitResponses(session);
});

scenario("AT-B10", {
  seats: {
    A: { hand: [{ typeId: "indians" }] },
    B: { hand: [{ typeId: "bang" }] },
  },
}, (session) => {
  const hpB = session.state.seats[1]!.public.hp;
  const hpC = session.state.seats[2]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "indians")), "Indians creates sequential per-player responses");
  const bang = handCard(session, "B", "bang");
  accepted(session.respond("B", "USE_BANG", { cardInstanceId: bang }), "submit BANG to Indians");
  assert.equal(session.state.seats[1]!.public.hp, hpB);
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(bang));
  accepted(session.respondCurrent("TAKE_HIT"), "decline next Indians payment");
  assert.equal(session.state.seats[2]!.public.hp, hpC - 1);
  accepted(session.respondCurrent("TAKE_HIT"), "decline final Indians payment");
});

scenario("AT-B11", {
  seats: { A: { hand: [{ typeId: "duel" }, { typeId: "bang" }] }, B: { hand: [{ typeId: "bang" }] } },
}, (session) => {
  const quota = session.state.turn.bangCardPlaysThisTurn;
  accepted(session.play("A", handCard(session, "A", "duel"), "B"), "Duel begins independent of range and BANG quota");
  accepted(session.respond("B", "PLAY_BANG", { cardInstanceId: handCard(session, "B", "bang") }), "target answers first");
  accepted(session.respond("A", "YIELD"), "initiator yields and takes one damage");
  assert.equal(session.state.seats[0]!.public.hp, 4);
  assert.equal(session.state.turn.bangCardPlaysThisTurn, quota);
  assert.equal(session.state.resolution.pendingInteraction, null);
});

scenario("AT-B12", {
  seats: {
    A: { hand: [{ typeId: "indians" }, { typeId: "duel" }, { typeId: "bang" }] },
    B: { characterId: "calamity_janet", hand: [{ typeId: "missed" }] },
  },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "indians")), "Indians permits Calamity conversion response");
  const missed = handCard(session, "B", "missed");
  accepted(session.respond("B", "USE_BANG", { cardInstanceId: missed }), "Calamity uses Missed as Indians BANG");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(missed));
  accepted(session.respondCurrent("TAKE_HIT"), "finish later Indians target");
  accepted(session.respondCurrent("TAKE_HIT"), "finish final Indians target");

  session.state = buildEngineScenarioFixture({
    id: "AT-B12-duel",
    seats: { A: { hand: [{ typeId: "duel" }, { typeId: "bang" }] }, B: { characterId: "calamity_janet", hand: [{ typeId: "missed" }] } },
  });
  accepted(session.play("A", handCard(session, "A", "duel"), "B"), "Duel permits Calamity conversion response");
  accepted(session.respond("B", "PLAY_BANG", { cardInstanceId: handCard(session, "B", "missed") }), "Calamity uses Missed as Duel BANG");
  accepted(session.respond("A", "YIELD"), "resolve Duel after transformed response");
});

scenario("AT-B13", {
  seats: { A: { characterId: "calamity_janet", hand: [{ typeId: "missed" }] }, B: { hand: [{ typeId: "missed" }] } },
}, (session) => {
  const converted = handCard(session, "A", "missed");
  accepted(session.play("A", converted, "B", { asCardType: "bang" }), "Calamity Missed is used as BANG");
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 1);
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: handCard(session, "B", "missed") }), "target may use normal Missed");
});

scenario("AT-B14", {
  seats: { A: { hand: [{ typeId: "beer" }] } },
}, (session) => {
  const hp = session.state.seats[0]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "beer")), "Beer may be used at max health");
  assert.equal(session.state.seats[0]!.public.hp, hp);
  assert.equal(session.state.zones.discardPileCardInstanceIds.some((id) => cardTypeId(session.state, id) === "beer"), true);

  session.state = buildEngineScenarioFixture({
    id: "AT-B14-two-seats",
    seats: {
      A: { hand: [{ typeId: "beer" }] },
      C: { eliminated: true },
      D: { eliminated: true },
    },
  });
  const twoAliveHp = session.state.seats[0]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "beer")), "Beer may be used with two players alive");
  assert.equal(session.state.seats[0]!.public.hp, twoAliveHp);
});

scenario("AT-B15", {
  seats: { A: { hand: [{ typeId: "beer" }], hp: 2, maxHp: 4 } },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "beer")), "Beer heals only its user");
  assert.equal(session.state.seats[0]!.public.hp, 3);
  assert.equal(session.state.seats[1]!.public.hp, 4);
});

scenario("AT-B16", {
  seats: {
    A: { hand: [{ typeId: "saloon" }], hp: 2, maxHp: 5 },
    B: { hp: 3, maxHp: 4 },
    C: { eliminated: true, hp: 0, maxHp: 4 },
    D: { eliminated: true, hp: 0, maxHp: 4 },
  },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "saloon")), "two-player Saloon resolves globally");
  assert.equal(session.state.seats[0]!.public.hp, 3);
  assert.equal(session.state.seats[1]!.public.hp, 4);
  assert.equal(session.state.seats[2]!.public.hp, 0);
  assert.equal(session.state.seats[3]!.public.hp, 0);
});

scenario("AT-B17", {
  seats: {
    A: { hand: [{ typeId: "duel" }] },
    B: { hand: [{ typeId: "saloon" }] },
    C: { hp: 1, maxHp: 4 },
  },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "duel"), "C"), "Duel damage enters rescue at zero HP");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  const saloon = handCard(session, "B", "saloon");
  const before = structuredClone(session.state);
  rejected(session.play("B", saloon));
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(saloon), "Saloon is not consumed by the pending lethal Duel");
  assert.deepEqual(session.state, before);
});

scenario("AT-B18", {
  playerCount: 5,
  seats: { A: { hand: [{ typeId: "general_store" }] } },
  drawTop: ["bang", "beer", "missed", "mustang", "stagecoach"].map((typeId) => ({ typeId })),
}, (session) => {
  const order = ["A", "B", "C", "D", "E"] as const;
  const originalHands = new Map(order.map((key) => [key, [...session.state.seats.find((seat) => seat.public.playerId === playerId(key))!.private.handCardInstanceIds]]));
  accepted(session.play("A", handCard(session, "A", "general_store")), "reveal one card per living player");
  assert.equal(session.state.zones.revealedPoolCardInstanceIds.length, 5);
  assert.equal(session.state.resolution.pendingInteraction?.actorPlayerIds[0], playerId("A"), "store owner chooses first");
  for (const key of order) {
    const pending = session.state.resolution.pendingInteraction;
    assert.ok(pending);
    assert.equal(pending.actorPlayerIds[0], playerId(key));
    const selectedCardInstanceId = pending.options[0]!.payload.selectedCardInstanceId as string;
    accepted(session.respond(key, "CHOOSE_CARD", { selectedCardInstanceId }), `General Store choice by ${key}`);
  }
  assert.equal(session.state.zones.revealedPoolCardInstanceIds.length, 0);
  for (const key of order) {
    const seat = session.state.seats.find((candidate) => candidate.public.playerId === playerId(key))!;
    assert.equal(seat.private.handCardInstanceIds.length, originalHands.get(key)!.length + 1 - Number(key === "A"), "the Store consumes its source card before A receives one selection");
  }
});

scenario("AT-B19", {
  seats: { A: { hand: [{ typeId: "panic" }] }, B: { hand: [{ typeId: "bang" }, { typeId: "missed" }] } },
}, (session) => {
  const targetHand = [...session.state.seats[1]!.private.handCardInstanceIds];
  accepted(session.play("A", handCard(session, "A", "panic"), "B", { targetZone: "HAND" }), "Panic chooses an opponent hand card server-side");
  const sourceRemaining = session.state.seats[1]!.private.handCardInstanceIds;
  const stolen = targetHand.find((id) => !sourceRemaining.includes(id));
  assert.equal(sourceRemaining.length, targetHand.length - 1);
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 1);
  assert.ok(stolen, "exactly one card leaves the target hand");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(stolen), "the privately selected card enters the actor hand");
});

scenario("AT-B20", {
  seats: { A: { hand: [{ typeId: "cat_balou" }] }, B: { inPlay: [{ typeId: "mustang" }] } },
}, (session) => {
  const mustang = inPlayCard(session, "B", "mustang");
  accepted(session.play("A", handCard(session, "A", "cat_balou"), "B", { targetZone: "IN_PLAY", targetCardInstanceId: mustang }), "Cat selects an actual public equipment instance");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(mustang));
  assert.equal(session.state.seats[1]!.public.inPlayCardInstanceIds.includes(mustang), false);
});

scenario("AT-B21", {
  seats: {
    A: { hand: [{ typeId: "panic" }, { typeId: "panic" }, { typeId: "cat_balou" }], inPlay: [{ typeId: "mustang" }] },
  },
}, (session) => {
  const mustang = inPlayCard(session, "A", "mustang");
  accepted(session.play("A", handCard(session, "A", "panic"), "A", { targetZone: "IN_PLAY", targetCardInstanceId: mustang }), "D03 allows self-targeting a public equipment card");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(mustang));
  accepted(session.play("A", mustang), "reinstall recovered Mustang");
  accepted(session.play("A", handCard(session, "A", "cat_balou"), "A", { targetZone: "IN_PLAY", targetCardInstanceId: mustang }), "self Cat discards public equipment");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(mustang));
  rejected(session.play("A", handCard(session, "A", "panic"), "A", { targetZone: "HAND" }), "TARGET_IS_SELF");
});

scenario("AT-B22", {
  seats: { A: { hand: [{ typeId: "stagecoach" }, { typeId: "wells_fargo" }] } },
  drawTop: ["bang", "beer", "missed", "panic", "saloon"].map((typeId) => ({ typeId })),
}, (session) => {
  const initial = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.play("A", handCard(session, "A", "stagecoach")), "Stagecoach draws two");
  const afterStagecoach = [...session.state.seats[0]!.private.handCardInstanceIds];
  assert.equal(afterStagecoach.filter((id) => !initial.includes(id)).length, 2);
  const wells = handCard(session, "A", "wells_fargo");
  accepted(session.play("A", wells), "Wells Fargo draws three");
  const newCards = session.state.seats[0]!.private.handCardInstanceIds.filter((id) => !afterStagecoach.includes(id));
  assert.equal(newCards.length, 3);
  const view = projectMatchSnapshot(session.state, playerId("B"), BASE_PHYSICAL_CARDS);
  for (const id of newCards) assert.ok(!JSON.stringify(view).includes(id), "another seat sees no drawn card face");
});

scenario("AT-B23", {
  seats: {
    A: { hand: [{ typeId: "volcanic" }, { typeId: "schofield" }], inPlay: [{ typeId: "volcanic" }] },
  },
}, (session) => {
  const duplicate = handCard(session, "A", "volcanic");
  const before = structuredClone(session.state);
  rejected(session.play("A", duplicate), "DUPLICATE_EQUIPMENT");
  assert.deepEqual(session.state, before);
  const oldWeapon = inPlayCard(session, "A", "volcanic");
  accepted(session.play("A", handCard(session, "A", "schofield")), "different weapon may replace installed weapon");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(oldWeapon));
  assert.ok(session.state.seats[0]!.public.inPlayCardInstanceIds.includes(handCard(session, "A", "volcanic")) === false);
});

scenario("AT-B24", {
  playerCount: 5,
  currentPlayer: "B",
  seats: { B: { hand: [{ typeId: "jail" }] } },
}, (session) => {
  const jail = handCard(session, "B", "jail");
  rejected(session.play("B", jail, "A"), "SHERIFF_CANNOT_BE_JAILED");
  rejected(session.play("B", jail, "B"), "TARGET_IS_SELF");
  accepted(session.play("B", jail, "E"), "Jail can target a distant non-Sheriff");
  assert.ok(session.state.seats[4]!.public.inPlayCardInstanceIds.includes(jail));
});

scenario("AT-B25", {
  currentPlayer: "B",
  phase: "start",
  seats: { B: { inPlay: [{ typeId: "jail" }] } },
  drawTop: [faceSpec("HEARTS", 2)],
}, (session) => {
  const jail = inPlayCard(session, "B", "jail");
  accepted(session.startTurn(), "Heart Jail judgment enters draw phase");
  assert.equal(session.state.turn.phase, "draw");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(jail));
  assert.equal(session.events.some((event) => (event as { type?: string }).type === "JAIL_JUDGMENT_RESOLVED" && (event as { payload?: { turnSkipped?: boolean } }).payload?.turnSkipped === true), false);

  session.state = buildEngineScenarioFixture({
    id: "AT-B25-fail",
    currentPlayer: "B",
    phase: "start",
    seats: { B: { inPlay: [{ typeId: "jail" }] } },
    drawTop: [faceSpec("SPADES", 10)],
  });
  const failedJail = inPlayCard(session, "B", "jail");
  accepted(session.startTurn(), "non-Heart Jail judgment skips the full turn");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(failedJail));
  assert.equal(session.state.turn.currentPlayerId, playerId("C"));
  assert.equal(session.state.turn.phase, "start");
});

scenario("AT-B26", {
  seats: {
    A: { hand: [{ typeId: "bang" }], inPlay: [{ typeId: "winchester" }] },
    B: { inPlay: [{ typeId: "jail" }, { typeId: "barrel" }, { typeId: "mustang" }] },
  },
  drawTop: [faceSpec("HEARTS", 3)],
}, (session) => {
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Jail does not block an incoming attack");
  accepted(session.respond("B", "USE_BARREL"), "Barrel remains available while jailed");
  assert.equal(session.state.seats[1]!.public.hp, hp);
  assert.equal(session.state.resolution.pendingInteraction, null);
});

scenario("AT-B27", { currentPlayer: "A", phase: "start" }, (session) => {
  for (const [rank, explodes] of [[2, true], [9, true], [10, false], ["A", false]] as const) {
    session.state = buildEngineScenarioFixture({
      id: `AT-B27-${rank}`,
      phase: "start",
      seats: { A: { inPlay: [{ typeId: "dynamite" }] }, B: {}, C: {}, D: {} },
      drawTop: [faceSpec("SPADES", rank)],
    });
    const dynamite = inPlayCard(session, "A", "dynamite");
    const hp = session.state.seats[0]!.public.hp;
    accepted(session.startTurn(), `Dynamite Spade ${rank}`);
    if (explodes) {
      assert.equal(session.state.seats[0]!.public.hp, hp - 3);
      assert.ok(session.state.zones.discardPileCardInstanceIds.includes(dynamite));
      assert.ok(!session.state.seats[1]!.public.inPlayCardInstanceIds.includes(dynamite));
    } else {
      assert.equal(session.state.seats[0]!.public.hp, hp);
      assert.ok(session.state.seats[1]!.public.inPlayCardInstanceIds.includes(dynamite));
    }
  }
});

scenario("AT-B28", {
  currentPlayer: "B",
  phase: "start",
  seats: { B: { hp: 4, maxHp: 4, inPlay: [{ typeId: "dynamite" }, { typeId: "jail" }] } },
  drawTop: [faceSpec("SPADES", 2), faceSpec("HEARTS", 4)],
}, (session) => {
  accepted(session.startTurn(), "Dynamite resolves before installed Jail");
  const dynamiteIndex = session.events.findIndex((event) => (event as { type?: string }).type === "DYNAMITE_EXPLODED");
  const jailIndex = session.events.findIndex((event) => (event as { type?: string }).type === "JAIL_JUDGMENT_REVEALED");
  assert.ok(dynamiteIndex >= 0);
  assert.ok(jailIndex > dynamiteIndex);
  assert.equal(session.state.seats[1]!.public.hp, 1);

  session.state = buildEngineScenarioFixture({
    id: "AT-B28-lethal",
    currentPlayer: "B",
    phase: "start",
    seats: { B: { hp: 1, maxHp: 4, inPlay: [{ typeId: "dynamite" }, { typeId: "jail" }] } },
    drawTop: [faceSpec("SPADES", 2), faceSpec("HEARTS", 4)],
  });
  const eventsBeforeLethal = session.events.length;
  accepted(session.startTurn(), "lethal Dynamite pauses at rescue before Jail");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(session.events.slice(eventsBeforeLethal).some((event) => (event as { type?: string }).type === "JAIL_JUDGMENT_REVEALED"), false);
});

scenario("AT-B29", {
  phase: "start",
  seats: { A: { inPlay: [{ typeId: "dynamite" }] }, B: { eliminated: true } },
  drawTop: [faceSpec("SPADES", 10)],
}, (session) => {
  const dynamite = inPlayCard(session, "A", "dynamite");
  accepted(session.startTurn(), "non-exploding Dynamite skips eliminated next seat");
  assert.ok(session.state.seats[2]!.public.inPlayCardInstanceIds.includes(dynamite));
  assert.equal(session.state.seats.reduce((count, seat) => count + Number(seat.public.inPlayCardInstanceIds.includes(dynamite)), 0), 1);
  assert.equal(Object.keys(session.state.zones.cardsByInstanceId).length, 80);
});

scenario("AT-B30", {
  seats: { A: { hand: [{ typeId: "cat_balou" }] } },
}, (session) => {
  const cat = handCard(session, "A", "cat_balou");
  const before = structuredClone(session.state);
  rejected(session.play("A", cat, "B", { targetZone: "IN_PLAY", targetCardInstanceId: "virtual-colt-45" }), "TARGET_CARD_NOT_IN_PLAY");
  assert.deepEqual(session.state, before, "virtual Colt .45 has no card instance to steal or discard");
});

scenario("AT-C01", {
  phase: "start",
  seats: { A: { characterId: "bart_cassidy", hp: 4, maxHp: 4, inPlay: [{ typeId: "dynamite" }] } },
  drawTop: [faceSpec("SPADES", 2), { typeId: "bang" }, { typeId: "beer" }, { typeId: "missed" }],
}, (session) => {
  const original = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.startTurn(), "Bart survives Dynamite and draws for three lost HP");
  assert.equal(session.state.seats[0]!.public.hp, 1);
  const gained = session.state.seats[0]!.private.handCardInstanceIds.filter((id) => !original.includes(id));
  assert.equal(gained.length, 3);
  assert.equal(session.events.filter((event) => (event as { type?: string }).type === "CARD_DRAWN").length, 3);
});

scenario("AT-C02", {
  seats: {
    A: { roleId: "renegade", hand: [{ typeId: "bang" }] },
    B: { roleId: "sheriff", characterId: "bart_cassidy", hp: 1, maxHp: 5 },
    C: { roleId: "outlaw" },
    D: { roleId: "outlaw" },
  },
  drawTop: [{ typeId: "beer" }],
}, (session) => {
  const beer = session.state.zones.drawPileCardInstanceIds[0]!;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Bart cannot draw before lethal damage is rescued");
  accepted(session.respond("B", "TAKE_HIT"), "Bart opens rescue without a Beer");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.ok(session.state.zones.drawPileCardInstanceIds.includes(beer), "top Beer is not fetched by Bart before rescue");
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 0);
  accepted(session.respond("B", "ACCEPT_ELIMINATION"), "Bart accepts elimination");
  assert.equal(session.state.seats[1]!.public.eliminated, true);
  assert.ok(session.state.zones.drawPileCardInstanceIds.includes(beer));
});

scenario("AT-C03", {
  seats: {
    A: { roleId: "renegade", hand: [{ typeId: "bang" }] },
    B: { roleId: "sheriff", characterId: "bart_cassidy", hp: 1, maxHp: 5, hand: [{ typeId: "beer" }] },
    C: { roleId: "outlaw" },
    D: { roleId: "outlaw" },
  },
  drawTop: [{ typeId: "missed" }],
}, (session) => {
  const beer = handCard(session, "B", "beer");
  const top = session.state.zones.drawPileCardInstanceIds[0]!;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Bart's existing Beer opens a rescue option");
  accepted(session.respond("B", "TAKE_HIT"), "open Bart rescue");
  accepted(session.respond("B", "USE_BEER", { cardInstanceId: beer }), "Beer saves Bart at one HP");
  assert.equal(session.state.seats[1]!.public.hp, 1);
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(top), "Bart draws after rescue survives");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(beer));
});

scenario("AT-C04", { phase: "draw", seats: { A: { characterId: "black_jack" } }, drawTop: [{ typeId: "bang" }, faceSpec("DIAMONDS", 3), { typeId: "beer" }] }, (session) => {
  const initialHand = [...session.state.seats[0]!.private.handCardInstanceIds];
  const extra = session.state.zones.drawPileCardInstanceIds[2]!;
  accepted(session.drawTurn(), "Black Jack reveals only the second ordinary draw");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, initialHand.length + 3);
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(extra));
  const revealEvents = session.events.filter((event) => (event as { type?: string; payload?: { reason?: string; visibility?: string } }).type === "CARD_DRAWN" &&
    (event as { payload?: { reason?: string; visibility?: string } }).payload?.reason === "BLACK_JACK_SECOND_DRAW" &&
    (event as { payload?: { reason?: string; visibility?: string } }).payload?.visibility === "public");
  assert.equal(revealEvents.length, 1, "the second card alone is publicly revealed");

  session.state = buildEngineScenarioFixture({
    id: "AT-C04-black",
    phase: "draw",
    seats: { A: { characterId: "black_jack" } },
    drawTop: [{ typeId: "bang" }, faceSpec("SPADES", 3), { typeId: "beer" }],
  });
  const blackInitial = session.state.seats[0]!.private.handCardInstanceIds.length;
  accepted(session.drawTurn(), "Black Jack gets no bonus on a black second card");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, blackInitial + 2);
});

scenario("AT-C05", {
  currentPlayer: "B",
  seats: {
    A: { hand: [{ typeId: "bang" }, { typeId: "beer" }] },
    B: { characterId: "el_gringo", roleId: "outlaw", hand: [{ typeId: "duel" }, { typeId: "bang" }] },
  },
}, (session) => {
  const actorHandBefore = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.play("B", handCard(session, "B", "duel"), "A"), "El Gringo initiates his Duel");
  accepted(session.respond("A", "PLAY_BANG", { cardInstanceId: handCard(session, "A", "bang") }), "other player answers first");
  accepted(session.respond("B", "YIELD"), "El Gringo loses the Duel he initiated");
  assert.equal(session.state.seats[1]!.public.hp, 2, "El Gringo loses one HP from the Duel he initiated");
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1, "El Gringo keeps the Bang he could have played instead of yielding");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(actorHandBefore.find((id) => cardTypeId(session.state, id) === "beer")!));
});

scenario("AT-C06", {
  seats: { A: { hand: [{ typeId: "bang" }] }, B: { characterId: "el_gringo", hand: [] } },
}, (session) => {
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "other source hits El Gringo");
  accepted(session.respond("B", "TAKE_HIT"), "El Gringo survives with no opponent hand to take");
  assert.equal(session.state.seats[1]!.public.hp, hp - 1);
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 0);
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 0);
});

scenario("AT-C07", {
  phase: "draw",
  seats: { A: { characterId: "jesse_jones" }, B: { hand: [{ typeId: "bang" }, { typeId: "beer" }] } },
  drawTop: [{ typeId: "missed" }, { typeId: "saloon" }],
}, (session) => {
  const opponentCards = [...session.state.seats[1]!.private.handCardInstanceIds];
  const normalSecond = session.state.zones.drawPileCardInstanceIds[0]!;
  accepted(session.drawTurn(), "Jesse gets a private source choice for first card");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "JESSE_DRAW_SOURCE");
  const option = session.state.resolution.pendingInteraction!.options.find((entry) => entry.choice === "TAKE_FROM_HAND" && entry.payload.sourcePlayerId === playerId("B"));
  assert.ok(option);
  accepted(session.respondDraw("A", option.choice, option.payload), "Jesse takes one random card from B");
  const actorHand = session.state.seats[0]!.private.handCardInstanceIds;
  assert.equal(actorHand.length, 2);
  assert.ok(opponentCards.some((id) => actorHand.includes(id)));
  assert.ok(actorHand.includes(normalSecond), "Jesse's second card comes from the deck");
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1);
});

scenario("AT-C08", {
  seats: {
    A: { characterId: "slab_the_killer", hand: [{ typeId: "bang" }] },
    B: { characterId: "jourdonnais", inPlay: [{ typeId: "barrel" }] },
  },
  drawTop: [faceSpec("HEARTS", 3), faceSpec("HEARTS", 4)],
}, (session) => {
  const hp = session.state.seats[1]!.public.hp;
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Slab BANG permits two separate judgment sources");
  accepted(session.respond("B", "USE_BARREL"), "real Barrel is judged first");
  const pending = session.state.resolution.pendingInteraction;
  assert.ok(pending);
  assert.ok(!pending.options.some((option) => option.choice === "USE_BARREL"), "the same Barrel source cannot be reused for one attack");
  accepted(session.respond("B", "USE_JOURDONNAIS"), "Jourdonnais virtual Barrel gets its own Heart judgment");
  assert.equal(session.state.seats[1]!.public.hp, hp);
  assert.equal(session.state.resolution.pendingInteraction, null);
});

scenario("AT-C09", {
  phase: "draw",
  seats: { A: { characterId: "kit_carlson" } },
  drawTop: [{ typeId: "bang" }, { typeId: "beer" }, { typeId: "missed" }],
}, (session) => {
  const [first, second, third] = session.state.zones.drawPileCardInstanceIds;
  accepted(session.drawTurn(), "Kit privately sees and chooses two of the top three");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "KIT_CARLSON_PICK");
  const options = session.state.resolution.pendingInteraction!.options;
  const selected = options.find((option) => Array.isArray(option.payload.selectedCardInstanceIds) &&
    option.payload.selectedCardInstanceIds.includes(first!) && option.payload.selectedCardInstanceIds.includes(third!));
  assert.ok(selected);
  accepted(session.respondDraw("A", selected.choice, selected.payload), "Kit takes first and third");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(first!));
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(third!));
  assert.equal(session.state.zones.drawPileCardInstanceIds[0], second);
  assert.equal(session.state.zones.revealedPoolCardInstanceIds.length, 0);
});

scenario("AT-C10", {
  currentPlayer: "B",
  phase: "start",
  seats: { B: { characterId: "lucky_duke", inPlay: [{ typeId: "jail" }] } },
  drawTop: [faceSpec("HEARTS", 2), faceSpec("SPADES", 3)],
}, (session) => {
  const heart = session.state.zones.drawPileCardInstanceIds[0]!;
  const spade = session.state.zones.drawPileCardInstanceIds[1]!;
  const jail = inPlayCard(session, "B", "jail");
  accepted(session.startTurn(), "Lucky sees two candidates for the Jail judgment");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "LUCKY_DRAW");
  const option = session.state.resolution.pendingInteraction!.options.find((entry) => entry.choice === "SELECT_JUDGMENT" && entry.payload.selectedCardInstanceId === heart);
  assert.ok(option);
  accepted(session.respond("B", option.choice, option.payload), "Lucky chooses the Heart candidate");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(heart));
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(spade));
  assert.equal(session.state.zones.discardPileCardInstanceIds.at(-1), jail, "Jail is placed on top after both Lucky candidates");
  accepted(session.startTurn(), "resume turn-start after the Lucky choice");
  assert.equal(session.state.turn.phase, "draw");
});

scenario("AT-C11", {
  seats: {
    A: { characterId: "rose_doolan", inPlay: [{ typeId: "scope" }] },
    B: { characterId: "paul_regret", inPlay: [{ typeId: "mustang" }] },
  },
}, (session) => {
  const fromA = calculateDistance(session.state, playerId("A"), playerId("B"));
  const fromB = calculateDistance(session.state, playerId("B"), playerId("A"));
  assert.equal(fromA?.targetMustangBonus, 1);
  assert.equal(fromA?.targetPaulRegretBonus, 1);
  assert.equal(fromA?.sourceScopeReduction, 1);
  assert.equal(fromA?.sourceRoseDoolanReduction, 1);
  assert.equal(fromA?.distance, 1);
  assert.equal(fromB?.distance, 1, "opposite direction uses its own source/target modifiers");
});

scenario("AT-C12", {
  phase: "draw",
  seats: { A: { characterId: "pedro_ramirez" } },
  discard: [{ typeId: "stagecoach" }, { typeId: "beer" }],
  drawTop: [{ typeId: "bang" }, { typeId: "missed" }],
}, (session) => {
  const oldDiscard = session.state.zones.discardPileCardInstanceIds[0]!;
  const discardTop = session.state.zones.discardPileCardInstanceIds.at(-1)!;
  const deckSecond = session.state.zones.drawPileCardInstanceIds[0]!;
  const otherView = projectMatchSnapshot(session.state, playerId("B"), BASE_PHYSICAL_CARDS);
  assert.equal(JSON.stringify(otherView).includes(oldDiscard), false, "other players cannot inspect the full discard pile");
  assert.equal(otherView.publicTable.publicDiscard.topCard?.cardInstanceId, discardTop);
  accepted(session.drawTurn(), "Pedro may take discard top before drawing from deck");
  const option = session.state.resolution.pendingInteraction!.options.find((entry) => entry.choice === "SELECT_SOURCE" && entry.payload.source === "DISCARD_TOP");
  assert.ok(option);
  accepted(session.respondDraw("A", option.choice, option.payload), "Pedro selects the top discard only");
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(discardTop));
  assert.ok(session.state.seats[0]!.private.handCardInstanceIds.includes(deckSecond));
  assert.ok(!session.state.zones.discardPileCardInstanceIds.includes(discardTop));
});

scenario("AT-C13", {
  seats: { A: { characterId: "sid_ketchum", hp: 2, maxHp: 4, hand: ["bang", "beer", "missed", "panic"].map((typeId) => ({ typeId })) } },
}, (session) => {
  const costs = session.state.seats[0]!.private.handCardInstanceIds.slice(0, 2);
  accepted(session.submit("A", command("USE_ABILITY", { abilityId: "sid-ketchum", cardInstanceIds: costs })), "Sid discards exactly two cards for one HP");
  assert.equal(session.state.seats[0]!.public.hp, 3);
  assert.ok(costs.every((id) => session.state.zones.discardPileCardInstanceIds.includes(id)));
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 2);
});

scenario("AT-C14", {
  seats: { A: { characterId: "sid_ketchum", hand: [{ typeId: "bang" }, { typeId: "beer" }, { typeId: "missed" }] } },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Sid begins another card effect");
  const twoCards = session.state.seats[0]!.private.handCardInstanceIds.slice(0, 2);
  const before = structuredClone(session.state);
  rejected(session.submit("A", command("USE_ABILITY", { abilityId: "sid-ketchum", cardInstanceIds: twoCards })));
  assert.deepEqual(session.state, before, "Sid cannot interrupt a nonlethal BANG resolution");
  accepted(session.respond("B", "TAKE_HIT"), "finish the existing card before another ability");
});

scenario("AT-C15", {
  seats: {
    A: { roleId: "sheriff", hand: [{ typeId: "bang" }] },
    B: { roleId: "outlaw", characterId: "sid_ketchum", hp: 1, maxHp: 4, hand: [{ typeId: "beer" }, { typeId: "missed" }] },
    C: { roleId: "outlaw", eliminated: true },
    D: { roleId: "renegade", eliminated: true },
  },
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Sid faces lethal BANG with exactly two living seats");
  accepted(session.respond("B", "TAKE_HIT"), "open Sid death rescue");
  const cost = [...session.state.seats[1]!.private.handCardInstanceIds];
  accepted(session.respond("B", "USE_SID", { cardInstanceIds: cost }), "Sid ability rescues at two-player count");
  assert.equal(session.state.seats[1]!.public.hp, 1);
  assert.equal(session.state.seats[1]!.public.eliminated, false);
  assert.ok(cost.every((id) => session.state.zones.discardPileCardInstanceIds.includes(id)));
});

scenario("AT-C16", {
  seats: { A: { characterId: "suzy_lafayette", hand: [{ typeId: "general_store" }] } },
  drawTop: ["bang", "beer", "missed", "panic"].map((typeId) => ({ typeId })),
}, (session) => {
  const store = handCard(session, "A", "general_store");
  accepted(session.play("A", store), "Suzy's last General Store yields one selected card");
  for (const player of ["A", "B", "C", "D"] as const) {
    const pending = session.state.resolution.pendingInteraction;
    assert.ok(pending);
    const chosen = pending.options[0]!.payload.selectedCardInstanceId as string;
    accepted(session.respond(player, "CHOOSE_CARD", { selectedCardInstanceId: chosen }), `store selection ${player}`);
  }
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 1, "the store card prevents an extra Suzy draw");

  for (const [typeId, expected] of [["stagecoach", 2], ["wells_fargo", 3]] as const) {
    session.state = buildEngineScenarioFixture({
      id: `AT-C16-${typeId}`,
      seats: { A: { characterId: "suzy_lafayette", hand: [{ typeId }] } },
      drawTop: ["bang", "beer", "missed", "panic"].map((item) => ({ typeId: item })),
    });
    accepted(session.play("A", handCard(session, "A", typeId)), `Suzy's last ${typeId} resolves`);
    assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, expected, `${typeId} cards prevent an extra Suzy draw`);
  }
});

scenario("AT-C17", {
  currentPlayer: "A",
  seats: {
    A: { characterId: "suzy_lafayette", hand: [{ typeId: "duel" }] },
    B: { hand: [{ typeId: "bang" }] },
  },
  drawTop: [{ typeId: "beer" }],
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "duel"), "B"), "Suzy's last Duel waits for all responses");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 0);
  accepted(session.respond("B", "PLAY_BANG", { cardInstanceId: handCard(session, "B", "bang") }), "target responds before Suzy");
  assert.equal(session.state.resolution.pendingInteraction, null, "an initiator without a Bang ends the Duel after the target response");
  assert.ok(session.events.findIndex((event) => (event as { type?: string }).type === "DUEL_BANG_PLAYED") <
    session.events.findIndex((event) => (event as { type?: string; payload?: { playerId?: string } }).type === "CARD_DRAWN" &&
      (event as { payload?: { playerId?: string } }).payload?.playerId === playerId("A")), "Suzy draws after the last Duel response resolves");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 1);
  assert.equal(cardTypeId(session.state, session.state.seats[0]!.private.handCardInstanceIds[0]!), "beer");
});

scenario("AT-C18", {
  seats: {
    A: { characterId: "slab_the_killer", hand: [{ typeId: "bang" }] },
    B: { characterId: "suzy_lafayette", hand: [{ typeId: "missed" }] },
  },
  drawTop: [{ typeId: "missed" }, { typeId: "beer" }],
}, (session) => {
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Slab attack starts against Suzy");
  const firstMissed = handCard(session, "B", "missed");
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: firstMissed }), "Suzy's last Missed triggers immediate draw");
  const secondMissed = handCard(session, "B", "missed");
  assert.notEqual(secondMissed, firstMissed);
  accepted(session.respond("B", "USE_MISSED", { cardInstanceId: secondMissed }), "Suzy uses her newly drawn Missed");
  assert.equal(session.state.seats[1]!.public.hp, 4);
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 1, "empty hand after the completed defense draws again");
  assert.equal(cardTypeId(session.state, session.state.seats[1]!.private.handCardInstanceIds[0]!), "beer");
});

scenario("AT-C19", {
  seats: {
    A: { characterId: "suzy_lafayette", hand: [{ typeId: "bang" }] },
    B: { characterId: "el_gringo", hand: [{ typeId: "missed" }] },
  },
  drawTop: [{ typeId: "panic" }, { typeId: "beer" }],
}, (session) => {
  const bang = handCard(session, "A", "bang");
  const gringoHpBefore = session.state.seats[1]!.public.hp;
  const initialSuzyHand = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.play("A", bang, "B"), "Suzy's last BANG hits El Gringo");
  accepted(session.respond("B", "TAKE_HIT"), "El Gringo survives and triggers source reward");
  assert.equal(session.state.seats[1]!.public.hp, gringoHpBefore - 1);
  assert.equal(session.state.seats[1]!.private.handCardInstanceIds.length, 2, "El Gringo keeps his old card and steals Suzy's first post-effect draw");
  const suzyHand = session.state.seats[0]!.private.handCardInstanceIds;
  assert.equal(suzyHand.length, 1, "Suzy draws once before the steal and again after her hand empties");
  assert.equal(cardTypeId(session.state, suzyHand[0]!), "beer");
  assert.ok(initialSuzyHand.every((id) => id === bang));
  assert.ok(session.events.findIndex((event) => (event as { type?: string }).type === "CARD_DRAWN") < session.events.findIndex((event) => (event as { type?: string }).type === "CARD_TRANSFERRED" && (event as { payload?: { fromZone?: string } }).payload?.fromZone === "hand"));
});

scenario("AT-C20", {
  playerCount: 5,
  seats: {
    A: { hand: [{ typeId: "bang" }], inPlay: [{ typeId: "scope" }] },
    B: { characterId: "vulture_sam" },
    E: { roleId: "renegade", hp: 1, maxHp: 4, hand: [{ typeId: "beer" }], inPlay: [{ typeId: "mustang" }] },
  },
}, (session) => {
  const beer = handCard(session, "E", "beer");
  const mustang = inPlayCard(session, "E", "mustang");
  accepted(session.play("A", handCard(session, "A", "bang"), "E"), "Vulture Sam is alive when Renegade is attacked");
  accepted(session.respond("E", "TAKE_HIT"), "E reaches death rescue");
  accepted(session.respond("E", "ACCEPT_ELIMINATION"), "E is eliminated and Sam recovers cards");
  assert.equal(session.state.seats[4]!.public.eliminated, true);
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(beer));
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(mustang));
  assert.ok(!session.state.seats[1]!.public.inPlayCardInstanceIds.includes(mustang), "recovered equipment is a hand card");
});

scenario("AT-C21", {
  phase: "start",
  seats: {
    A: { roleId: "outlaw", hp: 1, maxHp: 4, hand: [{ typeId: "beer" }], inPlay: [{ typeId: "dynamite" }, { typeId: "barrel" }] },
    B: { roleId: "sheriff", characterId: "vulture_sam" },
  },
  drawTop: [faceSpec("SPADES", 2)],
}, (session) => {
  const dynamite = inPlayCard(session, "A", "dynamite");
  const barrel = inPlayCard(session, "A", "barrel");
  const beer = handCard(session, "A", "beer");
  accepted(session.startTurn(), "Dynamite explodes before Vulture cleanup");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  accepted(session.respond("A", "ACCEPT_ELIMINATION"), "A is eliminated by Dynamite");
  assert.ok(session.state.zones.discardPileCardInstanceIds.includes(dynamite), "exploded Dynamite is already discarded");
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(barrel));
  assert.ok(session.state.seats[1]!.private.handCardInstanceIds.includes(beer));
  assert.ok(!session.state.seats[1]!.private.handCardInstanceIds.includes(dynamite));
});

scenario("AT-C22", {
  playerCount: 5,
  seats: {
    A: { characterId: "vulture_sam", hand: [{ typeId: "bang" }, { typeId: "beer" }], inPlay: [{ typeId: "mustang" }] },
    B: { roleId: "deputy", hp: 1, maxHp: 4, hand: [{ typeId: "missed" }], inPlay: [{ typeId: "barrel" }] },
  },
}, (session) => {
  const sheriffBefore = [...session.state.seats[0]!.private.handCardInstanceIds, ...session.state.seats[0]!.public.inPlayCardInstanceIds];
  const deputyCards = [...session.state.seats[1]!.private.handCardInstanceIds, ...session.state.seats[1]!.public.inPlayCardInstanceIds];
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "Sheriff Sam attacks Deputy");
  accepted(session.respond("B", "TAKE_HIT"), "Deputy reaches rescue");
  accepted(session.respond("B", "ACCEPT_ELIMINATION"), "Deputy dies and is first recovered by Sam");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DISCARDS_ORDER");
  assert.deepEqual(session.state.resolution.pendingInteraction?.actorPlayerIds, [playerId("A")]);
  const penaltyCards = [...session.state.seats[0]!.private.handCardInstanceIds, ...session.state.seats[0]!.public.inPlayCardInstanceIds];
  accepted(session.respond("A", "ORDER_CARDS", { orderedCardInstanceIds: penaltyCards }), "Sheriff orders all recovered and remaining owned cards for the penalty discard");
  assert.ok(deputyCards.every((id) => session.state.zones.discardPileCardInstanceIds.includes(id)), "Sheriff's Deputy penalty discards recovered cards");
  assert.ok(sheriffBefore.every((id) => session.state.zones.discardPileCardInstanceIds.includes(id)), "Sheriff's own hand and equipment are discarded too");
  assert.equal(session.state.seats[0]!.private.handCardInstanceIds.length, 0);
  assert.equal(session.state.seats[0]!.public.inPlayCardInstanceIds.length, 0);
});

scenario("AT-C23", {
  seats: { A: { characterId: "willy_the_kid", hand: [{ typeId: "bang" }, { typeId: "bang" }, { typeId: "bang" }] } },
}, (session) => {
  for (let count = 0; count < 2; count += 1) {
    accepted(session.play("A", handCard(session, "A", "bang"), "B"), `Willy BANG number ${count + 1}`);
    accepted(session.respond("B", "TAKE_HIT"), "resolve adjacent target");
  }
  assert.equal(session.state.turn.bangCardPlaysThisTurn, 2);
  const third = handCard(session, "A", "bang");
  const before = structuredClone(session.state);
  rejected(session.play("A", third, "C"), "TARGET_OUT_OF_RANGE");
  assert.deepEqual(session.state, before, "Willy's unlimited quota does not extend range");
});

scenario("AT-C24", {
  phase: "start",
  seats: { A: { hp: 2, maxHp: 4, hand: [{ typeId: "beer" }, { typeId: "beer" }], inPlay: [{ typeId: "dynamite" }] } },
  drawTop: [faceSpec("SPADES", 2)],
}, (session) => {
  const beers = [...session.state.seats[0]!.private.handCardInstanceIds];
  accepted(session.startTurn(), "HP2 takes three Dynamite damage and opens rescue");
  assert.equal(session.state.seats[0]!.public.hp, 0, "engine stores lethal HP as zero while rescue is pending");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  accepted(session.respond("A", "USE_BEER", { cardInstanceId: beers[0] }), "first Beer recovers from −1 to zero");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE", "one Beer is not enough from HP −1");
  accepted(session.respond("A", "USE_BEER", { cardInstanceId: beers[1] }), "second Beer brings HP to one");
  assert.equal(session.state.seats[0]!.public.hp, 1);
  assert.equal(session.state.seats[0]!.public.eliminated, false);
});

scenario("AT-C25", {
  currentPlayer: "D",
  seats: {
    A: { roleId: "sheriff" },
    B: { roleId: "outlaw" },
    C: { roleId: "outlaw", hand: [{ typeId: "bang" }] },
    D: { roleId: "outlaw", hp: 1, maxHp: 4, hand: [{ typeId: "duel" }, { typeId: "bang" }] },
  },
}, (session) => {
  const beforeTargetHand = [...session.state.seats[2]!.private.handCardInstanceIds];
  const drawPileBefore = session.state.zones.drawPileCardInstanceIds.length;
  accepted(session.play("D", handCard(session, "D", "duel"), "C"), "Outlaw initiates Duel and then loses");
  accepted(session.respond("C", "PLAY_BANG", { cardInstanceId: handCard(session, "C", "bang") }), "Duel target answers");
  accepted(session.respond("D", "YIELD"), "initiator accepts one damage and dies");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  accepted(session.respond("D", "ACCEPT_ELIMINATION"), "initiator is eliminated");
  assert.equal(session.state.seats[3]!.public.eliminated, true);
  assert.equal(session.state.seats[2]!.private.handCardInstanceIds.length, beforeTargetHand.length - 1);
  assert.equal(session.state.zones.drawPileCardInstanceIds.length, drawPileBefore, "the Duel initiator receives no three-card kill reward for their own elimination");
});

scenario("AT-C26", {
  seats: { A: { hand: [{ typeId: "bang" }], inPlay: [{ typeId: "scope" }] }, C: { roleId: "outlaw", hp: 1, maxHp: 4 } },
  drawTop: [{ typeId: "beer" }, { typeId: "missed" }, { typeId: "bang" }],
}, (session) => {
  const initial = [...session.state.seats[0]!.private.handCardInstanceIds];
  const expectedReward = [...session.state.zones.drawPileCardInstanceIds.slice(0, 3)];
  accepted(session.play("A", handCard(session, "A", "bang"), "C"), "source attribution stays with Sheriff");
  accepted(session.respond("C", "TAKE_HIT"), "Outlaw enters rescue");
  accepted(session.respond("C", "ACCEPT_ELIMINATION"), "Sheriff earns Outlaw kill reward");
  const gained = session.state.seats[0]!.private.handCardInstanceIds.filter((id) => !initial.includes(id));
  assert.equal(gained.length, 3);
  assert.deepEqual(gained, expectedReward, "reward draw order matches the fixed top three cards");
  assert.ok(gained.every((id) => session.state.seats[0]!.private.handCardInstanceIds.includes(id)), "the killer owns all three reward cards");
  assert.ok(gained.every((id) => !session.state.zones.drawPileCardInstanceIds.includes(id) && !session.state.zones.discardPileCardInstanceIds.includes(id)));
  assert.equal(session.events.filter((event) => (event as { type?: string }).type === "PLAYER_ELIMINATED" &&
    (event as { payload?: { playerId?: string; sourcePlayerId?: string; cause?: string } }).payload?.playerId === playerId("C") &&
    (event as { payload?: { playerId?: string; sourcePlayerId?: string; cause?: string } }).payload?.sourcePlayerId === playerId("A") &&
    (event as { payload?: { playerId?: string; sourcePlayerId?: string; cause?: string } }).payload?.cause === "BANG").length, 1, "elimination attribution remains with the Sheriff source");
  assertEngineStateInvariants(session.state);
});

scenario("AT-C27", {
  phase: "start",
  seats: {
    A: { roleId: "outlaw", hp: 1, maxHp: 4, inPlay: [{ typeId: "dynamite" }] },
    B: { roleId: "sheriff" },
    C: { roleId: "outlaw" },
    D: { roleId: "renegade" },
  },
  drawTop: [faceSpec("SPADES", 2), { typeId: "beer" }, { typeId: "missed" }, { typeId: "bang" }],
}, (session) => {
  const otherHands = session.state.seats.slice(1).map((seat) => [...seat.private.handCardInstanceIds]);
  accepted(session.startTurn(), "Dynamite creates no player kill source");
  accepted(session.respond("A", "ACCEPT_ELIMINATION"), "Outlaw is eliminated by Dynamite");
  for (let index = 1; index < session.state.seats.length; index += 1) {
    assert.deepEqual(session.state.seats[index]!.private.handCardInstanceIds, otherHands[index - 1], "no player receives the three-card Outlaw reward");
  }
});

scenario("AT-C28", {
  seats: {
    A: { hand: [{ typeId: "bang" }], inPlay: [{ typeId: "scope" }] },
    D: { roleId: "renegade", hp: 1, maxHp: 4, hand: [{ typeId: "beer" }, { typeId: "missed" }], inPlay: [{ typeId: "mustang" }] },
  },
}, (session) => {
  const victimCards = [
    ...session.state.seats[3]!.private.handCardInstanceIds,
    ...session.state.seats[3]!.public.inPlayCardInstanceIds,
  ];
  accepted(session.play("A", handCard(session, "A", "bang"), "D"), "Renegade enters death flow");
  accepted(session.respond("D", "TAKE_HIT"), "open D's rescue window");
  accepted(session.respond("D", "ACCEPT_ELIMINATION"), "eliminated owner receives one final cleanup order");
  assert.equal(session.state.resolution.pendingInteraction?.kind, "DISCARDS_ORDER");
  assert.deepEqual(session.state.resolution.pendingInteraction?.actorPlayerIds, [playerId("D")]);
  const before = structuredClone(session.state);
  rejected(session.play("D", victimCards[0]!));
  assert.deepEqual(session.state, before, "eliminated owner cannot issue a regular card action");
  const ordered = [victimCards[2]!, victimCards[0]!, victimCards[1]!];
  accepted(session.respond("D", "ORDER_CARDS", { orderedCardInstanceIds: ordered }), "dead player's cleanup response orders every held card");
  assert.deepEqual(session.state.zones.discardPileCardInstanceIds.slice(-3), ordered);
  assert.equal(session.state.resolution.pendingInteraction, null);
});

scenario("AT-C29", {
  currentPlayer: "D",
  seats: {
    A: { roleId: "sheriff", hp: 1, maxHp: 5 },
    B: { roleId: "outlaw", hp: 1, maxHp: 4 },
    C: { roleId: "outlaw", hp: 1, maxHp: 4 },
    D: { roleId: "renegade", hand: [{ typeId: "gatling" }] },
  },
}, (session) => {
  accepted(session.play("D", handCard(session, "D", "gatling")), "Renegade Gatling begins a multi-target effect");
  for (const target of ["A", "B", "C"] as const) {
    assert.equal(session.state.resolution.pendingInteraction?.actorPlayerIds[0], playerId(target));
    accepted(session.respond(target, "TAKE_HIT"), `target ${target} is resolved in clockwise order`);
    if (session.state.resolution.pendingInteraction?.kind === "DEATH_RESCUE") {
      accepted(session.respond(target, "ACCEPT_ELIMINATION"), `target ${target} accepts elimination after lethal Gatling damage`);
    }
    if (target !== "C") assert.equal(session.state.status, "playing", "victory check waits for the entire Gatling");
  }
  assert.equal(session.state.status, "completed");
  assert.equal(session.state.outcome?.winningFaction, "renegade");
  assert.deepEqual(session.state.outcome?.winningPlayerIds, [playerId("D")]);
});

scenario("AT-C30", {
  currentPlayer: "C",
  seats: {
    A: { roleId: "sheriff", hp: 1, maxHp: 5 },
    C: { roleId: "outlaw", hand: [{ typeId: "bang" }], inPlay: [{ typeId: "scope" }] },
  },
}, (session) => {
  accepted(session.play("C", handCard(session, "C", "bang"), "A"), "Outlaw attacks Sheriff");
  accepted(session.respond("A", "TAKE_HIT"), "Sheriff reaches rescue");
  accepted(session.respond("A", "ACCEPT_ELIMINATION"), "Sheriff death ends match");
  assert.equal(session.state.status, "completed");
  assert.equal(session.state.outcome?.winningFaction, "outlaws");
  assert.ok(session.state.outcome?.winningPlayerIds.includes(playerId("C")));
  assert.equal(session.state.outcome?.winningPlayerIds.some((id) => id === playerId("A")), false);
});

scenario("AT-C31", {
  playerCount: 5,
  currentPlayer: "A",
  seats: {
    A: { roleId: "sheriff", hand: [{ typeId: "bang" }] },
    B: { roleId: "deputy", eliminated: true, hp: 0 },
    C: { roleId: "outlaw", eliminated: true, hp: 0 },
    D: { roleId: "outlaw", hp: 1, maxHp: 4, hand: [] },
    E: { roleId: "renegade", eliminated: true, hp: 0 },
  },
}, (session) => {
  const bang = handCard(session, "A", "bang");
  accepted(session.play("A", bang, "D"), "Sheriff attacks the last living Outlaw");
  accepted(session.respond("D", "TAKE_HIT"), "last Outlaw reaches rescue");
  accepted(session.respond("D", "ACCEPT_ELIMINATION"), "eliminate the last Outlaw");
  assert.equal(session.state.status, "completed");
  assert.equal(session.state.outcome?.winningFaction, "sheriff_and_deputies");
  assert.ok(session.state.outcome?.winningPlayerIds.includes(playerId("A")));
  assert.ok(session.state.outcome?.winningPlayerIds.includes(playerId("B")), "dead Deputy shares faction victory");
});

scenario("AT-C32", { seats: { A: { hand: [{ typeId: "bang" }] } }, phase: "play" }, (session) => {
  const completed = structuredClone(session.state);
  completed.status = "completed";
  completed.outcome = { winningFaction: "sheriff_and_deputies", winningPlayerIds: [playerId("A")] };
  for (const seat of completed.seats) seat.public.roleRevealed = true;
  session.state = completed;
  const bang = handCard(session, "A", "bang");
  const before = structuredClone(session.state);
  rejected(session.play("A", bang, "B"), "MATCH_NOT_PLAYING");
  assert.deepEqual(session.state, before);
  for (const viewer of session.state.seats) {
    const view = projectMatchSnapshot(session.state, viewer.public.playerId, BASE_PHYSICAL_CARDS);
    assert.ok(view.publicTable.players.every((seat) => seat.role !== null));
    assert.equal(view.selfPrivate?.hand.some((card) => card.cardInstanceId === bang), viewer.public.playerId === playerId("A"));
  }
});

scenario("AT-D20", {
  seats: {
    A: { hand: [{ typeId: "stagecoach" }, { typeId: "bang" }] },
    B: { roleId: "outlaw", hp: 1, maxHp: 4 },
  },
  drawTop: [{ typeId: "beer" }],
}, (session) => {
  const onlyDraw = session.state.zones.drawPileCardInstanceIds[0]!;
  moveAllBut(session, [onlyDraw]);
  accepted(session.play("A", handCard(session, "A", "stagecoach")), "stagecoach moves cards and forces discard recycling");
  assertEngineStateInvariants(session.state);
  accepted(session.play("A", handCard(session, "A", "bang"), "B"), "BANG starts elimination sequence");
  accepted(session.respond("B", "TAKE_HIT"), "damage advances to death rescue");
  assertEngineStateInvariants(session.state);
  accepted(session.respond("B", "ACCEPT_ELIMINATION"), "cleanup and Sheriff reward transfer cards");
  assertEngineStateInvariants(session.state);
  const counts = session.state.seats.map((seat) => seat.private.handCardInstanceIds.length);
  assert.ok(counts.every((count) => Number.isInteger(count) && count >= 0));
  assert.equal(Object.keys(session.state.zones.cardsByInstanceId).length, 80);
});
