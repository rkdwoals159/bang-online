import assert from 'node:assert/strict';
import {runEngineAcceptanceScenario,findCard,playerId} from '../../packages/test-fixtures/engine/index.ts';
import {BASE_PHYSICAL_CARDS} from '../../packages/catalog/src/cards/index.ts';
import {projectMatchSnapshot} from '../../packages/engine/src/state/projection.ts';
import {writeFileSync} from 'node:fs';
let evidence;
runEngineAcceptanceScenario({id:'audit-sid-rescue',seats:{A:{hand:[{typeId:'bang'}]},B:{characterId:'sid_ketchum',hp:1,hand:Array.from({length:20},()=>({typeId:'bang'}))}}},session=>{
  assert.ok(session.play('A',findCard(session.state,'bang',{player:'A',zone:'hand'}),'B').ok);
  assert.ok(session.respond('B','TAKE_HIT').ok);
  const snapshot=projectMatchSnapshot(session.state,playerId('B'),BASE_PHYSICAL_CARDS);
  assert.equal(snapshot.pendingInteraction.kind,'DEATH_RESCUE');
  const options=snapshot.pendingInteraction.responseOptions;
  evidence={scope:'Performance candidate, no measured production latency',handCount:snapshot.selfPrivate.hand.length,sidOptions:options.filter(option=>option.choice==='USE_SID').length,totalOptions:options.length,snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),optionImageCount:options.filter(option=>option.choice==='USE_SID').length*2};
  assert.equal(evidence.sidOptions,190);
});
writeFileSync(new URL('./sid-rescue-measurement.json',import.meta.url),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
