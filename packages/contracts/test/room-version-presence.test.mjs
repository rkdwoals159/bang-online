import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseRoomView, parseRoomSyncResponse } from '../src/validation.ts';
const source = JSON.parse(readFileSync(new URL('../../test-fixtures/protocol/room-sync.response.waiting.valid.json',import.meta.url),'utf8'));
test('room commands can carry a canonical version and allowlisted member presence', () => {
  const room={...source.room,version:source.version,members:source.room.members.map(member=>({...member,connectionState:'connected'}))};
  assert.equal(parseRoomView(room).ok,true);
  assert.equal(parseRoomView({...room,version:-1}).ok,false);
  assert.equal(parseRoomView({...room,members:[{...room.members[0],connectionState:'reconnecting'}]}).ok,false);
});
test('room envelope and nested canonical version cannot disagree', () => {
  assert.equal(parseRoomSyncResponse({...source,room:{...source.room,version:source.version}}).ok,true);
  assert.equal(parseRoomSyncResponse({...source,room:{...source.room,version:source.version+1}}).ok,false);
});
