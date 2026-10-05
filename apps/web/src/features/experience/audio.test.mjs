import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GameAudio } from './audio.ts';
const originalWindow=globalThis.window, originalDocument=globalThis.document;
afterEach(()=>{globalThis.window=originalWindow;globalThis.document=originalDocument;});
function install(state='running') {
  const calls={contexts:0,noise:0,tones:0,closed:0,stops:0,gain:[],timeline:[],nodes:[]};
  const param=()=>({value:0,setValueAtTime:(v,t)=>{calls.gain.push(v);calls.timeline.push(['set',v,t]);},exponentialRampToValueAtTime:(v,t)=>calls.timeline.push(['ramp',v,t])});
  const node=()=>{const n={connect(){},disconnect(){},start(t){calls.timeline.push(['start',t]);},stop(t){calls.stops++;calls.timeline.push(['stop',t]);},gain:param(),frequency:param()};calls.nodes.push(n);return n;};
  class Context {state=state;currentTime=0;sampleRate=100;destination={};constructor(){calls.contexts++;}createGain(){return node();}createBuffer(){return {getChannelData:()=>new Float32Array(60)};}createBufferSource(){calls.noise++;return node();}createBiquadFilter(){return node();}createOscillator(){calls.tones++;return node();}async resume(){this.state='running';}async close(){calls.closed++;}}
  globalThis.window={AudioContext:Context};globalThis.document={hidden:false};return calls;
}
test('sound stays silent before a user gesture unlocks one reusable context',()=>{const calls=install(),audio=new GameAudio();assert.equal(audio.play('shot'),false);assert.equal(calls.contexts,0);audio.unlock();audio.unlock();assert.equal(calls.contexts,1);assert.equal(audio.play('shot'),true);assert.equal(calls.noise,1);audio.dispose();assert.equal(calls.closed,1);});
test('Gatling schedules five rapid shots and defense schedules a distinct metallic ping',()=>{const calls=install(),audio=new GameAudio();audio.unlock();audio.play('burst');assert.equal(calls.noise,5);assert.equal(calls.tones,5);audio.play('block');assert.equal(calls.tones,7);assert.equal(calls.noise,5);audio.dispose();});
test('mute immediately silences the output; hidden tabs and unsupported audio are harmless',()=>{const calls=install(),audio=new GameAudio();audio.unlock();audio.setEnabled(false);assert.equal(calls.gain.at(-1),0);assert.equal(audio.play('burst'),false);audio.setEnabled(true);globalThis.document.hidden=true;assert.equal(audio.play('block'),false);audio.dispose();globalThis.window={};const unavailable=new GameAudio();unavailable.unlock();assert.equal(unavailable.play('shot'),false);});

test('hiding a tab stops scheduled sources and cannot resume the old burst on return',()=>{const calls=install(),audio=new GameAudio();audio.unlock();audio.play('burst');const scheduled=calls.stops;audio.setVisible(false);assert.equal(calls.stops,scheduled+10);assert.equal(calls.gain.at(-1),0);assert.equal(audio.play('block'),false);audio.setVisible(true);assert.equal(calls.tones,5);assert.equal(audio.play('block'),true);audio.setEnabled(false);assert.equal(calls.stops,scheduled+10+4);audio.dispose();});

test('all 26 gameplay effects have distinct scheduled audio recipes',()=>{
  const kinds=['shot','burst','block','hit','heal','judgment','explosion','duel','threat','draw','discard','equip','turn','eliminated','victory','store','pick','ability','pass','play','drink','reload','fuse','jail','escape','jail_skip'];
  const signatures=new Set();
  for(const kind of kinds){const calls=install(),audio=new GameAudio();audio.unlock();calls.timeline=[];assert.equal(audio.play(kind),true,kind);const signature=JSON.stringify([calls.timeline,calls.nodes.map(n=>[n.type,n.frequency.value])]);assert.equal(signatures.has(signature),false,`${kind} must have its own recipe`);signatures.add(signature);audio.dispose();}
});
test('receiving several cards schedules a capped, staggered paper sound',()=>{
  const calls=install(),audio=new GameAudio();audio.unlock();audio.play('draw',.075,80);assert.equal(calls.noise,4);assert.equal(calls.tones,4);assert.ok(calls.timeline.filter(c=>c[0]==='start').every(c=>c[1]>=.075&&c[1]<.3));audio.dispose();
});
test('volume is clamped, mute stops sources, and invalid levels leave output unchanged',()=>{
  const calls=install(),audio=new GameAudio();audio.unlock();audio.setVolume(2);assert.equal(calls.gain.at(-1),.3);audio.setVolume(.5);assert.equal(calls.gain.at(-1),.15);audio.setVolume(NaN);assert.equal(calls.gain.at(-1),.15);audio.play('draw');audio.setVolume(0);assert.equal(calls.gain.at(-1),0);assert.equal(audio.play('play'),false);audio.setEnabled(false);audio.setVolume(.7);assert.equal(calls.gain.at(-1),0);audio.dispose();
});
test('source budget stops allocating nodes when a large sound batch fills it',()=>{
  const calls=install(),audio=new GameAudio();audio.unlock();for(let i=0;i<6;i++)audio.play('burst');assert.equal(calls.noise+calls.tones,48);const allocations=calls.nodes.length;assert.equal(audio.play('store'),false);assert.equal(calls.nodes.length,allocations);audio.dispose();
});
