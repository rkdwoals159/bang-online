import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseMatchCommand,
  parseCommandAck,
  parseLegalActionProposal,
  parseMatchOutcomeForStatus,
  parseMatchOutcomeSummary,
  parseMatchSyncRequest,
  parseMatchSyncResponse,
  parsePendingInteractionView,
  parseRoomCommand,
  parseRoomPreviewRequest,
  parseRoomPreviewResponse,
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseRoomView,
  parseSyncRejectedResponse,
} from "../src/validation.ts";
const base = { protocolVersion: 1, commandId: "018f8e3d-1234-4123-8123-123456789abc", expectedVersion: 0 };
const readFixture = (name) => JSON.parse(readFileSync(new URL(`../../test-fixtures/protocol/${name}`, import.meta.url), "utf8"));

test("public General Store faces are validated only in the matching interaction", () => {
  const response = readFixture("match-sync.response.valid.json");
  response.snapshot.pendingInteraction = { interactionId: "store-1", kind: "GENERAL_STORE_PICK",
    allowedChoices: ["CHOOSE_CARD"], currentResponderPlayerId: response.snapshot.viewer.playerId,
    step: { current: 1, total: 4 }, responseOptions: [
      { interactionId: "store-1", choice: "CHOOSE_CARD", selectedCardInstanceId: "public-beer" },
    ] };
  response.snapshot.publicTable.generalStoreCards = [{ cardInstanceId: "public-beer", typeId: "beer", rank: "6", suit: "HEARTS" }];
  assert.equal(parseMatchSyncResponse(response).ok, true);
  const invalid = structuredClone(response);
  invalid.snapshot.publicTable.generalStoreCards[0].privatePayload = "hidden";
  assert.equal(parseMatchSyncResponse(invalid).ok, false);
  const duplicates = structuredClone(response);
  duplicates.snapshot.publicTable.generalStoreCards.push(duplicates.snapshot.publicTable.generalStoreCards[0]);
  assert.equal(parseMatchSyncResponse(duplicates).ok, false);
  response.snapshot.pendingInteraction.kind = "KIT_CARLSON_PICK";
  assert.equal(parseMatchSyncResponse(response).ok, false);
});

test("parses the documented match command and rejects a missing protocol version", () => {
  const valid = { ...base, matchId: "m1", type: "PLAY_CARD", payload: { cardInstanceId: "opaque-1", targetPlayerId: "p2" } };
  assert.equal(parseMatchCommand(valid).ok, true);
  const missingVersion = { ...valid };
  delete missingVersion.protocolVersion;
  assert.equal(parseMatchCommand(missingVersion).ok, false);
  assert.equal(parseMatchCommand(readFixture("match-command.valid.json")).ok, true);
  assert.equal(parseMatchCommand(readFixture("match-command.missing-version.invalid.json")).ok, false);
  assert.equal(parseMatchCommand(readFixture("match-command.actor-id.invalid.json")).ok, false);
});

test("rejects client supplied identity, unknown fields and malformed response card selection", () => {
  assert.equal(parseMatchCommand({ ...base, actorId: "p1", matchId: "m1", type: "END_TURN", payload: {} }).ok, false);
  assert.equal(parseMatchCommand({ ...base, matchId: "m1", type: "END_TURN", payload: { ignored: true } }).ok, false);
  assert.equal(parseMatchCommand({ ...base, matchId: "m1", type: "RESPOND", payload: { interactionId: "i1", choice: "USE_SID", cardInstanceIds: ["one"] } }).ok, false);
});

test("parses the runtime-backed Jesse, Pedro and Lucky responses with strict payloads", () => {
  const respond = (payload) => parseMatchCommand({ ...base, matchId: "m1", type: "RESPOND", payload });
  for (const payload of [
    { interactionId: "i1", choice: "DRAW_FROM_PILE" },
    { interactionId: "i1", choice: "TAKE_FROM_HAND", sourcePlayerId: "p3" },
    { interactionId: "i1", choice: "SELECT_SOURCE", source: "DISCARD_TOP" },
    { interactionId: "i1", choice: "SELECT_SOURCE", source: "DRAW_PILE_TOP" },
    { interactionId: "i1", choice: "SELECT_JUDGMENT", selectedCardInstanceId: "c1", orderedCardInstanceIds: ["c1", "c2"] },
  ]) assert.equal(respond(payload).ok, true, JSON.stringify(payload));

  for (const payload of [
    { interactionId: "i1", choice: "DRAW_FROM_PILE", sourcePlayerId: "p3" },
    { interactionId: "i1", choice: "TAKE_FROM_HAND" },
    { interactionId: "i1", choice: "TAKE_FROM_HAND", sourcePlayerId: "p3", cardInstanceId: "secret" },
    { interactionId: "i1", choice: "SELECT_SOURCE", source: "UNKNOWN" },
    { interactionId: "i1", choice: "SELECT_SOURCE" },
    { interactionId: "i1", choice: "SELECT_JUDGMENT", selectedCardInstanceId: "c1", orderedCardInstanceIds: ["c1"] },
    { interactionId: "i1", choice: "SELECT_JUDGMENT", selectedCardInstanceId: "c1", orderedCardInstanceIds: ["c1", "c2"], extra: true },
  ]) assert.equal(respond(payload).ok, false, JSON.stringify(payload));
});

test("pending views accept current runtime options and ORDER_CARDS template separately from command payload", () => {
  for (const fixtureName of [
    "pending.jesse-source.valid.json",
    "pending.pedro-source.valid.json",
    "pending.lucky-judgment.valid.json",
    "pending.order-cards-template.valid.json",
  ]) {
    assert.equal(parsePendingInteractionView(readFixture(fixtureName), "player-2").ok, true, fixtureName);
  }

  const orderTemplate = readFixture("pending.order-cards-template.valid.json");
  assert.equal(parsePendingInteractionView(orderTemplate, "player-2").ok, true);
  assert.equal(parseMatchCommand({
    ...base,
    matchId: "m1",
    type: "RESPOND",
    payload: { interactionId: orderTemplate.interactionId, choice: "ORDER_CARDS" },
  }).ok, false, "the pending template is not a complete command");
  assert.equal(parseMatchCommand({
    ...base,
    matchId: "m1",
    type: "RESPOND",
    payload: { interactionId: orderTemplate.interactionId, choice: "ORDER_CARDS", orderedCardInstanceIds: ["c1"] },
  }).ok, true, "the actual response command includes the submitted order");
  assert.equal(parsePendingInteractionView({
    ...orderTemplate,
    allowedChoices: ["ORDER_CARDS"],
    responseOptions: [{ interactionId: orderTemplate.interactionId, choice: "ORDER_CARDS", source: "DRAW_PILE_TOP" }],
  }, "player-2").ok, false, "stored option payload must remain strict");
});

test("validates room creation and readiness", () => {
  assert.equal(parseRoomCommand({ ...base, type: "CREATE_ROOM", payload: { capacity: 6, rulesetVersion: "base4-ko-online-1.0", displayName: "player" } }).ok, true);
  assert.equal(parseRoomCommand({ ...base, type: "CREATE_ROOM", payload: { capacity: 8, rulesetVersion: "base4-ko-online-1.0", displayName: "player" } }).ok, false);
  assert.equal(parseRoomCommand({ ...base, roomId: "r1", type: "SET_READY", payload: { ready: true, actorId: "forged" } }).ok, false);
  assert.equal(parseRoomCommand({ ...base, roomId: "r1", type: "RETURN_TO_LOBBY", payload: {} }).ok, true);
  assert.equal(parseRoomCommand(readFixture("room-command.return-to-lobby.valid.json")).ok, true);
  assert.equal(parseRoomCommand({ ...base, roomId: "r1", type: "RETURN_TO_LOBBY", payload: { ready: true } }).ok, false);
  assert.equal(parseRoomCommand(readFixture("room-command.valid.json")).ok, true);
});

test("strictly parses room:preview requests and keeps preview replies free of invite/session secrets", () => {
  assert.equal(parseRoomPreviewRequest(readFixture("room-preview.request.valid.json")).ok, true);
  assert.equal(parseRoomPreviewRequest(readFixture("room-preview.request.extra-secret.invalid.json")).ok, false);
  assert.equal(parseRoomPreviewRequest(readFixture("room-preview.request.missing-invite.invalid.json")).ok, false);
  assert.deepEqual(parseRoomPreviewRequest({ protocolVersion: 2, requestId: "r", inviteCode: "ABCD" }), {
    ok: false,
    code: "BAD_REQUEST",
    path: "$.protocolVersion",
  });

  const success = readFixture("room-preview.response.success.json");
  assert.equal(parseRoomPreviewResponse(success).ok, true);
  assert.deepEqual(Object.keys(success).sort(), ["occupancy", "protocolVersion", "requestId", "roomId", "status", "version"]);
  assert.equal(success.status, "waiting");
  assert.ok(Number.isSafeInteger(success.version) && success.version >= 0);
  assert.ok(Number.isSafeInteger(success.occupancy) && success.occupancy >= 0);
  assert.equal("inviteCode" in success, false);
  assert.equal("sessionSecret" in success, false);
  const rejected = readFixture("room-preview.response.invite-invalid.json");
  assert.deepEqual(Object.keys(rejected).sort(), ["error", "protocolVersion", "requestId", "status"]);
  assert.deepEqual(Object.keys(rejected.error).sort(), ["code"]);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error.code, "INVITE_INVALID");
  assert.equal("inviteCode" in rejected, false);
  assert.equal("sessionSecret" in rejected, false);
  const malformedPreview = readFixture("room-preview.response.bad-request.json");
  const rateLimitedPreview = readFixture("room-preview.response.rate-limited.json");
  assert.equal(parseRoomPreviewResponse(rejected).ok, true);
  assert.equal(parseRoomPreviewResponse(malformedPreview).ok, true);
  assert.equal(parseRoomPreviewResponse(rateLimitedPreview).ok, true);
  assert.equal(malformedPreview.error.code, "BAD_REQUEST");
  assert.deepEqual(Object.keys(malformedPreview.error).sort(), ["code"]);
  assert.deepEqual(Object.keys(rateLimitedPreview.error).sort(), ["code", "retryAfterMs"]);
  assert.ok(Number.isSafeInteger(rateLimitedPreview.error.retryAfterMs) && rateLimitedPreview.error.retryAfterMs > 0);

  for (const fixtureName of [
    "room-preview.response.success.secret-field.invalid.json",
    "room-preview.response.rejected.invite-field.invalid.json",
    "room-preview.response.rejected.secret-error-field.invalid.json",
  ]) {
    assert.equal(parseRoomPreviewResponse(readFixture(fixtureName)).ok, false, fixtureName);
  }
  assert.equal(parseRoomPreviewResponse({
    protocolVersion: 1, requestId: "r", roomId: "room", version: -1, occupancy: 0, status: "waiting",
  }).ok, false);
  assert.equal(parseRoomPreviewResponse({
    protocolVersion: 1, requestId: "r", roomId: "room", version: 1, occupancy: 0, status: "unknown",
  }).ok, false);
  assert.equal(parseRoomPreviewResponse({
    protocolVersion: 1, requestId: "r", status: "rejected", error: { code: "FORBIDDEN" },
  }).ok, false);
  for (const retryAfterMs of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const error = retryAfterMs === undefined
      ? { code: "RATE_LIMITED" }
      : { code: "RATE_LIMITED", retryAfterMs };
    assert.equal(parseRoomPreviewResponse({
      protocolVersion: 1, requestId: "r", status: "rejected", error,
    }).ok, false);
  }
  assert.equal(parseRoomPreviewResponse({
    protocolVersion: 1, requestId: "r", status: "rejected", error: { code: "INVITE_INVALID", retryAfterMs: 1 },
  }).ok, false);
  assert.equal(parseRoomPreviewResponse({
    protocolVersion: 1, requestId: "r", status: "rejected", error: { code: "RATE_LIMITED", retryAfterMs: 100, extra: true },
  }).ok, false);
});

test("strictly parses room:sync requests with exact keys and non-negative versions", () => {
  assert.equal(parseRoomSyncRequest(readFixture("room-sync.request.valid.json")).ok, true);
  assert.equal(parseRoomSyncRequest(readFixture("room-sync.request.extra-key.invalid.json")).ok, false);
  assert.equal(parseRoomSyncRequest(readFixture("room-sync.request.invalid-version.invalid.json")).ok, false);
  assert.equal(parseRoomSyncRequest({ protocolVersion: 1, requestId: "", roomId: "r1", knownVersion: 0 }).ok, false);
  assert.equal(parseRoomSyncRequest({ protocolVersion: 1, requestId: "r1", roomId: "r1", knownVersion: Number.MAX_SAFE_INTEGER + 1 }).ok, false);
});

test("strictly parses RoomView and room:sync responses with active-match routing and consistent viewer", () => {
  const waiting = readFixture("room-sync.response.waiting.valid.json");
  const inGame = readFixture("room-sync.response.in-game.valid.json");
  assert.equal(parseRoomSyncResponse(waiting).ok, true);
  assert.equal(parseRoomSyncResponse(inGame).ok, true);
  assert.equal(parseRoomView(waiting.room).ok, true);
  assert.equal(waiting.room.activeMatchId, null);
  assert.equal(typeof inGame.room.activeMatchId, "string");

  for (const fixtureName of [
    "room-sync.response.missing-active-match.invalid.json",
    "room-sync.response.status-match-mismatch.invalid.json",
    "room-sync.response.viewer-not-member.invalid.json",
    "room-sync.response.owner-flag.invalid.json",
    "room-sync.response.extra-field.invalid.json",
  ]) {
    assert.equal(parseRoomSyncResponse(readFixture(fixtureName)).ok, false, fixtureName);
  }
  assert.equal(parseRoomView({ ...waiting.room, activeMatchId: 7 }).ok, false);
  assert.equal(parseRoomSyncResponse({ ...waiting, room: { ...waiting.room, roomId: "other" } }).ok, false);
});

test("strictly parses match:sync requests and shares non-disclosing sync rejection DTOs", () => {
  assert.equal(parseMatchSyncRequest(readFixture("match-sync.request.valid.json")).ok, true);
  assert.equal(parseMatchSyncRequest(readFixture("match-sync.request.extra-key.invalid.json")).ok, false);
  assert.equal(parseMatchSyncRequest(readFixture("match-sync.request.invalid-cursor.invalid.json")).ok, false);
  assert.deepEqual(parseMatchSyncRequest({
    protocolVersion: 1,
    requestId: "req-1",
    matchId: "m1",
    knownVersion: 0,
    afterEventSeq: 0,
    deckOrder: [],
  }), { ok: false, code: "BAD_REQUEST", path: "$" });

  for (const fixtureName of [
    "sync.response.not-found-or-forbidden.json",
    "sync.response.bad-request.json",
    "sync.response.recovery-required.json",
  ]) {
    const rejected = readFixture(fixtureName);
    assert.equal(parseSyncRejectedResponse(rejected).ok, true);
    assert.deepEqual(Object.keys(rejected).sort(), ["error", "protocolVersion", "requestId", "status"]);
    assert.deepEqual(Object.keys(rejected.error).sort(), ["code"]);
    assert.equal(rejected.status, "rejected");
    assert.ok(["BAD_REQUEST", "NOT_FOUND_OR_FORBIDDEN", "RECOVERY_REQUIRED"].includes(rejected.error.code));
    assert.equal("roomId" in rejected, false);
    assert.equal("matchId" in rejected, false);
    assert.equal("sessionSecret" in rejected, false);
  }
  for (const fixtureName of [
    "sync.response.resource-id.invalid.json",
    "sync.response.recovery-required.resource-id.invalid.json",
    "sync.response.secret-error-field.invalid.json",
  ]) {
    assert.equal(parseSyncRejectedResponse(readFixture(fixtureName)).ok, false, fixtureName);
  }
  assert.equal(parseSyncRejectedResponse({
    protocolVersion: 1,
    requestId: "req-1",
    status: "rejected",
    error: { code: "NOT_FOUND_OR_FORBIDDEN", message: "extra field" },
  }).ok, false);
  assert.equal(parseSyncRejectedResponse({
    protocolVersion: 1,
    requestId: "req-1",
    status: "accepted",
    error: { code: "BAD_REQUEST" },
  }).ok, false);
});

test("strictly parses accepted/rejected command acknowledgements and excludes extra fields", () => {
  const accepted = readFixture("command-ack.accepted.valid.json");
  const rejected = readFixture("command-ack.rejected.valid.json");
  assert.equal(parseCommandAck(accepted).ok, true);
  assert.equal(parseCommandAck(rejected).ok, true);
  assert.equal(parseCommandAck(readFixture("command-ack.extra-field.invalid.json")).ok, false);
  assert.equal(parseCommandAck(readFixture("command-ack.rejected.extra-error.invalid.json")).ok, false);
  const missingEventSeq = { ...accepted };
  delete missingEventSeq.eventSeq;
  assert.equal(parseCommandAck(missingEventSeq).ok, false);
  const invalidRetry = { ...rejected, error: { ...rejected.error, retryAfterMs: -1 } };
  assert.equal(parseCommandAck(invalidRetry).ok, false);
});

test("strictly parses viewer-scoped match:sync responses and ordered visible event cursors", () => {
  assert.equal(parseMatchSyncResponse(readFixture("match-sync.response.valid.json")).ok, true);
  for (const fixtureName of [
    "match-sync.response.extra-field.invalid.json",
    "match-sync.response.nested-private-field.invalid.json",
    "match-sync.response.event-order.invalid.json",
    "match-sync.response.event-cursor.invalid.json",
  ]) {
    assert.equal(parseMatchSyncResponse(readFixture(fixtureName)).ok, false, fixtureName);
  }
  const missingViewer = readFixture("match-sync.response.valid.json");
  delete missingViewer.snapshot.viewer.playerId;
  assert.equal(parseMatchSyncResponse(missingViewer).ok, false);
  const invalidPendingViewer = readFixture("match-sync.response.valid.json");
  invalidPendingViewer.snapshot.pendingInteraction = {
    interactionId: "interaction-1",
    kind: "DUEL_RESPONSE",
    allowedChoices: ["USE_MISSED"],
    currentResponderPlayerId: "p2",
    step: { current: 1, total: 1 },
  };
  assert.equal(parseMatchSyncResponse(invalidPendingViewer).ok, false);
});

test("legal action proposals contain only canonical command types and payloads", () => {
  for (const fixtureName of [
    "legal-action.play-card.valid.json",
    "legal-action.use-ability.valid.json",
    "legal-action.end-turn.valid.json",
  ]) {
    const action = readFixture(fixtureName);
    assert.equal(parseLegalActionProposal(action).ok, true, fixtureName);
    assert.deepEqual(Object.keys(action).sort(), ["payload", "type"]);
  }

  for (const fixtureName of [
    "legal-action.respond.invalid.json",
    "legal-action.command-envelope.invalid.json",
    "legal-action.extra-payload.invalid.json",
  ]) {
    assert.equal(parseLegalActionProposal(readFixture(fixtureName)).ok, false, fixtureName);
  }
  assert.equal(parseLegalActionProposal({ type: "END_TURN", payload: { ignored: true } }).ok, false);
  assert.equal(parseLegalActionProposal({ type: "PLAY_CARD", payload: { cardInstanceId: "self-card", targetZone: "SECRET" } }).ok, false);
});

test("pending response options are exclusive to the current responder and progress contains no choices", () => {
  const responder = readFixture("pending.responder.valid.json");
  assert.equal(parsePendingInteractionView(responder, "player-2").ok, true);
  assert.equal(parsePendingInteractionView(responder, "player-1").ok, false, "a different viewer must not receive response options");
  assert.deepEqual(Object.keys(responder).sort(), [
    "allowedChoices", "currentResponderPlayerId", "interactionId", "kind", "responseOptions", "step",
  ]);
  assert.equal(responder.responseOptions.every((option) => option.interactionId === responder.interactionId), true);

  const progress = readFixture("pending.progress.valid.json");
  assert.equal(parsePendingInteractionView(progress, "player-1").ok, true);
  assert.deepEqual(Object.keys(progress).sort(), [
    "allowedChoices", "currentResponderPlayerId", "interactionId", "kind", "step",
  ]);
  assert.deepEqual(progress.allowedChoices, []);
  assert.equal("responseOptions" in progress, false);
  assert.equal("context" in progress, false);
  assert.equal("cardInstanceId" in progress, false);

  for (const fixtureName of [
    "pending.responder-wrong-interaction.invalid.json",
    "pending.responder-context-leak.invalid.json",
  ]) {
    assert.equal(parsePendingInteractionView(readFixture(fixtureName), "player-2").ok, false, fixtureName);
  }
  for (const fixtureName of [
    "pending.progress-options-leak.invalid.json",
    "pending.progress-choice-leak.invalid.json",
    "pending.progress-hand-id-leak.invalid.json",
  ]) {
    assert.equal(parsePendingInteractionView(readFixture(fixtureName), "player-1").ok, false, fixtureName);
  }
  assert.equal(parsePendingInteractionView({ ...progress, step: { current: 0, total: 2 } }, "player-1").ok, false);
  assert.equal(parsePendingInteractionView({ ...responder, allowedChoices: ["TAKE_HIT"] }, "player-2").ok, false);

  const discardOrder = readFixture("pending.discard-order.responder.valid.json");
  assert.equal(parsePendingInteractionView(discardOrder, "player-2").ok, true);
  assert.equal(parsePendingInteractionView(discardOrder, "player-1").ok, false);
  assert.equal(parsePendingInteractionView({ ...progress, discardOrder: discardOrder.discardOrder }, "player-1").ok, false);
  for (const fixtureName of [
    "pending.discard-order.too-many.invalid.json",
    "pending.discard-order.missing.invalid.json",
    "pending.other-kind.discard-order.invalid.json",
  ]) {
    assert.equal(parsePendingInteractionView(readFixture(fixtureName), "player-2").ok, false, fixtureName);
  }
  const duplicateCandidates = structuredClone(discardOrder);
  duplicateCandidates.discardOrder.allowedCards[1] = { ...duplicateCandidates.discardOrder.allowedCards[0] };
  assert.equal(parsePendingInteractionView(duplicateCandidates, "player-2").ok, false);
});

test("winner summary is public only for completed snapshots and rejects unrelated state", () => {
  const outcome = readFixture("match-outcome.completed.valid.json");
  assert.equal(parseMatchOutcomeSummary(outcome).ok, true);
  assert.equal(parseMatchOutcomeForStatus("completed", outcome).ok, true);
  assert.deepEqual(parseMatchOutcomeForStatus("playing", undefined), { ok: true, value: undefined });
  assert.equal(parseMatchOutcomeForStatus("playing", outcome).ok, false);
  assert.equal(parseMatchOutcomeForStatus("completed", undefined).ok, false);
  assert.equal(parseMatchOutcomeForStatus("unknown", undefined).ok, false);
  assert.equal(parseMatchOutcomeSummary(readFixture("match-outcome.extra-secret.invalid.json")).ok, false);
  assert.equal(parseMatchOutcomeSummary(readFixture("match-outcome.duplicate-winner.invalid.json")).ok, false);
  assert.equal(parseMatchOutcomeSummary({ winningFaction: "unknown", winningPlayerIds: ["player-1"] }).ok, false);
});
