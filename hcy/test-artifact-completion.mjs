import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../repo/js/AAA-Artifacts-Bulk-Supply/main.js',import.meta.url),'utf8');
const start=source.indexOf('async function runPath(');
const end=source.indexOf('//加载拾取物图片',start);
assert(start>0 && end>start);

async function runPath({pathFailure,pickupFailure}={}) {
  const context=vm.createContext({
    settings:{},state:{activatePickUp:true},lastsettimeTime:0,
    sleep:async()=>new Promise(resolve=>setTimeout(resolve,1)),
    log:{info(){},warn(){},error(){}},fakeLog:async()=>{},
    pathingScript:{runFile:async()=>{if(pathFailure)throw pathFailure;return {success:true};}},
    recognizeAndInteract:async()=>{if(pickupFailure)throw pickupFailure;},
    RecognitionObject:{TemplateMatch:()=>({})},file:{ReadImageMatSync:()=>({})},findAndClick:async()=>false,
  });
  vm.runInContext(source.slice(start,end),context);
  return vm.runInContext("runPath('fixture.json')",context);
}

test('a companion failure cannot be reported as a successful artifact route',async()=>{
  const failure=new Error('pickup failed');
  await assert.rejects(runPath({pickupFailure:failure}),error=>error===failure);
});

async function workflow(failedRoutes=new Set(),ending=async()=>{},events=[]) {
  const context=vm.createContext({
    settings:{accountName:'fixture',decomposeMode:'保留',autoOnline:'fixture'},accountName:'fixture',
    pickup_Mode:'bgi原版拾取',onlyActivate:false,targetItems:null,
    state:{runnedToday:true},record:{records:[],lastRunEndingRoute:'fixture'},
    artifactExperienceDiff:0,moraDiff:0,failedRoutes,
    setGameMetrics(){},dispatcher:{AddTrigger(){}},RealtimeTimer:class{},
    loadTargetItems:async()=>[],readRecord:async()=>{},readCDInfo:async()=>{},writeCDInfo:async()=>{},
    writeRecord:async()=>events.push('record'),processArtifacts:async()=>0,mora:async()=>0,
    runNormalPath:async()=>{},runActivatePath:async()=>{},runEndingAndExtraPath:ending,
    generateCommandFile:async()=>events.push('commands'),notification:{Send(){}},
    log:{info(){},warn(){},error(){}},sleep:async()=>{},
  });
  const checkStart=source.indexOf('function assertCompletedRoutes(');
  if(checkStart>=0)vm.runInContext(source.slice(checkStart,source.indexOf('// 生成命令文件',checkStart)),context);
  const entryStart=source.indexOf('(async function () {');
  const entryEnd=source.indexOf('\n})();',entryStart)+6;
  assert(entryStart>0 && entryEnd>entryStart);
  await vm.runInContext(source.slice(entryStart,entryEnd),context);
  return events;
}

test('the overall workflow rejects unresolved routes rather than reporting a completed script',async()=>{
  const events=[];
  await assert.rejects(workflow(new Set(['fixture.json']),async()=>{},events),/未完成/);
  assert(events.includes('record'),'partial real收益 records remain preserved');
  assert(!events.includes('commands'),'failure must not schedule follow-up commands');
});

test('the standard-script entry promise remains pending until its workflow completes',async()=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let settled=false;
  const pending=workflow(new Set(),()=>gate).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  release();
  assert((await pending).includes('commands'));
});

test('path failures retain priority over companion failures',async()=>{
  const pathFailure=new Error('path failed');
  await assert.rejects(runPath({pathFailure,pickupFailure:new Error('pickup failed')}),error=>error===pathFailure);
});

test('a completed path retains the explicit host result',async()=>
  assert.deepEqual(await runPath(),{success:true}));

function routeBatch(results,{failedRoutes=new Set(),recoveryError,cancelled=false}={}) {
  const calls=[],saved=[];
  const paths=results.map((_,i)=>({fullPath:`route-${i}.json`,fileName:`route-${i}.json`}));
  const context=vm.createContext({
    settings:{},state:{cancel:false},CDInfo:[],failedRoutes,minIntervalTime:1,
    autoSalvageCount:0,accountName:'fixture',
    file:{IsFolder:()=>true},readFolder:async()=>paths,
    sleep:async()=>{},log:{info(){},warn(){},error(){}},
    parsePathing:async()=>({ok:true,x:100,y:100,map_name:'Teyvat'}),
    runPath:async path=>{const result=results[paths.findIndex(p=>p.fullPath===path)];calls.push(path);if(result instanceof Error)throw result;return result;},
    pathingScript:{isCancellationRequested:cancelled},
    genshin:{returnMainUi:async()=>{if(recoveryError)throw recoveryError;},
      getPositionFromMap:async()=>{throw new Error('confirmed native results must not recheck global coordinates');}},
    writeCDInfo:async()=>saved.push(Array.from(context.CDInfo)),
  });
  const begin=source.indexOf('async function runPaths(');
  vm.runInContext(source.slice(begin,source.indexOf('\nasync function parsePathing',begin)),context);
  return {context,calls,saved,run:()=>vm.runInContext("runPaths('fixture','',false)",context)};
}

test('ordinary route failures remain uncredited while later confirmed routes finish',async()=>{
  const batch=routeBatch([new Error('not reached'),{success:true}]);
  await batch.run();
  assert.deepEqual(Array.from(batch.context.failedRoutes),['route-0.json']);
  assert.deepEqual(Array.from(batch.context.CDInfo),['route-1.json']);
  assert.equal(batch.saved.length,1);
});

test('a later confirmed retry clears the unresolved failure for that route',async()=>{
  const batch=routeBatch([{success:true}],{failedRoutes:new Set(['route-0.json'])});
  await batch.run();
  assert.equal(batch.context.failedRoutes.size,0);
  assert.deepEqual(Array.from(batch.context.CDInfo),['route-0.json']);
});

test('failed UI recovery stops instead of attempting a later route in an unknown page',async()=>{
  const recoveryError=new Error('recovery failed');
  const batch=routeBatch([new Error('path failed'),{success:true}],{recoveryError});
  await assert.rejects(batch.run(),error=>error===recoveryError);
  assert.deepEqual(batch.calls,['route-0.json']);
  assert.equal(batch.saved.length,0);
});

test('cancellation escapes without running later routes or writing cooldowns',async()=>{
  const cancelled=new Error('A task was canceled.');
  const batch=routeBatch([cancelled,{success:true}],{cancelled:true});
  await assert.rejects(batch.run(),error=>error===cancelled);
  assert.deepEqual(batch.calls,['route-0.json']);
  assert.equal(batch.saved.length,0);
});
