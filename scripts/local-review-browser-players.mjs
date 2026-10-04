import { randomUUID } from 'node:crypto';
const origin = 'http://localhost:5173';
const roomId = process.argv[2];
const inviteCode = process.argv[3];
if (!roomId || !inviteCode) throw new Error('Local review requires a room ID and invite code');
async function request(path, cookie, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || result.status === 'rejected') throw new Error(JSON.stringify(result));
  return { result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
for (let i = 2; i <= 4; i++) {
  const guest = await request('/api/guest-sessions', undefined, { protocolVersion: 1, displayName: `로컬 검증 ${i}` });
  // Guests cannot read an unjoined room: use invite preview to obtain the current version.
  const preview = await request('/api/rooms/preview', guest.cookie, { protocolVersion: 1, requestId: randomUUID(), inviteCode });
  const view = preview.result;
  const command = (type, version, payload) => ({ protocolVersion: 1, commandId: randomUUID(), roomId, expectedVersion: version, type, payload });
  const joined = await request(`/api/rooms/${roomId}/commands`, guest.cookie, command('JOIN', view.version, { inviteCode }));
  const ready = await request(`/api/rooms/${roomId}/commands`, guest.cookie, command('SET_READY', joined.result.version, { ready: true }));
  console.log(JSON.stringify({ player: i, roomVersion: ready.result.version, ready: true }));
}
