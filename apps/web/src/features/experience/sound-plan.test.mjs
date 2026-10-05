import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planSounds} from './sound-plan.ts';
const cue=(kind,id=kind,extra={})=>({id,kind,label:'공개 행동',targetIds:['public-player'],...extra});
test('card sounds distinguish draw, play, discard and equipment in one prompt score',()=>{
  const steps=planSounds(['draw','play','discard','equip'].map(kind=>cue(kind)));
  assert.deepEqual(steps.map(s=>s.kind),['play','draw','discard','equip']);
  assert.deepEqual(steps.map(s=>Math.round(s.offset*1000)),[0,75,150,225]);
});
test('draw packets use public counts but never schedule more than four paper slips',()=>{
  assert.equal(planSounds([cue('draw','a',{count:2}),cue('draw','b',{count:3})])[0].count,4);
  assert.equal(planSounds([cue('draw','a',{count:Infinity})])[0].count,1);
});
test('repeated cue identities and same-kind public responses are coalesced',()=>{
  assert.equal(planSounds([cue('block','a'),cue('block','a'),cue('block','b')]).length,1);
});
test('weapon reload, jail latch and dynamite fuse derive only from projected equipment',()=>{
  for(const [typeId,kind] of [['winchester','reload'],['volcanic','reload'],['jail','jail'],['dynamite','fuse'],['barrel','equip']])
    assert.equal(planSounds([cue('equip','a',{card:{typeId}})])[0].kind,kind);
});
test('explicit beer and jail result sounds preserve their visual cue kind',()=>{
  assert.equal(planSounds([cue('ability','beer',{sound:'drink'})])[0].kind,'drink');
  assert.equal(planSounds([cue('judgment','jail',{sound:'escape'})])[0].kind,'escape');
});
test('large syncs have a bounded score and always retain the victory ending',()=>{
  const steps=planSounds(['draw','play','equip','hit','block','eliminated','turn','victory'].map(kind=>cue(kind)));
  assert.equal(steps.length,6);assert.equal(steps.at(-1).kind,'victory');assert.ok(steps.every(s=>s.offset<.4));
});
