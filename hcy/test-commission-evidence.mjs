import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../repo/js/AutoCommissionNova/src/recognition/completion-detector.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace('export async function', 'async function');
async function run({cancel, failEvidence = false, bridge = true} = {}) {
  const events = [];
  const context = vm.createContext({
    COMMISSION_STATUS: {COMPLETED: 'done'}, enterCommissionScreen: async () => true,
    sleep: async () => {}, resolveCommissionNameOcrRegions: async () => [1,2,3,4],
    bvPageOcrRegionText: () => 'fixture', standardizeCommissionName: x => x, pageScroll: async () => {},
    detectCommissionStatusByImage: async () => { if (cancel) throw cancel; return 'done'; },
    isCancellationError: x => x === cancel, genshin: {returnMainUi: async () => events.push('return')},
    log: {debug(){},warn(){},error(){}},
    ...(bridge ? {requestEvidenceWindow: (...args) => { events.push(args); if (failEvidence) throw Error('diagnostics only'); }} : {})
  });
  vm.runInContext(source, context);
  const operation = vm.runInContext("isCompleted('fixture')", context);
  if (cancel) { await assert.rejects(operation, x => x === cancel); return events; }
  assert.equal(await operation, true);
  return events;
}
test('completion recheck emits correlated before/result/exit windows without changing success', async () => {
  const events = await run();
  const windows = events.filter(Array.isArray);
  assert.deepEqual(windows.map(x => x[1]), ['commission-before', 'commission-result', 'commission-exit']);
  assert.equal(new Set(windows.map(x => x[0])).size, 1);
  assert.equal(events.at(-1), 'return');
});
test('missing or failing evidence bridge cannot change completion', async () => {
  await run({bridge: false}); await run({failEvidence: true});
});
test('evidence cannot swallow the original cancellation', async () => {
  const cancellation = Error('user cancelled');
  const events = await run({cancel: cancellation, failEvidence: true});
  assert.equal(events.at(-1), 'return');
});
