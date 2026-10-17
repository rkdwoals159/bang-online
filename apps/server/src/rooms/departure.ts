import { randomUUID } from "node:crypto";
import { parseMatchState } from "../../../../packages/engine/src/state/schema.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import { prepareGameRuntime } from "../commands/runtime-context.js";
import type { PgClientLike } from "../storage/database.js";

/** Called under the room row lock. The match lock serializes against every card command. */
export async function forfeitLatestMatch(client: PgClientLike, roomId: string, playerId: string): Promise<void> {
  const result = await client.query<{ id: string; version: string | number; event_seq: string | number; state_json: GameState }>(
    `SELECT id, version, event_seq, state_json FROM matches WHERE room_id = $1
     ORDER BY created_at DESC, started_at DESC, id DESC LIMIT 1 FOR UPDATE`, [roomId]);
  const match = result.rows[0];
  if (!match) return;
  const state = parseMatchState(match.state_json, 1);
  if (state.version !== Number(match.version) || state.eventSeq !== Number(match.event_seq)) throw new Error("Departure match metadata mismatch.");
  if (state.status === "completed" || state.status === "recovery_required") return;
  if (!state.seats.some(seat => seat.public.playerId === playerId)) throw new Error("Departure player has no match seat.");
  const marked: GameState = { ...state, forfeitedPlayerIds: [...new Set([...(state.forfeitedPlayerIds ?? []), playerId])] };
  const settled = prepareGameRuntime(match.id).continueTurnPhases(marked);
  const drafts = [{ type: "PLAYER_LEFT", actorPlayerId: playerId, payload: { playerId } }, ...settled.events];
  const next = { ...settled.state, version: state.version + 1, eventSeq: state.eventSeq + drafts.length };
  parseMatchState(next, 1);
  await client.query(`UPDATE matches SET status=$2, version=$3, event_seq=$4, state_json=$5::jsonb, updated_at=now(),
    ended_at=CASE WHEN $2='completed' THEN COALESCE(ended_at,now()) ELSE ended_at END WHERE id=$1`,
    [match.id, next.status, next.version, next.eventSeq, JSON.stringify(next)]);
  for (const [index, draft] of drafts.entries()) {
    await client.query(`INSERT INTO match_events (match_id,event_seq,event_id,version,type,actor_player_id,payload_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [match.id, state.eventSeq + index + 1, `evt_${randomUUID()}`,
      next.version, draft.type, draft.actorPlayerId, JSON.stringify(draft.payload)]);
  }
  for (const seat of next.seats) {
    await client.query(`UPDATE match_players SET alive=$3,
      eliminated_at=CASE WHEN $3 THEN NULL ELSE COALESCE(eliminated_at,now()) END
      WHERE match_id=$1 AND player_id=$2`, [match.id, seat.public.playerId, !seat.public.eliminated]);
  }
  await client.query(`INSERT INTO outbox (event_id,aggregate_id,aggregate_version,event_seq,kind,payload_json)
    VALUES ($1,$2,$3,$4,'match:changed',$5::jsonb)`, [`evt_${randomUUID()}`,match.id,next.version,next.eventSeq,
    JSON.stringify({ matchId: match.id, version: next.version, eventSeq: next.eventSeq })]);
}
