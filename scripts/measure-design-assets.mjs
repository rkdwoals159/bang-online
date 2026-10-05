import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const baselineCommit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(baselineCommit ?? '')) throw new Error('Provide the exact baseline commit SHA');
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', baselineCommit, 'apps/web/src'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(path => path.endsWith('.css'));
const before = files.map(path => execFileSync('git', ['show', `${baselineCommit}:${path}`])).join('\n');
const after = [...files, 'apps/web/src/app/tokens.css'].filter(existsSync).map(path => readFileSync(path, 'utf8')).join('\n');
const size = (css) => ({ bytes: Buffer.byteLength(css), gzipBytes: gzipSync(css).byteLength });
console.log(JSON.stringify({ baselineCommit, scope: 'All shared web CSS source, concatenated in path order; not deployed bundle or API timings', before: size(before), after: size(after), gzipReductionPercent: Number(((1 - size(after).gzipBytes / size(before).gzipBytes) * 100).toFixed(1)) }, null, 2));
