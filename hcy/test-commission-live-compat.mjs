import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../repo/js/AutoCommissionNova');
let passed=0;
async function load(relative,dependencies,globals={}) {
 const context=vm.createContext({log:{info(){},warn(){},error(){},debug(){}},...globals});
 const mod=new vm.SourceTextModule(fs.readFileSync(path.join(root,relative),'utf8'),{context});
 await mod.link(spec=>{
  const exports=dependencies[spec];assert.ok(exports,'Unexpected dependency '+spec);
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});
 });
 await mod.evaluate();return mod.namespace;
}
async function mainScenario({skip=false,valid=true,allDone=true,enter=true}={}) {
 let executions=0,saved=0,entered=0;
 const commissions=Array.from({length:valid?4:3},(_,i)=>({id:i+1,name:'fixture'+i,supported:true}));
 const mod=await load('src/core/main-process.js',{
  '../data/index.js':{loadSupportedCommissions:async()=>({}),saveCommissionsData:async()=>{saved++;}},
  '../recognition/index.js':{recognizeCommissions:async()=>commissions,initCommissionReferenceData:async()=>{},checkEncounterPoints:async()=>true},
  './commission-executor.js':{executeCommissionTracking:async()=>{executions++;return allDone;}},
  '../vision/index.js':{enterCommissionScreen:async()=>{entered++;return enter;}},
  '../loaders/global-config.js':{loadGlobalConfig:()=>({checkEncounterPoints:skip,skipSafeTeleport:true})},
  '../loaders/process-scope.js':{scanCommissionScopes:()=>({list:[]})}
 },{genshin:{returnMainUi:async()=>{}},sleep:async()=>{}});
 let error;try{await mod.executeMainProcess({},[]);}catch(e){error=e;}
 return {executions,saved,entered,error};
}
let r=await mainScenario({skip:true});assert.equal(r.executions,0);assert.equal(r.saved,0);assert.equal(r.error,undefined);passed++;
r=await mainScenario();assert.equal(r.executions,1);assert.equal(r.saved,1);assert.equal(r.error,undefined);passed++;
r=await mainScenario({valid:false});assert.equal(r.executions,0);assert.equal(r.saved,0);assert.ok(r.error);passed++;
r=await mainScenario({allDone:false});assert.match(r.error.message,/未全部完成/);passed++;
r=await mainScenario({enter:false});assert.equal(r.entered,2);assert.equal(r.saved,0);assert.ok(r.error);passed++;
const errors=await load('src/utils/error-utils.js',{});
const terminal=new Error('[BGI_COMBAT_UNCONFIRMED] unknown');assert.throws(()=>errors.rethrowIfCancellation(terminal),e=>e===terminal);passed++;
assert.doesNotThrow(()=>errors.rethrowIfCancellation(new Error('[BGI_RECOVERY_COMPLETED] recovered')));passed++;
assert.throws(()=>errors.rethrowIfCancellation(new Error('The task was canceled')));passed++;
let attempts=0,credits=0;
const executor=await load('src/core/commission-executor.js',{
 '../config/index.js':{COMMISSION_TYPE:{NPC:'NPC',BASIC:'Basic'},COMMISSION_STATUS:{UNCOMPLETED:'todo',COMPLETED:'done'},MAX_COMMISSION_RETRY_COUNT:1},
 '../recognition/index.js':{isCompleted:async()=>true},
 './npc-executor.js':{executeNpcCommission:async()=>({success:false})},
 './basic-executor.js':{executeBasicCommission:async()=>({success:++attempts===2,context:null})},
 '../utils/error-utils.js':{isCancellationError:errors.isCancellationError},
 '../probes/index.js':{dispatchOnCommissionComplete(){}},
 '../data/index.js':{appendBranchCompletion(){},loadCurrentCommissionsData:async()=>({uid:'fixture',account:{commissions:[{name:'test',type:'Basic',supported:true,status:'todo'}]}}),updateCommissionStatus:async()=>{credits++;}}
},{genshin:{returnMainUi:async()=>{}},dispatcher:{ClearAllTriggers(){}},sleep:async()=>{}});
assert.equal(await executor.executeCommissionTracking({}),true);assert.equal(attempts,2);assert.equal(credits,1);passed++;
let teamInputs=0;
const party=await load('src/core/commission-party-switcher.js',{
 '../config/index.js':{PATHS:{COMMISSION_CATALOG:'fixture'}},
 '../loaders/party-config.js':{loadPartyConfigForContext:()=>({}),resolvePartySelection:()=>({mode:'name',teamName:''}),validateCompleteRoles:()=>({ok:false})}
},{file:{readTextSync:()=>JSON.stringify({switchBattleParty:['fixture']})},genshin:{switchParty:async()=>{teamInputs++;return true;}}});
assert.equal(await party.prepareCommissionBattleParty({commissionName:'fixture'}),true);assert.equal(teamInputs,0);passed++;
const step=await load('src/processors/switch-commission-party.js',{
 '../loaders/party-config.js':{loadPartyConfigForContext:()=>({}),resolvePartySelection:()=>({mode:'name',teamName:''})},
 '../core/commission-party-switcher.js':{switchPartyByName:async()=>{teamInputs++;return true;},switchPartyWithRoles:async()=>{teamInputs++;return true;}},
 './define-step.js':{defineStep:spec=>spec}
});
assert.equal(await step.default.run({data:'战斗'},{}),true);assert.equal(teamInputs,0);passed++;
console.log(JSON.stringify({passed,scope:'offline source compatibility; no game or user data execution'}));
