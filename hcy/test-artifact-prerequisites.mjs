import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../repo/js/AAA-Artifacts-Bulk-Supply/main.js',import.meta.url),'utf8');
const begin=source.indexOf('async function runPaths(');
const code=source.slice(begin,source.indexOf('\nasync function parsePathing',begin));
const root='assets/ArtifactsPath/额外/所有额外';
const dependent=`${root}/执行/01【额外】稻妻-踏鞴砂大炮点5.json`;
const prerequisites=['000【复位程序】稻妻踏鞴砂大炮点.json','001【激活程序】稻妻大炮1.json','001【激活程序】稻妻大炮2.json'].map(x=>`${root}/准备/${x}`);
function batch({completed=[],failed=[],separator='/',party=''}={}) {
  const paths=[dependent,'independent.json'].map(fullPath=>({fullPath:fullPath.replaceAll('/',separator),fileName:fullPath.split('/').at(-1)}));
  const inputs=[],writes=[],parties=[];
  const context=vm.createContext({settings:{},state:{cancel:false},CDInfo:[...completed],failedRoutes:new Set(failed),
    minIntervalTime:1,autoSalvageCount:0,accountName:'fixture',file:{IsFolder:()=>true},
    readFolder:async()=>paths,parsePathing:async()=>({ok:true,x:100,y:100}),sleep:async()=>{},
    log:{info(){},warn(){},error(){}},
    runPath:async path=>{inputs.push(path);return {success:true};},
    switchPartyIfNeeded:async p=>parties.push(p),pathingScript:{isCancellationRequested:false},
    genshin:{returnMainUi:async()=>{}},writeCDInfo:async()=>writes.push([...context.CDInfo])});
  vm.runInContext(code,context);
  return {context,inputs,writes,parties,run:()=>vm.runInContext(`runPaths('fixture',${JSON.stringify(party)},false)`,context)};
}
test('failed or missing preparation blocks only its dependent route before route input or cooldown',async()=>{
  const run=batch();await run.run();
  assert.deepEqual(run.inputs,['independent.json']);
  assert.deepEqual([...run.context.CDInfo],['independent.json']);
  assert(run.context.failedRoutes.has(dependent));
});

test('all confirmed preparations unlock the original route with slash normalization',async()=>{
  const run=batch({completed:prerequisites,separator:'\\'});await run.run();
  assert.equal(run.inputs.length,2);
  assert(!run.context.failedRoutes.size);
});

test('a failed preparation cannot be authorized by its older completed record',async()=>{
  for(const missing of prerequisites) {
    const run=batch({completed:prerequisites,failed:[missing]});await run.run();
    assert.deepEqual(run.inputs,['independent.json']);
    assert(run.context.failedRoutes.has(dependent));
  }
});

test('already completed dependent does not run again and independent route still runs',async()=>{
  const run=batch({completed:[dependent]});await run.run();
  assert.deepEqual(run.inputs,['independent.json']);
  assert(!run.context.failedRoutes.has(dependent));
});

test('completed dependent with an alternate separator is still not replayed',async()=>{
  const run=batch({completed:[dependent],separator:'\\'});await run.run();
  assert.deepEqual(run.inputs,['independent.json']);
  assert.equal(run.context.failedRoutes.size,0);
});

test('a successful route clears its previous failure in either separator form',async()=>{
  const run=batch({completed:prerequisites,failed:[dependent],separator:'\\'});await run.run();
  assert.equal(run.inputs.length,2);
  assert.equal(run.context.failedRoutes.size,0);
});

test('a later valid preparation clears the dependent failure only after real route success',async()=>{
  const run=batch({completed:prerequisites,failed:[dependent]});await run.run();
  assert(run.inputs.includes(dependent));
  assert(!run.context.failedRoutes.has(dependent));
});

test('failed party switch is not reported as successful setup',async()=>{
  const start=source.indexOf('async function switchPartyIfNeeded(');
  const end=source.indexOf('\n/**',start);
  const failure=new Error('switch rejected');
  const context=vm.createContext({genshin:{switchParty:async()=>{throw failure;},returnMainUi:async()=>{},tpToStatueOfTheSeven:async()=>{}},
    log:{info(){},error(){}},notification:{error(){}}});
  vm.runInContext(source.slice(start,end),context);
  await assert.rejects(vm.runInContext("switchPartyIfNeeded('target')",context),error=>error===failure);
});
