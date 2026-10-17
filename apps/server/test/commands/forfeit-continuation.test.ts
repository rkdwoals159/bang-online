import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import { executeTurnDraw } from "../../../../packages/engine/src/turn/draw.ts";
import { parseMatchState } from "../../../../packages/engine/src/state/schema.ts";
import { prepareGameRuntime } from "../../src/commands/runtime-context.ts";

for(const character of ["kit_carlson","jesse_jones"]){
  test(`departure resumes a saved ${character} private draw and moves to the next living player`,()=>{
    const random={nextFloat:()=>.51};const state=initializeGame({players:Array.from({length:5},(_,i)=>({playerId:`p${i}`,displayName:`Player ${i}`})),random});
    const roles=["sheriff","outlaw","deputy","outlaw","renegade"] as const;
    state.seats.forEach((seat,index)=>{seat.private.roleId=roles[index]!;seat.public.characterId="willy_the_kid";seat.public.roleRevealed=index===0;});
    const actor=state.seats[1]!;actor.public.characterId=character;state.turn.currentPlayerId=actor.public.playerId;state.turn.phase="draw";
    let serial=0;const nextInteractionIdentity=()=>({interactionId:`i${++serial}`,createdAt:new Date(0).toISOString()});
    const opened=executeTurnDraw({state,actorPlayerId:actor.public.playerId,random,nextInteractionIdentity,continuationFrameId:"private-draw"});
    assert.ok(opened.ok);if(!opened.ok)return;assert.ok(opened.output.state.resolution.pendingInteraction);
    const marked={...opened.output.state,forfeitedPlayerIds:[actor.public.playerId]};
    const result=prepareGameRuntime("draw-forfeit").continueTurnPhases(marked);
    assert.equal(result.state.seats[1]!.public.eliminated,true);assert.notEqual(result.state.turn.currentPlayerId,actor.public.playerId);
    assert.equal(result.state.resolution.pendingInteraction,null);assert.equal(result.state.turn.phase,"play");parseMatchState(result.state,1);
  });
}
