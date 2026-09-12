import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

for (const name of ['AAA-Artifacts-Bulk-Supply']) {
  const source = readFileSync(new URL(`../repo/js/${name}/main.js`, import.meta.url), 'utf8');
  const start = source.indexOf('        if (pathRes ');
  const end = source.indexOf('        if (!skiprecord)', start);
  assert(start > 0 && end > start, 'live route confirmation block exists');
  const block = source.slice(start, end);
  async function run(points, target = {ok:true, x:100, y:100, map_name:'Teyvat'}, pathRes = undefined) {
    let calls = 0;
    const context = vm.createContext({pathInfo:target, pathRes, Path:{fileName:'fixture',fullPath:'fixture.json'},
      skiprecord:false, failedRoutes:new Set(), sleep:async()=>{}, log:{info(){},warn(){},error(){}},
      genshin:{returnMainUi:async()=>{},getPositionFromMap:async()=>{
        const item=points[Math.min(calls++,points.length-1)];
        if(item instanceof Error) throw item;
        return item;
      }}});
    const result = await vm.runInContext(`(async()=>{${block};return {skiprecord,failcount:failedRoutes.size};})()`, context);
    return {...result,calls};
  }
  test(`${name}: missing frame then valid frame confirms`, async()=>
    assert.deepEqual(await run([null,{x:100,y:100}]),{skiprecord:false,failcount:0,calls:2}));
  test(`${name}: three missing frames never credit`, async()=>
    assert.deepEqual(await run([null]),{skiprecord:true,failcount:1,calls:3}));
  test(`${name}: non-finite and distant points never credit`, async()=>{
    for(const point of [{x:NaN,y:100},{x:Infinity,y:100},{x:9999,y:9999}])
      assert.deepEqual(await run([point]),{skiprecord:true,failcount:1,calls:3});
  });
  test(`${name}: invalid target never credits`, async()=>{
    assert.equal((await run([{x:100,y:100}],{ok:false})).skiprecord,true);
    assert.equal((await run([{x:100,y:100}],{ok:true,x:NaN,y:100})).skiprecord,true);
  });
  test(`${name}: cancellation and terminal combat escape`, async()=>{
    for(const message of ['A task was canceled.','[BGI_COMBAT_UNCONFIRMED] not finished'])
      await assert.rejects(run([new Error(message)]),e=>e.message===message);
  });
  test(`${name}: explicit host result is authoritative`, async()=>{
    assert.equal((await run([null],undefined,{success:true})).skiprecord,false);
    assert.equal((await run([null],undefined,{success:false})).skiprecord,true);
  });
}
