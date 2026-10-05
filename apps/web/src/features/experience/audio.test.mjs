import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GameAudio } from './audio.ts';
const originalWindow=globalThis.window, originalDocument=globalThis.document;
afterEach(()=>{globalThis.window=originalWindow;globalThis.document=originalDocument;});
function install(state='running') {
  const calls={contexts:0,noise:0,tones:0,closed:0,gain:[]};
  const param=()=>({value:0,setValueAtTime:(v)=>calls.gain.push(v),exponentialRampToValueAtTime:()=>{}});
  const node=()=>({connect(){},disconnect(){},start(){},stop(){},gain:param(),frequency:param()});
  class Context {state=state;currentTime=0;sampleRate=100;destination={};constructor(){calls.contexts++;}createGain(){return node();}createBuffer(){return {getChannelData:()=>new Float32Array(60)};}createBufferSource(){calls.noise++;return node();}createBiquadFilter(){return node();}createOscillator(){calls.tones++;return node();}async resume(){this.state='running';}async close(){calls.closed++;}}
  globalThis.window={AudioContext:Context};globalThis.document={hidden:false};return calls;
}
test('sound stays silent before a user gesture unlocks one reusable context',()=>{const calls=install(),audio=new GameAudio();assert.equal(audio.play('shot'),false);assert.equal(calls.contexts,0);audio.unlock();audio.unlock();assert.equal(calls.contexts,1);assert.equal(audio.play('shot'),true);assert.equal(calls.noise,1);audio.dispose();assert.equal(calls.closed,1);});
test('Gatling schedules five rapid shots and defense schedules a distinct metallic ping',()=>{const calls=install(),audio=new GameAudio();audio.unlock();audio.play('burst');assert.equal(calls.noise,5);assert.equal(calls.tones,5);audio.play('block');assert.equal(calls.tones,7);assert.equal(calls.noise,5);audio.dispose();});
test('mute immediately silences the output; hidden tabs and unsupported audio are harmless',()=>{const calls=install(),audio=new GameAudio();audio.unlock();audio.setEnabled(false);assert.equal(calls.gain.at(-1),0);assert.equal(audio.play('burst'),false);audio.setEnabled(true);globalThis.document.hidden=true;assert.equal(audio.play('block'),false);audio.dispose();globalThis.window={};const unavailable=new GameAudio();unavailable.unlock();assert.equal(unavailable.play('shot'),false);});
