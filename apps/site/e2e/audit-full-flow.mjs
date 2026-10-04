import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const base=new URL(args.base??'http://127.0.0.1:8806');
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname),'Local-only fixture');
const capacity=Number(args.capacity??4);
assert.ok([4,7].includes(capacity));
const guests=[];
async function api(path,body,guest) {
  const response=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:base.origin}),...(guest?{Cookie:guest.cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const value=await response.json();
  if(response.status>=400||value.status==='rejected')throw Error(`${path}: HTTP${response.status} ${JSON.stringify(value.error)}`);
  return {value,cookie:response.headers.get('Set-Cookie')?.split(';',1)[0]};
}
async function guest(index) {
  const {value,cookie}=await api('/api/guest-sessions',{protocolVersion:1,displayName:`검증 참가자 ${index}`});
  const entry={playerId:value.player.playerId,cookie};guests.push(entry);return entry;
}
const command=(type,roomId,expectedVersion,payload)=>({protocolVersion:1,commandId:randomUUID(),...(roomId?{roomId}:{}),expectedVersion,type,payload});
const roomSync=async(g,roomId)=>(await api(`/api/rooms/${roomId}/sync`,{protocolVersion:1,requestId:randomUUID(),roomId,knownVersion:0},g)).value;
const matchSync=async(g,matchId)=>(await api(`/api/matches/${matchId}/sync`,{protocolVersion:1,requestId:randomUUID(),matchId,knownVersion:0,afterEventSeq:0},g)).value;
let roomId=args.room,inviteCode=args.invite,version=0,owner;
if(!roomId) {
  owner=await guest(1);
  const {value}=await api('/api/rooms',command('CREATE_ROOM',null,0,{capacity,rulesetVersion:'base4-ko-online-1.0',displayName:'검증 참가자 1'}),owner);
  roomId=value.roomId;inviteCode=value.inviteCode;version=value.version;
}
const count=owner?capacity-1:capacity-1;
for(let i=0;i<count;i++) {
  const g=await guest(i+2);
  const {value:preview}=await api('/api/rooms/preview',{protocolVersion:1,requestId:randomUUID(),inviteCode},g);
  version=preview.version;
  const {value:joined}=await api(`/api/rooms/${roomId}/commands`,command('JOIN',roomId,version,{inviteCode}),g);
  version=joined.version??version+1;
  const {value:ready}=await api(`/api/rooms/${roomId}/commands`,command('SET_READY',roomId,version,{ready:true}),g);
  version=ready.version??version+1;
}
let matchId;
if(owner) {
  const {value:ready}=await api(`/api/rooms/${roomId}/commands`,command('SET_READY',roomId,version,{ready:true}),owner);
  version=ready.version??version+1;
  const {value:started}=await api(`/api/rooms/${roomId}/commands`,command('START_MATCH',roomId,version,{}),owner);
  matchId=started.activeMatchId;
} else console.log(JSON.stringify({phase:'others-ready',capacity,roomId,roomVersion:version}));

function actionFor(snapshot) {
  const pending=snapshot.pendingInteraction;
  if(pending?.responseOptions?.length) {
    const priority=['TAKE_HIT','YIELD','ACCEPT_ELIMINATION','TAKE_CARD','CHOOSE_CARD','DRAW_FROM_PILE','DRAW_PILE','USE_MISSED','USE_BANG','PLAY_BANG','USE_BEER'];
    const option=priority.map(choice=>pending.responseOptions.find(o=>o.choice===choice)).find(Boolean)??pending.responseOptions[0];
    const payload={...option};
    if(payload.choice==='ORDER_CARDS'&&!payload.orderedCardInstanceIds)payload.orderedCardInstanceIds=pending.discardOrder.allowedCards.slice(0,pending.discardOrder.requiredCount).map(c=>c.cardInstanceId);
    return {type:'RESPOND',payload};
  }
  const cards=new Map((snapshot.selfPrivate?.hand??[]).map(c=>[c.cardInstanceId,c.typeId]));
  const rank=a=>a.type==='END_TURN'?0:a.type==='USE_ABILITY'?10:({bang:100,panic:95,cat_balou:95,gatling:90,indians:90,duel:80,beer:70,saloon:70,stagecoach:50,wells_fargo:50,general_store:50,jail:35}[cards.get(a.payload.cardInstanceId)]??20);
  return [...(snapshot.legalActions??[])].sort((a,b)=>rank(b)-rank(a))[0];
}
async function run(limit,stopAtOwner=true) {
  let accepted=0,responses=0;
  const byId=new Map(guests.map(g=>[g.playerId,g]));
  for(let step=0;step<limit;step++) {
    const overview=await matchSync(guests[0],matchId);
    if(overview.snapshot.status==='completed')return {phase:'completed',accepted,responses,version:overview.version,eventSeq:overview.eventSeq,outcome:overview.snapshot.outcome,rolesRevealed:overview.snapshot.publicTable.players.every(p=>p.role!==null)};
    const actorId=overview.snapshot.pendingInteraction?.currentResponderPlayerId??overview.snapshot.publicTable.turn.currentPlayerId;
    const actor=byId.get(actorId);
    if(!actor)return {phase:'browser-input-needed',accepted,responses,pendingKind:overview.snapshot.pendingInteraction?.kind??null,turnPlayerId:actorId};
    const view=await matchSync(actor,matchId);
    const action=actionFor(view.snapshot);if(!action)throw Error('No legal proposal or responder option');
    const cmd={protocolVersion:1,commandId:randomUUID(),matchId,expectedVersion:view.version,...action};
    const {value:ack}=await api(`/api/matches/${matchId}/commands`,cmd,actor);
    assert.equal(ack.status,'accepted');accepted++;if(action.type==='RESPOND')responses++;
    if(step===0) {
      const {value:duplicate}=await api(`/api/matches/${matchId}/commands`,cmd,actor);assert.equal(duplicate.duplicate,true);
    }
  }
  return {phase:'limit',accepted,responses};
}
if(owner) {
  const result=await run(1200,false);
  assert.equal(result.phase,'completed');assert.ok(result.outcome && result.rolesRevealed);
  const view=await roomSync(owner,roomId);
  const {value:returned}=await api(`/api/rooms/${roomId}/commands`,command('RETURN_TO_LOBBY',roomId,view.version,{}),owner);
  assert.equal(returned.status,'waiting');assert.ok(returned.members.every(m=>m.ready===false));
  const evidence={observedAt:new Date().toISOString(),mode:'local real Worker HTTP, simulated players; NOT full browser or production S09',capacity,result,returnToLobby:true};
  await writeFile(new URL(`../../../outputs/review-2026-10-04/logic-performance-audit/full-flow-${capacity}.json`,import.meta.url),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} else {
  console.log('Awaiting local browser start; send JSON {matchId}, then {run:1} for next simulated players.');
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input) {
    const message=JSON.parse(line);
    if(message.exit)break;
    if(message.matchId)matchId=message.matchId;
    if(message.run)console.log(JSON.stringify(await run(Number(message.run))));
  }
}
