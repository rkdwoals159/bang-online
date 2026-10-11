import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from '../apps/site/node_modules/typescript/lib/typescript.js';
const output = process.env.BANG_AUDIT_OUTPUT ?? 'outputs/migration-parity-2026-10-12';
await mkdir(output, { recursive: true });
async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.filter(e => !['node_modules', 'dist', '.wrangler'].includes(e.name))
    .map(e => e.isDirectory() ? files(`${root}/${e.name}`) : [`${root}/${e.name}`]))).flat().sort();
}
const groups = {
  shared: ['packages/catalog/test', 'packages/contracts/test', 'packages/engine/test'],
  node: ['apps/server/test'], site: ['apps/site/test'], web: ['apps/web/src', 'apps/web/test'],
};
if (process.argv[2] === 'inventory') {
  const paths = (await Promise.all(['apps/site/src', 'apps/server/src', 'apps/web/src', 'packages/engine/src', 'packages/contracts/src', 'packages/catalog/src', 'deploy/selfhost'].map(files))).flat();
  const inventory = [];
  for (const path of paths) {
    const content = await readFile(path);
    const item = { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
    if (/\.tsx?$/.test(path)) {
      const source = ts.createSourceFile(path, content.toString(), ts.ScriptTarget.Latest, true);
      const imports = [], methods = [], cases = [];
      const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const walk = node => {
        if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text);
        if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) methods.push({ name: node.name?.getText(source), line: line(node) });
        if (ts.isCaseClause(node)) cases.push({ value: node.expression.getText(source), line: line(node) });
        ts.forEachChild(node, walk);
      };
      walk(source); Object.assign(item, { imports, methods, cases });
    }
    inventory.push(item);
  }
  await writeFile(`${output}/source-inventory.json`, JSON.stringify({ checkedAt: new Date().toISOString(), fileCount: inventory.length, files: inventory }, null, 2) + '\n');
  console.log(`Inventoried ${inventory.length} source and deployment files`);
} else {
  const group = process.argv[2]; if (!groups[group]) throw new Error('Choose inventory/shared/node/site/web');
  const paths = (await Promise.all(groups[group].map(files))).flat().filter(path => /\.test\.(?:ts|mjs)$/.test(path));
  const startedAt = new Date().toISOString();
  const loader = group === 'web' || group === 'site'
    ? ['--import', './apps/site/node_modules/tsx/dist/loader.mjs']
    : ['--experimental-transform-types', '--loader', './packages/engine/test/setup/ts-source-loader.mjs'];
  const run = spawnSync(process.execPath, [...loader, '--test', '--test-concurrency=1', ...paths], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  await mkdir(`${output}/logs`, { recursive: true });
  await writeFile(`${output}/logs/${group}.log`, log);
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) counts[key] = Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? 0);
  const result = { group, startedAt, completedAt: new Date().toISOString(), exitCode: run.status, error: run.error?.message, counts, files: paths };
  await writeFile(`${output}/${group}-tests.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result)); process.exitCode = run.status ?? 1;
}
