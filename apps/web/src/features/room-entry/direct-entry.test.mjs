import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createInviteJoiner, extractInviteCode, INVALID_INVITE_MESSAGE, CONNECTION_ERROR_MESSAGE } from './model.ts';
import { BrowserTransportError } from '../../transport/errors.ts';

const origin = 'https://game.example';
const link = `${origin}/rooms/join?code=invite_123`;
const preview = { roomId: 'room-1', version: 4, occupancy: 1, status: 'waiting' };
const room = { roomId: 'room-1', status: 'waiting', members: [{ playerId: 'self' }] };
const failure = code => Object.assign(new Error('server detail must not reach UI'), { code });
function fixture(overrides = {}) {
  const calls = [], ids = [];
  const transport = {
    async previewInvite(code) { calls.push(['lookup', code]); return preview; },
    async joinRoom(command) { calls.push(['join', structuredClone(command)]); return room; },
    async recoverAssignedSeats() { calls.push(['recover']); return []; },
    ...overrides,
  };
  return { calls, ids, join: createInviteJoiner(transport, () => { const id=`join-${ids.length+1}`; ids.push(id); return id; }) };
}

test('direct entry: actual adapter rejection wrapper supports seat recovery, stale retry and friendly errors', async () => {
  for (const code of ['ALREADY_JOINED', 'ROOM_LOCKED']) {
    const f = fixture({ async joinRoom() { throw new BrowserTransportError('REQUEST_REJECTED', code); }, async recoverAssignedSeats() { return [room]; } });
    assert.deepEqual(await f.join(link, origin), room);
  }
  let attempts = 0;
  const stale = fixture({ async joinRoom() { if (++attempts === 1) throw new BrowserTransportError('REQUEST_REJECTED', 'STALE_VERSION'); return room; } });
  assert.deepEqual(await stale.join(link, origin), room);
  assert.equal(stale.ids.length, 2);
  for (const code of ['ROOM_FULL', 'ROOM_CLOSED', 'INVALID_INVITE']) {
    const f = fixture({ async joinRoom() { throw new BrowserTransportError('REQUEST_REJECTED', code); } });
    await assert.rejects(f.join(link, origin), { message: INVALID_INVITE_MESSAGE });
  }
});

test('direct entry: parses the current invite URL and retains legacy internal token compatibility', () => {
  assert.equal(extractInviteCode(`  ${link}  `, origin), 'invite_123');
  assert.equal(extractInviteCode('invite_123', origin), 'invite_123');
  for (const input of ['', `${origin}/wrong?code=invite_123`, `${origin}/rooms/join`, `${link}&code=another`, `https://other.example/rooms/join?code=invite_123`, 'javascript:alert(1)', `https://user:password@game.example/rooms/join?code=invite_123`, `${origin}/rooms/join?code=%20bad`]) {
    assert.throws(() => extractInviteCode(input, origin), { message: INVALID_INVITE_MESSAGE });
  }
});

test('direct entry: one request from the UI performs lookup then JOIN with authoritative version', async () => {
  const f = fixture();
  assert.deepEqual(await f.join(link, origin), room);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], ['lookup', 'invite_123']);
  assert.equal(f.calls[1][1].expectedVersion, 4);
  assert.equal(f.calls[1][1].roomId, 'room-1');
  assert.deepEqual(f.calls[1][1].payload, { inviteCode: 'invite_123' });
});

test('direct entry: same-link double submissions share one in-flight transaction', async () => {
  let release;
  const gate = new Promise(resolve => { release=resolve; });
  let writes=0;
  const f = fixture({ async joinRoom() { writes++; await gate; return room; } });
  const first=f.join(link,origin), second=f.join('invite_123',origin);
  assert.equal(first,second);
  await assert.rejects(f.join('different',origin), /입장이 진행 중/);
  release(); await first;
  assert.equal(writes,1);
  assert.equal(f.ids.length,1);
});

test('direct entry: transport ambiguity retries the exact command without a new lookup or ID', async () => {
  const sent=[]; let attempts=0;
  const f=fixture({ async joinRoom(command) { sent.push(structuredClone(command)); if (++attempts===1) throw failure('CONNECTION'); return room; } });
  await assert.rejects(f.join(link,origin), {message:CONNECTION_ERROR_MESSAGE});
  assert.deepEqual(await f.join(link,origin),room);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(f.ids.length,1);
  assert.equal(f.calls.filter(c=>c[0]==='lookup').length,1);
});

test('direct entry: a definitive stale version refreshes and obtains a new command ID', async () => {
  let version=4; const sent=[];
  const f=fixture({ async previewInvite() { return {...preview,version}; }, async joinRoom(command) { sent.push(command); if (sent.length===1) { version=5; throw failure('STALE_VERSION'); } return room; } });
  assert.deepEqual(await f.join(link,origin),room);
  assert.equal(sent[0].expectedVersion,4); assert.equal(sent[1].expectedVersion,5);
  assert.notEqual(sent[0].commandId,sent[1].commandId);
});

test('direct entry: version races have a finite retry budget', async () => {
  let writes=0;
  const f=fixture({ async joinRoom() { writes++; throw failure('STALE_VERSION'); } });
  await assert.rejects(f.join(link,origin),{message:INVALID_INVITE_MESSAGE});
  assert.equal(writes,3);
});

test('direct entry: full, closed and invalid invites report safe errors and stop', async () => {
  for (const code of ['ROOM_FULL','ROOM_CLOSED','INVALID_INVITE']) {
    let writes=0; const f=fixture({async joinRoom() { writes++; throw failure(code); }});
    await assert.rejects(f.join(link,origin),{message:INVALID_INVITE_MESSAGE});
    assert.equal(writes,1);
  }
  const invalid=fixture({async previewInvite() { return null; }});
  await assert.rejects(invalid.join(link,origin),{message:INVALID_INVITE_MESSAGE});
  assert.equal(invalid.ids.length,0);
  const malformed=fixture();
  await assert.rejects(malformed.join('https://wrong.example/rooms/join?code=valid',origin),{message:INVALID_INVITE_MESSAGE});
  assert.equal(malformed.calls.length,0);
});

test('direct entry: an existing authenticated seat can resume a waiting or started room', async () => {
  for (const code of ['ALREADY_JOINED','ROOM_LOCKED']) {
    const assigned={...room,status:code==='ROOM_LOCKED'?'in_game':'waiting'};
    const f=fixture({async joinRoom() { throw failure(code); },async recoverAssignedSeats() { return [{roomId:'other',status:'waiting'},assigned]; }});
    assert.deepEqual(await f.join(link,origin),assigned);
  }
  const unassigned=fixture({async joinRoom() { throw failure('ROOM_LOCKED'); }});
  await assert.rejects(unassigned.join(link,origin),{message:INVALID_INVITE_MESSAGE});
});

test('direct entry: closed recovered seats and unrelated rooms cannot bypass admission', async () => {
  const f=fixture({async joinRoom() { throw failure('ALREADY_JOINED'); },async recoverAssignedSeats() { return [{...room,status:'closed'},{roomId:'other',status:'waiting'}]; }});
  await assert.rejects(f.join(link,origin),{message:INVALID_INVITE_MESSAGE});
});

test('direct entry: UI has no preview confirmation or separate raw-code input', async () => {
  const [entry,pages]=await Promise.all([readFile(new URL('./RoomEntry.tsx',import.meta.url),'utf8'),readFile(new URL('../../app/pages.tsx',import.meta.url),'utf8')]);
  assert.doesNotMatch(entry,/방 미리 보기|이 방에 참가할까요|handlePreview|room-entry-invite-code|초대 코드/);
  assert.doesNotMatch(pages,/만든 방 대기실 열기|초대 코드/);
  assert.match(entry,/autoJoinAttempted\.current = true/);
  assert.match(entry,/if \(!mounted\.current\) return/);
  assert.match(entry,/mode === "join" \? "대기실 입장"/);
});
