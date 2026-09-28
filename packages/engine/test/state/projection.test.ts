import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhysicalCard } from "../../../catalog/src/schema.ts";
import { parsePendingInteractionView } from "../../../contracts/src/validation.ts";
import type { PendingInteractionResponderView, RespondPayload } from "../../../contracts/src/protocol.ts";
import { applyMatchCommand } from "../../src/commands/index.ts";
import { checkVictoryAtBoundary } from "../../src/endgame/index.ts";
import { beginEffectResolution, openPendingInteraction } from "../../src/resolution/index.ts";
import { projectMatchSnapshot } from "../../src/state/projection.ts";
import type { CardInstance, GameState, InteractionOption, SeatState } from "../../src/state/types.ts";

const physicalCards: PhysicalCard[] = [
  { definitionId: "bang_01", typeId: "bang", rank: "A", suit: "SPADES", copyIndex: 1 },
  { definitionId: "beer_01", typeId: "beer", rank: 6, suit: "HEARTS", copyIndex: 1 },
  { definitionId: "missed_01", typeId: "missed", rank: 10, suit: "CLUBS", copyIndex: 1 },
  { definitionId: "mustang_01", typeId: "mustang", rank: 8, suit: "HEARTS", copyIndex: 1 },
  { definitionId: "cat_balou_01", typeId: "cat_balou", rank: "K", suit: "HEARTS", copyIndex: 1 },
  { definitionId: "stagecoach_01", typeId: "stagecoach", rank: 9, suit: "SPADES", copyIndex: 1 },
  { definitionId: "duel_01", typeId: "duel", rank: "Q", suit: "DIAMONDS", copyIndex: 1 },
  { definitionId: "indians_01", typeId: "indians", rank: "K", suit: "DIAMONDS", copyIndex: 1 },
];

function card(
  cardInstanceId: string,
  cardDefinitionId: string,
  rank: CardInstance["rank"],
  suit: CardInstance["suit"],
): CardInstance {
  return { cardInstanceId, cardDefinitionId, rank, suit };
}

function seat(
  playerId: string,
  seatIndex: number,
  roleId: SeatState["private"]["roleId"],
  handCardInstanceIds: string[],
  options: { eliminated?: boolean; roleRevealed?: boolean; inPlayCardInstanceIds?: string[] } = {},
): SeatState {
  return {
    public: {
      playerId,
      displayName: `Player ${seatIndex + 1}`,
      seatIndex,
      characterId: `character-${seatIndex + 1}`,
      hp: 4,
      maxHp: 4,
      eliminated: options.eliminated ?? false,
      roleRevealed: options.roleRevealed ?? false,
      inPlayCardInstanceIds: options.inPlayCardInstanceIds ?? [],
    },
    private: { roleId, handCardInstanceIds },
  };
}

function makeState(): GameState {
  return {
    schemaVersion: 1,
    rulesetVersion: "base4-ko-online-1.0",
    status: "playing",
    pauseReason: null,
    version: 7,
    eventSeq: 12,
    seats: [
      seat("player-a", 0, "sheriff", ["hand-a"], { roleRevealed: true, inPlayCardInstanceIds: ["public-mustang"] }),
      seat("player-b", 1, "outlaw", ["hand-b"]),
      seat("player-c", 2, "renegade", ["hand-c"]),
    ],
    zones: {
      cardsByInstanceId: {
        "hand-a": card("hand-a", "bang_01", "A", "SPADES"),
        "hand-b": card("hand-b", "beer_01", 6, "HEARTS"),
        "hand-c": card("hand-c", "missed_01", 10, "CLUBS"),
        "public-mustang": card("public-mustang", "mustang_01", 8, "HEARTS"),
        "discard-old": card("discard-old", "cat_balou_01", "K", "HEARTS"),
        "discard-top": card("discard-top", "stagecoach_01", 9, "SPADES"),
        "draw-hidden": card("draw-hidden", "duel_01", "Q", "DIAMONDS"),
        "revealed-pool-card": card("revealed-pool-card", "indians_01", "K", "DIAMONDS"),
      },
      drawPileCardInstanceIds: ["draw-hidden"],
      discardPileCardInstanceIds: ["discard-old", "discard-top"],
      revealedPoolCardInstanceIds: ["revealed-pool-card"],
    },
    turn: {
      currentPlayerId: "player-b",
      phase: "play",
      bangCardPlaysThisTurn: 1,
      turnNumber: 3,
    },
    resolution: {
      effectQueue: [],
      continuations: [],
      pendingInteraction: null,
      pendingDeath: null,
      victoryCheckDeferredByEffectId: null,
    },
    outcome: null,
  };
}

function addPendingInteraction(
  state: GameState,
  option: InteractionOption = { choice: "ORDER_CARDS", payload: {} },
  kind = "DISCARDS_ORDER",
): void {
  state.resolution.pendingInteraction = {
    interactionId: "interaction-1",
    kind,
    actorPlayerIds: ["player-b"],
    options: [option],
    context: {
      victimPlayerId: "player-b",
      hiddenContext: "context-private",
      ...(kind === "DISCARDS_ORDER"
        ? { discardOrder: { allowedCardInstanceIds: ["hand-b"], requiredCount: 1 } }
        : {}),
      __resolutionCursor: {
        cursor: 1,
        responders: [
          { playerId: "player-a", options: [{ choice: "TAKE_HIT", payload: {} }] },
          { playerId: "player-b", options: [option] },
        ],
        responses: [{ playerId: "player-a", choice: "TAKE_HIT", payload: {} }],
      },
    },
    resumeFrameId: "frame-private",
    createdAt: "2026-09-27T00:00:00.000Z",
  };
}

test("two viewers receive only their own hand and role while public state agrees", () => {
  const state = makeState();
  const viewA = projectMatchSnapshot(state, "player-a", physicalCards);
  const viewB = projectMatchSnapshot(state, "player-b", physicalCards);
  const viewC = projectMatchSnapshot(state, "player-c", physicalCards);

  assert.deepEqual(viewA.publicTable, viewB.publicTable);
  assert.deepEqual(viewB.publicTable, viewC.publicTable);
  assert.equal(viewA.publicTable.deckCount, state.zones.drawPileCardInstanceIds.length);
  assert.equal(viewB.publicTable.deckCount, viewA.publicTable.deckCount);
  assert.equal(viewC.publicTable.deckCount, viewA.publicTable.deckCount);
  assert.equal(viewA.publicTable.players[0]?.role, "sheriff");
  assert.equal(viewA.publicTable.players[1]?.role, null);
  assert.equal(viewA.publicTable.players[2]?.role, null);
  assert.deepEqual(viewA.selfPrivate, {
    role: "sheriff",
    hand: [{ cardInstanceId: "hand-a", typeId: "bang", rank: "A", suit: "SPADES" }],
  });
  assert.deepEqual(viewB.selfPrivate, {
    role: "outlaw",
    hand: [{ cardInstanceId: "hand-b", typeId: "beer", rank: "6", suit: "HEARTS" }],
  });
  assert.deepEqual(viewA.legalActions, []);
  assert.deepEqual(viewB.legalActions, [
    { type: "PLAY_CARD", payload: { cardInstanceId: "hand-b" } },
    { type: "END_TURN", payload: {} },
  ]);
  assert.equal(Object.hasOwn(viewA, "outcome"), false);

  const serializedA = JSON.stringify(viewA);
  const serializedB = JSON.stringify(viewB);
  assert.equal(serializedA.includes("hand-b"), false);
  assert.equal(serializedA.includes("hand-c"), false);
  assert.equal(serializedA.includes('"role":"outlaw"'), false);
  assert.equal(serializedB.includes("hand-a"), false);
  assert.equal(serializedB.includes("hand-c"), false);
  assert.equal(serializedB.includes('"role":"renegade"'), false);
  const serializedC = JSON.stringify(viewC);
  assert.equal(serializedC.includes("hand-a"), false);
  assert.equal(serializedC.includes("hand-b"), false);
  assert.equal(serializedC.includes("draw-hidden"), false);
  assert.equal(serializedC.includes('"role":"outlaw"'), false);
});

test("public discard exposes only its top card and total count", () => {
  const state = makeState();
  const view = projectMatchSnapshot(state, "player-a", physicalCards);

  assert.deepEqual(view.publicTable.publicDiscard, {
    topCard: { cardInstanceId: "discard-top", typeId: "stagecoach", rank: "9", suit: "SPADES" },
    count: 2,
  });
  assert.deepEqual(Object.keys(view.publicTable.publicDiscard).sort(), ["count", "topCard"]);
  assert.equal(JSON.stringify(view).includes("discard-old"), false);
  assert.equal(view.publicTable.deckCount, 1);
  assert.equal(JSON.stringify(view).includes("draw-hidden"), false);
});

test("only a pending interaction actor receives its exact response option; others receive progress only", () => {
  const state = makeState();
  addPendingInteraction(state);
  const viewA = projectMatchSnapshot(state, "player-a", physicalCards);
  const viewB = projectMatchSnapshot(state, "player-b", physicalCards);

  assert.deepEqual(viewA.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DISCARDS_ORDER",
    allowedChoices: [],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
  });
  assert.deepEqual(viewB.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DISCARDS_ORDER",
    allowedChoices: ["ORDER_CARDS"],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
    responseOptions: [{ interactionId: "interaction-1", choice: "ORDER_CARDS" }],
    discardOrder: {
      requiredCount: 1,
      allowedCards: [{ cardInstanceId: "hand-b", typeId: "beer", rank: "6", suit: "HEARTS" }],
    },
  });
  assert.equal(parsePendingInteractionView(viewA.pendingInteraction, "player-a").ok, true);
  assert.equal(parsePendingInteractionView(viewB.pendingInteraction, "player-b").ok, true);
  const serializedProgress = JSON.stringify(viewA.pendingInteraction);
  assert.equal(serializedProgress.includes("responseOptions"), false);
  assert.equal(serializedProgress.includes("context-private"), false);
  assert.equal(JSON.stringify(viewA.pendingInteraction).includes("cursor-private-card"), false);
  assert.equal(JSON.stringify(viewB.pendingInteraction).includes("cursor-private-card"), false);
  assert.equal(JSON.stringify(viewB.pendingInteraction).includes("context-private"), false);
  assert.equal(JSON.stringify(viewA.pendingInteraction).includes("hand-b"), false);
  assert.equal(JSON.stringify(viewB.pendingInteraction).includes("hiddenContext"), false);
  assert.deepEqual(viewA.legalActions, []);
  assert.deepEqual(viewB.legalActions, []);
});

test("projection rejects malformed saved discard-order candidate context", () => {
  const malformedContexts = [
    null,
    { allowedCardInstanceIds: ["hand-b"], requiredCount: 0 },
    { allowedCardInstanceIds: ["hand-b"], requiredCount: 2 },
    { allowedCardInstanceIds: ["hand-b", "hand-b"], requiredCount: 1 },
    { allowedCardInstanceIds: ["hand-b", 3], requiredCount: 1 },
  ];

  for (const discardOrder of malformedContexts) {
    const state = makeState();
    addPendingInteraction(state);
    if (discardOrder === null) {
      delete state.resolution.pendingInteraction!.context.discardOrder;
    } else {
      state.resolution.pendingInteraction!.context.discardOrder = discardOrder;
    }
    assert.throws(() => projectMatchSnapshot(state, "player-b", physicalCards), /candidate context/);
  }
});

test("responder receives a stored private option payload while other viewers never see it", () => {
  const state = makeState();
  addPendingInteraction(state, { choice: "USE_BEER", payload: { cardInstanceId: "hand-b" } }, "DEATH_RESCUE");
  const actorView = projectMatchSnapshot(state, "player-b", physicalCards);
  const otherView = projectMatchSnapshot(state, "player-a", physicalCards);

  assert.deepEqual(actorView.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DEATH_RESCUE",
    allowedChoices: ["USE_BEER"],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
    responseOptions: [{ interactionId: "interaction-1", choice: "USE_BEER", cardInstanceId: "hand-b" }],
  });
  assert.deepEqual(otherView.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DEATH_RESCUE",
    allowedChoices: [],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
  });
  assert.equal(parsePendingInteractionView(actorView.pendingInteraction, "player-b").ok, true);
  assert.equal(parsePendingInteractionView(otherView.pendingInteraction, "player-a").ok, true);
  assert.equal(JSON.stringify(otherView).includes("hand-b"), false);
  assert.equal(JSON.stringify(otherView.pendingInteraction).includes("responseOptions"), false);
});

test("projected runtime response payloads pass T14 against the same saved pending state", () => {
  const state = makeState();
  const started = beginEffectResolution(state, {
    steps: [{ effectId: "test-effect", kind: "PENDING", sourcePlayerId: "player-a", targetPlayerId: null, sourceCardInstanceId: null, payload: {} }],
    continuation: { frameId: "frame-private", kind: "T69_TEST", sourcePlayerId: "player-a", sourceCardInstanceId: null, payload: {} },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const opened = openPendingInteraction(started.state, {
    interactionId: "runtime-interaction",
    kind: "T69_TEST",
    responders: [{
      playerId: "player-b",
      options: [
        { choice: "DRAW_FROM_PILE", payload: {} },
        { choice: "TAKE_FROM_HAND", payload: { sourcePlayerId: "player-a" } },
        { choice: "SELECT_SOURCE", payload: { source: "DRAW_PILE_TOP" } },
        { choice: "SELECT_JUDGMENT", payload: { selectedCardInstanceId: "draw-hidden", orderedCardInstanceIds: ["draw-hidden", "discard-top"] } },
      ],
    }],
    context: { hiddenContext: "private-runtime-context" },
    resumeFrameId: "frame-private",
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const actorView = projectMatchSnapshot(opened.state, "player-b", physicalCards);
  assert.equal(parsePendingInteractionView(actorView.pendingInteraction, "player-b").ok, true);
  const pending = actorView.pendingInteraction as PendingInteractionResponderView;
  assert.equal(pending.responseOptions.length, 4);
  for (const payload of pending.responseOptions as readonly RespondPayload[]) {
    const result = applyMatchCommand(opened.state, "player-b", {
      type: "RESPOND",
      payload,
    }, { random: { nextFloat: () => 0.5 } });
    assert.equal(result.ok, true, JSON.stringify(payload));
  }

  const otherView = projectMatchSnapshot(opened.state, "player-a", physicalCards);
  assert.equal(parsePendingInteractionView(otherView.pendingInteraction, "player-a").ok, true);
  assert.equal(JSON.stringify(otherView.pendingInteraction).includes("runtime-interaction"), true);
  assert.equal(JSON.stringify(otherView.pendingInteraction).includes("private-runtime-context"), false);
  assert.equal(JSON.stringify(otherView.pendingInteraction).includes("responseOptions"), false);
});

test("eliminated actor sees final cleanup pending but receives no private hand", () => {
  const state = makeState();
  const eliminatedSeat = state.seats[1]!;
  eliminatedSeat.public.eliminated = true;
  eliminatedSeat.public.roleRevealed = true;
  addPendingInteraction(state);

  const eliminatedView = projectMatchSnapshot(state, "player-b", physicalCards);
  const otherView = projectMatchSnapshot(state, "player-a", physicalCards);

  assert.equal(eliminatedView.viewer.mode, "eliminated_observer");
  assert.equal(eliminatedView.selfPrivate, null);
  assert.equal(JSON.stringify(otherView).includes("hand-b"), false);
  assert.equal(eliminatedView.publicTable.players[1]?.handCount, 1);
  assert.equal(eliminatedView.publicTable.players[1]?.role, "outlaw");
  assert.deepEqual(eliminatedView.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DISCARDS_ORDER",
    allowedChoices: ["ORDER_CARDS"],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
    responseOptions: [{ interactionId: "interaction-1", choice: "ORDER_CARDS" }],
    discardOrder: {
      requiredCount: 1,
      allowedCards: [{ cardInstanceId: "hand-b", typeId: "beer", rank: "6", suit: "HEARTS" }],
    },
  });
  assert.deepEqual(otherView.pendingInteraction, {
    interactionId: "interaction-1",
    kind: "DISCARDS_ORDER",
    allowedChoices: [],
    currentResponderPlayerId: "player-b",
    step: { current: 2, total: 2 },
  });
  assert.deepEqual(otherView.legalActions, []);
});

test("completed game reveals every role while keeping other hands private", () => {
  const state = makeState();
  state.seats[0]!.public.eliminated = true;
  state.seats[0]!.public.roleRevealed = true;
  const checked = checkVictoryAtBoundary(state);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const completed = checked.state;
  const viewA = projectMatchSnapshot(completed, "player-a", physicalCards);
  const viewB = projectMatchSnapshot(completed, "player-b", physicalCards);

  assert.deepEqual(viewA.publicTable.players.map(({ role }) => role), ["sheriff", "outlaw", "renegade"]);
  assert.deepEqual(viewB.publicTable.players.map(({ role }) => role), ["sheriff", "outlaw", "renegade"]);
  assert.equal(viewA.selfPrivate, null);
  assert.equal(viewB.selfPrivate?.hand[0]?.cardInstanceId, "hand-b");
  assert.equal(JSON.stringify(viewA).includes("hand-b"), false);
  assert.equal(JSON.stringify(viewA).includes("hand-c"), false);
  assert.equal(viewA.viewer.mode, "eliminated_observer");
  assert.deepEqual(viewB.outcome, {
    winningFaction: "outlaws",
    winningPlayerIds: ["player-b"],
  });
});

test("outcome projection preserves the other R30 winning factions and includes dead teammates", () => {
  const renegadeState = makeState();
  renegadeState.seats[0]!.public.eliminated = true;
  renegadeState.seats[0]!.public.roleRevealed = true;
  renegadeState.seats[1]!.public.eliminated = true;
  renegadeState.seats[1]!.public.roleRevealed = true;
  const renegadeChecked = checkVictoryAtBoundary(renegadeState);
  assert.equal(renegadeChecked.ok, true);
  if (!renegadeChecked.ok) return;
  const renegadeView = projectMatchSnapshot(renegadeChecked.state, "player-c", physicalCards);
  assert.deepEqual(renegadeView.outcome, {
    winningFaction: "renegade",
    winningPlayerIds: ["player-c"],
  });

  const sheriffState = makeState();
  sheriffState.seats[1]!.private.roleId = "deputy";
  sheriffState.seats[1]!.public.eliminated = true;
  sheriffState.seats[1]!.public.roleRevealed = true;
  sheriffState.seats[2]!.private.roleId = "outlaw";
  sheriffState.seats[2]!.public.eliminated = true;
  sheriffState.seats[2]!.public.roleRevealed = true;
  const sheriffChecked = checkVictoryAtBoundary(sheriffState);
  assert.equal(sheriffChecked.ok, true);
  if (!sheriffChecked.ok) return;
  const sheriffView = projectMatchSnapshot(sheriffChecked.state, "player-a", physicalCards);
  assert.deepEqual(sheriffView.outcome, {
    winningFaction: "sheriff_and_deputies",
    winningPlayerIds: ["player-a", "player-b"],
  });
});

test("outcome is projected only for completed matches and a completed snapshot needs an engine result", () => {
  const state = makeState();
  const staleOutcome: GameState["outcome"] = {
    winningFaction: "renegade",
    winningPlayerIds: ["player-c"],
  };
  const paused = projectMatchSnapshot({ ...state, status: "paused", outcome: staleOutcome }, "player-a", physicalCards);
  assert.equal(Object.hasOwn(paused, "outcome"), false);
  assert.throws(
    () => projectMatchSnapshot({ ...state, status: "completed" }, "player-a", physicalCards),
    /authoritative engine outcome/,
  );
});

test("projection does not mutate the internal match state", () => {
  const state = makeState();
  addPendingInteraction(state);
  const before = structuredClone(state);

  projectMatchSnapshot(state, "player-a", physicalCards);
  projectMatchSnapshot(state, "player-b", physicalCards);

  assert.deepEqual(state, before);
});

test("rejects a viewer who does not own a seat in the match", () => {
  assert.throws(
    () => projectMatchSnapshot(makeState(), "spectator", physicalCards),
    /does not have a seat/,
  );
});

