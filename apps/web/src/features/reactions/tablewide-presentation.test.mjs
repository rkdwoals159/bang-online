import assert from 'node:assert/strict';
import {test} from 'node:test';
import {tablewideResponseLabel,finishTablewideAttack} from './tablewide-presentation.ts';
const target=(status,response)=>({playerId:'b',status,...(response?{response}:{})});
test('waiting and responding both mean choosing, without imposing an input order',()=>{
  for(const status of ['waiting','responding'])assert.equal(tablewideResponseLabel(target(status),null),'선택 중');
});
test('submitted damage is a choice and never presented as applied damage',()=>{
  assert.equal(tablewideResponseLabel(target('submitted','TAKE_HIT'),null),'♥ −1 선택');
  assert.equal(tablewideResponseLabel(target('resolved','TAKE_HIT'),null),'♥ −1');
  assert.equal(tablewideResponseLabel(target('responding','TAKE_HIT'),{kind:'DEATH_RESCUE'}),'♥ −1 · 구제 중');
});
test('bang, missed and barrel results stay distinct from pending judgments',()=>{
  assert.equal(tablewideResponseLabel(target('resolved','USE_BANG'),null),'뱅!');
  assert.equal(tablewideResponseLabel(target('submitted','USE_BANG'),null),'뱅! 선택');
  assert.equal(tablewideResponseLabel(target('resolved','USE_MISSED'),null),'빗나감!');
  assert.equal(tablewideResponseLabel(target('responding','USE_BARREL'),{kind:'LUCKY_DRAW'}),'술통 판정 중');
  assert.equal(tablewideResponseLabel(target('responding','USE_BARREL'),{kind:'GATLING_RESPONSE'}),'다시 선택');
  assert.equal(tablewideResponseLabel(target('resolved','USE_BARREL'),null),'술통 · 방어');
});
test('unknown legacy responses never invent a card or damage outcome',()=>{
  assert.equal(tablewideResponseLabel(target('submitted'),null),'선택함');assert.equal(tablewideResponseLabel(target('resolved'),null),'대응 마침');
});
test('final feedback uses only fresh matching public outcomes and preserves prior accepted choices',()=>{
  const attack={attackId:'current',kind:'indians',sourcePlayerId:'a',targets:[target('resolved','USE_BANG'),{playerId:'c',status:'responding'}]};
  const snapshot={publicTable:{players:[{playerId:'b',eliminated:false},{playerId:'c',eliminated:false}]}};
  const result=finishTablewideAttack(attack,snapshot,[{eventSeq:2,type:'INDIANS_HIT',payload:{targetPlayerId:'b'}},{eventSeq:8,type:'GATLING_MISSED',payload:{targetPlayerId:'c'}},{eventSeq:9,type:'INDIANS_HIT',payload:{targetPlayerId:'c'}}],7);
  assert.equal(result.targets[0].response,'USE_BANG');assert.equal(result.targets[1].response,'TAKE_HIT');assert.ok(result.targets.every(target=>target.status==='resolved'));
});
test('a failed barrel followed by Missed is not falsely reported as barrel success',()=>{
  const attack={attackId:'current',kind:'gatling',sourcePlayerId:'a',targets:[target('responding','USE_BARREL')]};
  const snapshot={publicTable:{players:[{playerId:'b',eliminated:false}]}};
  assert.equal(finishTablewideAttack(attack,snapshot,[{eventSeq:8,type:'BARREL_CHECK_RESOLVED',payload:{targetPlayerId:'b',attackKind:'GATLING',succeeded:false}},{eventSeq:9,type:'GATLING_MISSED',payload:{targetPlayerId:'b'}}],7).targets[0].response,'USE_MISSED');
});
