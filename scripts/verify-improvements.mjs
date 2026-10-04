import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.join(root,'apps/site');
const node=process.execPath;
const loader=pathToFileURL(path.join(site,'node_modules/tsx/dist/loader.mjs')).href;
const records=[];
let previous;
if (process.argv.includes('--resume')) previous=JSON.parse(readFileSync(path.join(root,'outputs/review-2026-10-04/verification.json'),'utf8'));
function tests(directory, pattern) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?tests(path.join(directory,entry.name),pattern):pattern.test(entry.name)?[path.join(directory,entry.name)]:[]);
}
function run(label,args,cwd=root) {
  const verified=!(process.argv.includes('--rebuild') && ['site-build','stage-site-build'].includes(label)) && previous?.records.find(record=>record.label===label && record.status==='PASS' && JSON.stringify(record.args)===JSON.stringify(args));
  if (verified) { records.push({...verified,reusedFrom:previous.observedAt}); console.log(`REUSE ${label}: PASS`); return true; }
  console.log(`RUN ${label}`);
  const started=Date.now();
  const result=spawnSync(node,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  const tests=output.match(/# tests (\d+)/)?.[1];
  const passed=output.match(/# pass (\d+)/)?.[1];
  const failed=output.match(/# fail (\d+)/)?.[1];
  const record={label,args,cwd:path.relative(root,cwd)||'.',status:result.status===0?'PASS':'FAIL',exitCode:result.status,elapsedMs:Date.now()-started,...(tests?{tests:Number(tests),passed:Number(passed),failed:Number(failed)}:{}),outputTail:output.slice(-3000)};
  records.push(record);
  console.log(`RESULT ${label}: ${record.status}${tests?' '+passed+'/'+tests:''}`);
  if(result.status!==0) console.log(output.slice(-7000));
  return result.status===0;
}
run('contracts-check',['node_modules/typescript/bin/tsc','--noEmit','-p','packages/contracts/tsconfig.json']);
run('contracts-tests',['--experimental-strip-types','--test',...tests(path.join(root,'packages/contracts/test'),/\.(?:test\.mjs|type-test\.ts)$/)]);
run('engine-acceptance',['--import',loader,'--test','packages/engine/test/scenarios/engine-acceptance.test.ts']);
run('site-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(site,'test'),/\.test\.ts$/)],site);
run('web-tests',['--import',loader,'--test','--test-concurrency=1',...tests(path.join(root,'apps/web/src'),/\.test\.mjs$/),...tests(path.join(root,'apps/web/test'),/\.test\.mjs$/)]);
run('game-table-fixtures',['--experimental-strip-types','--loader','./packages/engine/test/setup/ts-source-loader.mjs','apps/web/src/features/game-table/verify-fixtures.mjs']);
run('web-check',['node_modules/typescript/bin/tsc','--noEmit','-p','apps/web/tsconfig.json']);
run('site-check',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],site);
const checksPassed=records.every(record=>record.status==='PASS');
if(checksPassed && run('site-build',['scripts/run-framework.mjs','build'],site)) run('stage-site-build',['scripts/build-sites.mjs']);
const result={observedAt:new Date().toISOString(),scope:'UI/API improvements, platform baseline recovery and engine regression; does not upgrade unrun original D06/D18 or production S09',records,status:records.every(record=>record.status==='PASS')?'PASS':'FAIL'};
mkdirSync(path.join(root,'outputs/review-2026-10-04'),{recursive:true});
writeFileSync(path.join(root,'outputs/review-2026-10-04/verification.json'),JSON.stringify(result,null,2)+'\n');
process.exitCode=result.status==='PASS'?0:1;
