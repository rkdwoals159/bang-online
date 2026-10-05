import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../packages/catalog/src/cards/index.ts";
import type { MatchCommand } from "../../../../packages/contracts/src/protocol.ts";
import { applyMatchCommand, type ApplyMatchCommandContext } from "../../../../packages/engine/src/commands/index.ts";
import { createEffectCommandHandlers } from "../../../../packages/engine/src/effects/runtime/index.ts";
import { createEffectRegistry } from "../../../../packages/engine/src/effects/registry.ts";
import type { EffectEventDraft } from "../../../../packages/engine/src/effects/api.ts";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import { projectMatchSnapshot } from "../../../../packages/engine/src/state/projection.ts";
import { withTurnStartEffects } from "../../../../packages/engine/src/turn/draw.ts";
import type { PgClientLike, PgPoolLike } from "../../src/storage/database.ts";
import { applyStorageMigrations } from "../../src/storage/migrations.ts";
import { StorageRepository } from "../../src/storage/repository.ts";
import { createDatabase } from "../storage/pglite-pool.ts";
import { processMatchCommand, type MatchCommandRelayDependencies } from "../../src/commands/index.ts";
import { advanceTurnPhases, createTurnAwareCommandHandlers } from "../../src/commands/turn-runtime.ts";

const PLAYER_IDS = ["player-1", "player-2", "player-3", "player-4"] as const;
const MATCH_ID = "match-command-relay";

function commandId(number: number): string {
  return "00000000-0000-4000-8000-" + number.toString().padStart(12, "0");
}

function initialState(): GameState {
  const cardsByInstanceId: GameState["zones"]["cardsByInstanceId"] = {};
  const seats: GameState["seats"] = PLAYER_IDS.map((playerId, seatIndex) => {
    const cardInstanceId = "card-" + playerId;
    cardsByInstanceId[cardInstanceId] = {
      cardInstanceId,
      cardDefinitionId: "card-definition-test",
      rank: 2,
      suit: "SPADES",
    };
    return {
      public: {
        playerId,
        displayName: "Player " + (seatIndex + 1),
        seatIndex,
        characterId: "bart_cassidy",
        hp: 4,
        maxHp: 4,
        eliminated: false,
        roleRevealed: seatIndex === 0,
        inPlayCardInstanceIds: [],
      },
      private: {
        roleId: (["sheriff", "deputy", "outlaw", "renegade"] as const)[seatIndex]!,
        handCardInstanceIds: [cardInstanceId],
      },
    };
  });

  return {
    schemaVersion: 1,
    rulesetVersion: "base4-ko-online-1.0",
    status: "playing",
    pauseReason: null,
    version: 0,
    eventSeq: 0,
    seats,
    zones: {
      cardsByInstanceId,
      drawPileCardInstanceIds: [],
      discardPileCardInstanceIds: [],
      revealedPoolCardInstanceIds: [],
    },
    turn: { currentPlayerId: PLAYER_IDS[0], phase: "play", bangCardPlaysThisTurn: 0, turnNumber: 1 },
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

function fixedEngineContext(): ApplyMatchCommandContext {
  return { random: { nextFloat: () => 0.5 } };
}

function endTurn(id: number, expectedVersion = 0): MatchCommand {
  return {
    protocolVersion: 1,
    commandId: commandId(id),
    matchId: MATCH_ID,
    expectedVersion,
    type: "END_TURN",
    payload: {},
  };
}

function authContext(playerId: string, member = true) {
  return {
    playerId,
    matchMembership: async (matchId: string) => matchId === MATCH_ID && member,
  };
}

function serializingPool(pool: PgPoolLike): PgPoolLike {
  let tail = Promise.resolve();
  return {
    async connect(): Promise<PgClientLike> {
      const turn = tail;
      let releaseTurn!: () => void;
      tail = new Promise<void>((resolve) => { releaseTurn = resolve; });
      await turn;
      const client = await pool.connect();
      let released = false;
      return {
        query: (sql, parameters) => client.query(sql, parameters),
        release: () => {
          if (released) return;
          released = true;
          client.release();
          releaseTurn();
        },
      };
    },
  };
}

async function fixture(options: { serializeConnections?: boolean; state?: GameState } = {}) {
  const { database, pool: rawPool } = await createDatabase();
  await applyStorageMigrations(rawPool);
  const pool = options.serializeConnections ? serializingPool(rawPool) : rawPool;
  const storage = new StorageRepository(pool);
  for (const [index, playerId] of PLAYER_IDS.entries()) {
    await storage.createGuestSession({
      id: playerId,
      tokenHash: "token-hash-" + playerId,
      displayName: "Player " + (index + 1),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  }
  await storage.createRoom({
    id: "room-command-relay",
    ownerPlayerId: PLAYER_IDS[0],
    inviteCodeHash: "invite-hash",
    capacity: 4,
    players: PLAYER_IDS.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: true })),
  });
  await storage.createMatch({
    id: MATCH_ID,
    roomId: "room-command-relay",
    state: options.state ?? initialState(),
    players: PLAYER_IDS.map((playerId) => ({ playerId, connectionState: "connected" })),
  });
  return { database, storage };
}

function deterministicGameState(nextCharacterId?: string): GameState {
  const state = initializeGame({
    players: PLAYER_IDS.map((playerId, index) => ({ playerId, displayName: `Player ${index + 1}` })),
    random: { nextFloat: () => 0.314159 },
  });
  return {
    ...state,
    turn: { ...state.turn, phase: "play" },
    seats: state.seats.map((seat) => seat.public.seatIndex === 1 && nextCharacterId
      ? { ...seat, public: { ...seat.public, characterId: nextCharacterId } }
      : seat),
  };
}

function registeredRuntimeContext(matchId = MATCH_ID): ApplyMatchCommandContext & {
  continueTurnPhases: (state: GameState) => { state: GameState; events: readonly EffectEventDraft[] };
} {
  const random = { nextFloat: () => 0.271828 };
  let interactionSequence = 0;
  const nextInteractionIdentity = () => ({
    interactionId: `${matchId}-interaction-${++interactionSequence}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const runtimeOptions = withTurnStartEffects({ registry: createEffectRegistry(), nextInteractionIdentity });
  const turnRuntime = { matchId, random, nextInteractionIdentity, runtimeOptions };
  return {
    random,
    interaction: nextInteractionIdentity(),
    handlers: createTurnAwareCommandHandlers(createEffectCommandHandlers(runtimeOptions), turnRuntime),
    continueTurnPhases: (state) => advanceTurnPhases(state, turnRuntime),
  };
}

function cardTypeId(cardDefinitionId: string): string | undefined {
  return BASE_PHYSICAL_CARDS.find((card) => card.definitionId === cardDefinitionId)?.typeId;
}

test("same-version tablewide responses all commit and preserve private reservations", async () => {
  let state = deterministicGameState();
  const actor = state.turn.currentPlayerId;
  state = { ...state, seats: state.seats.map(seat => ({ ...seat, public: { ...seat.public, characterId: "willy_the_kid", hp: 4, maxHp: 4 } })) };
  const prepared = putCardInHand(state, "gatling", actor);
  state = prepared.state;
  const defenders = state.seats.filter(seat => seat.public.playerId !== actor).map(seat => seat.public.playerId);
  const missed = Object.values(state.zones.cardsByInstanceId).filter(card => cardTypeId(card.cardDefinitionId) === "missed").slice(0, defenders.length);
  assert.equal(missed.length, defenders.length);
  const moved = new Set(missed.map(card => card.cardInstanceId));
  state = {
    ...state,
    seats: state.seats.map(seat => ({ ...seat,
      private: { ...seat.private, handCardInstanceIds: [...seat.private.handCardInstanceIds.filter(id => !moved.has(id)), ...missed.flatMap((card, index) => defenders[index] === seat.public.playerId ? [card.cardInstanceId] : [])] },
      public: { ...seat.public, inPlayCardInstanceIds: seat.public.inPlayCardInstanceIds.filter(id => !moved.has(id)) },
    })),
    zones: { ...state.zones,
      drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds.filter(id => !moved.has(id)),
      discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds.filter(id => !moved.has(id)),
      revealedPoolCardInstanceIds: state.zones.revealedPoolCardInstanceIds.filter(id => !moved.has(id)),
    },
  };
  const { database, storage } = await fixture({ state, serializeConnections: true });
  try {
    const deps = dependencies(storage, { prepareEngineContext: () => registeredRuntimeContext() });
    const played = await processMatchCommand(authContext(actor), { protocolVersion: 1, commandId: commandId(901), matchId: MATCH_ID, expectedVersion: 0, type: "PLAY_CARD", payload: { cardInstanceId: prepared.cardInstanceId } }, deps);
    assert.equal(played?.status, "accepted");
    const waiting = await storage.getMatch(MATCH_ID);
    assert.ok(waiting);
    const commands = defenders.map((id, index) => {
      const pending = projectMatchSnapshot(waiting.state, id, BASE_PHYSICAL_CARDS).pendingInteraction;
      assert.ok(pending && "responseOptions" in pending);
      return { protocolVersion: 1, commandId: commandId(902 + index), matchId: MATCH_ID, expectedVersion: waiting.version, type: "RESPOND", payload: { interactionId: pending.interactionId, choice: "USE_MISSED", cardInstanceId: missed[index]!.cardInstanceId } } as MatchCommand;
    });
    const replies = await Promise.all(commands.map((command, index) => processMatchCommand(authContext(defenders[index]!), command, deps)));
    assert.ok(replies.every(reply => reply?.status === "accepted"));
    const final = await storage.getMatch(MATCH_ID);
    assert.equal(final?.version, waiting.version + defenders.length);
    assert.equal(final?.state.resolution.pendingInteraction, null);
    assert.ok(missed.every(card => final?.state.zones.discardPileCardInstanceIds.includes(card.cardInstanceId)));
    assert.ok(final?.state.seats.every(seat => seat.public.hp === 4));
    assert.equal((await processMatchCommand(authContext(defenders[2]!), commands[2], deps))?.status, "accepted");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, final?.version);
  } finally { await database.close(); }
});

function putCardInHand(state: GameState, typeId: string, playerId: string): { state: GameState; cardInstanceId: string } {
  const card = Object.values(state.zones.cardsByInstanceId).find((candidate) => cardTypeId(candidate.cardDefinitionId) === typeId);
  assert.ok(card, `missing catalog card ${typeId}`);
  return {
    cardInstanceId: card.cardInstanceId,
    state: {
      ...state,
      seats: state.seats.map((seat) => ({
        ...seat,
        private: {
          ...seat.private,
          handCardInstanceIds: seat.public.playerId === playerId
            ? [...seat.private.handCardInstanceIds.filter((id) => id !== card.cardInstanceId), card.cardInstanceId]
            : seat.private.handCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        },
        public: {
          ...seat.public,
          inPlayCardInstanceIds: seat.public.inPlayCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        },
      })),
      zones: {
        ...state.zones,
        drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        revealedPoolCardInstanceIds: state.zones.revealedPoolCardInstanceIds.filter((id) => id !== card.cardInstanceId),
      },
    },
  };
}

function putCardInPlay(state: GameState, typeId: string, playerId: string): { state: GameState; cardInstanceId: string } {
  const card = Object.values(state.zones.cardsByInstanceId).find((candidate) => cardTypeId(candidate.cardDefinitionId) === typeId);
  assert.ok(card, `missing catalog card ${typeId}`);
  return {
    cardInstanceId: card.cardInstanceId,
    state: {
      ...state,
      seats: state.seats.map((seat) => ({
        ...seat,
        private: { ...seat.private, handCardInstanceIds: seat.private.handCardInstanceIds.filter((id) => id !== card.cardInstanceId) },
        public: {
          ...seat.public,
          inPlayCardInstanceIds: seat.public.playerId === playerId
            ? [...seat.public.inPlayCardInstanceIds.filter((id) => id !== card.cardInstanceId), card.cardInstanceId]
            : seat.public.inPlayCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        },
      })),
      zones: {
        ...state.zones,
        drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds.filter((id) => id !== card.cardInstanceId),
        revealedPoolCardInstanceIds: state.zones.revealedPoolCardInstanceIds.filter((id) => id !== card.cardInstanceId),
      },
    },
  };
}

function dependencies(
  storage: MatchCommandRelayDependencies["storage"],
  overrides: Partial<MatchCommandRelayDependencies> = {},
): MatchCommandRelayDependencies {
  let sequence = 0;
  return {
    storage,
    prepareEngineContext: () => fixedEngineContext(),
    newEventId: () => "test-event-" + (++sequence),
    ...overrides,
  };
}

test("D01: repeated accepted command returns its receipt without reapplying or duplicating persistence", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const command = endTurn(1);

    const first = await processMatchCommand(authContext(PLAYER_IDS[0]), command, deps);
    assert.deepEqual(first, {
      protocolVersion: 1,
      commandId: commandId(1),
      status: "accepted",
      duplicate: false,
      aggregateVersion: 1,
      eventSeq: 0,
    });

    const replay = await processMatchCommand(authContext(PLAYER_IDS[0]), command, deps);
    assert.deepEqual(replay, { ...first!, duplicate: true });
    assert.equal(prepareCount, 1, "receipt replay must not invoke engine evaluation again");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 1);
    assert.equal((await storage.getMatch(MATCH_ID))?.state.turn.currentPlayerId, PLAYER_IDS[1]);
    assert.deepEqual(await storage.listMatchEvents(MATCH_ID), []);
    assert.equal((await storage.listPendingOutbox()).length, 1);
    assert.ok((await storage.findCommandReceipt(PLAYER_IDS[0], commandId(1)))?.requestHash);
  } finally {
    await database.close();
  }
});

test("D02: reusing a command ID with another payload fails before engine evaluation", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const first = endTurn(2);
    await processMatchCommand(authContext(PLAYER_IDS[0]), first, deps);

    const reused: MatchCommand = {
      ...first,
      type: "PLAY_CARD",
      payload: { cardInstanceId: "card-" + PLAYER_IDS[0] },
    };
    const response = await processMatchCommand(authContext(PLAYER_IDS[0]), reused, deps);
    assert.equal(response?.status, "rejected");
    if (response?.status === "rejected") assert.equal(response.error.code, "COMMAND_ID_REUSED");
    assert.equal(prepareCount, 1);
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 1);
    assert.equal((await storage.listPendingOutbox()).length, 1);
  } finally {
    await database.close();
  }
});

test("D03: same-version concurrent valid commands commit once and save the losing stale outcome", async () => {
  const { database, storage } = await fixture({ serializeConnections: true });
  try {
    let prepareCount = 0;
    let releaseBarrier!: () => void;
    const bothPrepared = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const overrides: Partial<MatchCommandRelayDependencies> = {
      prepareEngineContext: () => {
        prepareCount += 1;
        if (prepareCount === 2) releaseBarrier();
        return bothPrepared.then(() => fixedEngineContext());
      },
    };
    // Distinct relay dependency instances model separate command workers, so
    // both requests can evaluate the same observed version before either CAS.
    const leftDependencies = dependencies(storage, overrides);
    const rightDependencies = dependencies(storage, overrides);

    const [left, right] = await Promise.all([
      processMatchCommand(authContext(PLAYER_IDS[0]), endTurn(3), leftDependencies),
      processMatchCommand(authContext(PLAYER_IDS[0]), endTurn(4), rightDependencies),
    ]);
    const outcomes = [left, right];
    assert.equal(outcomes.filter((outcome) => outcome?.status === "accepted").length, 1);
    const stale = outcomes.find((outcome) => outcome?.status === "rejected");
    assert.equal(stale?.status, "rejected");
    if (stale?.status === "rejected") {
      assert.equal(stale.error.code, "STALE_VERSION");
      assert.equal(stale.error.currentVersion, 1);
    }
    assert.equal(prepareCount, 2, "each independent worker evaluates once against the initially observed version");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 1);
    assert.equal((await storage.listMatchEvents(MATCH_ID)).length, 0);
    assert.equal((await storage.listPendingOutbox()).length, 1);
    assert.ok(await storage.findCommandReceipt(PLAYER_IDS[0], commandId(3)));
    assert.ok(await storage.findCommandReceipt(PLAYER_IDS[0], commandId(4)));
  } finally {
    await database.close();
  }
});

test("D04: actor spoofing fails strict validation and another player's card fails ownership checks", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const spoofed = { ...endTurn(5), actorId: PLAYER_IDS[0] };
    const malformed = await processMatchCommand(authContext(PLAYER_IDS[0]), spoofed, deps);
    assert.equal(malformed?.status, "rejected");
    if (malformed?.status === "rejected") assert.equal(malformed.error.code, "BAD_REQUEST");
    assert.equal(await storage.findCommandReceipt(PLAYER_IDS[0], commandId(5)), null);

    const forgedCard: MatchCommand = {
      protocolVersion: 1,
      commandId: commandId(6),
      matchId: MATCH_ID,
      expectedVersion: 0,
      type: "PLAY_CARD",
      payload: { cardInstanceId: "card-" + PLAYER_IDS[1] },
    };
    const rejectedCard = await processMatchCommand(authContext(PLAYER_IDS[0]), forgedCard, deps);
    assert.equal(rejectedCard?.status, "rejected");
    if (rejectedCard?.status === "rejected") assert.equal(rejectedCard.error.code, "ILLEGAL_ACTION");
    assert.equal(prepareCount, 1);
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 0);
    assert.ok(await storage.findCommandReceipt(PLAYER_IDS[0], commandId(6)));
    assert.equal((await storage.listPendingOutbox()).length, 0);
  } finally {
    await database.close();
  }
});

test("known-match rule rejection is saved and replayed without another engine evaluation", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const command = endTurn(7);
    const first = await processMatchCommand(authContext(PLAYER_IDS[1]), command, deps);
    assert.equal(first?.status, "rejected");
    if (first?.status === "rejected") assert.equal(first.error.code, "NOT_YOUR_TURN");

    const replay = await processMatchCommand(authContext(PLAYER_IDS[1]), command, deps);
    assert.deepEqual(replay, first);
    assert.equal(prepareCount, 1);
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 0);
    assert.ok((await storage.findCommandReceipt(PLAYER_IDS[1], commandId(7)))?.outcome);
    assert.deepEqual(await storage.listMatchEvents(MATCH_ID), []);
    assert.deepEqual(await storage.listPendingOutbox(), []);
  } finally {
    await database.close();
  }
});

test("known-match stale version rejection is stored and replayed before engine evaluation", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const command = endTurn(10, 5);

    const first = await processMatchCommand(authContext(PLAYER_IDS[0]), command, deps);
    assert.equal(first?.status, "rejected");
    if (first?.status === "rejected") {
      assert.equal(first.error.code, "STALE_VERSION");
      assert.equal(first.error.currentVersion, 0);
    }
    const replay = await processMatchCommand(authContext(PLAYER_IDS[0]), command, deps);
    assert.deepEqual(replay, first);
    assert.equal(prepareCount, 0);
    assert.ok(await storage.findCommandReceipt(PLAYER_IDS[0], commandId(10)));
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 0);
    assert.deepEqual(await storage.listMatchEvents(MATCH_ID), []);
    assert.deepEqual(await storage.listPendingOutbox(), []);
  } finally {
    await database.close();
  }
});

test("rejection receipt version race reloads state and records the revalidated stale result", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: async ({ state }) => {
        prepareCount += 1;
        if (prepareCount === 1) {
          const external = applyMatchCommand(state, PLAYER_IDS[0], { type: "END_TURN", payload: {} }, fixedEngineContext());
          assert.equal(external.ok, true);
          if (external.ok) {
            await storage.commitMatch({
              matchId: MATCH_ID,
              expectedVersion: 0,
              state: external.state,
              events: [],
              receipt: {
                actorPlayerId: PLAYER_IDS[0],
                commandId: "concurrent-accepted-command",
                requestHash: "concurrent-accepted-hash",
                outcome: {
                  protocolVersion: 1,
                  commandId: "concurrent-accepted-command",
                  status: "accepted",
                  duplicate: false,
                  aggregateVersion: external.state.version,
                  eventSeq: external.state.eventSeq,
                },
              },
              outboxEventId: "concurrent-accepted-outbox",
            });
          }
        }
        return fixedEngineContext();
      },
    });
    const command = endTurn(8);

    const response = await processMatchCommand(authContext(PLAYER_IDS[1]), command, deps);
    assert.equal(response?.status, "rejected");
    if (response?.status === "rejected") {
      assert.equal(response.error.code, "STALE_VERSION");
      assert.equal(response.error.currentVersion, 1);
    }
    const receipt = await storage.findCommandReceipt(PLAYER_IDS[1], commandId(8));
    assert.equal((receipt?.outcome as { error?: { code?: string } } | undefined)?.error?.code, "STALE_VERSION");
    assert.equal(prepareCount, 1, "stale revalidation reads current version without reapplying the engine");

    const replay = await processMatchCommand(authContext(PLAYER_IDS[1]), command, deps);
    assert.deepEqual(replay, response);
    assert.equal(prepareCount, 1);
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 1);
    assert.equal((await storage.listPendingOutbox()).length, 1);
  } finally {
    await database.close();
  }
});

test("stale rejection race re-enters engine evaluation when the competing commit makes expectedVersion current", async () => {
  const { database, storage } = await fixture();
  try {
    let rejectionRaceTriggered = false;
    const racingStorage: MatchCommandRelayDependencies["storage"] = {
      getMatch: storage.getMatch.bind(storage),
      findCommandReceipt: storage.findCommandReceipt.bind(storage),
      commitMatch: storage.commitMatch.bind(storage),
      recordMatchRejection: async (input) => {
        if (!rejectionRaceTriggered) {
          rejectionRaceTriggered = true;
          const current = await storage.getMatch(MATCH_ID);
          assert.ok(current);
          assert.equal(current.version, 0);
          // Model an accepted same-turn action (such as a legal card play): it
          // advances the aggregate version while keeping player-1 as owner.
          const competingState = { ...current.state, version: 1 };
          await storage.commitMatch({
            matchId: MATCH_ID,
            expectedVersion: 0,
            state: competingState,
            events: [],
            receipt: {
              actorPlayerId: PLAYER_IDS[0],
              commandId: "concurrent-accepted-command",
              requestHash: "concurrent-accepted-hash",
              outcome: {
                protocolVersion: 1,
                commandId: "concurrent-accepted-command",
                status: "accepted",
                duplicate: false,
                aggregateVersion: competingState.version,
                eventSeq: competingState.eventSeq,
              },
            },
            outboxEventId: "concurrent-accepted-outbox",
          });
        }
        return storage.recordMatchRejection(input);
      },
    };
    let prepareCount = 0;
    const deps = dependencies(racingStorage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });

    // At version 0 this is stale. A competing same-turn action advances the
    // aggregate to version 1 before the rejection receipt can be recorded.
    // The command must then be re-evaluated at version 1 and accepted.
    const command = endTurn(11, 1);
    const response = await processMatchCommand(authContext(PLAYER_IDS[0]), command, deps);
    assert.deepEqual(response, {
      protocolVersion: 1,
      commandId: commandId(11),
      status: "accepted",
      duplicate: false,
      aggregateVersion: 2,
      eventSeq: 0,
    });
    assert.equal(rejectionRaceTriggered, true);
    assert.equal(prepareCount, 1, "the engine runs against the newly current expected version");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 2);
    assert.equal((await storage.getMatch(MATCH_ID))?.state.turn.currentPlayerId, PLAYER_IDS[1]);
    assert.equal((await storage.listPendingOutbox()).length, 2);
    const receipt = await storage.findCommandReceipt(PLAYER_IDS[0], commandId(11));
    assert.equal((receipt?.outcome as { status?: string } | undefined)?.status, "accepted");
  } finally {
    await database.close();
  }
});

test("a non-member cannot obtain or persist a command receipt", async () => {
  const { database, storage } = await fixture();
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return fixedEngineContext();
      },
    });
    const response = await processMatchCommand(authContext("outside-player"), endTurn(9), deps);
    assert.equal(response?.status, "rejected");
    if (response?.status === "rejected") assert.equal(response.error.code, "NOT_A_PLAYER");
    assert.equal(prepareCount, 0);
    assert.equal(await storage.findCommandReceipt("outside-player", commandId(9)), null);
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 0);
  } finally {
    await database.close();
  }
});

test("T67 advances END_TURN through start and two-card draw in one commit, then replays the receipt", async () => {
  const state = deterministicGameState("bart_cassidy");
  const currentPlayerId = state.turn.currentPlayerId;
  const nextActor = state.seats.find((seat) => seat.public.seatIndex === 1)!;
  const startingHandCount = nextActor.private.handCardInstanceIds.length;
  const { database, storage } = await fixture({ state });
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return registeredRuntimeContext();
      },
    });
    const command = endTurn(101);
    const first = await processMatchCommand(authContext(currentPlayerId), command, deps);
    assert.equal(first?.status, "accepted");
    const after = await storage.getMatch(MATCH_ID);
    assert.ok(after);
    assert.equal(after.version, 1, "END_TURN, start and draw share one aggregate version");
    assert.equal(after.state.version, 1);
    assert.equal(after.state.turn.currentPlayerId, nextActor.public.playerId);
    assert.equal(after.state.turn.phase, "play");
    assert.equal(after.state.seats.find((seat) => seat.public.playerId === nextActor.public.playerId)?.private.handCardInstanceIds.length, startingHandCount + 2);
    assert.equal((await storage.listMatchEvents(MATCH_ID)).length, 2);
    assert.equal((await storage.listPendingOutbox()).length, 1);

    const replay = await processMatchCommand(authContext(currentPlayerId), command, deps);
    assert.equal(replay?.status, "accepted");
    if (replay?.status === "accepted") assert.equal(replay.duplicate, true);
    assert.equal(prepareCount, 1, "a replayed receipt bypasses command and turn runtime evaluation");
    const afterReplay = await storage.getMatch(MATCH_ID);
    assert.equal(afterReplay?.version, 1);
    assert.equal(afterReplay?.state.seats.find((seat) => seat.public.playerId === nextActor.public.playerId)?.private.handCardInstanceIds.length, startingHandCount + 2);
    assert.equal((await storage.listMatchEvents(MATCH_ID)).length, 2);
    assert.equal((await storage.listPendingOutbox()).length, 1);
  } finally {
    await database.close();
  }
});

test("a saved T67 Kit draw prompt resumes through executeTurnDraw and reaches play", async () => {
  const state = deterministicGameState("kit_carlson");
  const currentPlayerId = state.turn.currentPlayerId;
  const nextActor = state.seats.find((seat) => seat.public.seatIndex === 1)!;
  const startingHandCount = nextActor.private.handCardInstanceIds.length;
  const { database, storage } = await fixture({ state });
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return registeredRuntimeContext();
      },
    });
    const ended = await processMatchCommand(authContext(currentPlayerId), endTurn(102), deps);
    assert.equal(ended?.status, "accepted");
    const waiting = await storage.getMatch(MATCH_ID);
    assert.ok(waiting);
    assert.equal(waiting.version, 1);
    assert.equal(waiting.state.turn.phase, "draw");
    assert.equal(waiting.state.resolution.pendingInteraction?.kind, "KIT_CARLSON_PICK");
    assert.equal(waiting.state.resolution.continuations.filter((frame) => frame.kind === "TURN_DRAW").length, 1);
    const pending = waiting.state.resolution.pendingInteraction!;
    const choice = pending.options.find((option) => option.choice === "CHOOSE_CARDS");
    assert.ok(choice);
    const selectedCardInstanceIds = choice.payload.selectedCardInstanceIds as [string, string];

    const response: MatchCommand = {
      protocolVersion: 1,
      commandId: commandId(103),
      matchId: MATCH_ID,
      expectedVersion: waiting.version,
      type: "RESPOND",
      payload: { interactionId: pending.interactionId, choice: "CHOOSE_CARDS", selectedCardInstanceIds },
    };
    const resumed = await processMatchCommand(authContext(nextActor.public.playerId), response, deps);
    assert.equal(resumed?.status, "accepted");
    const after = await storage.getMatch(MATCH_ID);
    assert.ok(after);
    assert.equal(after.version, 2, "the completed draw response commits one version");
    assert.equal(after.state.version, 2);
    assert.equal(after.state.turn.phase, "play");
    assert.equal(after.state.turn.currentPlayerId, nextActor.public.playerId);
    assert.equal(after.state.resolution.pendingInteraction, null);
    assert.equal(after.state.resolution.continuations.length, 0);
    assert.equal(after.state.seats.find((seat) => seat.public.playerId === nextActor.public.playerId)?.private.handCardInstanceIds.length, startingHandCount + 2);

    const replay = await processMatchCommand(authContext(nextActor.public.playerId), response, deps);
    assert.equal(replay?.status, "accepted");
    if (replay?.status === "accepted") assert.equal(replay.duplicate, true);
    assert.equal(prepareCount, 2, "the completed prompt receipt is replayed without a second draw resume");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 2);
  } finally {
    await database.close();
  }
});

test("the registered effect runtime applies PLAY_CARD, resumes RESPOND, and executes Sid ability", async () => {
  const base = deterministicGameState();
  const actorPlayerId = base.turn.currentPlayerId;
  const targetPlayerId = base.seats.find((seat) => seat.public.seatIndex === 1)!.public.playerId;
  let prepared = putCardInHand(base, "bang", actorPlayerId);
  const bangCard = prepared.cardInstanceId;
  prepared = putCardInHand(prepared.state, "missed", targetPlayerId);
  const missedCard = prepared.cardInstanceId;
  const { database, storage } = await fixture({ state: prepared.state });
  try {
    const deps = dependencies(storage, { prepareEngineContext: () => registeredRuntimeContext() });
    const played = await processMatchCommand(authContext(actorPlayerId), {
      protocolVersion: 1,
      commandId: commandId(104),
      matchId: MATCH_ID,
      expectedVersion: 0,
      type: "PLAY_CARD",
      payload: { cardInstanceId: bangCard, targetPlayerId },
    }, deps);
    assert.equal(played?.status, "accepted");
    const pending = await storage.getMatch(MATCH_ID);
    assert.equal(pending?.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
    const interactionId = pending?.state.resolution.pendingInteraction?.interactionId;
    assert.ok(interactionId);

    const responded = await processMatchCommand(authContext(targetPlayerId), {
      protocolVersion: 1,
      commandId: commandId(105),
      matchId: MATCH_ID,
      expectedVersion: 1,
      type: "RESPOND",
      payload: { interactionId, choice: "USE_MISSED", cardInstanceId: missedCard },
    }, deps);
    assert.equal(responded?.status, "accepted");
    const afterResponse = await storage.getMatch(MATCH_ID);
    assert.equal(afterResponse?.state.resolution.pendingInteraction, null);
    assert.ok(afterResponse?.state.zones.discardPileCardInstanceIds.includes(missedCard));
    assert.equal(afterResponse?.state.seats.find((seat) => seat.public.playerId === targetPlayerId)?.public.hp,
      pending?.state.seats.find((seat) => seat.public.playerId === targetPlayerId)?.public.hp);

    const abilityBase = deterministicGameState();
    const sidId = abilityBase.turn.currentPlayerId;
    const sid = abilityBase.seats.find((seat) => seat.public.playerId === sidId)!;
    const abilityState: GameState = {
      ...abilityBase,
      seats: abilityBase.seats.map((seat) => seat.public.playerId === sidId
        ? { ...seat, public: { ...seat.public, characterId: "sid_ketchum", hp: seat.public.maxHp - 1 } }
        : seat),
    };
    const costCardInstanceIds = abilityState.seats.find((seat) => seat.public.playerId === sidId)!.private.handCardInstanceIds.slice(0, 2) as [string, string];
    const abilityFixture = await fixture({ state: abilityState });
    try {
      const ability = await processMatchCommand(authContext(sidId), {
        protocolVersion: 1,
        commandId: commandId(106),
        matchId: MATCH_ID,
        expectedVersion: 0,
        type: "USE_ABILITY",
        payload: { abilityId: "sid-ketchum", cardInstanceIds: costCardInstanceIds },
      }, dependencies(abilityFixture.storage, { prepareEngineContext: () => registeredRuntimeContext() }));
      assert.equal(ability?.status, "accepted");
      const healed = await abilityFixture.storage.getMatch(MATCH_ID);
      assert.equal(healed?.state.seats.find((seat) => seat.public.playerId === sidId)?.public.hp, sid.public.maxHp);
      assert.ok(costCardInstanceIds.every((cardId) => healed?.state.zones.discardPileCardInstanceIds.includes(cardId)));
    } finally {
      await abilityFixture.database.close();
    }
  } finally {
    await database.close();
  }
});

test("a saved Jail start interaction resumes T66, then T67 completes draw before the same commit", async () => {
  const initial = deterministicGameState("lucky_duke");
  const nextActor = initial.seats.find((seat) => seat.public.seatIndex === 1)!;
  let state: GameState = {
    ...initial,
    seats: initial.seats.map((seat) => seat.public.seatIndex === 1
      ? seat
      : { ...seat, public: { ...seat.public, characterId: "bart_cassidy" } }),
  };
  const jail = putCardInPlay(state, "jail", nextActor.public.playerId);
  state = jail.state;
  const currentPlayerId = state.turn.currentPlayerId;
  const { database, storage } = await fixture({ state });
  try {
    let prepareCount = 0;
    const deps = dependencies(storage, {
      prepareEngineContext: () => {
        prepareCount += 1;
        return registeredRuntimeContext();
      },
    });
    const ended = await processMatchCommand(authContext(currentPlayerId), endTurn(107), deps);
    assert.equal(ended?.status, "accepted");
    const waiting = await storage.getMatch(MATCH_ID);
    assert.ok(waiting);
    assert.equal(waiting.version, 1);
    assert.equal(waiting.state.turn.phase, "start");
    assert.equal(waiting.state.turn.currentPlayerId, nextActor.public.playerId);
    assert.equal(waiting.state.resolution.pendingInteraction?.kind, "LUCKY_DRAW");
    assert.equal(waiting.state.resolution.continuations.filter((frame) => frame.kind === "EFFECT_RUNTIME").length, 1);
    const pending = waiting.state.resolution.pendingInteraction!;
    const option = pending.options.find((candidate) => candidate.choice === "SELECT_JUDGMENT");
    assert.ok(option);
    const selectedCardInstanceId = option.payload.selectedCardInstanceId as string;
    const orderedCardInstanceIds = option.payload.orderedCardInstanceIds as [string, string];

    const response: MatchCommand = {
      protocolVersion: 1,
      commandId: commandId(108),
      matchId: MATCH_ID,
      expectedVersion: waiting.version,
      type: "RESPOND",
      payload: { interactionId: pending.interactionId, choice: "SELECT_JUDGMENT", selectedCardInstanceId, orderedCardInstanceIds },
    };
    const resumed = await processMatchCommand(authContext(nextActor.public.playerId), response, deps);
    assert.equal(resumed?.status, "accepted");
    const after = await storage.getMatch(MATCH_ID);
    assert.ok(after);
    assert.equal(after.version, 2, "start effect response and following draw share the response command's single version");
    assert.equal(after.state.version, 2);
    assert.equal(after.state.turn.phase, "play");
    assert.equal(after.state.resolution.pendingInteraction, null);
    assert.equal(after.state.resolution.continuations.length, 0);
    assert.equal(prepareCount, 2);

    const replay = await processMatchCommand(authContext(nextActor.public.playerId), response, deps);
    assert.equal(replay?.status, "accepted");
    if (replay?.status === "accepted") assert.equal(replay.duplicate, true);
    assert.equal(prepareCount, 2, "a start-response receipt prevents the start effect and draw from running twice");
    assert.equal((await storage.getMatch(MATCH_ID))?.version, 2);
  } finally {
    await database.close();
  }
});
