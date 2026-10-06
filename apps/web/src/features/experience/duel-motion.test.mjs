import assert from "node:assert/strict";
import { test } from "node:test";
import { runEngineAcceptanceScenario, findCard, playerId } from "../../../../../packages/test-fixtures/engine/index.ts";
import { BASE_PHYSICAL_CARDS } from "../../../../../packages/catalog/src/cards/index.ts";
import { projectMatchSnapshot } from "../../../../../packages/engine/src/state/projection.ts";
import { syncProjectionInternals } from "../../../../../apps/server/src/projections/sync.ts";
import { advancePresentation } from "./model.ts";

test("A04 real duel responses always animate toward the other participant", () => {
  runEngineAcceptanceScenario({ id: "duel-motion", seats: {
    A: { hand: [{ typeId: "duel" }, { typeId: "bang" }, { typeId: "bang" }] },
    B: { hand: [{ typeId: "bang" }, { typeId: "bang" }] },
  } }, session => {
    assert.ok(session.play("A", findCard(session.state, "duel", { player: "A", zone: "hand" }), "B").ok);
    for (const [index, responder] of ["B", "A", "B", "A"].entries()) {
      const snapshot = projectMatchSnapshot(session.state, playerId("A"), BASE_PHYSICAL_CARDS);
      const before = advancePresentation(null, session.state.version, snapshot, [], Date.now()).cursor;
      const start = session.events.length;
      assert.ok(session.respond(responder, "PLAY_BANG", { cardInstanceId: findCard(session.state, "bang", { player: responder, zone: "hand" }) }).ok);
      const draft = session.events.slice(start).find(event => event.type === "DUEL_BANG_PLAYED");
      assert.ok(draft);
      const event = syncProjectionInternals.projectEvent({ ...draft, eventSeq: index + 1, createdAt: new Date() }, session.state);
      assert.ok(event);
      assert.equal(event.payload.targetPlayerId, playerId(responder === "A" ? "B" : "A"));
      const next = advancePresentation(before, session.state.version, projectMatchSnapshot(session.state, playerId("A"), BASE_PHYSICAL_CARDS), [event], Date.now());
      const shot = next.cues.find(cue => cue.kind === "shot");
      assert.ok(shot);
      assert.equal(shot.actorId, playerId(responder));
      assert.deepEqual(shot.targetIds, [playerId(responder === "A" ? "B" : "A")]);
    }
  });
});
