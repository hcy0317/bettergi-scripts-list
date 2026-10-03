import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../repo/js/AAA-Artifacts-Bulk-Supply/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runPaths(');
const end = source.indexOf('\nasync function ', start + 1);
const runPathsSource = source.slice(start, end < 0 ? undefined : end);

// 保留父范围 route_exclusion 的未实施红回归；不属于 S71 frame_evidence_chain。
// TODO 会实际执行并显示失败，不得把它计作已通过或删除后声称全量完成。
test('excluded route never reaches waiting, party, route execution or cooldown state', {
  todo: 'route_exclusion 尚未实施；交付证据链不关闭此余项'
}, async () => {
  const path = 'assets/ArtifactsPath/普通98点2号线/执行/216璃月-珉林北4.json';
  const events = [];
  const context = vm.createContext({settings: {excludedRoutes: ' ./'+path.replaceAll('/', '\\')+'\r\n'},
    state: {cancel: false, aimActivateTime: 0}, minIntervalTime: 1,
    readFolder: async () => [{fullPath: path, fileName: '216璃月-珉林北4.json'}],
    file: {IsFolder: () => true}, log: {info: m => events.push(m)},
    sleep: async () => {throw new Error('excluded route waited');},
    CDInfo: new Proxy([], {get() {throw new Error('excluded route touched CD');}})});
  vm.runInContext(runPathsSource, context);
  await vm.runInContext("runPaths('assets/ArtifactsPath', 'fixture-party', false)", context);
  assert.equal(events.length, 1);
  assert.match(events[0], /PLAN_ROUTE_EXCLUDED/);
});
