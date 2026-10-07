import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { io } from '../apps/web/node_modules/socket.io-client/build/esm/index.js';

const origin = process.env.BANG_VERIFY_ORIGIN ?? 'https://bang-online.site';
const webOrigin = process.env.BANG_VERIFY_WEB_ORIGIN ?? origin;
const headers = { Origin: webOrigin, 'Content-Type': 'application/json' };
const sockets = [];
const emit = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(10000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
});
const command = (type, expectedVersion, payload, extra = {}) => ({ protocolVersion: 1, commandId: randomUUID(), expectedVersion, type, payload, ...extra });
try {
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.equal((await fetch(origin + '/rooms/verification-route')).status, 200);
  const players = [];
  for (let index = 0; index < 4; index++) {
    const response = await fetch(origin + '/api/guest-sessions', { method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, displayName: `서버 이전 검증 ${index + 1}` }) });
    assert.equal(response.status, 201);
    const cookieHeader = response.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /Secure/i);
    const cookie = cookieHeader.split(';')[0];
    const guest = await response.json();
    const socket = io(origin, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: webOrigin }, reconnection: false, timeout: 10000 });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    players.push({ ...guest.player, cookie, socket });
  }
  const owner = players[0];
  const created = await emit(owner.socket, 'room:create', command('CREATE_ROOM', 0, { capacity: 4, rulesetVersion: 'base4-ko-online-1.0', displayName: owner.displayName }));
  assert.ok(created.roomId, JSON.stringify(created));
  let version = created.version;
  for (const player of players.slice(1)) {
    const joined = await emit(player.socket, 'room:command', command('JOIN', version, { inviteCode: created.inviteCode }, { roomId: created.roomId }));
    assert.ok(joined.members, JSON.stringify(joined));
    version++;
  }
  const started = await emit(owner.socket, 'room:command', command('START_MATCH', version, {}, { roomId: created.roomId }));
  assert.equal(started.status, 'in_game', JSON.stringify(started));
  assert.ok(started.activeMatchId);
  const snapshots = [];
  for (const player of players) {
    const sync = await emit(player.socket, 'match:sync', { protocolVersion: 1, requestId: randomUUID(), matchId: started.activeMatchId, knownVersion: 0, afterEventSeq: 0 });
    assert.ok(sync.snapshot, JSON.stringify(sync));
    snapshots.push(sync.snapshot);
  }
  const renamed = await fetch(origin + '/api/guest-sessions/profile', { method: 'POST', headers: { ...headers, Cookie: owner.cookie }, body: JSON.stringify({ protocolVersion: 1, displayName: '서버 이전 검증 완료' }) });
  assert.equal(renamed.status, 200);
  const checks = ['HTTP health response (TLS verified by fetch when HTTPS)', 'SPA deep link', 'secure session cookies', 'four authenticated WebSocket connections', 'room creation/join', 'match start', 'four private match projections', 'nickname change'];
  if (process.env.BANG_VERIFY_RESTART === '1') {
    for (const socket of sockets) socket.disconnect();
    execFileSync('ssh', ['-o', 'BatchMode=yes', 'rkdwoals159@100.124.235.102', 'launchctl kickstart -k gui/502/site.bang-online.server'], { stdio: 'inherit' });
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { healthy = (await fetch(origin + '/healthz')).status === 200; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(healthy, 'server recovered after restart');
    for (const player of players) {
      assert.equal((await fetch(origin + '/api/guest-sessions', { headers: { ...headers, Cookie: player.cookie } })).status, 200);
      const restoredSocket = io(origin, { transports: ['websocket'], extraHeaders: { Cookie: player.cookie, Origin: webOrigin }, reconnection: false, timeout: 10000 });
      sockets.push(restoredSocket);
      await new Promise((resolve, reject) => { restoredSocket.once('connect', resolve); restoredSocket.once('connect_error', reject); });
      const restored = await emit(restoredSocket, 'match:sync', { protocolVersion: 1, requestId: randomUUID(), matchId: started.activeMatchId, knownVersion: 0, afterEventSeq: 0 });
      assert.ok(restored.snapshot, JSON.stringify(restored));
      assert.equal(restored.matchId, started.activeMatchId);
    }
    checks.push('server restart preserves four sessions and match projections');
  }
  console.log(JSON.stringify({ ok: true, origin, checks, roomId: created.roomId, matchId: started.activeMatchId }, null, 2));
} finally {
  for (const socket of sockets) socket.disconnect();
}
