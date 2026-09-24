import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../repo/js/AAA-Artifacts-Bulk-Supply/main.js',import.meta.url),'utf8');
const start=source.indexOf('async function runPath(');
const code=source.slice(start,source.indexOf('//加载拾取物图片',start));
async function run({fail=false,logFail=false}={}) {
  const logs=[];let now=1000;
  const failure=new Error('original failure');
  const context=vm.createContext({Date:{now:()=>now},settings:{},state:{activatePickUp:false},lastsettimeTime:0,
    log:{info(){},warn(){},error(){}},sleep:async()=>{},
    fakeLog:async(...args)=>{logs.push(args);if(logFail)throw new Error('log fault');},
    pathingScript:{runFile:async()=>{now+=1234;if(fail)throw failure;return {success:true};}},
    RecognitionObject:{TemplateMatch:()=>({})},file:{ReadImageMatSync:()=>({})},findAndClick:async()=>false});
  vm.runInContext(code,context);
  let caught;try {await vm.runInContext("runPath('fixture.json')",context);}catch(error){caught=error;}
  return {logs,caught,failure};
}
test('route completion logs measured elapsed time and explicit outcome',async()=>{
  const {logs,caught}=await run();assert.equal(caught,undefined);
  const end=logs.find(args=>args[2]===false);assert(end);assert.equal(end[3],1234);assert.equal(end[4],'完成');
});
test('failure still closes its measured log and propagates original failure',async()=>{
  const {logs,caught,failure}=await run({fail:true});assert.equal(caught,failure);
  const end=logs.find(args=>args[2]===false);assert(end);assert.equal(end[3],1234);assert.equal(end[4],'失败');
});
test('diagnostic failures do not prevent or replace route work',async()=>{
  assert.equal((await run({logFail:true})).caught,undefined);
  const {caught,failure}=await run({fail:true,logFail:true});assert.equal(caught,failure);
});
