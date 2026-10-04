import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.join(root,'apps/site');
const node=process.execPath;
const loader=pathToFileURL(path.join(site,'node_modules/tsx/dist/loader.mjs')).href;
const audit=process.argv.includes('--audit');
const outputDirectory=path.join(root,'outputs/review-2026-10-04',...(audit?['logic-performance-audit']:[]));
const records=[];
let previous;
if (process.argv.includes('--resume')) previous=JSON.parse(readFileSync(path.join(outputDirectory,'verification.json'),'utf8'));
function tests(directory, pattern) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?tests(path.join(directory,entry.name),pattern):pattern.test(entry.name)?[path.join(directory,entry.name)]:[]);
}
function inputFingerprint(label) {
  const prefixes = label.startsWith('contracts-') ? ['packages/contracts/']
    : label.startsWith('catalog-') ? ['packages/catalog/','packages/contracts/']
    : label.startsWith('engine-') ? ['packages/']
    : label.startsWith('server-') ? ['packages/','apps/server/']
    : label.startsWith('web-') || label === 'game-table-fixtures' ? ['packages/','apps/web/']
    : label === 'site-tests' ? ['packages/','apps/site/src/','apps/site/app/','apps/site/test/','drizzle/']
    : ['packages/','apps/web/','apps/site/','scripts/','drizzle/','.openai/'];
  const inventory=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
  if(inventory.status!==0) throw new Error('Cannot fingerprint verification inputs.');
  const paths=[...new Set(inventory.stdout.split('\0').filter(file=>file &&
    (prefixes.some(prefix=>file.startsWith(prefix)) || ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].includes(file))))].sort();
  const hash=createHash('sha256');
  for(const file of paths) hash.update(file).update('\0').update(readFileSync(path.join(root,file))).update('\0');
  return hash.digest('hex');
}
function run(label,args,cwd=root) {
  if (args.includes('--test') && !args.some(arg=>arg.startsWith('--test-timeout='))) {
    args=[...args,'--test-timeout=180000'];
  }
  const fingerprint=inputFingerprint(label);
  const verified=!(process.argv.includes('--rebuild') && ['site-build','stage-site-build'].includes(label)) && previous?.records.find(record=>record.label===label && record.status==='PASS' && record.inputFingerprint===fingerprint && JSON.stringify(record.args)===JSON.stringify(args));
  if (verified) { records.push({...verified,reusedFrom:previous.observedAt}); console.log(`REUSE ${label}: PASS`); return true; }
  console.log(`RUN ${label}`);
  const started=Date.now();
  // Miniflare can leave idle runtime handles after all its tests have finished.
  // Bound the process too: per-test timeouts alone cannot close idle handles.
  const result=spawnSync(node,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024,
    timeout:label==='server-tests'?600000:300000});
  const output=(result.stdout??'')+(result.stderr??'');
  const tests=output.match(/# tests (\d+)/)?.[1];
  const passed=output.match(/# pass (\d+)/)?.[1];
  const failed=output.match(/# fail (\d+)/)?.[1];
  const lines=output.split('\n');
  const failureDetails=lines.flatMap((line,index)=>/^not ok/.test(line)?[lines.slice(Math.max(0,index-1),index+45).join('\n')]:[]);
  const inputsStable=inputFingerprint(label)===fingerprint;
  const record={label,args,cwd:path.relative(root,cwd)||'.',status:result.status===0 && inputsStable?'PASS':'FAIL',exitCode:result.status,inputFingerprint:fingerprint,inputsStable,elapsedMs:Date.now()-started,...(tests?{tests:Number(tests),passed:Number(passed),failed:Number(failed)}:{}),...(failureDetails.length?{failureDetails}:{}),outputTail:output.slice(-3000)};
  records.push(record);
  mkdirSync(outputDirectory,{recursive:true});
  writeFileSync(path.join(outputDirectory,'verification.json'),JSON.stringify({observedAt:new Date().toISOString(),status:'RUNNING',records},null,2)+'\n');
  console.log(`RESULT ${label}: ${record.status}${tests?' '+passed+'/'+tests:''}`);
  if(result.status!==0) console.log(output.slice(-7000));
  return record.status==='PASS';
}
run('contracts-check',['node_modules/typescript/bin/tsc','--noEmit','-p','packages/contracts/tsconfig.json']);
run('contracts-tests',['--experimental-strip-types','--test',...tests(path.join(root,'packages/contracts/test'),/\.(?:test\.mjs|type-test\.ts)$/)]);
if (audit) {
  for (const project of ['catalog','engine']) run(`${project}-check`,['node_modules/typescript/bin/tsc','--noEmit','-p',`packages/${project}/tsconfig.json`]);
  run('catalog-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(root,'packages/catalog/test'),/\.test\.ts$/)]);
  run('engine-all-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(root,'packages/engine/test'),/\.test\.ts$/)]);
  run('server-check',['node_modules/typescript/bin/tsc','--noEmit','-p','apps/server/tsconfig.json']);
  run('server-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(root,'apps/server/test'),/\.test\.ts$/)]);
} else run('engine-acceptance',['--import',loader,'--test','packages/engine/test/scenarios/engine-acceptance.test.ts']);
run('site-tests',['--import',loader,'--test','--test-concurrency=1','--test-force-exit',...tests(path.join(site,'test'),/\.test\.ts$/)],site);
run('web-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(root,'apps/web/src'),/\.test\.mjs$/),...tests(path.join(root,'apps/web/test'),/\.test\.mjs$/)]);
run('game-table-fixtures',['--experimental-strip-types','--loader','./packages/engine/test/setup/ts-source-loader.mjs','apps/web/src/features/game-table/verify-fixtures.mjs']);
run('web-check',['node_modules/typescript/bin/tsc','--noEmit','-p','apps/web/tsconfig.json']);
run('site-check',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],site);
const checksPassed=records.every(record=>record.status==='PASS');
if(checksPassed && run('site-build',['scripts/run-framework.mjs','build'],site)) run('stage-site-build',['scripts/build-sites.mjs']);
const result={observedAt:new Date().toISOString(),scope:audit?'Full catalog/engine/server/Site/web regression, type checks and production build; original D06/D18 and production S09 retain their prior unverified status':'UI/API improvements, platform baseline recovery and engine regression; does not upgrade unrun original D06/D18 or production S09',records,status:records.every(record=>record.status==='PASS')?'PASS':'FAIL'};
mkdirSync(outputDirectory,{recursive:true});
writeFileSync(path.join(outputDirectory,'verification.json'),JSON.stringify(result,null,2)+'\n');
process.exitCode=result.status==='PASS'?0:1;
