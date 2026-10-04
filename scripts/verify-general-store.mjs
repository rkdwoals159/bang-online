import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/review-2026-10-04/general-store-fix');
mkdirSync(output, { recursive: true });
const loader = pathToFileURL(path.join(root, 'apps/site/node_modules/tsx/dist/loader.mjs')).href;
const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (files.status !== 0) throw Error('Cannot inventory verification inputs');
const inventory = [...new Set(files.stdout.split('\0').filter(file => /^(packages\/|apps\/(web|site|server)\/|scripts\/|pnpm-lock\.yaml|package\.json)/.test(file)))].sort();
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of inventory) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
};
const inputFingerprint = fingerprint();
const selectTests = prefix => inventory.filter(file => file.startsWith(prefix) && /(?:\.test\.(ts|mjs)|\.type-test\.ts)$/.test(file));
const records = [];
function run(label, args, cwd = root) {
  console.log(`RUN ${label}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true,
    maxBuffer: 20 * 1024 * 1024, timeout: 300000 });
  const text = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(path.join(output, `${label}.log`), text);
  records.push({ label, args, cwd: path.relative(root, cwd) || '.', exitCode: result.status,
    status: result.status === 0 ? 'PASS' : 'FAIL', elapsedMs: Date.now() - started,
    ...(text.match(/# tests (\d+)/) ? { tests: Number(text.match(/# tests (\d+)/)[1]), passed: Number(text.match(/# pass (\d+)/)[1]) } : {}),
    ...(result.error ? { error: result.error.message } : {}) });
  console.log(`RESULT ${label}: ${records.at(-1).status}`);
  if (result.status !== 0) throw Error(`${label} failed; see its log`);
}
let status = 'FAIL';
try {
  for (const project of ['packages/contracts', 'packages/engine', 'apps/server', 'apps/web', 'apps/site']) {
    run(`${project.split('/').at(-1)}-check`, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', `${project}/tsconfig.json`]);
  }
  run('contracts-tests', ['--import', loader, '--test', ...selectTests('packages/contracts/test/')]);
  run('engine-tests', ['--import', loader, '--test', '--test-concurrency=1', ...selectTests('packages/engine/test/')]);
  run('site-match-tests', ['--import', loader, '--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=180000', 'apps/site/test/server/match-sync.test.ts']);
  run('web-tests', ['--import', loader, '--test', '--test-concurrency=1', ...selectTests('apps/web/')]);
  run('site-build', ['scripts/run-framework.mjs', 'build'], path.join(root, 'apps/site'));
  run('stage-site-build', ['scripts/build-sites.mjs']);
  if (fingerprint() !== inputFingerprint) throw Error('Verification inputs changed during execution');
  status = 'PASS';
} catch (error) {
  console.error(error.message);
} finally {
  writeFileSync(path.join(output, 'verification.json'), `${JSON.stringify({ observedAt: new Date().toISOString(), status,
    inputFingerprint, records, scope: 'General Store fix: full contracts/engine/web regressions, Site match HTTP suite, type checks and build. Full Node/D1 suites were not rerun; original D06/D18 and production S09 remain NOT RUN.' }, null, 2)}\n`);
}
process.exitCode = status === 'PASS' ? 0 : 1;
