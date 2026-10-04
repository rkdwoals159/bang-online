import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8806');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname), 'Local Worker only');
const chunks = await readdir(new URL('../dist/client/_next/static/chunks/', import.meta.url));
const entry = chunks.find(name => /^app-[^.]+\.js$/.test(name));
assert.ok(entry, 'Built hashed application entry must exist');
const records = [];
for (const [path, expectedStatus, expectedCache] of [
  ['/assets/cards/playing/01_bang.png', 200, 'public, max-age=3600, must-revalidate'],
  [`/_next/static/chunks/${entry}`, 200, 'public, max-age=31536000, immutable'],
  ['/api/guest-sessions', 204, 'no-store'],
]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, expectedStatus, path);
  const cacheControl = response.headers.get('cache-control');
  assert.equal(cacheControl, expectedCache, path);
  await response.body?.cancel();
  records.push({ path, status: response.status, cacheControl });
}
const result = { observedAt: new Date().toISOString(), scope: 'Built local Wrangler Worker HTTP headers; no production request', status: 'PASS', records };
await writeFile(new URL('../../../outputs/review-2026-10-04/logic-performance-audit/static-headers.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
