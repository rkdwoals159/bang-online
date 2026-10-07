import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancePresentation, boundCueQueue, MAX_QUEUED_CUES, cueDuration } from './model.ts';
const now = Date.parse('2026-10-05T07:00:00Z');
const card = {cardInstanceId:'public-card',typeId:'bang',rank:'A',suit:'SPADES'};
function state() { return {status:'playing', viewer:{playerId:'a',seatIndex:0,mode:'active'}, publicTable:{players:['a','b','c','d'].map((playerId,seatIndex)=>({playerId,seatIndex,displayName:playerId,characterId:'willy_the_kid',hp:4,maxHp:4,handCount:4,inPlay:[],eliminated:false,role:seatIndex===0?'sheriff':null})),turn:{currentPlayerId:'a',phase:'play'},deckCount:40,publicDiscard:{topCard:null,count:0}},selfPrivate:{role:'sheriff',hand:[card]},pendingInteraction:null}; }
const event = (eventSeq,type,payload={},age=0)=>({eventSeq,type,payload,occurredAt:new Date(now-age).toISOString()});
const baseline = snapshot=>advancePresentation(null,1,snapshot,[],now).cursor;

test('steal and forced discard cues preserve the public route without leaking card faces',()=>{
  for(const type of ['PANIC_USED','PUBLIC_CARD_TAKEN','CAT_BALOU_USED','PUBLIC_CARD_DISCARDED']) {
    const s=state(), result=advancePresentation(baseline(s),2,s,[event(1,type,{actorPlayerId:'a',targetPlayerId:'b',targetZone:'in_play',fromZone:'in_play',cardType:'beer',cardInstanceId:'private-secret'})],now);
    const cue=result.cues[0]; assert.deepEqual(cue.movement,type.includes('TAKEN')||type==='PANIC_USED'
      ?{fromId:'b',toId:'a',fromZone:'in_play',toZone:'hand'}:{fromId:'b',fromZone:'in_play',toZone:'discard'});
    assert.doesNotMatch(JSON.stringify(cue),/beer|private-secret/); assert.equal(cue.card,undefined);
    assert.deepEqual(advancePresentation(result.cursor,2,s,[event(1,type,{actorPlayerId:'a',targetPlayerId:'b'})],now).cues,[]);
  }
});
test('a stolen card gets one transfer effect and no duplicate deck draw',()=>{
  const old=state(),s=structuredClone(old);s.publicTable.players[0].handCount++;
  s.selfPrivate.hand.push({...card,cardInstanceId:'private-new'});
  const result=advancePresentation(baseline(old),2,s,[event(1,'PUBLIC_CARD_TAKEN',{actorPlayerId:'a',targetPlayerId:'b',targetZone:'hand'})],now);
  assert.equal(result.cues.filter(c=>c.kind==='pick').length,1);assert.equal(result.cues.some(c=>c.kind==='draw'),false);
});
test('lethal dynamite explosion survives cleanup backlog and is not doubled as ordinary damage',()=>{
  const old=state(),s=structuredClone(old);s.publicTable.players[1].hp=1;
  const events=[event(1,'DYNAMITE_EXPLODED',{targetPlayerId:'b',damage:3}),...Array.from({length:24},(_,i)=>event(i+2,'PUBLIC_CARD_DISCARDED',{targetPlayerId:'b',fromZone:'hand'}))];
  const result=advancePresentation(baseline(old),2,s,events,now);
  assert.equal(result.cues.length,MAX_QUEUED_CUES);assert.equal(result.cues[0].kind,'explosion');assert.equal(result.cues.some(c=>c.kind==='hit'),false);
  assert.equal(boundCueQueue(result.cues.concat(Array.from({length:15},(_,i)=>({id:`new:${i}`,kind:'draw',label:'draw',targetIds:['a']})))).some(c=>c.kind==='explosion'),true);
  assert.ok(cueDuration('explosion')>=1000);
});
test('first connection and hidden-tab replay do not play historical attacks',()=>{const s=state(),e=event(10,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'}); assert.deepEqual(advancePresentation(null,1,s,[e],now).cues,[]); const hidden=advancePresentation(baseline(s),2,s,[e],now,false); assert.deepEqual(hidden.cues,[]); assert.deepEqual(advancePresentation(hidden.cursor,2,s,[e],now).cues,[]);});
test('shots connect authenticated actor and public target; replay is silent',()=>{const s=state(); const next=advancePresentation(baseline(s),2,s,[event(1,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'})],now); assert.deepEqual(next.cues.map(c=>[c.kind,c.actorId,c.targetIds]),[['shot','a',['b']]]); assert.deepEqual(advancePresentation(next.cursor,2,s,[event(1,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'})],now).cues,[]);});
test('Gatling targets every projected opponent and a blocked player gets a separate ping',()=>{const s=state(); const next=advancePresentation(baseline(s),2,s,[event(1,'GATLING_STARTED',{actorPlayerId:'a',targetPlayerIds:['b','c','d','unknown']}),event(2,'GATLING_MISSED',{actorPlayerId:'b',targetPlayerId:'b'})],now); assert.deepEqual(next.cues.map(c=>[c.kind,c.targetIds]),[['burst',['b','c','d']],['block',['b']]]);});
test('barrel failure never sounds like a successful block; success is not double counted',()=>{const s=state(); const fail=advancePresentation(baseline(s),2,s,[event(1,'BARREL_CHECK_RESOLVED',{targetPlayerId:'b',succeeded:false})],now); assert.equal(fail.cues[0].kind,'judgment'); const success=advancePresentation(baseline(s),2,s,[event(1,'BARREL_CHECK_RESOLVED',{targetPlayerId:'b',succeeded:true}),event(2,'BANG_MISSED',{targetPlayerId:'b'})],now); assert.equal(success.cues.filter(c=>c.kind==='block').length,1); const partial=advancePresentation(baseline(s),2,s,[event(1,'BARREL_CHECK_RESOLVED',{targetPlayerId:'b',succeeded:true,requiredMisses:2,successfulMisses:1})],now); assert.equal(partial.cues[0].kind,'block');});
test('stale, malformed, private and unknown event data cannot create effects',()=>{const s=state(); const result=advancePresentation(baseline(s),2,s,[event(1,'CARD_DRAWN',{card:{...card,typeId:'private-sentinel'}}),event(2,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'private-sentinel'}),event(3,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'},11000),{...event(4,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'}),occurredAt:'bad'}],now); assert.deepEqual(result.cues,[]); assert.doesNotMatch(JSON.stringify(result.cues),/private-sentinel/);});
test('older versions cannot move the effect cursor backwards',()=>{const s=state();const previous={...baseline(s),version:8,eventSeq:20};const result=advancePresentation(previous,7,s,[event(21,'BANG_ATTACKED',{actorPlayerId:'a',targetPlayerId:'b'})],now);assert.equal(result.cursor,previous);assert.deepEqual(result.cues,[]);});
test('HP deltas show hit/heal once and zero-healing beer does not fake a heal',()=>{const old=state(),s=structuredClone(old); s.publicTable.players[1].hp=3; const result=advancePresentation(baseline(old),2,s,[event(1,'BANG_HIT',{actorPlayerId:'a',targetPlayerId:'b',damage:1}),event(2,'BEER_USED',{actorPlayerId:'a',healed:0})],now); assert.equal(result.cues.filter(c=>c.kind==='hit').length,1); assert.equal(result.cues.filter(c=>c.kind==='heal').length,0); assert.match(result.cues.find(c=>c.kind==='ability').label,/회복 없음/);});
test('draw, equipment, turn, elimination and victory use public snapshot changes',()=>{const old=state(),s=structuredClone(old); s.publicTable.players[0].handCount=6; s.publicTable.players[1].inPlay=[{...card,typeId:'barrel'}]; s.publicTable.players[2].hp=0;s.publicTable.players[2].eliminated=true;s.publicTable.turn.currentPlayerId='b';const result=advancePresentation(baseline(old),2,s,[],now);assert.deepEqual(result.cues.map(c=>c.kind),['draw','equip','eliminated','turn']);const completed=structuredClone(s);completed.status='completed';completed.outcome={winningFaction:'sheriff_and_deputies',winningPlayerIds:['a','b']};assert.equal(advancePresentation(result.cursor,3,completed,[],now).cues[0].kind,'victory');});
test('store pick moves only one publicly revealed card to its known previous chooser',()=>{const old=state();old.pendingInteraction={kind:'GENERAL_STORE_PICK',interactionId:'store',currentResponderPlayerId:'b',allowedChoices:[],step:{current:1,total:4}};old.publicTable.generalStoreCards=[card,{...card,cardInstanceId:'second'}];const s=structuredClone(old);s.publicTable.generalStoreCards=[old.publicTable.generalStoreCards[1]];s.pendingInteraction.currentResponderPlayerId='c';const result=advancePresentation(baseline(old),2,s,[],now);assert.equal(result.cues[0].kind,'pick');assert.deepEqual(result.cues[0].targetIds,['b']);assert.equal(result.cues[0].card.cardInstanceId,card.cardInstanceId);s.publicTable.generalStoreCards=[];assert.equal(advancePresentation(baseline(old),2,s,[],now).cues.length,0);});
test('short bounded queue prevents unbounded animation backlog',()=>{const s=state();const events=Array.from({length:50},(_,i)=>event(i+1,'BANG_MISSED',{targetPlayerId:'b'})); assert.equal(advancePresentation(baseline(s),2,s,events,now).cues.length,MAX_QUEUED_CUES);});
test('a queue containing only critical effects still stays bounded',()=>{
  const cues=Array.from({length:30},(_,i)=>({id:`critical:${i}`,kind:'explosion',label:'blast',targetIds:['a']}));
  const bounded=boundCueQueue(cues);assert.equal(bounded.length,MAX_QUEUED_CUES);
  assert.deepEqual(bounded.slice(-3).map(c=>c.id),cues.slice(-3).map(c=>c.id));
});

test('elimination precedes victory and simultaneous equipment cues have unique identities',()=>{const old=state(),s=structuredClone(old);s.publicTable.players[1].hp=0;s.publicTable.players[1].eliminated=true;s.publicTable.players[0].inPlay=[card,{...card,cardInstanceId:'another-public-card',typeId:'barrel'}];s.status='completed';s.outcome={winningFaction:'sheriff_and_deputies',winningPlayerIds:['a']};const result=advancePresentation(baseline(old),2,s,[],now);assert.equal(result.cues.at(-1).kind,'victory');assert.ok(result.cues.findIndex(c=>c.kind==='eliminated')<result.cues.findIndex(c=>c.kind==='victory'));assert.equal(new Set(result.cues.map(c=>c.id)).size,result.cues.length);});

test('public card use gets one flight only for an adjacent update on the same turn',()=>{const old=state(),s=structuredClone(old);s.publicTable.publicDiscard={topCard:card,count:1};const result=advancePresentation(baseline(old),2,s,[],now);assert.equal(result.cues.find(c=>c.kind==='play').card.cardInstanceId,'public-card');assert.equal(result.cues.find(c=>c.kind==='play').actorId,'a');assert.equal(advancePresentation(baseline(old),4,s,[],now).cues.some(c=>c.kind==='play'),false);s.publicTable.turn.currentPlayerId='b';assert.equal(advancePresentation(baseline(old),2,s,[],now).cues.some(c=>c.kind==='play'),false);});
test('dynamite passing preserves public source and avoids a false equip cue',()=>{const old=state(),s=structuredClone(old);s.publicTable.players[1].inPlay=[{...card,typeId:'dynamite'}];const result=advancePresentation(baseline(old),2,s,[event(1,'DYNAMITE_PASSED',{fromPlayerId:'a',toPlayerId:'b'})],now);assert.equal(result.cues[0].actorId,'a');assert.equal(result.cues.filter(c=>c.kind==='equip').length,0);});
test('draw cues retain count without exposing cards, and zero-healing beer has a drink sound',()=>{
  const old=state(),s=structuredClone(old);s.publicTable.players[0].handCount=7;
  const result=advancePresentation(baseline(old),2,s,[event(1,'BEER_USED',{actorPlayerId:'a',healed:0})],now);
  assert.equal(result.cues.find(c=>c.kind==='draw').count,3);assert.equal(result.cues.find(c=>c.kind==='ability').sound,'drink');assert.equal(result.cues.some(c=>c.kind==='heal'),false);assert.doesNotMatch(JSON.stringify(result.cues),/public-card/);
});
test('a used draw card still counts both incoming private cards instead of just the net hand gain',()=>{
  const old=state(),s=structuredClone(old);old.selfPrivate.hand=[{...card,typeId:'stagecoach'}];s.selfPrivate.hand=[{...card,cardInstanceId:'new-one'},{...card,cardInstanceId:'new-two'}];s.publicTable.players[0].handCount=5;
  const result=advancePresentation(baseline(old),2,s,[],now);assert.equal(result.cues.find(c=>c.kind==='draw').count,2);assert.doesNotMatch(JSON.stringify(result.cues),/new-one|new-two/);
});
