import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGame } from "../../../packages/engine/src/setup/initialize.ts";
import { applyMatchCommand, type EngineCommand } from "../../../packages/engine/src/commands/index.ts";
import { earlyTablewideInteraction, projectTablewideAttack } from "../../../packages/engine/src/effects/runtime/index.ts";
import { BASE_PHYSICAL_CARDS } from "../../../packages/catalog/src/cards/index.ts";
import { parseMatchState } from "../../../packages/engine/src/state/schema.ts";
import type { GameState } from "../../../packages/engine/src/state/types.ts";
import { prepareGameRuntime } from "../src/commands/runtime-context.ts";
import { hasAutomaticEliminationCleanup, hasUnavoidableElimination } from "../src/commands/elimination-cleanup.ts";

function setup() {
  const state = initializeGame({ players: Array.from({length:5},(_,i)=>({playerId:`p${i}`,displayName:`Player ${i}`})), random:{nextFloat:()=>.51} });
  const roles = ["sheriff", "outlaw", "deputy", "outlaw", "renegade"] as const;
  state.seats.forEach((seat,i)=>{seat.public.playerId=`p${i}`;seat.private.roleId=roles[i]!;seat.public.roleRevealed=i===0;seat.public.characterId="willy_the_kid";});
  state.turn.currentPlayerId="p4";state.turn.phase="play";
  return { state, runtime:prepareGameRuntime("cleanup-test") };
}
function give(state:GameState,type:string,playerId:string) {
  const card=BASE_PHYSICAL_CARDS.find(card=>card.typeId===type)!;
  const id=Object.values(state.zones.cardsByInstanceId).find(instance=>instance.cardDefinitionId===card.definitionId)!.cardInstanceId;
  state.zones.drawPileCardInstanceIds=state.zones.drawPileCardInstanceIds.filter(x=>x!==id);
  for(const seat of state.seats){seat.private.handCardInstanceIds=seat.private.handCardInstanceIds.filter(x=>x!==id);}
  state.seats.find(seat=>seat.public.playerId===playerId)!.private.handCardInstanceIds.push(id);return id;
}
function apply(state:GameState,actor:string,command:EngineCommand,runtime:ReturnType<typeof prepareGameRuntime>) {
  const result=applyMatchCommand(state,actor,command,runtime);assert.ok(result.ok,JSON.stringify(result));
  if(!result.ok)throw new Error();return result.state;
}
function respond(state:GameState,choice:string,runtime:ReturnType<typeof prepareGameRuntime>) {
  const prompt=state.resolution.pendingInteraction!;
  return apply(state,prompt.actorPlayerIds[0]!,{type:"RESPOND",payload:{interactionId:prompt.interactionId,choice}} as EngineCommand,runtime);
}

for(const type of ["indians","gatling"]){
  for(const victimIndex of [0,1,3]){
    test(`${type}: automatic cleanup resumes queued responses after target ${victimIndex} is eliminated`,()=>{
      const {state,runtime}=setup();const victim=state.seats[victimIndex]!;
      // Keep a living Sheriff so the full attack can finish in every target position.
      if(victimIndex===0){state.seats[0]!.private.roleId="outlaw";state.seats[2]!.private.roleId="sheriff";}
      victim.public.hp=1;
      const attack=give(state,type,"p4");
      const held=[...victim.private.handCardInstanceIds];
      let next=apply(state,"p4",{type:"PLAY_CARD",payload:{cardInstanceId:attack}},runtime);
      for(const seat of next.seats){
        const early=earlyTablewideInteraction(next,seat.public.playerId);
        if(early)next=apply(next,seat.public.playerId,{type:"RESPOND",payload:{interactionId:early.interactionId,choice:"TAKE_HIT"}},runtime);
      }
      for(let i=0;i<8&&next.resolution.pendingInteraction?.kind!=="DEATH_RESCUE";i++)next=respond(next,"TAKE_HIT",runtime);
      assert.equal(next.resolution.pendingInteraction?.kind,"DEATH_RESCUE");
      const rescue=runtime.continueTurnPhases(next);
      if(next.resolution.pendingInteraction!.options.length>1)assert.equal(rescue.state,next,"never decline a legal rescue on their behalf");
      else assert.equal(rescue.state.seats[victimIndex]!.public.eliminated,true,"no recovery option needs no confirmation");
      next=respond(next,"ACCEPT_ELIMINATION",runtime);
      assert.ok(hasAutomaticEliminationCleanup(next));
      // A serialized legacy snapshot must use the same path as a newly generated prompt.
      const restored=parseMatchState(JSON.parse(JSON.stringify(next)),1);
      const cleaned=prepareGameRuntime("cleanup-test").continueTurnPhases(restored);
      assert.equal(cleaned.state.resolution.pendingInteraction,null);
      assert.equal(projectTablewideAttack(cleaned.state),null);
      assert.deepEqual(cleaned.state.seats[victimIndex]!.private.handCardInstanceIds,[]);
      assert.ok(held.every(id=>cleaned.state.zones.discardPileCardInstanceIds.includes(id)));
      assert.ok(cleaned.events.some(event=>event.type==="CARD_DISCARDED"));
      assert.equal(cleaned.state.status,"playing");parseMatchState(cleaned.state,1);
      const repeated=runtime.continueTurnPhases(cleaned.state);assert.deepEqual(repeated.events,[]);
      assert.deepEqual(repeated.state,cleaned.state,"no duplicate discards or damage");
    });
  }
}

test("living player's hand-limit discard is never chosen automatically",()=>{
  const {state,runtime}=setup();state.seats[4]!.public.hp=1;
  const pending=apply(state,"p4",{type:"END_TURN",payload:{}},runtime);
  assert.equal(pending.resolution.pendingInteraction?.kind,"DISCARDS_ORDER");
  assert.equal(hasAutomaticEliminationCleanup(pending),false);
  assert.equal(runtime.continueTurnPhases(pending).state,pending);
});

test("Vulture Sam still inherits cards instead of automatic discarding",()=>{
  const {state,runtime}=setup();state.seats[2]!.public.characterId="vulture_sam";state.seats[1]!.public.hp=1;
  state.turn.currentPlayerId="p0";
  const bang=give(state,"bang","p0");
  const held=[...state.seats[1]!.private.handCardInstanceIds];
  let next=apply(state,"p0",{type:"PLAY_CARD",payload:{cardInstanceId:bang,targetPlayerId:"p1"}},runtime);
  next=respond(next,"TAKE_HIT",runtime);next=respond(next,"ACCEPT_ELIMINATION",runtime);
  next=runtime.continueTurnPhases(next).state;
  assert.ok(held.every(id=>next.seats[2]!.private.handCardInstanceIds.includes(id)));
  assert.equal(next.resolution.pendingInteraction,null);parseMatchState(next,1);
});

test("automatic victim cleanup stops at the living Sheriff's penalty choice",()=>{
  const {state,runtime}=setup();state.turn.currentPlayerId="p0";
  state.seats[1]!.private.roleId="deputy";state.seats[2]!.private.roleId="outlaw";state.seats[1]!.public.hp=1;
  const bang=give(state,"bang","p0");
  let next=apply(state,"p0",{type:"PLAY_CARD",payload:{cardInstanceId:bang,targetPlayerId:"p1"}},runtime);
  next=respond(next,"TAKE_HIT",runtime);next=respond(next,"ACCEPT_ELIMINATION",runtime);
  const cleaned=runtime.continueTurnPhases(next).state;
  assert.equal(cleaned.resolution.pendingInteraction?.kind,"DISCARDS_ORDER");
  assert.deepEqual(cleaned.resolution.pendingInteraction?.actorPlayerIds,["p0"]);
  assert.equal(hasAutomaticEliminationCleanup(cleaned),false);
  assert.deepEqual(cleaned.seats[1]!.private.handCardInstanceIds,[]);
});

test("automatic cleanup preserves an unanswered future Indians target",()=>{
  const {state,runtime}=setup();state.seats[0]!.private.roleId="outlaw";state.seats[2]!.private.roleId="sheriff";state.seats[0]!.public.hp=1;
  const card=give(state,"indians","p4");
  let next=apply(state,"p4",{type:"PLAY_CARD",payload:{cardInstanceId:card}},runtime);
  next=respond(next,"TAKE_HIT",runtime);next=respond(next,"ACCEPT_ELIMINATION",runtime);
  const cleaned=runtime.continueTurnPhases(next).state;
  assert.equal(cleaned.resolution.pendingInteraction?.kind,"INDIANS_RESPONSE");
  assert.deepEqual(cleaned.resolution.pendingInteraction?.actorPlayerIds,["p1"]);
  assert.ok(projectTablewideAttack(cleaned));assert.equal(cleaned.seats[1]!.public.hp,next.seats[1]!.public.hp);
});

function clearBeer(state:GameState,playerId:string){
  const seat=state.seats.find(s=>s.public.playerId===playerId)!;
  const beerIds=seat.private.handCardInstanceIds.filter(id=>BASE_PHYSICAL_CARDS.find(c=>c.definitionId===state.zones.cardsByInstanceId[id]!.cardDefinitionId)?.typeId==="beer");
  seat.private.handCardInstanceIds=seat.private.handCardInstanceIds.filter(id=>!beerIds.includes(id));state.zones.drawPileCardInstanceIds.push(...beerIds);
}
function lethalBang(state:GameState,runtime:ReturnType<typeof prepareGameRuntime>){
  state.turn.currentPlayerId="p0";state.seats[1]!.public.hp=1;
  const bang=give(state,"bang","p0");
  return respond(apply(state,"p0",{type:"PLAY_CARD",payload:{cardInstanceId:bang,targetPlayerId:"p1"}},runtime),"TAKE_HIT",runtime);
}
test("no recovery: lethal damage, discarded cards and elimination finish without player input",()=>{
  const {state,runtime}=setup();clearBeer(state,"p1");const next=lethalBang(state,runtime);
  assert.ok(hasUnavoidableElimination(next));
  const result=runtime.continueTurnPhases(parseMatchState(JSON.parse(JSON.stringify(next)),1));
  assert.equal(result.state.seats[1]!.public.eliminated,true);assert.deepEqual(result.state.seats[1]!.private.handCardInstanceIds,[]);
  assert.equal(result.state.resolution.pendingInteraction,null);assert.equal(result.state.resolution.pendingDeath,null);
  assert.equal(result.events.filter(e=>e.type==="PLAYER_ELIMINATED").length,1);parseMatchState(result.state,1);
  assert.deepEqual(runtime.continueTurnPhases(result.state).events,[]);
});
test("a usable Beer keeps rescue choices and is never silently consumed or declined",()=>{
  const {state,runtime}=setup();give(state,"beer","p1");const next=lethalBang(state,runtime);
  assert.equal(hasUnavoidableElimination(next),false);assert.ok(next.resolution.pendingInteraction?.options.some(o=>o.choice==="USE_BEER"));
  assert.equal(runtime.continueTurnPhases(next).state,next);
});
test("Sid's two-card rescue keeps the manual choice even with no Beer",()=>{
  const {state,runtime}=setup();state.seats[1]!.public.characterId="sid_ketchum";clearBeer(state,"p1");
  const next=lethalBang(state,runtime);assert.ok(next.resolution.pendingInteraction?.options.some(o=>o.choice==="USE_SID"));
  assert.equal(hasUnavoidableElimination(next),false);assert.equal(runtime.continueTurnPhases(next).state,next);
});
test("Beer cannot stall automatic elimination in the final two-player duel",()=>{
  const {state,runtime}=setup();give(state,"beer","p1");
  for(const seat of state.seats.slice(2)){seat.public.eliminated=true;seat.public.hp=0;state.zones.discardPileCardInstanceIds.push(...seat.private.handCardInstanceIds);seat.private.handCardInstanceIds=[];}
  const next=lethalBang(state,runtime);assert.ok(hasUnavoidableElimination(next));
  const result=runtime.continueTurnPhases(next);assert.equal(result.state.status,"completed");assert.equal(result.state.seats[1]!.public.eliminated,true);
});
