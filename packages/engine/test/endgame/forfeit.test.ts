import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGame } from "../../src/setup/initialize.ts";
import { applyMatchCommand, type ApplyMatchCommandContext, type EngineCommand } from "../../src/commands/index.ts";
import { createEffectRegistry } from "../../src/effects/registry.ts";
import { createEffectCommandHandlers } from "../../src/effects/runtime/index.ts";
import { settleForfeits } from "../../src/endgame/forfeit.ts";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { parseMatchState } from "../../src/state/schema.ts";
import type { GameState } from "../../src/state/types.ts";

function setup() {
  const random = { nextFloat: () => .51 };
  const state = initializeGame({ players: Array.from({length:5},(_,i)=>({playerId:`p${i}`,displayName:`Player ${i}`})),random });
  const roles = ["sheriff", "outlaw", "deputy", "outlaw", "renegade"] as const;
  state.seats.forEach((seat,index)=> { seat.private.roleId=roles[index]!; seat.public.roleRevealed=index===0; seat.public.characterId="willy_the_kid"; });
  state.turn.currentPlayerId=state.seats[0]!.public.playerId; state.turn.phase="play";
  let serial=0;
  const context: ApplyMatchCommandContext={random,interaction:{interactionId:"discard",createdAt:new Date(0).toISOString()},
    handlers:createEffectCommandHandlers({registry:createEffectRegistry(),nextInteractionIdentity:()=>({interactionId:`i${++serial}`,createdAt:new Date(0).toISOString()})})};
  return {state,context};
}
function give(state: GameState,type:string,playerId:string) {
  const card=BASE_PHYSICAL_CARDS.find(card=>card.typeId===type)!;
  const id=Object.values(state.zones.cardsByInstanceId).find(item=>item.cardDefinitionId===card.definitionId)!.cardInstanceId;
  state.zones.drawPileCardInstanceIds=state.zones.drawPileCardInstanceIds.filter(x=>x!==id);
  state.zones.discardPileCardInstanceIds=state.zones.discardPileCardInstanceIds.filter(x=>x!==id);
  state.zones.revealedPoolCardInstanceIds=state.zones.revealedPoolCardInstanceIds.filter(x=>x!==id);
  state.seats.forEach(seat=>{seat.private.handCardInstanceIds=seat.private.handCardInstanceIds.filter(x=>x!==id);seat.public.inPlayCardInstanceIds=seat.public.inPlayCardInstanceIds.filter(x=>x!==id);});
  state.seats.find(seat=>seat.public.playerId===playerId)!.private.handCardInstanceIds.push(id); return id;
}
function apply(state:GameState,actor:string,command:EngineCommand,context:ApplyMatchCommandContext) {
  const result=applyMatchCommand(state,actor,command,context);assert.ok(result.ok,JSON.stringify(result));if(!result.ok)throw new Error();return result.state;
}
function mark(state:GameState,id:string){return {...state,forfeitedPlayerIds:[...(state.forfeitedPlayerIds??[]),id]};}

test("forfeit clears cards, reveals role, keeps other players and has no outlaw kill reward",()=>{
  const {state,context}=setup(); const victim=state.seats[1]!,otherHands=state.seats.map(s=>s.private.handCardInstanceIds.length);
  const cards=[...victim.private.handCardInstanceIds,...victim.public.inPlayCardInstanceIds];
  const result=settleForfeits(mark(state,victim.public.playerId),context);
  const departed=result.state.seats[1]!;assert.equal(departed.public.eliminated,true);assert.equal(departed.public.hp,0);assert.equal(departed.public.roleRevealed,true);
  assert.deepEqual(departed.private.handCardInstanceIds,[]);assert.ok(cards.every(id=>result.state.zones.discardPileCardInstanceIds.includes(id)));
  result.state.seats.forEach((s,i)=>{if(i!==1)assert.equal(s.private.handCardInstanceIds.length,otherHands[i]);});
  assert.equal(result.state.status,"playing");parseMatchState(result.state,1);assert.equal(result.events.filter(e=>e.type==="PLAYER_ELIMINATED").length,1);
});
test("Vulture Sam inherits forfeited hand and equipment, including an unexploded Dynamite",()=>{
  const {state,context}=setup();const victim=state.seats[1]!,sam=state.seats[2]!;sam.public.characterId="vulture_sam";
  const dynamite=give(state,"dynamite",victim.public.playerId);victim.private.handCardInstanceIds=victim.private.handCardInstanceIds.filter(id=>id!==dynamite);victim.public.inPlayCardInstanceIds.push(dynamite);
  const cards=[...victim.private.handCardInstanceIds,...victim.public.inPlayCardInstanceIds];
  const result=settleForfeits(mark(state,victim.public.playerId),context);
  assert.ok(cards.every(id=>result.state.seats[2]!.private.handCardInstanceIds.includes(id)));assert.equal(result.state.seats[1]!.public.inPlayCardInstanceIds.length,0);parseMatchState(result.state,1);
});
test("leaving Sheriff ends the match through existing faction victory rules",()=>{
  const {state,context}=setup();const result=settleForfeits(mark(state,state.seats[0]!.public.playerId),context);
  assert.equal(result.state.status,"completed");assert.equal(result.state.outcome?.winningFaction,"outlaws");assert.ok(result.state.seats.every(s=>s.public.roleRevealed));
});
test("current player's forfeit advances to a living player",()=>{
  const {state,context}=setup();const victim=state.seats[1]!;state.turn.currentPlayerId=victim.public.playerId;
  const result=settleForfeits(mark(state,victim.public.playerId),context);assert.equal(result.state.turn.currentPlayerId,state.seats[2]!.public.playerId);assert.equal(result.state.turn.phase,"start");
});
for(const type of ["gatling","indians"]){
  test(`${type}: departed future responder never blocks other players and is eliminated after the effect`,()=>{
    const {state,context}=setup();const actor=state.seats[0]!.public.playerId,victim=state.seats[2]!.public.playerId;
    for(const seat of state.seats)give(state,type==="gatling"?"missed":"bang",seat.public.playerId);
    const attack=give(state,type,actor);
    let next=apply(state,actor,{type:"PLAY_CARD",payload:{cardInstanceId:attack}},context);
    const pendingId=next.resolution.pendingInteraction!.interactionId;
    next=settleForfeits(mark(next,victim),context).state;
    assert.equal(next.resolution.pendingInteraction!.interactionId,pendingId,"another player's response must stay untouched");
    for(let step=0;step<20&&next.resolution.pendingInteraction;step++){
      const prompt=next.resolution.pendingInteraction;
      next=apply(next,prompt.actorPlayerIds[0]!,{type:"RESPOND",payload:{interactionId:prompt.interactionId,choice:"TAKE_HIT"}},context);
      next=settleForfeits(next,context).state;
    }
    assert.equal(next.resolution.pendingInteraction,null);assert.equal(next.seats.find(s=>s.public.playerId===victim)!.public.eliminated,true);parseMatchState(next,1);
  });
}
for(const type of ["bang","duel"]){
  test(`${type}: leaving the current responder finishes their prompt without input`,()=>{
    const {state,context}=setup();const actor=state.seats[0]!.public.playerId,victim=state.seats[1]!.public.playerId;
    give(state,type==="bang"?"missed":"bang",victim);const card=give(state,type,actor);
    const opened=apply(state,actor,{type:"PLAY_CARD",payload:{cardInstanceId:card,targetPlayerId:victim}},context);
    const result=settleForfeits(mark(opened,victim),context);assert.equal(result.state.seats[1]!.public.eliminated,true);assert.equal(result.state.resolution.pendingInteraction,null);parseMatchState(result.state,1);
  });
}
test("departed player in death rescue accepts elimination and cannot stall cleanup",()=>{
  const {state,context}=setup();const actor=state.seats[0]!.public.playerId,victim=state.seats[1]!.public.playerId;state.seats[1]!.public.hp=1;
  give(state,"beer",victim);const card=give(state,"bang",actor);
  let opened=apply(state,actor,{type:"PLAY_CARD",payload:{cardInstanceId:card,targetPlayerId:victim}},context);
  if(opened.resolution.pendingInteraction?.kind==="BANG_RESPONSE") opened=apply(opened,victim,{type:"RESPOND",payload:{interactionId:opened.resolution.pendingInteraction.interactionId,choice:"TAKE_HIT"}},context);
  assert.equal(opened.resolution.pendingInteraction?.kind,"DEATH_RESCUE");
  const result=settleForfeits(mark(opened,victim),context);assert.equal(result.state.seats[1]!.public.eliminated,true);assert.equal(result.state.resolution.pendingInteraction,null);parseMatchState(result.state,1);
});
test("General Store: leaving chooser is automated, while other choices and the shared pool survive",()=>{
  const {state,context}=setup();const actor=state.seats[0]!.public.playerId,victim=state.seats[1]!.public.playerId;
  const card=give(state,"general_store",actor);let next=apply(state,actor,{type:"PLAY_CARD",payload:{cardInstanceId:card}},context);
  next=settleForfeits(mark(next,victim),context).state;
  for(let step=0;step<20&&next.resolution.pendingInteraction;step++){
    const prompt=next.resolution.pendingInteraction,option=prompt.options[0]!;
    next=apply(next,prompt.actorPlayerIds[0]!,{type:"RESPOND",payload:{...option.payload,interactionId:prompt.interactionId,choice:option.choice}} as EngineCommand,context);
    next=settleForfeits(next,context).state;
  }
  assert.equal(next.zones.revealedPoolCardInstanceIds.length,0);assert.equal(next.seats[1]!.public.eliminated,true);parseMatchState(next,1);
});
test("stored departure IDs are validated and survive serialization",()=>{
  const {state}=setup();const marked=mark(state,state.seats[1]!.public.playerId);assert.deepEqual(parseMatchState(JSON.parse(JSON.stringify(marked)),1).forfeitedPlayerIds,marked.forfeitedPlayerIds);
  assert.throws(()=>parseMatchState({...state,forfeitedPlayerIds:["unknown"]},1));assert.throws(()=>parseMatchState({...marked,forfeitedPlayerIds:[...marked.forfeitedPlayerIds,...marked.forfeitedPlayerIds]},1));
});

test("forfeit during hand-limit ordering finishes the discard without waiting for the departed owner",()=>{
  const {state,context}=setup();const actor=state.seats[1]!;state.turn.currentPlayerId=actor.public.playerId;actor.public.hp=1;
  const opened=apply(state,actor.public.playerId,{type:"END_TURN",payload:{}},context);assert.equal(opened.resolution.pendingInteraction?.kind,"DISCARDS_ORDER");
  const result=settleForfeits(mark(opened,actor.public.playerId),context);assert.equal(result.state.resolution.pendingInteraction,null);
  assert.equal(result.state.seats[1]!.public.eliminated,true);assert.notEqual(result.state.turn.currentPlayerId,actor.public.playerId);parseMatchState(result.state,1);
});
