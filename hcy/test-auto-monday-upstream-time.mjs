import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {execFileSync} from 'node:child_process';

const root = new URL('../', import.meta.url);
const source = process.env.HCY_TEST_BASELINE === '1'
  ? execFileSync('git', ['show', 'HEAD:repo/js/AutoMonday/main.js'], {cwd: root, encoding: 'utf8'})
  : fs.readFileSync(new URL('repo/js/AutoMonday/main.js', root), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const brace = source.indexOf('{', start);
  let depth = 1, end = brace + 1;
  while (depth && end < source.length) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, end);
}
function fixture(at, record = '') {
  const now = Date.parse(at);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({Date: Clock, SERVER_TIMEZONE_OFFSET_MS: 8*3600*1000,
    readOptionalText: () => record, cdRecordPath: 'fixture', cdSources: new WeakMap(), log: {info(){},warn(){}},
    codedError: (code, message) => Object.assign(new Error(message), {code})});
  const helpers = source.includes('function parseCDTimestamp(') ? ['parseCDTimestamp'] : [];
  vm.runInContext([...helpers, 'getNextMonday4AMISO','getNextMonthFirst4AMISO','readCDRecords','isRouteAvailable'].map(extract).join('\n'), context);
  return context;
}
test('server Monday boundary does not skip the imminent reset', () => {
  assert.equal(vm.runInContext('getNextMonday4AMISO()', fixture('2026-09-21T03:59:00+08:00')), '2026-09-20T20:00:00.000Z');
  assert.equal(vm.runInContext('getNextMonday4AMISO()', fixture('2026-09-21T04:00:00+08:00')), '2026-09-27T20:00:00.000Z');
});
test('server first day boundary does not skip a month', () => {
  assert.equal(vm.runInContext('getNextMonthFirst4AMISO()', fixture('2026-10-01T03:59:00+08:00')), '2026-09-30T20:00:00.000Z');
  assert.equal(vm.runInContext('getNextMonthFirst4AMISO()', fixture('2026-10-01T04:00:00+08:00')), '2026-10-31T20:00:00.000Z');
});
test('CRLF and milliseconds preserve route identity and due time', async () => {
  const f = fixture('2026-09-23T12:00:00+08:00', '  任务 :: 1790146800000 \r\n');
  const records = await vm.runInContext('readCDRecords()', f);
  assert.equal(records['任务'], '1790146800000');
  f.records = records;
  assert.equal(vm.runInContext('isRouteAvailable("任务",records)', f), false);
});
test('damaged records never authorize consumption', async () => {
  for (const record of ['任务::broken', '任务::', 'garbage', '::2026-10-01T00:00:00Z']) {
    await assert.rejects(vm.runInContext('readCDRecords()', fixture('2026-09-23T12:00:00+08:00', record)), e => e.code === 'CD_RECORD_INVALID');
  }
});
