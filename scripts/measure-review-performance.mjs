import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { buildEngineScenarioFixture, playerId } from "../packages/test-fixtures/engine/index.ts";
import { buildLegalActionCandidates } from "../packages/engine/src/actions/index.ts";

const results = [];
for (const playerCount of [4, 7]) {
  const state = buildEngineScenarioFixture({ id: `review-performance-${playerCount}`, playerCount,
    seats: { A: { characterId: "sid_ketchum", hp: 2, hand: Array.from({ length: 20 }, () => ({ typeId: "bang" })) } } });
  const modes = {};
  for (const compactAbilityCosts of [false, true]) {
    const run = () => buildLegalActionCandidates(state, playerId("A"), { compactAbilityCosts });
    for (let i = 0; i < 5; i++) run();
    const samples = [];
    for (let i = 0; i < 40; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    const ability = run().filter(action => action.type === "USE_ABILITY");
    modes[compactAbilityCosts ? "compact" : "enumerated"] = {
      samples: samples.length, p50Ms: samples[19], p95Ms: samples[37],
      abilityProposalCount: ability.length, abilityJsonBytes: Buffer.byteLength(JSON.stringify(ability)),
    };
  }
  results.push({ playerCount, handCount: 20, modes });
}
const output = { scope: "local engine microbenchmark; no production/network latency claim", results };
await mkdir("outputs/review-2026-10-05/full-code-fixes", { recursive: true });
await writeFile("outputs/review-2026-10-05/full-code-fixes/performance.json", JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output));
