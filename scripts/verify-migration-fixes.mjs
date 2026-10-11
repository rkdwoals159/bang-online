import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { BrowserGameTransport } from '../apps/web/src/transport/client.ts';
import { SitesGameTransport } from '../apps/web/src/transport/sites-client.ts';
import { observeCommandRecovery } from '../apps/web/src/features/feedback/recovery.ts';
import { initializeGame } from '../packages/engine/src/setup/initialize.ts';
import { projectMatchSnapshot } from '../packages/engine/src/state/projection.ts';
import { BASE_PHYSICAL_CARDS } from '../packages/catalog/src/cards/index.ts';
import { createSyncProjectionHandlers } from '../apps/server/src/projections/sync.ts';
import { matchCommandRequestHash as nodeHash } from '../apps/server/src/commands/index.ts';
import { matchCommandRequestHash as siteHash } from '../apps/site/src/server/matches/service.ts';
import { createDatabase } from '../apps/server/test/storage/pglite-pool.ts';
import { createRuntimeServer } from '../apps/server/src/main.ts';
import { readServerConfig } from '../apps/server/src/config.ts';
import { createIsolatedD1 } from '../apps/site/test/storage/d1-test-db.ts';
import { routeApiRequest } from '../apps/site/src/server/routes/index.ts';
import { D1RoomService } from '../apps/site/src/server/rooms/service.ts';
import { GuestSessionService } from '../apps/site/src/server/auth/guest-sessions.ts';
import { StorageRepository } from '../apps/server/src/storage/repository.ts';
import { io } from '../apps/server/node_modules/socket.io-client/build/esm-debug/index.js';
const out = 'outputs/migration-fixes-2026-10-12';
const result = { checkedAt: new Date().toISOString(), purpose: 'Assert corrected migration behavior in isolated runtimes', observations: [] };
const record = (id, values) => { result.observations.push({ id, ...values }); console.log(id); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class FakeSocket {
  connected = true; listeners = new Map(); emitted = []; handler = () => {};
  on(event, listener) { const list = this.listeners.get(event) ?? []; list.push(listener); this.listeners.set(event, list); }
  off(event, listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener)); }
  fire(event, payload) { (this.listeners.get(event) ?? []).forEach(listener => listener(payload)); }
  emit(event, payload, ack) { this.emitted.push({ event, payload, ack }); this.handler(event, payload, ack); }
  connect() { this.connected = true; this.fire('connect'); }
  disconnect() { this.connected = false; this.fire('disconnect'); }
}
class Source { addEventListener() {} close() {} }
const state = initializeGame({ players: ['a','b','c','d'].map(id => ({ playerId: `p_${id}`, displayName: id })), random: { nextFloat: () => 0.314159 } });
const viewer = state.seats[0].public.playerId;
const snapshot = projectMatchSnapshot(state, viewer, BASE_PHYSICAL_CARDS);
const reply = (req, version = 0) => ({ protocolVersion: 1, requestId: req.requestId, matchId: req.matchId, version, eventSeq: 0, requiresFullSnapshot: true, snapshot, visibleEvents: [] });
const command = { protocolVersion: 1, commandId: randomUUID(), matchId: 'm_probe', expectedVersion: 0, type: 'END_TURN', payload: {} };
const accepted = { protocolVersion: 1, commandId: command.commandId, status: 'accepted', duplicate: false, aggregateVersion: 1, eventSeq: 0 };

// A late receipt and an automatic exact-envelope retry both release the UI.
for (const late of [true, false]) {
  const socket = new FakeSocket(), transport = new BrowserGameTransport({ socketFactory: () => socket, acknowledgementTimeoutMs: 15, commandRetryIntervalMs: 10 });
  socket.handler = (event, req, ack) => { if (event === 'match:sync') ack(reply(req, 1)); };
  let uiRecoveries = 0;
  const stopObserving = observeCommandRecovery(transport, command, () => { uiRecoveries++; });
  await assert.rejects(transport.sendMatchCommand(command), error => error.code === 'ACK_TIMEOUT');
  if (late) socket.emitted.find(item => item.event === 'match:command').ack(accepted);
  else socket.handler = (event, req, ack) => { if (event === 'match:command') { assert.deepEqual(req, command); ack(accepted); } else if (event === 'match:sync') ack(reply(req, 1)); };
  await delay(80);
  assert.equal(transport.getSnapshot().pendingCommandIds.length, 0);
  assert.equal(uiRecoveries, 1);
  assert.deepEqual(transport.getCommandAcknowledgement(command.commandId), accepted);
  record(late ? 'F01-late' : 'F01-retry', { passed: true, uiRecoveries });
  stopObserving(); transport.disconnect();
}
// A dropped sync acknowledgement recovers while the socket remains connected.
{
  const socket = new FakeSocket(), transport = new BrowserGameTransport({ socketFactory: () => socket, acknowledgementTimeoutMs: 15, syncRetryIntervalMs: 10 });
  transport.watchMatch('m_probe');
  socket.fire('match:changed', { matchId: 'm_probe', version: 1, eventSeq: 1 });
  socket.handler = (event, req, ack) => { if (event === 'match:sync') ack(reply(req, 1)); };
  await delay(45);
  socket.fire('match:changed', { matchId: 'm_probe', version: 1, eventSeq: 1 });
  await delay(30);
  const count = socket.emitted.filter(item => item.event === 'match:sync').length;
  assert.ok(count >= 2); assert.ok(transport.getSnapshot().matches.m_probe);
  let siteReads = 0;
  const site = new SitesGameTransport({ syncRetryIntervalMs: 10, eventSourceFactory: () => new Source(), fetcher: async (url, init) => {
    siteReads++; return siteReads === 1 ? Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }) : Response.json(reply(JSON.parse(init.body)));
  } });
  site.connect(); site.watchMatch('m_probe'); await delay(120);
  assert.ok(site.getSnapshot().matches.m_probe); assert.ok(siteReads >= 2);
  record('F02', { nodeSyncAttempts: count, nodeRecovered: true, siteSyncAttempts: siteReads, siteRecovered: true });
  transport.disconnect(); site.disconnect();
}
// Both adapters accept the canonical inline command projection.
{
  const socket = new FakeSocket(), transport = new BrowserGameTransport({ socketFactory: () => socket });
  socket.handler = (event, req, ack) => { if (event === 'match:command') ack({ ...accepted, matchProjection: { baseEventSeq: 0, snapshot, visibleEvents: [] } }); };
  transport.store.applyMatchSync(reply({requestId:'cached', matchId:'m_probe'}));
  const result = await transport.sendMatchCommand(command);
  assert.ok(result.matchProjection);
  assert.equal(transport.getSnapshot().matches.m_probe.version, 1);
  assert.equal(socket.emitted.filter(item => item.event === 'match:sync').length, 0);
  record('F04', { canonicalInlineProjectionApplied: true, extraReadAvoided: true });
  transport.disconnect();
}
// Server adapter differences using isolated real databases; no production state is touched.
// Match membership rejection must remove the cached projection and stop retaining its resource.
{
  const socket = new FakeSocket(), transport = new BrowserGameTransport({ socketFactory: () => socket });
  let reads = 0;
  socket.handler = (event, req, ack) => {
    if (event === 'match:sync') { reads++; ack(reads === 1 ? reply(req) : { protocolVersion: 1, requestId: req.requestId, status: 'rejected', error: { code: 'NOT_FOUND_OR_FORBIDDEN' } }); }
  };
  const unwatch = transport.watchMatch('m_probe'); await delay(5);
  await assert.rejects(transport.syncMatch('m_probe'));
  assert.equal(transport.getSnapshot().matches.m_probe, undefined);
  socket.fire('match:changed', { matchId: 'm_probe', version: 1, eventSeq: 1 }); await delay(5);
  assert.equal(reads, 2);
  let siteReads = 0;
  const site = new SitesGameTransport({ fetcher: async (url, init) => {
    const req = JSON.parse(init.body); siteReads++;
    return Response.json(siteReads === 1 ? reply(req) : { protocolVersion: 1, requestId: req.requestId, status: 'rejected', error: { code: 'NOT_FOUND_OR_FORBIDDEN' } });
  } });
  await site.syncMatch('m_probe'); await assert.rejects(site.syncMatch('m_probe'));
  assert.equal(site.getSnapshot().matches.m_probe, undefined);
  record('F10', { nodeKeepsDeniedMatchSnapshot: false, nodeReadsAfterRejection: reads, siteKeepsDeniedMatchSnapshot: false });
  unwatch(); transport.disconnect(); site.disconnect();
}
const pg = await createDatabase(), d1 = await createIsolatedD1();
let runtime; const sockets = [];
try {
  runtime = await createRuntimeServer(readServerConfig({ DATABASE_URL: 'postgresql://unused/unused', HOST: '127.0.0.1', PORT: '0', WEB_ORIGIN: 'https://site.test', SESSION_COOKIE_NAME: 'bang_session' }), pg.pool, { logger: { info() {}, error() {} } });
  const base = `http://127.0.0.1:${runtime.port}`, origin = 'https://site.test';
  const siteRequest = (path, body, cookie, requestOrigin = origin, method = 'POST') => new Request(origin + path, { method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const guestInput = { protocolVersion: 1, displayName: 'Parity owner' };
  const foreignNode = await fetch(base + '/api/guest-sessions', { method: 'POST', headers: { Origin: 'https://foreign.test', 'Content-Type': 'application/json' }, body: JSON.stringify(guestInput) });
  const foreignSite = await routeApiRequest(siteRequest('/api/guest-sessions', guestInput, null, 'https://foreign.test'), { DB: d1.db });
  assert.equal(foreignNode.status, 403); assert.equal(foreignSite.status, 403);
  const allowedGuest = await fetch(base + '/api/guest-sessions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(guestInput) });
  assert.equal(allowedGuest.status,201);
  const nodeGuest = await allowedGuest.json(), cookie = allowedGuest.headers.get('set-cookie').split(';',1)[0];
  const profileNode = await fetch(base + '/api/guest-sessions/profile', { method: 'POST', headers: { Origin: 'https://foreign.test', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...guestInput, displayName: 'Foreign accepted' }) });
  const profileSite = await routeApiRequest(siteRequest('/api/guest-sessions/profile', guestInput, null, 'https://foreign.test'), { DB: d1.db });
  assert.equal(profileNode.status, 403); assert.equal(profileSite.status, 403);
  record('F06', { foreignOriginGuestCreate: { node: 403, site: 403 }, foreignOriginProfileUpdate: { node: 403, site: 403 }, note: 'Both authenticated entry points enforce the configured Origin' });
  const foreignSocket = io(base, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: 'https://foreign.test' }, reconnection: false }); sockets.push(foreignSocket);
  await assert.rejects(new Promise((resolve,reject) => { foreignSocket.once('connect',resolve); foreignSocket.once('connect_error',reject); }));
  const socket = io(base, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: origin }, reconnection: false }); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  record('F06-WebSocket', { foreignOriginAuthenticatedWebSocketAccepted: false });
  const ack = (event, payload) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply)));
  const created = await ack('room:create', { protocolVersion: 1, commandId: randomUUID(), expectedVersion: 0, type: 'CREATE_ROOM', payload: { capacity: 4, rulesetVersion: 'base4-ko-online-1.0', displayName: 'Parity owner' } });
  assert.ok(created.roomId);
  const siteGuest = await new GuestSessionService(d1.db).create('Parity owner'), siteCookie = `bang_session=${siteGuest.credential}`;
  const siteRooms = new D1RoomService(d1.db);
  const siteCreated = await siteRooms.createPrivateRoom(siteGuest.response.player.playerId, { capacity: 4, rulesetVersion: 'base4-ko-online-1.0', commandId: randomUUID() });
  await siteRooms.closeRoom(siteGuest.response.player.playerId, { roomId: siteCreated.roomId, expectedVersion: 0, commandId: randomUUID() });
  await ack('room:command', { protocolVersion: 1, roomId: created.roomId, commandId: randomUUID(), expectedVersion: 0, type: 'CLOSE_ROOM', payload: {} });
  const nodeRecovered = await (await fetch(base + '/api/guest-sessions/rooms', { headers: { Cookie: cookie } })).json();
  const siteRecovered = await siteRooms.recoverAssignedSeats(siteGuest.response.player.playerId);
  assert.equal(nodeRecovered.length, 0); assert.equal(siteRecovered.length, 0);
  record('F03', { nodeRecoversClosedRoom: false, siteRecoversClosedRoom: false });
  await pg.pool.connect().then(async client => { try { await client.query('UPDATE guest_sessions SET revoked_at = now() WHERE id = $1', [nodeGuest.player.playerId]); } finally { client.release(); } });
  const expiry = new Promise(resolve => socket.once('session:expired', resolve));
  let revokedReplyReceived = false;
  socket.emit('room:sync', { protocolVersion:1, requestId:'revoked', roomId:created.roomId, knownVersion:1 }, () => { revokedReplyReceived = true; });
  await Promise.race([expiry, delay(2000).then(() => { throw new Error('revoked socket not expired'); })]);
  await delay(20);
  assert.equal(revokedReplyReceived, false);
  assert.equal(socket.connected, false);
  await d1.db.prepare('UPDATE guest_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), siteGuest.response.player.playerId).run();
  const siteRevoked = await routeApiRequest(siteRequest('/api/guest-sessions/rooms', null, siteCookie, origin, 'GET'), { DB: d1.db });
  assert.equal(siteRevoked.status, 401);
  record('F07', { nodeExistingSocketStillReadsAfterSessionRevocation: false, siteNextRequestStatus: 401 });
  // Both adapters cap the initial replay to the latest 100 events.
  const nodeRepository = new StorageRepository(pg.pool);
  for (const seat of state.seats) {
    const input = { id: seat.public.playerId, tokenHash: createHash('sha256').update(seat.public.playerId).digest('hex'), displayName: seat.public.displayName, expiresAt: new Date('2030-01-01') };
    await nodeRepository.createGuestSession(input); await d1.repository.createGuestSession(input);
  }
  const room = { id: 'r_shared', ownerPlayerId: viewer, inviteCodeHash: 'shared-hash', capacity: 4, players: state.seats.map((seat, seatIndex) => ({ playerId: seat.public.playerId, seatIndex, ready: true })) };
  await nodeRepository.createRoom(room); await d1.repository.createRoom(room);
  const longState = structuredClone(state); longState.eventSeq = 250; longState.version = 1;
  await nodeRepository.createMatch({ id: 'm_shared', roomId: room.id, state: longState });
  await d1.repository.createMatch({ id: 'm_shared', roomId: room.id, state: longState });
  const pgClient = await pg.pool.connect();
  try { for (let seq = 1; seq <= 250; seq++) await pgClient.query('INSERT INTO match_events(event_id,match_id,event_seq,version,type,actor_player_id,payload_json) VALUES($1,$2,$3,1,$4,$5,$6::jsonb)', [`event-${seq}`, 'm_shared', seq, 'BANG_ATTACKED', viewer, JSON.stringify({ targetPlayerId: 'p_b' })]); } finally { pgClient.release(); }
  await d1.db.batch(Array.from({ length: 250 }, (_, index) => d1.db.prepare('INSERT INTO match_events(event_id,match_id,event_seq,version,type,actor_player_id,payload_json,created_at) VALUES(?,?,?,1,?,?,?,?)').bind(`event-${index+1}`, 'm_shared', index+1, 'BANG_ATTACKED', viewer, JSON.stringify({ targetPlayerId: 'p_b' }), new Date().toISOString())));
  const request = { protocolVersion: 1, requestId: 'long-history', matchId: 'm_shared', knownVersion: 0, afterEventSeq: 0 };
  let nodeSync;
  await createSyncProjectionHandlers({ storage: nodeRepository }).matchSync({ playerId: viewer, matchMembership: async () => true }, request, response => { nodeSync = response; });
  const sharedCookie = `bang_session=${viewer}`;
  const siteSync = await (await routeApiRequest(siteRequest('/api/matches/m_shared/sync', request, sharedCookie), { DB: d1.db })).json();
  assert.equal(nodeSync.visibleEvents.length, 100); assert.equal(siteSync.visibleEvents.length, 100);
  record('F05', { nodeSyncEvents: 100, siteSyncEvents: 100, nodeResponseBytes: JSON.stringify(nodeSync).length, siteResponseBytes: JSON.stringify(siteSync).length });
  const unchangedRequest = { ...request, requestId: 'unchanged', knownVersion: 1, afterEventSeq: 250, acceptUnchanged: true };
  let unchangedNode;
  await createSyncProjectionHandlers({ storage: nodeRepository }).matchSync({ playerId: viewer, matchMembership: async () => true }, unchangedRequest, response => { unchangedNode = response; });
  const unchangedSite = await (await routeApiRequest(siteRequest('/api/matches/m_shared/sync', unchangedRequest, sharedCookie), { DB: d1.db })).json();
  assert.equal(unchangedNode.status, 'unchanged'); assert.equal(unchangedSite.status, 'unchanged');
  record('F11', { nodeUnchangedResponseBytes: JSON.stringify(unchangedNode).length, siteUnchangedResponseBytes: JSON.stringify(unchangedSite).length, nodeReturnsFullSnapshot: false });
  const hashCommand = { ...command, matchId: 'm_shared' };
  assert.notEqual(nodeHash(hashCommand), await siteHash(hashCommand));
  record('D-HASH', { sameEnvelopeDifferentRequestHash: true, currentDatabasesAreSeparate: true });
  // Both adapters explicitly reject unsupported snapshots.
  const unsupported = { ...longState, schemaVersion: 2 };
  const client = await pg.pool.connect();
  try { await client.query('UPDATE matches SET state_schema_version=2,state_json=$1::jsonb WHERE id=$2', [JSON.stringify(unsupported), 'm_shared']); } finally { client.release(); }
  await d1.db.prepare('UPDATE matches SET state_schema_version=2,state_json=? WHERE id=?').bind(JSON.stringify(unsupported), 'm_shared').run();
  let unsupportedNode;
  await createSyncProjectionHandlers({ storage: nodeRepository }).matchSync({ playerId: viewer, matchMembership: async () => true }, request, response => { unsupportedNode = response; });
  const unsupportedSite = await (await routeApiRequest(siteRequest('/api/matches/m_shared/sync', request, sharedCookie), { DB: d1.db })).json();
  assert.equal(unsupportedNode.error.code, 'RECOVERY_REQUIRED'); assert.equal(unsupportedSite.error.code, 'RECOVERY_REQUIRED');
  record('F08', { nodeProjectsUnsupportedSchemaAtReadBoundary: false, siteRejectsWith: unsupportedSite.error.code, note: 'Both startup and per-request snapshot boundaries are guarded' });
} finally { sockets.forEach(socket => socket.disconnect()); await runtime?.close(); await pg.database.close(); await d1.runtime.dispose(); }
await mkdir(out, { recursive: true });
await writeFile(`${out}/regressions.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ completed: true, observations: result.observations.length }));
