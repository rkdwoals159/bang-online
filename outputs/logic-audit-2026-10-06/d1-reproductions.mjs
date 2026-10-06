import assert from 'node:assert/strict';
import {createIsolatedD1} from '../../apps/site/test/storage/d1-test-db.ts';
import {GuestSessionService} from '../../apps/site/src/server/auth/guest-sessions.ts';
import {D1RoomService} from '../../apps/site/src/server/rooms/service.ts';
import {D1InviteRateLimiter} from '../../apps/site/src/storage/invite-limiter.ts';
import {writeFileSync} from 'node:fs';
const {runtime,db}=await createIsolatedD1();const records=[];
try {
  const guest=await new GuestSessionService(db).create('Audit');
  const rooms=new D1RoomService(db), player=guest.response.player.playerId;
  const command={capacity:4,rulesetVersion:'base4-ko-online-1.0',commandId:'audit-create'};
  const first=await rooms.createPrivateRoom(player,command);
  const replay=await rooms.createPrivateRoom(player,command);
  const recovered=await rooms.recoverAssignedSeats(player);
  assert.equal(replay.inviteCode,null);assert.ok(!('inviteCode' in recovered[0]));
  records.push({id:'A03',firstHasInvite:!!first.inviteCode,replayInvite:replay.inviteCode,recoveredHasInvite:'inviteCode' in recovered[0]});
  await rooms.closeRoom(player,{roomId:first.roomId,expectedVersion:first.version,commandId:'audit-close'});
  const closedRecovery=await rooms.recoverAssignedSeats(player);
  records.push({id:'A06',recoveredRoomStatuses:closedRecovery.map(room=>room.status)});
  const limiter=new D1InviteRateLimiter(db),bucket='a'.repeat(64);let counter=0;
  async function failFive(at){for(let i=0;i<5;i++){const r=await limiter.reserve(bucket,`a-${++counter}`,at);assert.ok(r.allowed);await r.complete('invalid',at);}}
  await failFive(1000);
  let last;
  for(let i=0;i<12;i++)last=await limiter.reserve(bucket,`a-${++counter}`,1001);
  assert.ok(!last.allowed);
  const saved=await db.prepare('SELECT retry_at,retry_delay_ms FROM invite_attempts WHERE bucket_hash = ?').bind(bucket).first();
  const early=await limiter.reserve(bucket,`a-${++counter}`,62000);
  assert.ok(saved.retry_at>62000);assert.ok(early.allowed);await early.complete('neutral',62000);
  const idleAt=2000000;
  await failFive(idleAt);
  const afterIdle=await limiter.reserve(bucket,`a-${++counter}`,idleAt+1);
  assert.ok(!afterIdle.allowed);assert.ok(afterIdle.retryAfterMs>1000);
  records.push({id:'A07',retryAt:saved.retry_at,attemptAt:62000,allowedBeforeRetryAt:early.allowed,afterOver15MinutesIdleFirstRetryMs:afterIdle.retryAfterMs});
}finally{await runtime.dispose();}
writeFileSync(new URL('./d1-reproductions.json',import.meta.url),JSON.stringify(records,null,2));console.log(JSON.stringify(records,null,2));
