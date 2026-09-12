import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../repo/js/AutoPlan/config/config.js', import.meta.url), 'utf8');
async function runtime(settings) {
  const events = [], logs = [];
  const manifest = {name:'fixture',version:'0.1.4',key:'current-revision',last_key:'previous-revision',
    settings_ui:'settings.json',authors:[{name:'fixture'}]};
  const context = vm.createContext({
    settings, log:Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(...args)=>logs.push(args.join(' '))])),
    genshin:{uid:async()=>{events.push('uid');return 'fixture-uid';}},
    file:{readTextSync(path){
      if(path==='manifest.json')return JSON.stringify(manifest);
      if(path==='settings.json')return '[]';
      events.push('legacy-file:'+path);
      throw new Error('legacy configuration should not be read by a managed entry');
    }},
  });
  const module = new vm.SourceTextModule(source,{context});
  await module.link(()=>new vm.SyntheticModule(['toMainUi'],function(){
    this.setExport('toMainUi',async()=>events.push('main'));
  },{context}));
  await module.evaluate();
  await module.namespace.buildInitConfigSettings();
  await module.namespace.initSettings();
  return {api:module.namespace,events,logs};
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
