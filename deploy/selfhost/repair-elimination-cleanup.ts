/** Targeted maintenance: dry-run by default; uses the same automatic policy as live commands. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { decodeMatchState, parseMatchState } from "../../packages/engine/src/state/schema.js";
import { projectMatchSnapshot } from "../../packages/engine/src/state/projection.js";
import { BASE_PHYSICAL_CARDS } from "../../packages/catalog/src/cards/index.js";
import { parseMatchSyncResponse } from "../../packages/contracts/src/validation.js";
import { hasAutomaticEliminationCleanup, hasUnavoidableElimination } from "../../apps/server/src/commands/elimination-cleanup.js";
import { prepareGameRuntime } from "../../apps/server/src/commands/runtime-context.js";

const [roomId, mode] = process.argv.slice(2);
if ((roomId!=="--scan" && !/^r_[\w-]+$/.test(roomId ?? "")) || (mode && (mode !== "--apply" || roomId==="--scan"))) throw new Error("Usage: repair-elimination-cleanup.mjs ROOM_ID [--apply] | --scan");
const base = homedir() + "/.bang-online";
const { Client } = createRequire(base + "/current/package.json")("pg");
const env = Object.fromEntries((await readFile(base + "/config/server.env", "utf8")).split("\n").filter(line => line.includes("=")).map(line => [line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
const db = new Client({connectionString:env.DATABASE_URL});
await db.connect();
try {
  if(roomId==="--scan"){
    const rows=(await db.query("SELECT r.id AS room_id,m.version,m.state_json FROM rooms r JOIN LATERAL (SELECT version,status,state_json FROM matches WHERE room_id=r.id ORDER BY created_at DESC,started_at DESC,id DESC LIMIT 1) m ON true WHERE r.status<>'closed' AND m.status='playing'")).rows;
    const pending=rows.flatMap((row:any)=>{const state=decodeMatchState(row.state_json);return hasAutomaticEliminationCleanup(state)||hasUnavoidableElimination(state)?[{roomId:row.room_id,version:Number(row.version),pendingKind:state.resolution.pendingInteraction!.kind}]:[];});
    console.log(JSON.stringify({checked:rows.length,pending}));
  }else{
  await db.query("BEGIN");
  const room = (await db.query("SELECT status FROM rooms WHERE id=$1 FOR UPDATE",[roomId])).rows[0];
  if (!room || room.status === "closed") throw new Error("Room missing or closed.");
  const row = (await db.query("SELECT id,version,event_seq,state_json FROM matches WHERE room_id=$1 ORDER BY created_at DESC,started_at DESC,id DESC LIMIT 1 FOR UPDATE",[roomId])).rows[0];
  if (!row) throw new Error("Match missing.");
  const state = decodeMatchState(row.state_json);
  if (state.version !== Number(row.version) || state.eventSeq !== Number(row.event_seq)) throw new Error("Match metadata mismatch.");
  if (!hasAutomaticEliminationCleanup(state) && !hasUnavoidableElimination(state)) {
    await db.query("ROLLBACK");console.log(JSON.stringify({roomId,changed:false,reason:"No automatic elimination pending",version:state.version}));
  } else {
    const settled = prepareGameRuntime(row.id).continueTurnPhases(state);
    const next = {...settled.state,version:state.version+1,eventSeq:state.eventSeq+settled.events.length};
    parseMatchState(next,1);
    for (const seat of next.seats) {
      const parsed = parseMatchSyncResponse({protocolVersion:1,requestId:"cleanup-repair",matchId:row.id,version:next.version,eventSeq:next.eventSeq,requiresFullSnapshot:true,snapshot:projectMatchSnapshot(next,seat.public.playerId,BASE_PHYSICAL_CARDS),visibleEvents:[]});
      if (!parsed.ok) throw new Error("Repaired projection failed its contract.");
    }
    if (mode === "--apply") {
      await db.query("UPDATE matches SET status=$2,version=$3,event_seq=$4,state_json=$5::jsonb,updated_at=now(),ended_at=CASE WHEN $2='completed' THEN COALESCE(ended_at,now()) ELSE ended_at END WHERE id=$1",[row.id,next.status,next.version,next.eventSeq,JSON.stringify(next)]);
      for (const [index,event] of settled.events.entries()) await db.query("INSERT INTO match_events (match_id,event_seq,event_id,version,type,actor_player_id,payload_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",[row.id,state.eventSeq+index+1,`evt_${randomUUID()}`,next.version,event.type,event.actorPlayerId,JSON.stringify(event.payload)]);
      for (const seat of next.seats) await db.query("UPDATE match_players SET alive=$3,eliminated_at=CASE WHEN $3 THEN NULL ELSE COALESCE(eliminated_at,now()) END WHERE match_id=$1 AND player_id=$2",[row.id,seat.public.playerId,!seat.public.eliminated]);
      await db.query("INSERT INTO outbox (event_id,aggregate_id,aggregate_version,event_seq,kind,payload_json) VALUES ($1,$2,$3,$4,'match:changed',$5::jsonb)",[`evt_${randomUUID()}`,row.id,next.version,next.eventSeq,JSON.stringify({matchId:row.id,version:next.version,eventSeq:next.eventSeq})]);
      await db.query("COMMIT");
    } else await db.query("ROLLBACK");
    console.log(JSON.stringify({roomId,applied:mode==="--apply",fromVersion:state.version,toVersion:next.version,eventCount:settled.events.length,status:next.status,pendingKind:next.resolution.pendingInteraction?.kind??null,remainingEffects:next.resolution.effectQueue.length,validatedProjections:next.seats.length}));
  }
  }
} catch(error) {await db.query("ROLLBACK");throw error;} finally {await db.end();}
