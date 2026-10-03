import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../repo/js/AutoCommissionNova');
let passed=0;
async function load(relative, deps, globals={}) {
 const context=vm.createContext({log:{info(){},warn(){},error(){},debug(){}},...globals});
 const mod=new vm.SourceTextModule(fs.readFileSync(path.join(root,relative),'utf8'),{context});
 await mod.link(spec=>{assert.ok(deps[spec],spec);return new vm.SyntheticModule(Object.keys(deps[spec]),function(){for(const [key,value]of Object.entries(deps[spec]))this.setExport(key,value);},{context});});
 await mod.evaluate();return mod.namespace;
}
const isCancellationError=e=>e.message.includes('canceled');
const utils=await load('src/navigation/position-utils.js',{'../utils/error-utils.js':{isCancellationError}},{file:{readTextSync:()=>JSON.stringify({positions:[{x:0,y:5}]})}});
assert.equal(utils.calculateDistance({x:0,y:5},{X:0,Y:5}),0);passed++;
for(const p of [{x:NaN,y:2},{x:Infinity,y:2},{x:'1',y:2},null]) { assert.equal(utils.normalizePosition(p),null);passed++; }
assert.equal((await utils.getCommissionTargetPosition('fixture')).x,0);passed++;
async function locate({tracked=true,missing=false,closed=false,cleanupFail=false,mainFail=false,cancel=false,cancelTracking=false}={}) {
 let state='main',events=[];
 const cleanup=new Error('cleanup-failed'), canceled=new Error('task was canceled');
 const page=class{locator(label){const locator={withRetryInterval(){return locator;},withRetryAction(action){locator.action=action;return locator;},isExist(){return tracked;},async waitFor(){if(label==='map'){assert.equal(state,'map');events.push('map-ready');return;}if(!tracked){await locator.action();tracked=true;}assert.equal(state,'map');},async waitForDisappear(){await locator.action();}};return locator;}};
 const mod=await load('src/navigation/commission-locator.js',{
  '../config/index.js':{OCR_REGIONS:{COMMISSION_TRACKING:{}}},
  '../vision/index.js':{enterCommissionScreen:async()=>{state='handbook';},isInMainUI:()=>state==='main'},
  '../vision/templates/index.js':{RO:{track:'map'}},
  '../navigation/position-utils.js':{normalizePosition:utils.normalizePosition},
  './position-utils.js':{normalizePosition:utils.normalizePosition},
  '../utils/error-utils.js':{isCancellationError},
  '../recognition/index.js':{findCommissionIndex:async()=>0,clickCommissionAndOpenMap:async()=>{state='map';events.push('open-map');},getCommissionPosition:async()=>{assert.equal(state,'map');events.push('get-position');if(cancel)throw canceled;return missing?null:{x:0,y:8};}}
 },{BvPage:page,PostMessage:class{keyPress(){state='main';events.push('background-close');}},click(){if(cancelTracking)throw canceled;events.push('handle-tracking');if(closed)state='main';},keyPress(){state='closing';events.push('close-map');},sleep:async()=>{},genshin:{returnMainUi:async()=>{if(events.includes('open-map')){if(cleanupFail)throw cleanup;if(mainFail)return;events.push('main-ready');}state='main';}}});
 let result,error;try{result=await mod.findCommissionTarget('攀高危险');}catch(e){error=e;}
 return {result,error,events,state,canceled};
}
for(const tracked of [true,false]) { const r=await locate({tracked});assert.equal(r.error,undefined);assert.equal(r.result.x,0);assert.ok(r.events.indexOf('get-position')<r.events.indexOf('close-map'));assert.equal(r.events.includes('handle-tracking'),!tracked);assert.equal(r.state,'main');passed++; }
let r=await locate({missing:true});assert.match(r.error.message,/commission-position-unavailable/);assert.equal(r.state,'main');passed++;
r=await locate({missing:true,cleanupFail:true});assert.ok(r.error.cause);assert.equal(r.error.cleanupError.message,'cleanup-failed');passed++;
r=await locate({tracked:false,closed:true});assert.ok(r.error);assert.ok(!r.events.includes('get-position'));passed++;
r=await locate({mainFail:true});assert.ok(r.error);passed++;
r=await locate({cancel:true});assert.equal(r.error,r.canceled);passed++;
async function match({position=null,retries=[null,{x:0,y:8}],cancel=false}={}) {
 let calls=0,reads=0;
 const canceled=new Error('task was canceled');
 const mod=await load('src/core/basic-process-matcher.js',{
 '../navigation/index.js':{calculateDistance:utils.calculateDistance,getCommissionTargetPosition:async file=>{reads++;return file.includes('1')?{x:0,y:9}:{x:100,y:9};},normalizePosition:utils.normalizePosition,findCommissionTarget:async()=>{if(cancel)throw canceled;return retries[calls++];}},
 '../loaders/process-scope.js':{buildProcessBasePath:()=>'/routes'},
 '../utils/location-dir.js':{parseLocationDir:()=>({location:'伦波岛'})},
 '../utils/error-utils.js':{isCancellationError}
 },{file:{readPathSync:()=>['/routes/1','/routes/2'],isFolder:()=>true}});
 let result,error;try{result=await mod.findNearestBasicProcess('攀高危险','伦波岛',position,'蒙德');}catch(e){error=e;}
 return {result,error,calls,reads,canceled};
}
r=await match();assert.equal(r.calls,2);assert.equal(r.result.processDir,'/routes/1');passed++;
r=await match({position:{x:0,y:8}});assert.equal(r.calls,0);assert.equal(r.result.distance,1);passed++;
r=await match({retries:[null,null]});assert.equal(r.calls,2);assert.equal(r.reads,0);assert.match(r.error.message,/commission-position-unavailable/);passed++;
r=await match({cancel:true});assert.equal(r.error,r.canceled);passed++;
console.log(JSON.stringify({passed,scope:'offline commission position and map transaction; no game or User writes'}));
const positioningError = new Error('commission-position-unavailable: fixture');
const executor = await load('src/core/basic-executor.js', {
 '../utils/error-utils.js':{isCancellationError},
 '../config/index.js':{COMMISSION_TYPE:{BASIC:'Basic'}},
 './basic-process-matcher.js':{findNearestBasicProcess:async()=>{throw positioningError;}},
 '../loaders/index.js':{loadBasicProcess:async()=>[]},
 '../navigation/index.js':{trackCommission:async()=>true},
 './commission-context.js':{createCommissionContext:()=>({}),runStepsWithContext:async()=>true},
 './commission-party-switcher.js':{prepareCommissionBattleParty:async()=>{}}
});
await assert.rejects(()=>executor.executeBasicCommission({name:'攀高危险',location:'伦波岛'},{}), e=>e===positioningError);passed++;
console.log(JSON.stringify({passed,scope:'offline executor preserves exact coordinate failure'}));
r=await locate({tracked:false,cancelTracking:true});assert.equal(r.error,r.canceled);assert.ok(!r.events.includes('close-map'));passed++;
console.log(JSON.stringify({passed,scope:'offline cancellation in physical tracking input propagates unchanged'}));
