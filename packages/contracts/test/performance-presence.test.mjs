import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoomPresenceView, parseSyncUnchangedResponse, parseRoomSyncRequest, parseMatchSyncRequest } from '../src/validation.ts';
test('unchanged responses are exact, versioned, and contain no private projection', () => {
  const room = {protocolVersion:1,requestId:'r',status:'unchanged',roomId:'room',version:2};
  const match = {protocolVersion:1,requestId:'r',status:'unchanged',matchId:'match',version:2,eventSeq:3};
  assert.equal(parseSyncUnchangedResponse(room).ok,true);
  assert.equal(parseSyncUnchangedResponse(match).ok,true);
  for (const bad of [{...room, snapshot:{}},{...match,roomId:'room'},{...match,eventSeq:-1}]) assert.equal(parseSyncUnchangedResponse(bad).ok,false);
});
test('unchanged response opt-in is explicitly true and remains backward compatible', () => {
  const room = {protocolVersion:1,requestId:'r',roomId:'room',knownVersion:1};
  const match = {protocolVersion:1,requestId:'r',matchId:'match',knownVersion:1,afterEventSeq:2};
  for (const [parser, value] of [[parseRoomSyncRequest,room],[parseMatchSyncRequest,match]]) {
    assert.equal(parser(value).ok,true);
    assert.equal(parser({...value,acceptUnchanged:true}).ok,true);
    assert.equal(parser({...value,acceptUnchanged:false}).ok,false);
  }
});
test('presence allows only public membership observations', () => {
  const value = {protocolVersion:1,roomId:'room',observedAt:'2026-10-04T00:00:00Z',members:[{playerId:'p',connectionState:'connected'}]};
  assert.equal(parseRoomPresenceView(value).ok,true);
  for (const bad of [{...value,token:'secret'},{...value,members:[{...value.members[0],hand:[]}]},{...value,members:[...value.members,...value.members]},{...value,observedAt:'bad'}]) assert.equal(parseRoomPresenceView(bad).ok,false);
});
