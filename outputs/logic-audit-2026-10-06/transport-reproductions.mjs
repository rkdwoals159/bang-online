import assert from 'node:assert/strict';
import { SitesGameTransport } from '../../apps/web/src/transport/sites-client.ts';
import { initializeGame } from '../../packages/engine/src/setup/initialize.ts';
import { projectMatchSnapshot } from '../../packages/engine/src/state/projection.ts';
import { BASE_PHYSICAL_CARDS } from '../../packages/catalog/src/cards/index.ts';
import { writeFileSync } from 'node:fs';
const state=initializeGame({players:Array.from({length:4},(_,i)=>({playerId:`p${i}`,displayName:`P${i}`})),random:{nextFloat:()=>.5}});
const snapshot=projectMatchSnapshot(state,'p0',BASE_PHYSICAL_CARDS);
const guest={protocolVersion:1,player:{playerId:'p0',displayName:'P0'},sessionExpiresAt:'9999-12-31T23:59:59.999Z'};
const event=seq=>({eventSeq:seq,occurredAt:'2026-10-06T00:00:00Z',type:'INDIANS_HIT',payload:{targetPlayerId:'p1',damage:1}});
const sync=(request,version,eventSeq,events=[])=>({protocolVersion:1,requestId:request.requestId,matchId:'m',version,eventSeq,requiresFullSnapshot:false,snapshot,visibleEvents:events});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
class Source {readyState=0;listeners=new Map();addEventListener(k,f){this.listeners.set(k,f);}close(){this.readyState=2;}open(){this.readyState=1;this.onopen?.(new Event('open'));}invalidate(id,version,eventSeq){this.listeners.get('invalidation')?.({lastEventId:String(id),data:JSON.stringify({kind:'match',aggregateId:'m',version,eventSeq})});}}
const records=[];
{
  let calls=0, failNext=false;const source=new Source();
  const transport=new SitesGameTransport({fallbackPollIntervalMs:10,eventSourceFactory:()=>source,createId:()=>`r-${++calls}`,
    fetcher:async(url,init)=>{
      if(url==='/api/guest-sessions')return Response.json(guest);
      const request=JSON.parse(init.body);
      if(failNext){failNext=false;return Response.json({error:{code:'INTERNAL_ERROR'}},{status:500});}
      return Response.json(sync(request,1,1));
    }});
  await transport.restoreGuestSession();transport.watchMatch('m');await delay(10);transport.connect();source.open();await delay(10);
  const before=calls;failNext=true;source.invalidate(1,2,2);await delay(80);
  const afterFailure=calls;source.invalidate(2,2,2);await delay(80);
  const observed={id:'A01',connection:transport.getSnapshot().connection,lastError:transport.getSnapshot().lastError,version:transport.getSnapshot().matches.m.version,readCallsAfterInitial:afterFailure-before,readCallsAfterRepeatedHint:calls-afterFailure};
  assert.equal(observed.version,1);assert.equal(observed.connection,'connected');assert.equal(observed.readCallsAfterInitial,1);assert.equal(observed.readCallsAfterRepeatedHint,0);
  records.push(observed);transport.disconnect();
}
{
  const requests=[];
  const transport=new SitesGameTransport({createId:()=>`q-${requests.length}`,fetcher:async(url,init)=>{
    if(url==='/api/guest-sessions')return Response.json(guest);
    const request=JSON.parse(init.body);requests.push({url,request});
    if(url.endsWith('/commands'))return Response.json({protocolVersion:1,commandId:request.commandId,status:'accepted',duplicate:false,aggregateVersion:7,eventSeq:14,matchProjection:{snapshot,visibleEvents:[event(14)]}});
    if(request.afterEventSeq===14)return Response.json({protocolVersion:1,requestId:request.requestId,status:'unchanged',matchId:'m',version:7,eventSeq:14});
    return Response.json(sync(request,5,10,[event(10)]));
  }});
  await transport.restoreGuestSession();await transport.syncMatch('m');
  await transport.sendMatchCommand({protocolVersion:1,commandId:'00000000-0000-4000-8000-000000000001',matchId:'m',expectedVersion:5,type:'RESPOND',payload:{interactionId:'same-tablewide-attack',choice:'TAKE_HIT'}});
  await transport.syncMatch('m');
  const observed={id:'A02',cachedEventSeq:transport.getSnapshot().matches.m.eventSeq,visibleSequences:transport.getSnapshot().matches.m.visibleEvents.map(e=>e.eventSeq),lastReadCursor:requests.at(-1).request.afterEventSeq};
  assert.deepEqual(observed.visibleSequences,[10,14]);assert.equal(observed.lastReadCursor,14);records.push(observed);transport.disconnect();
}
{
  let revoked=false;
  const room={roomId:'r',version:1,status:'waiting',activeMatchId:null,ownerPlayerId:'p0',capacity:4,rulesetVersion:'base4-ko-online-1.0',members:[{playerId:'p0',displayName:'P0',seatIndex:0,ready:true}],viewer:{playerId:'p0',isOwner:true}};
  const transport=new SitesGameTransport({createId:()=> 'membership-audit',fetcher:async(url,init)=>{
    if(url==='/api/guest-sessions')return Response.json(guest);
    const request=JSON.parse(init.body);
    return Response.json(revoked?{protocolVersion:1,requestId:request.requestId,status:'rejected',error:{code:'NOT_FOUND_OR_FORBIDDEN'}}:{protocolVersion:1,requestId:request.requestId,roomId:'r',version:1,requiresFullSnapshot:true,room});
  }});
  await transport.restoreGuestSession();await transport.syncRoom('r');revoked=true;await assert.rejects(transport.syncRoom('r'));
  const observed={id:'A05',lastError:transport.getSnapshot().lastError,cachedRoomAfterMembershipRejected:!!transport.getSnapshot().rooms.r,cachedMemberIds:transport.getSnapshot().rooms.r.room.members.map(member=>member.playerId)};
  assert.equal(observed.cachedRoomAfterMembershipRejected,true);records.push(observed);transport.disconnect();
}
writeFileSync(new URL('./transport-reproductions.json',import.meta.url),JSON.stringify(records,null,2));console.log(JSON.stringify(records,null,2));
