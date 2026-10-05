import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circleSeatPosition, viewerDistance } from './layout.ts';
import { survivorSnapshot } from './game-table.fixtures.mjs';

test('viewer sits at the bottom and later seats proceed clockwise', () => {
  assert.deepEqual(circleSeatPosition(0,4), {left:'50%',top:'85%'});
  assert.equal(circleSeatPosition(1,4).left,'16%');
  assert.equal(circleSeatPosition(2,4).top,'15%');
  for (let count=4;count<=7;count++) assert.equal(new Set(Array.from({length:count},(_,i)=>JSON.stringify(circleSeatPosition(i,count)))).size,count);
});
test('public distance excludes eliminated players and applies directional modifiers', () => {
  const view = structuredClone(survivorSnapshot);
  const target=view.publicTable.players[0], viewer=view.publicTable.players[2];
  target.characterId='willy_the_kid'; target.inPlay=[]; viewer.inPlay=[]; viewer.characterId='willy_the_kid';
  assert.equal(viewerDistance(view,target),2);
  view.publicTable.players[1].eliminated=true;
  assert.equal(viewerDistance(view,target),1);
  target.characterId='paul_regret'; target.inPlay=[{typeId:'mustang'}];
  assert.equal(viewerDistance(view,target),3);
  viewer.characterId='rose_doolan'; viewer.inPlay=[{typeId:'scope'}];
  assert.equal(viewerDistance(view,target),1);
  assert.equal(viewerDistance(view,viewer),null);
  viewer.eliminated=true;
  assert.equal(viewerDistance(view,target),null);
});
