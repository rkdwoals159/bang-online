import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { seatMotion, playSeatMotion } from './motion.ts';

function fixture() {
  const doc = new EventTarget(); doc.hidden = false;
  const calls = [];
  return { doc, calls, element: { ownerDocument: doc, animate(frames, options) { const animation = { cancelled: false, cancel() { this.cancelled = true; } }; calls.push({ frames, options, animation }); return animation; } } };
}
test('all seat presets are finite and finish at the untransformed seat', () => {
  for (const effect of ['hit', 'explosion', 'source', 'turn', 'draw', 'pick', 'equip', 'block', 'heal', 'victory', 'eliminated']) {
    const preset = seatMotion(effect);
    assert.equal(preset.options.iterations, 1);
    assert.ok(preset.options.duration <= 480);
    assert.notEqual(preset.options.fill, 'forwards');
    assert.match(preset.frames.at(-1).transform, /^(none|scale\(1\)|translateX\(0px\))$/);
    for (const frame of preset.frames) assert.ok(Object.keys(frame).every(key => ['transform', 'opacity', 'offset'].includes(key)));
  }
});
test('consecutive identical hits create distinct animations and clean up the old one', () => {
  const f = fixture(); const first = playSeatMotion(f.element, 'hit', true); first();
  const second = playSeatMotion(f.element, 'hit', true);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].animation.cancelled, true);
  assert.equal(f.calls[1].animation.cancelled, false); second();
  assert.equal(f.calls[1].animation.cancelled, true);
});
test('disabled/reduced motion and hidden documents never start seat effects', () => {
  const f = fixture(); playSeatMotion(f.element, 'hit', false)();
  f.doc.hidden = true; playSeatMotion(f.element, 'hit', true)();
  assert.equal(f.calls.length, 0);
});
test('hiding a tab cancels active motion, and cleanup removes its listener', () => {
  const f = fixture(); const stop = playSeatMotion(f.element, 'source', true);
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.calls[0].animation.cancelled, true); stop();
  f.calls[0].animation.cancelled = false; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.calls[0].animation.cancelled, false);
});
test('missing, unrelated or unsupported motion does not interfere with gameplay', () => {
  const f = fixture(); playSeatMotion(f.element, undefined, true)(); playSeatMotion(f.element, 'judgment', true)();
  assert.equal(f.calls.length, 0); delete f.element.animate;
  assert.doesNotThrow(() => playSeatMotion(f.element, 'hit', true)());
  f.element.animate = () => { throw new Error('animation unavailable'); };
  assert.doesNotThrow(() => playSeatMotion(f.element, 'hit', true)());
});
test('adapted shake preserves Animista offsets with small game-specific amplitude', () => {
  const hit = seatMotion('hit'); assert.equal(hit.frames.length, 11);
  assert.deepEqual(hit.frames.map(f => f.offset), Array.from({ length: 11 }, (_, i) => i / 10));
  assert.ok(hit.frames.every(f => Math.abs(Number(f.transform.match(/\(([-\d.]+)px/)[1])) <= 3));
});
test('selected CSS and the distributable license retain Animista attribution', () => {
  const css = readFileSync(new URL('./animista.css', import.meta.url), 'utf8');
  assert.match(css, /Copyright 2017 Ana Travas/); assert.match(css, /bang-swing-in-top-fwd/);
  assert.doesNotMatch(css, /infinite|filter:|width:|height:/);
  const license = readFileSync(new URL('../../../../site/public/licenses/animista.txt', import.meta.url), 'utf8');
  assert.match(license, /THIS SOFTWARE IS PROVIDED/); assert.match(license, /Redistributions in binary form/);
});
