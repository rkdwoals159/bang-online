import assert from 'node:assert/strict';
import {test} from 'node:test';
import {automaticResponseFor,parseAutomaticResponsePreferences,DEFAULT_AUTOMATIC_RESPONSES,scheduleAutomaticResponse} from './automatic-response.ts';
const all={indiansBang:true,attackMissed:true,barrelFirst:true};
function view(kind,choices){return {status:'playing',viewer:{playerId:'self',mode:'active'},pendingInteraction:{kind,interactionId:'prompt',currentResponderPlayerId:'self',responseOptions:choices.map(choice=>({interactionId:'prompt',choice,...(['USE_BANG','USE_MISSED'].includes(choice)?{cardInstanceId:`own-${choice}`}:{})}))}};}
test('automatic defense defaults off and settings accept only explicit booleans',()=>{
  for(const value of [null,'{}','broken','null','[]','{"indiansBang":"true","attackMissed":1}'])assert.deepEqual(parseAutomaticResponsePreferences(value),DEFAULT_AUTOMATIC_RESPONSES);
  assert.deepEqual(parseAutomaticResponsePreferences(JSON.stringify({...all,unexpected:true})),all);
  assert.equal(automaticResponseFor(view('INDIANS_RESPONSE',['USE_BANG','TAKE_HIT']),DEFAULT_AUTOMATIC_RESPONSES),null);
});
for(const kind of ['BANG_RESPONSE','GATLING_RESPONSE']){
  test(`${kind}: Barrel has priority, a failed/unavailable Barrel falls back only to enabled Missed`,()=>{
    const snapshot=view(kind,['USE_MISSED','USE_BARREL','TAKE_HIT']);
    assert.strictEqual(automaticResponseFor(snapshot,all),snapshot.pendingInteraction.responseOptions[1]);
    assert.equal(automaticResponseFor(view(kind,['USE_MISSED','TAKE_HIT']),all)?.choice,'USE_MISSED');
    assert.equal(automaticResponseFor(view(kind,['USE_MISSED','TAKE_HIT']),{...all,attackMissed:false}),null);
    assert.equal(automaticResponseFor(snapshot,{...all,barrelFirst:false})?.choice,'USE_MISSED');
    assert.equal(automaticResponseFor(view(kind,['TAKE_HIT']),all),null);
  });
}
test('Indians uses the exact Bang option, never Barrel or Missed or damage',()=>{
  const snapshot=view('INDIANS_RESPONSE',['USE_BARREL','USE_MISSED','USE_BANG','TAKE_HIT']);
  assert.strictEqual(automaticResponseFor(snapshot,all),snapshot.pendingInteraction.responseOptions[2]);
  assert.equal(automaticResponseFor(view('INDIANS_RESPONSE',['USE_MISSED','TAKE_HIT']),all),null);
  assert.equal(automaticResponseFor(snapshot,{...all,indiansBang:false}),null);
});
for(const kind of ['DUEL_RESPONSE','DEATH_RESCUE','LUCKY_DRAW','DISCARDS_ORDER','GENERAL_STORE_PICK'])test(`${kind}: manual choices are never automated`,()=>{
  assert.equal(automaticResponseFor(view(kind,['USE_MISSED','USE_BANG','USE_BARREL','ACCEPT_ELIMINATION']),all),null);
});
test('spectators, another responder, paused and completed games never send automatic commands',()=>{
  for(const change of [{status:'paused'},{status:'completed'},{viewer:{playerId:'self',mode:'eliminated'}},{viewer:{playerId:'other',mode:'active'}}])assert.equal(automaticResponseFor({...view('BANG_RESPONSE',['USE_MISSED']),...change},all),null);
});
test('cancelled timers and repeated renders cannot send twice; a newer legal response can proceed',()=>{
  const gate={current:''};let pending,cancelled=0,sent=0;
  const schedule=callback=>(pending=callback,1),cancel=()=>cancelled++;
  const stop=scheduleAutomaticResponse('match:v1:prompt',gate,()=>sent++,schedule,cancel);stop();pending();assert.equal(sent,0);assert.equal(cancelled,1);
  scheduleAutomaticResponse('match:v1:prompt',gate,()=>sent++,schedule,cancel);pending();pending();assert.equal(sent,1);
  assert.equal(scheduleAutomaticResponse('match:v1:prompt',gate,()=>sent++,schedule,cancel),undefined);
  scheduleAutomaticResponse('match:v2:next',gate,()=>sent++,schedule,cancel);pending();assert.equal(sent,2);
});
