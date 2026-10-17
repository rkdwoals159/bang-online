import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { io } from '../apps/web/node_modules/socket.io-client/build/esm/index.js';

const origin=process.env.BANG_VERIFY_ORIGIN??'https://bang-online.site';
const webOrigin=process.env.BANG_VERIFY_WEB_ORIGIN??origin;
const sockets=[];
const emit=(socket,event,payload)=>new Promise((resolve,reject)=>socket.timeout(15000).emit(event,payload,(error,reply)=>error?reject(error):resolve(reply)));
const command=(type,roomId,expectedVersion,payload={})=>({protocolVersion:1,commandId:randomUUID(),roomId,expectedVersion,type,payload});
const request=(path,options={})=>fetch(origin+path,{...options,signal:AbortSignal.timeout(20000)});
let roomId,owner,roomVersion;
try{
  assert.equal((await request('/healthz')).status,200);
  const players=[];
  for(let index=0;index<5;index++){
    const response=await request('/api/guest-sessions',{method:'POST',headers:{Origin:webOrigin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,displayName:`방 관리 검증 ${index+1}`})});
    assert.equal(response.status,201);const body=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
    const socket=io(origin,{transports:['websocket'],extraHeaders:{Cookie:cookie,Origin:webOrigin},reconnection:false,timeout:15000});sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    players.push({id:body.player.playerId,cookie,socket});
  }
  owner=players[0];
  const created=await emit(owner.socket,'room:create',{protocolVersion:1,commandId:randomUUID(),expectedVersion:0,type:'CREATE_ROOM',payload:{capacity:5,rulesetVersion:'base4-ko-online-1.0',displayName:'방 관리 검증 1'}});
  roomId=created.roomId;roomVersion=created.version;assert.ok(roomId);
  for(const player of players.slice(1)){
    const joined=await emit(player.socket,'room:command',command('JOIN',roomId,roomVersion,{inviteCode:created.inviteCode}));assert.ok(joined.members);roomVersion=joined.version;
  }
  const started=await emit(owner.socket,'room:command',command('START_MATCH',roomId,roomVersion));roomVersion=started.version;
  assert.ok(started.activeMatchId);const matchId=started.activeMatchId;
  const sync=async(player)=>emit(player.socket,'match:sync',{protocolVersion:1,requestId:randomUUID(),matchId,knownVersion:0,afterEventSeq:0});
  for(const player of players)await emit(player.socket,'room:sync',{protocolVersion:1,requestId:randomUUID(),roomId,knownVersion:0});
  // Finish only the initial turn-draw prompt in this newly created verification game.
  for(let step=0;step<10;step++){
    const observed=await sync(owner),pending=observed.snapshot?.pendingInteraction;if(!pending)break;
    const responder=players.find(player=>player.id===pending.currentResponderPlayerId),view=await sync(responder),option=view.snapshot.pendingInteraction.responseOptions[0];
    const ack=await emit(responder.socket,'match:command',{protocolVersion:1,commandId:randomUUID(),expectedVersion:view.version,type:'RESPOND',matchId,payload:option});assert.equal(ack.status,'accepted');
  }
  const snapshots=await Promise.all(players.map(sync));
  const leavingIndex=snapshots.findIndex((view,index)=>index>0&&view.snapshot.selfPrivate?.role==='outlaw');assert.ok(leavingIndex>0);
  const leaving=players[leavingIndex],retained=players.find(player=>player!==owner&&player!==leaving);
  const nonOwnerDelete=await emit(leaving.socket,'room:command',command('CLOSE_ROOM',roomId,roomVersion));assert.equal(nonOwnerDelete.status,'rejected');
  const leave=command('LEAVE_ROOM',roomId,roomVersion),left=await emit(leaving.socket,'room:command',leave);assert.equal(left.status,'accepted');roomVersion=left.aggregateVersion;
  assert.equal((await emit(leaving.socket,'room:command',leave)).duplicate,true);
  const after=await sync(owner);assert.equal(after.snapshot.status,'playing');assert.equal(after.snapshot.publicTable.players.find(player=>player.playerId===leaving.id).eliminated,true);
  assert.equal((await sync(leaving)).status,'rejected');
  assert.deepEqual(await (await request('/api/guest-sessions/rooms',{headers:{Cookie:leaving.cookie}})).json(),[]);
  const notification=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Close invalidation not received')),15000);retained.socket.on('room:changed',payload=>{if(payload.roomId===roomId&&payload.version>roomVersion){clearTimeout(timer);resolve();}});});
  const close=command('CLOSE_ROOM',roomId,roomVersion),closed=await emit(owner.socket,'room:command',close);assert.equal(closed.status,'accepted');await notification;
  assert.equal((await emit(owner.socket,'room:command',close)).duplicate,true);
  for(const player of players){assert.equal((await sync(player)).status,'rejected');assert.deepEqual(await (await request('/api/guest-sessions/rooms',{headers:{Cookie:player.cookie}})).json(),[]);}
  const rejoin=await emit(leaving.socket,'room:command',command('JOIN',roomId,closed.aggregateVersion,{inviteCode:created.inviteCode}));assert.equal(rejoin.status,'rejected');
  const report={verifiedAt:new Date().toISOString(),origin,roomId,checks:['five authenticated clients','five-player game starts','non-owner deletion denied','outlaw departure eliminates only that player','remaining game stays playing','departure retry is idempotent','departed player cannot sync match','departed room absent from recovery','playing clients receive room closure','owner close retry is idempotent','all five clients lose game access','all five recovered room lists are empty','old invitation cannot rejoin'],passed:true};
  if(process.env.BANG_VERIFY_REPORT)await writeFile(process.env.BANG_VERIFY_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}catch(error){
  // Clean up this script's room only; never touch pre-existing games.
  if(roomId&&owner){try{const latest=await emit(owner.socket,'room:sync',{protocolVersion:1,requestId:randomUUID(),roomId,knownVersion:0});if(latest.room)await emit(owner.socket,'room:command',command('CLOSE_ROOM',roomId,latest.version));}catch{}}
  throw error;
}finally{for(const socket of sockets)socket.disconnect();}
