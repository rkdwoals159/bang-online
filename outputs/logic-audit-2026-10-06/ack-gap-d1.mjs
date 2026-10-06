import assert from 'node:assert/strict';
import {createIsolatedD1} from '../../apps/site/test/storage/d1-test-db.ts';
import {GuestSessionService} from '../../apps/site/src/server/auth/guest-sessions.ts';
import {D1RoomService} from '../../apps/site/src/server/rooms/service.ts';
import {D1MatchService} from '../../apps/site/src/server/matches/service.ts';
import {SitesGameTransport} from '../../apps/web/src/transport/sites-client.ts';
import {routeApiRequest} from '../../apps/site/src/server/routes/index.ts';
import {BASE_PHYSICAL_CARDS} from '../../packages/catalog/src/cards/index.ts';
import {projectMatchSnapshot} from '../../packages/engine/src/state/projection.ts';
import {writeFileSync} from 'node:fs';
const {runtime,db,repository}=await createIsolatedD1();const sessionService=new GuestSessionService(db),rooms=new D1RoomService(db),matches=new D1MatchService(db,{includeMatchProjection:true});
let evidence;
try{
  const guests=[];for(let i=0;i<4;i++)guests.push(await sessionService.create(`Audit ${i}`));
  const player=guest=>guest.response.player.playerId;
  const room=await rooms.createPrivateRoom(player(guests[0]),{capacity:4,rulesetVersion:'base4-ko-online-1.0',commandId:crypto.randomUUID()});let version=room.version;
  for(const guest of guests.slice(1)){const joined=await rooms.joinPrivateRoom(player(guest),{roomId:room.roomId,expectedVersion:version,commandId:crypto.randomUUID(),inviteCode:room.inviteCode},'127.0.0.1');version=joined.version;}
  const started=await rooms.startMatch(player(guests[0]),{roomId:room.roomId,expectedVersion:version,commandId:crypto.randomUUID()});const matchId=started.matchId;
  for(let i=0;i<10;i++){const match=await repository.getMatch(matchId);const p=match.state.resolution.pendingInteraction;if(!p)break;const opt=p.options[0];const ack=await matches.execute(p.actorPlayerIds[0],{protocolVersion:1,commandId:crypto.randomUUID(),matchId,expectedVersion:match.version,type:'RESPOND',payload:{interactionId:p.interactionId,choice:opt.choice,...opt.payload}});assert.equal(ack.status,'accepted');}
  const initial=await repository.getMatch(matchId),state=initial.state;state.seats.forEach(seat=>{seat.public.characterId='willy_the_kid';seat.public.hp=seat.public.maxHp;});
  const source=state.turn.currentPlayerId;
  const physical=BASE_PHYSICAL_CARDS.find(card=>card.typeId==='indians');const id=Object.keys(state.zones.cardsByInstanceId).find(id=>state.zones.cardsByInstanceId[id].cardDefinitionId===physical.definitionId);
  for(const seat of state.seats){seat.private.handCardInstanceIds=seat.private.handCardInstanceIds.filter(card=>card!==id);seat.public.inPlayCardInstanceIds=seat.public.inPlayCardInstanceIds.filter(card=>card!==id);}
  for(const key of ['drawPileCardInstanceIds','discardPileCardInstanceIds','revealedPoolCardInstanceIds'])state.zones[key]=state.zones[key].filter(card=>card!==id);
  state.seats.find(seat=>seat.public.playerId===source).private.handCardInstanceIds.push(id);
  await db.prepare('UPDATE matches SET state_json = ? WHERE id = ?').bind(JSON.stringify(state),matchId).run();
  assert.equal((await matches.execute(source,{protocolVersion:1,commandId:crypto.randomUUID(),matchId,expectedVersion:initial.version,type:'PLAY_CARD',payload:{cardInstanceId:id}})).status,'accepted');
  const opened=await repository.getMatch(matchId),first=opened.state.resolution.pendingInteraction.actorPlayerIds[0];
  const future=opened.state.seats.find(seat=>seat.public.playerId!==source&&seat.public.playerId!==first).public.playerId;
  const futureGuest=guests.find(guest=>player(guest)===future),cookie=`bang_session=${encodeURIComponent(futureGuest.credential)}`;
  const transport=new SitesGameTransport({fetcher:async(path,init)=>routeApiRequest(new Request(`https://site.test${path}`,{...init,headers:{...init.headers,Cookie:cookie,Origin:'https://site.test'}}),{DB:db})});
  await transport.restoreGuestSession();await transport.syncMatch(matchId);
  const pending=projectMatchSnapshot(opened.state,future,BASE_PHYSICAL_CARDS).pendingInteraction;
  const firstPending=opened.state.resolution.pendingInteraction;
  assert.equal((await matches.execute(first,{protocolVersion:1,commandId:crypto.randomUUID(),matchId,expectedVersion:opened.version,type:'RESPOND',payload:{interactionId:firstPending.interactionId,choice:'TAKE_HIT'}})).status,'accepted');
  const ack=await transport.sendMatchCommand({protocolVersion:1,commandId:crypto.randomUUID(),matchId,expectedVersion:opened.version,type:'RESPOND',payload:{interactionId:pending.interactionId,choice:'TAKE_HIT'}});assert.equal(ack.status,'accepted');
  await transport.syncMatch(matchId);
  const events=await repository.listMatchEvents(matchId,opened.eventSeq),hit=events.find(event=>event.type==='INDIANS_HIT');assert.ok(hit);
  const cached=transport.getSnapshot().matches[matchId];assert.ok(!cached.visibleEvents.some(event=>event.eventSeq===hit.eventSeq));
  evidence={id:'A02',scope:'Real isolated D1 services/routes plus production transport',initialEventSeq:opened.eventSeq,cachedEventSeq:cached.eventSeq,omittedHitSeq:hit.eventSeq,omittedHitTarget:first,ackVersion:ack.aggregateVersion,cachePublicTypes:cached.visibleEvents.map(event=>event.type)};transport.disconnect();
}finally{await runtime.dispose();}
writeFileSync(new URL('./ack-gap-d1.json',import.meta.url),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
