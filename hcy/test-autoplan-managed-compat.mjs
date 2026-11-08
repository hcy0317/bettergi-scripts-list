import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../repo/js/AutoPlan/config/config.js', import.meta.url), 'utf8');
const canonicalPlanSource = readFileSync(new URL('../repo/js/AutoPlan/utils/cultivation_plan.js', import.meta.url), 'utf8');
const taskTypesSource = readFileSync(new URL('../repo/js/AutoPlan/config/task_types.js', import.meta.url), 'utf8');
const dummyUid = '123456789';
async function runtime(settings, {nativeUid = async () => dummyUid} = {}) {
  const events = [], logs = [], uidReads = [], requests = [];
  const manifest = {name:'fixture',version:'0.1.4',key:'current-revision',last_key:'previous-revision',
    settings_ui:'settings.json',authors:[{name:'fixture'}]};
  const context = vm.createContext({
    settings, log:Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(...args)=>logs.push(args.join(' '))])),
    genshin:{uid:async()=>{events.push('uid');const value=await nativeUid();uidReads.push(value);return value;}},
    http:{async request(method,url,body){requests.push({method,url,body});return {status_code:200,body:JSON.stringify({code:200,data:{status:'DONE'}})};}},
    file:{readTextSync(path){
      if(path==='manifest.json')return JSON.stringify(manifest);
      if(path==='settings.json')return '[]';
      events.push('legacy-file:'+path);
      throw new Error('legacy configuration should not be read by a managed entry');
    }},
  });
  const module = new vm.SourceTextModule(source,{context});
  // Real canonical helper; these external adapters are unused by config initialization.
  // The separate actual-graph runtime case verifies the complete config/plan/handler cycle.
  const plan = new vm.SourceTextModule(canonicalPlanSource,{context});
  const taskTypes = new vm.SourceTextModule(taskTypesSource,{context});
  const tool = new vm.SyntheticModule(['toMainUi'],function(){
    this.setExport('toMainUi',async()=>events.push('main'));
  },{context});
  const handlers = new vm.SyntheticModule(['taskHandlerMap'],function(){
    this.setExport('taskHandlerMap',{});
  },{context});
  const physical = new vm.SyntheticModule(['Physical'],function(){
    this.setExport('Physical',class {});
  },{context});
  const dependencies = {'./task_types':taskTypes,'../utils/tool':tool,'../utils/cultivation_plan':plan,
    './load_check_run':handlers,'./physical':physical};
  function resolve(specifier) {
    assert(Object.hasOwn(dependencies,specifier),'unexpected initialization dependency: '+specifier);
    return dependencies[specifier];
  }
  await module.link(resolve);
  await module.evaluate();
  await module.namespace.buildInitConfigSettings();
  await module.namespace.initSettings();
  return {api:module.namespace,events,logs,uidReads,requests};
}

test('generated cultivation entry accepts the exact previous revision without changing saved settings',async()=>{
  const settings={cultivation_plan_mode:true,key:'previous-revision'};
  const run=await runtime(settings);
  await run.api.checkKey(settings.key);
  assert.equal(settings.key,'previous-revision');
  assert.deepEqual(run.events,[]);
});

test('managed initialization cannot load legacy plans or enable legacy automatic pushes',async()=>{
  const run=await runtime({cultivation_plan_mode:true,key:'previous-revision',
    bgi_tools_open_push:true,run_config:'old fixed plan',loop_plan:true,
    bgi_tools_token:'Authorization=fixture-secret',bgi_tools_http_pull_json_config:'http://local/auto/plan/json'});
  await run.api.initConfig();
  assert.deepEqual(run.events,['main','uid']);
  assert.equal(run.api.config.bgi_tools.open.open_push,false);
  assert.equal(run.api.config.run.config,'');
  assert.equal(run.api.config.run.loop_plan,false);
  assert.equal(run.api.config.bgi_tools.api.httpPullJsonConfig,'http://local/auto/plan/json');
  assert.equal(run.logs.some(line=>line.includes('fixture-secret')),false);
});

for(const mode of [{},{cultivation_plan_mode:false},{cultivation_plan_mode:'true'},
  {cultivation_inventory_reconcile_mode:'true'}]) {
  test(`legacy revision remains rejected outside explicit managed mode: ${JSON.stringify(mode)}`,async()=>{
    const run=await runtime(mode);
    await assert.rejects(run.api.checkKey('previous-revision'),/密钥已经变更/);
    assert.deepEqual(run.events,[]);
  });
}

for(const mode of [{cultivation_plan_mode:true},{cultivation_inventory_reconcile_mode:true},
  {cultivation_plan_mode:true,cultivation_inventory_reconcile_mode:true}]) {
  test(`managed entry rejects arbitrary and empty keys: ${JSON.stringify(mode)}`,async()=>{
    const run=await runtime(mode);
    for(const key of ['older-revision','random','',null,undefined])
      await assert.rejects(run.api.checkKey(key),/密钥错误/);
    assert.deepEqual(run.events,[]);
  });
}

for(const mode of [{},{cultivation_plan_mode:true},{cultivation_inventory_reconcile_mode:true}]) {
  test(`current revision stays valid: ${JSON.stringify(mode)}`,async()=>{
    const run=await runtime(mode);
    await run.api.checkKey('current-revision');
  });
}

test('inventory reconciliation uses the same isolated managed initialization',async()=>{
  const run=await runtime({cultivation_inventory_reconcile_mode:true,key:'previous-revision',bgi_tools_open_push:true});
  await run.api.initConfig();
  assert.deepEqual(run.events,['main','uid']);
  assert.equal(run.api.config.bgi_tools.open.open_push,false);
  assert.deepEqual(Array.from(run.api.config.run.loads),[]);
});

test('native UID zero is rejected after good initialization premises before record path or plan requests',async()=>{
  const settings={cultivation_plan_mode:true,key:'current-revision',
    bgi_tools_http_pull_json_config:'http://local/auto/plan/json'};
  const run=await runtime(settings,{nativeUid:async()=>0});
  await run.api.checkKey(settings.key);
  assert.deepEqual(run.events,[],'the real key precondition must already be valid');
  const initialRecordPath=run.api.config.path.record;
  run.api.config.user.uid=dummyUid; // A prior configured value must not turn native unknown into an accepted account.
  let failure;
  try { await run.api.initConfig(); } catch(error) { failure=error; }
  assert.deepEqual(run.events,['main','uid'],'UI preparation and the native call must both have succeeded');
  assert.deepEqual(run.uidReads,[0],'the async native source really resolved the unknown sentinel');
  assert(failure,'native unknown zero must reject initialization rather than accepting record/0.json');
  assert.match(String(failure.message),/UID|账号|未确认/i);
  assert.equal(run.api.config.path.record,initialRecordPath,'unknown UID must not construct a record path');
  assert.equal(run.requests.length,0,'initialization failure must not call reconcile or next-action');
});

test('canonical native integer and string UIDs keep the same decimal record identity',async()=>{
  for(const uid of [Number(dummyUid),dummyUid]) {
    const run=await runtime({cultivation_plan_mode:true,key:'current-revision'},
      {nativeUid:async()=>uid});
    await run.api.checkKey('current-revision');
    await run.api.initConfig();
    assert.deepEqual(run.events,['main','uid']);
    assert.equal(run.uidReads.length,1);
    assert.equal(run.uidReads[0],uid);
    assert.equal(String(run.api.config.user.uid),dummyUid);
    assert.equal(run.api.config.path.record,'record/'+dummyUid+'.json');
    assert.equal(run.requests.length,0);
  }
});
