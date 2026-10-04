import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { buildLegalActionCandidates } from '../packages/engine/src/actions/index.ts';
import { buildReferenceActionCandidates } from '../packages/engine/test/actions/reference-probe.ts';
import { initializeGame } from '../packages/engine/src/setup/initialize.ts';

const players = Array.from({ length: 7 }, (_, i) => ({ playerId: `p${i}`, displayName: `P${i}` }));
const results = [];
for (const handSize of [4, 12, 40, 80]) {
  const state = initializeGame({ players, random: { nextFloat: () => 0.5 } });
  const actor = state.seats[0];
  state.turn.currentPlayerId = actor.public.playerId;
  state.turn.phase = 'play';
  actor.public.characterId = 'sid_ketchum';
  const all = Object.keys(state.zones.cardsByInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [];
    seat.public.inPlayCardInstanceIds = [];
  }
  actor.private.handCardInstanceIds = all.slice(0, handSize);
  state.zones.drawPileCardInstanceIds = all.slice(handSize);
  state.zones.discardPileCardInstanceIds = [];
  const samples = { reference: [], optimized: [] };
  const functions = { reference: buildReferenceActionCandidates, optimized: buildLegalActionCandidates };
  let candidates;
  for (let iteration = 0; iteration < 12; iteration++) {
    for (const name of iteration % 2 ? ['optimized', 'reference'] : ['reference', 'optimized']) {
      const started = performance.now();
      const value = functions[name](state, actor.public.playerId);
      const elapsed = performance.now() - started;
      if (iteration >= 2) samples[name].push(elapsed);
      if (name === 'reference') candidates = value;
      else assert.deepEqual(value, candidates);
    }
  }
  results.push({ handSize, candidates: candidates.length, jsonBytes: Buffer.byteLength(JSON.stringify(candidates)),
    referenceMedianMs: samples.reference.sort((a, b) => a - b)[5],
    optimizedMedianMs: samples.optimized.sort((a, b) => a - b)[5] });
}
const evidence = { observedAt: new Date().toISOString(),
  scope: 'Isolated Node CPU benchmark, seven-player synthetic Sid fixtures; not network latency or production P95',
  samplesPerImplementation: 10, warmupIterations: 2, results };
console.log(JSON.stringify(evidence, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`);
