// Local QA only. Credentials stay in ignored .sites-runtime files, never stdout.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const origin = 'http://localhost:5173';
const [mode, roomId, argument, capacityArg = '4', firstArg = '2'] = process.argv.slice(2);
if (!roomId || !['setup','respond','all'].includes(mode)) throw new Error('Use setup ROOM INVITE [CAPACITY] [FIRST_BOT], or respond/all ROOM [CHOICE]');
const file = `.sites-runtime/experience-guests-${roomId}.json`;
if (!/^r_[\w-]+$/.test(roomId)) throw new Error('Invalid local review room');
async function request(path,cookie,body) {
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(!response.ok||result.status==='rejected')throw new Error(`Local QA request rejected: ${result.error?.code ?? response.status}`);
  return {result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
if(mode==='setup'){
  const capacity=Number(capacityArg),first=Number(firstArg);if(![4,5,6,7].includes(capacity)||first<2||first>capacity)throw new Error('Invalid review capacity');
  const guests=[];
  for(let i=first;i<=capacity;i++){
    const guest=await request('/api/guest-sessions',null,{protocolVersion:1,displayName:`로컬 연출 ${i}`});
    const preview=await request('/api/rooms/preview',guest.cookie,{protocolVersion:1,requestId:randomUUID(),inviteCode:argument});
    const envelope=(type,version,payload)=>({protocolVersion:1,commandId:randomUUID(),roomId,expectedVersion:version,type,payload});
    await request(`/api/rooms/${roomId}/commands`,guest.cookie,envelope('JOIN',preview.result.version,{inviteCode:argument}));
    guests.push({cookie:guest.cookie,playerId:guest.result.player.playerId});
  }
  await mkdir('.sites-runtime',{recursive:true});await writeFile(file,JSON.stringify(guests),{mode:0o600});console.log(JSON.stringify({readyBots:guests.length}));
}else{
  const guests=JSON.parse(await readFile(file,'utf8'));let count=0;
  for(let step=0;step<(mode==='all'?12:1);step++){
    let responded=false;
    for(const guest of guests){
      const room=await request(`/api/rooms/${roomId}/sync`,guest.cookie,{protocolVersion:1,requestId:randomUUID(),roomId,knownVersion:0});
      if(!room.result.room.members.some(m=>m.displayName.startsWith('디자인 검증')))throw new Error('Agent-created local review room required');
      const matchId=room.result.room.activeMatchId;if(!matchId)continue;
      const sync=await request(`/api/matches/${matchId}/sync`,guest.cookie,{protocolVersion:1,requestId:randomUUID(),matchId,knownVersion:0,afterEventSeq:0});
      const pending=sync.result.snapshot.pendingInteraction;
      if(!pending?.responseOptions?.length)continue;
      const option=pending.responseOptions.find(o=>o.choice===(argument??'USE_MISSED'))??pending.responseOptions.find(o=>['CHOOSE_CARD','TAKE_HIT'].includes(o.choice));
      if(!option||option.choice==='ORDER_CARDS')continue;
      await request(`/api/matches/${matchId}/commands`,guest.cookie,{protocolVersion:1,commandId:randomUUID(),matchId,expectedVersion:sync.result.version,type:'RESPOND',payload:option});
      console.log(JSON.stringify({choice:option.choice,playerId:guest.playerId}));count++;responded=true;break;
    }
    if(!responded)break;
  }
  console.log(JSON.stringify({responses:count}));
}
