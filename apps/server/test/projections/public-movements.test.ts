import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import { syncProjectionInternals } from "../../src/projections/sync.ts";
import { formatPublicEvent } from "../../../web/src/features/status/model.ts";
import type { MatchEventRecord } from "../../src/storage/repository.ts";

const state = initializeGame({ players: ["a", "b", "c", "d"].map(playerId => ({ playerId, displayName: playerId })), random: { nextFloat: () => 0 } });
const id = (type: string) => Object.values(state.zones.cardsByInstanceId).find(card => card.cardDefinitionId.startsWith(`${type}_`))!.cardInstanceId;
const names = new Map([["a", "사용자"], ["b", "상대"]]);
const project = (type: string, payload: Record<string, unknown>, actorPlayerId = "a") => syncProjectionInternals.projectEvent({
  eventId: "history", eventSeq: 1, version: 1, type, actorPlayerId, createdAt: new Date("2026-10-06T00:00:00Z"),
  payload: { ...payload, secret: "private-sentinel", rank: "K", suit: "SPADES" },
} as MatchEventRecord, state);

test("all equipment types, jail and dynamite placement have named public records", () => {
  for (const type of ["barrel", "mustang", "scope", "volcanic", "schofield", "remington", "carabine", "winchester", "jail", "dynamite"]) {
    const card = id(type);
    const event = project("CARD_TRANSFERRED", { cardInstanceId: card, sourceCardInstanceId: card,
      fromPlayerId: "a", fromZone: "hand", toPlayerId: type === "jail" ? "b" : "a", toZone: "in_play" });
    assert.equal(event?.type, "CARD_EQUIPPED", type); assert.equal(event!.payload.cardType, type);
    assert.match(formatPublicEvent(event!, names)!, /장착/); assert.doesNotMatch(JSON.stringify(event), /private-sentinel|SPADES|cardInstanceId/);
  }
});

test("turn discards, Sid costs, weapon replacement and elimination cleanup are public discard records", () => {
  for (const fromZone of ["hand", "in_play"]) {
    const event = project("CARD_DISCARDED", { cardInstanceId: id("beer"), sourceCardInstanceId: null,
      ownerPlayerId: "a", fromZone, toZone: "discard" });
    assert.equal(event?.type, "PUBLIC_CARD_DISCARDED"); assert.match(formatPublicEvent(event!, names)!, /맥주 1장을 버렸/);
    assert.doesNotMatch(JSON.stringify(event), /private-sentinel|SPADES|cardInstanceId/);
  }
});

test("Panic and Cat records name the public effect and target zone without a hidden hand face", () => {
  for (const [source, movement, expected] of [["panic", "CARD_TRANSFERRED", "PANIC_USED"], ["cat_balou", "CARD_DISCARDED", "CAT_BALOU_USED"]]) {
    const event = project(movement, { sourceCardInstanceId: id(source), cardInstanceId: id("beer"), fromPlayerId: "b",
      ownerPlayerId: "b", fromZone: "hand", toPlayerId: "a", toZone: source === "panic" ? "hand" : "discard" });
    assert.equal(event?.type, expected); assert.match(formatPublicEvent(event!, names)!, /상대 님의 손패 1장/);
    assert.doesNotMatch(JSON.stringify(event), /beer|private-sentinel|SPADES|cardInstanceId/);
  }
});

test("Jesse, El Gringo and Vulture transfers omit private hand identities", () => {
  const event = project("CARD_TRANSFERRED", { sourceCardInstanceId: id("bang"), cardInstanceId: id("beer"),
    fromPlayerId: "b", fromZone: "hand", toPlayerId: "a", toZone: "hand" });
  assert.equal(event?.type, "PUBLIC_CARD_TAKEN"); assert.match(formatPublicEvent(event!, names)!, /손패 1장을 가져/);
  assert.deepEqual(event!.payload, { actorPlayerId: "a", targetPlayerId: "b", targetZone: "hand" });
});

test("General Store picks and public discard-pile pickups name the already public card", () => {
  for (const [fromZone, expected] of [["revealed_pool", "STORE_CARD_PICKED"], ["discard", "DISCARD_CARD_TAKEN"]]) {
    const event = project("CARD_TRANSFERRED", { sourceCardInstanceId: id("general_store"), cardInstanceId: id("beer"),
      fromZone, toZone: "hand", toPlayerId: "b" });
    assert.equal(event?.type, expected); assert.equal(event!.payload.actorPlayerId, "b");
    assert.match(formatPublicEvent(event!, names)!, /맥주/);
  }
});

test("Stagecoach, Wells Fargo and General Store usage has a record; hidden draws expose count only", () => {
  for (const type of ["stagecoach", "wells_fargo", "general_store"]) {
    const source = id(type);
    const used = project("CARD_DISCARDED", { sourceCardInstanceId: source, cardInstanceId: source,
      ownerPlayerId: "a", fromZone: "hand", toZone: "discard" });
    assert.equal(used?.type, "CARD_USED"); assert.equal(used!.payload.cardType, type);
  }
  for (const type of ["CARD_DRAWN", "CARD_TRANSFERRED"]) {
    const draw = project(type, { cardInstanceId: id("beer"), playerId: "a", toPlayerId: "a", fromZone: "draw_pile", toZone: "hand" });
    assert.equal(draw?.type, "CARD_RECEIVED"); assert.deepEqual(draw!.payload, { actorPlayerId: "a", count: 1 });
    assert.doesNotMatch(JSON.stringify(draw), /beer|SPADES|private-sentinel|cardInstanceId/);
  }
  assert.equal(project("CARD_TRANSFERRED", { cardInstanceId: id("beer"), fromZone: "revealed_pool", toZone: "draw_pile" }), undefined,
    "Kit's private returned deck card is not a public record");
});

test("elimination, reshuffle, resource exhaustion and match completion have readable records", () => {
  for (const [type, payload] of [["PLAYER_ELIMINATED", { playerId: "b", cause: "BANG" }],
    ["MATCH_COMPLETED", { winningFaction: "outlaws", winningPlayerIds: ["b"] }],
    ["DRAW_PILE_RESHUFFLED", { cardInstanceIds: [id("beer")] }],
    ["RULE_RESOURCE_EXHAUSTED", { requestedCount: 3, fulfilledCount: 1 }]] as const) {
    const event = project(type, payload); assert.ok(event); assert.ok(formatPublicEvent(event, names));
    assert.doesNotMatch(JSON.stringify(event), /private-sentinel|SPADES|cardInstanceId/);
  }
});
