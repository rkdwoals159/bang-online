import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusPanel, type ResultRoomTransport } from "../src/features/status/StatusPanel.js";
import type { MatchStatusSync } from "../src/features/status/model.js";
import type { PublicMatchEvent } from "../../../packages/contracts/src/protocol.js";

const occurredAt = new Date(Date.now() - 59_000).toISOString();
const makeEvent = (eventSeq: number): PublicMatchEvent => ({ eventSeq, occurredAt, type: "BEER_USED", payload: { actorPlayerId: "a", healed: false } });
const snapshot: MatchStatusSync["snapshot"] = {
  status: "playing", viewer: { playerId: "a", seatIndex: 0, mode: "active" },
  publicTable: { players: [
    { playerId: "a", displayName: "테스트", seatIndex: 0, characterId: "bart_cassidy", hp: 4, maxHp: 4, eliminated: false, handCount: 0, role: "sheriff", inPlay: [] },
    { playerId: "b", displayName: "상대", seatIndex: 1, characterId: "black_jack", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: null, inPlay: [] },
  ], turn: { currentPlayerId: "a", phase: "play" }, deckCount: 50, publicDiscard: { topCard: null, count: 0 } },
  selfPrivate: { role: "sheriff", hand: [] }, pendingInteraction: null,
};
function Fixture() {
  const [events, setEvents] = useState(() => Array.from({ length: 140 }, (_, i) => makeEvent(i + 41)));
  const [loads, setLoads] = useState(0);
  const transport: ResultRoomTransport = {
    async sendRoomCommand() { throw new Error("Unused fixture command"); },
    async syncRoom() { throw new Error("Unused fixture sync"); },
    async getMatchHistory(matchId, beforeEventSeq = 41) {
      setLoads(count => count + 1);
      return { protocolVersion: 1, requestId: "fixture-history", matchId, beforeEventSeq,
        events: Array.from({ length: 40 }, (_, i) => makeEvent(i + 1)), nextBeforeEventSeq: null };
    },
  };
  return <main style={{ maxWidth: 900, margin: "20px auto", fontFamily: "sans-serif" }}>
    <button onClick={() => setEvents(rows => [...rows, makeEvent(rows.at(-1)!.eventSeq + 1)])}>새 이벤트 발생</button>
    <output aria-label="과거 조회 횟수">조회 {loads}회</output>
    <StatusPanel initialLogOpen matchId="history-fixture" transport={transport}
      sync={{ version: events.length, snapshot, visibleEvents: events }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
