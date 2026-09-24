import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../repo/js/AAA-Artifacts-Bulk-Supply/main.js',import.meta.url),'utf8');
const begin=source.indexOf('async function runPaths(');
const code=source.slice(begin,source.indexOf('\nasync function parsePathing',begin));

function batch({message='[BGI_PATH_TARGET_UNAVAILABLE] marker editor',recoveryError,cancelled=false}={}) {
  const calls=[],warnings=[],saved=[];
  const paths=[{fullPath:'assets/激活/6纳塔额外激活CD.json',fileName:'6纳塔额外激活CD.json'},
    {fullPath:'next.json',fileName:'next.json'}];
  const context=vm.createContext({settings:{},state:{cancel:false},CDInfo:[],failedRoutes:new Set(),
    minIntervalTime:1,autoSalvageCount:0,accountName:'fixture',file:{IsFolder:()=>true},
    readFolder:async()=>paths,parsePathing:async()=>({ok:true,x:100,y:100}),sleep:async()=>{},
    log:{info(){},warn(text){warnings.push(text);},error(){}},
    runPath:async path=>{calls.push(path);if(path===paths[0].fullPath)throw new Error(message);return {success:true};},
    pathingScript:{isCancellationRequested:cancelled},
    genshin:{returnMainUi:async()=>{if(recoveryError)throw recoveryError;}},
    writeCDInfo:async()=>saved.push([...context.CDInfo])});
  vm.runInContext(code,context);
  return {context,calls,warnings,saved,run:()=>vm.runInContext("runPaths('activation','',false)",context)};
}

test('unavailable activation is skipped after recovery without cooldown or unresolved-failure credit',async()=>{
  const run=batch();await run.run();
  assert.equal(run.calls.length,2);
  assert.deepEqual([...run.context.CDInfo],['next.json']);
  assert.equal(run.context.failedRoutes.size,0);
  assert(run.warnings.some(text=>text.includes('TARGET_UNAVAILABLE')));
});

test('unclassified failure is still unresolved',async()=>{
  const run=batch({message:'unknown failure'});await run.run();assert.equal(run.context.failedRoutes.size,1);
});

test('recovery failure or cancellation never proceeds to next route',async()=>{
  for(const options of [{recoveryError:new Error('recover failed')},{cancelled:true}]) {
    const run=batch(options);await assert.rejects(run.run());assert.equal(run.calls.length,1);assert.equal(run.saved.length,0);
  }
});
