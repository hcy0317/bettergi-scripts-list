import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../repo/js/AutoCommissionNova');

async function fixture({mode='timeout',chain=false,secondSuccess=false}={}) {
 let now=0,attempts=0,after=0,credits=0,inputs=0,contextNamespace,registry;
 const logs=[];
 const terminal=new Error(mode==='cancel'?'The task was canceled':'[BGI_COMBAT_UNCONFIRMED] unknown');
 const context=vm.createContext({
  Date:class extends Date{static now(){return now;}},
  log:{info(){},warn(...args){logs.push(args.join(' '));},debug(){},error(...args){logs.push(args.join(' '));}},
  OpenCvSharp:{OpenCvSharp:{Rect:class{constructor(...args){this.args=args;}}}},
  BvPage:class{locator(){return {isExist(){return false;}};}},
  keyPress(){inputs++;},
  sleep:async ms=>{now+=ms;if(now>400000)throw Error('TEST_WATCHDOG');},
  genshin:{returnMainUi:async()=>{}},dispatcher:{ClearAllTriggers(){}}
 });
 const real=new Set(['src/processors/music-flow.js','src/processors/define-step.js','src/utils/error-utils.js','src/processors/registry.js','src/core/commission-context.js','src/core/commission-executor.js']);
 const dependencies={
  'src/vision/index.js':{RO:{moonLightIcon:'moon'}},
  'src/vision/ocr-utils.js':{
   bvPageOcrRegionText:()=>{
    if(mode==='cancel'||mode==='terminal')throw terminal;
    if(mode==='ocr-error')throw Error('transient OCR');
    return mode==='complete'||secondSuccess&&attempts===2?'委托完成':'';
   },
   bvPageOcrRegion:()=>({count:1,0:{text:mode==='failed'?'挑战失败':mode==='expired'?'挑战超时':mode==='explanation'?'挑战失败时请重新开始':''}})
  },
  'src/processors/commission-desc-utils.js':{shouldExecuteStepByDesc:async()=>true},
  'src/processors/commission-loc-utils.js':{shouldExecuteStepByLoc:async()=>true},
  'src/config/index.js':{COMMISSION_TYPE:{NPC:'NPC',BASIC:'Basic'},COMMISSION_STATUS:{UNCOMPLETED:'todo',COMPLETED:'done'},MAX_COMMISSION_RETRY_COUNT:1},
  'src/loaders/process-scope.js':{buildProcessBasePath:()=>''},
  'src/recognition/index.js':{isCompleted:async()=>true},
  'src/core/npc-executor.js':{executeNpcCommission:async()=>({success:false})},
  'src/core/basic-executor.js':{executeBasicCommission:async()=>{
   attempts++;
   return {success:await contextNamespace.runStepsWithContext({processSteps:[{type:'乐流奔引'},{type:'after'}],stepRegistry:registry},{sleepMs:0,stopOnError:true}),context:null};
  }},
  'src/probes/index.js':{dispatchOnCommissionComplete(){}},
  'src/data/index.js':{appendBranchCompletion(){},loadCurrentCommissionsData:async()=>({uid:'test',account:{commissions:[{name:'test',type:'Basic',supported:true,status:'todo'}]}}),updateCommissionStatus:async()=>{credits++;}}
 };
 const cache=new Map();
 function module(file) {
  if(cache.has(file))return cache.get(file);
  let result;
  if(real.has(file)) result=new vm.SourceTextModule(fs.readFileSync(path.join(root,file),'utf8'),{context,identifier:file});
  else {const exports=dependencies[file];assert.ok(exports,'missing dependency '+file);result=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:file});}
  cache.set(file,result);return result;
 }
 async function load(file){const m=module(file);if(m.status==='unlinked')await m.link((spec,parent)=>module(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),spec))));if(m.status==='linked')await m.evaluate();return m.namespace;}
 const music=(await load('src/processors/music-flow.js')).default;
 const run=async()=>{
  if(!chain)return music.handler({type:'乐流奔引'},{});
  contextNamespace=await load('src/core/commission-context.js');
  const ns=await load('src/processors/registry.js');registry=new ns.StepProcessorRegistry();
  registry.register(music.type,music.handler,music.validateData,music.category,music.dataSpec);
  registry.register('after',async()=>{after++;},()=>({ok:true}),'流程控制',{kind:'none'});
  const executor=await load('src/core/commission-executor.js');return executor.executeCommissionTracking(registry);
 };
 return {run,terminal,state:()=>({now,attempts,after,credits,inputs,logs})};
}
let tests=0;
let f=await fixture();await assert.rejects(f.run,/MUSIC_FLOW_TIMEOUT/);assert.equal(f.state().now,120000);tests++;
f=await fixture({mode:'complete'});assert.equal(await f.run(),true);assert.equal(f.state().now,0);tests++;
for(const mode of ['failed','expired']){f=await fixture({mode});await assert.rejects(f.run,/MUSIC_FLOW_FAILED/);assert.ok(f.state().now<3000);tests++;}
for(const mode of ['ocr-error','explanation']){f=await fixture({mode});await assert.rejects(f.run,/MUSIC_FLOW_TIMEOUT/);assert.equal(f.state().now,120000);tests++;}
for(const mode of ['cancel','terminal']){f=await fixture({mode});await assert.rejects(f.run,e=>e===f.terminal);assert.equal(f.state().inputs,0);tests++;}
f=await fixture({mode:'failed',chain:true});assert.equal(await f.run(),false);assert.equal(f.state().attempts,2);assert.equal(f.state().after,0);assert.equal(f.state().credits,0);tests++;
f=await fixture({chain:true,secondSuccess:true});assert.equal(await f.run(),true);assert.equal(f.state().attempts,2);assert.equal(f.state().after,1);assert.equal(f.state().credits,1);tests++;
console.log(JSON.stringify({passed:tests,actualModuleChain:true,noGameExecution:true}));
