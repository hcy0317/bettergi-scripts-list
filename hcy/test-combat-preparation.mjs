import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../repo/js/AutoCommissionNova');
const events = [];
const files = new Map();
class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
const context = vm.createContext({
  log: { info() {}, warn() {}, error() {}, debug() {} },
  OpenCvSharp: { OpenCvSharp: { Rect } },
  AutoFightParam: class { constructor(strategy) { this.strategy = strategy; } },
  PostMessage: class {},
  BvPage: class { constructor() { events.push('navigation-page'); throw new Error('external UI unavailable in replay'); } },
  genshin: {
    uid: async () => '123456789',
    returnMainUi: async () => events.push('main-ui'),
    tpToStatueOfTheSeven: async () => events.push('safe-teleport'),
    switchParty: async name => { events.push('party:' + name); return true; },
  },
  dispatcher: { PrepareAutoFightTask: async param => { events.push('prepare:' + (param?.strategy ?? 'common')); return true; } },
  sleep: async () => {},
  file: {
    isFile: name => files.has(name) || fs.existsSync(path.join(root, name)),
    isDirectory: () => false,
    isFolder: () => false,
    readTextSync: name => name.replaceAll('\\', '/').endsWith('/fixture/location/process.json')
      ? JSON.stringify([{ type: 'fixture-end' }]) : files.get(name) ?? fs.readFileSync(path.join(root, name), 'utf8'),
    writeTextSync: (name, value) => files.set(name, value),
    readDirectorySync: () => [],
    listFiles: () => [],
  },
});
const cache = new Map();
function getModule(relative) {
  const key = relative.replaceAll('\\', '/');
  if (cache.has(key)) return cache.get(key);
  const module = new vm.SourceTextModule(fs.readFileSync(path.join(root, key), 'utf8'), { context, identifier: key });
  cache.set(key, module);
  return module;
}
async function load(relative) {
  const module = getModule(relative);
  if (module.status === 'unlinked')
    await module.link((specifier, parent) => getModule(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), specifier))));
  return module;
}
const accounts = await load('src/utils/account-utils.js');
await accounts.evaluate();
assert.equal(await accounts.namespace.getCurrentUid({ knownUids: ['123456789'] }), '123456789');
const main = await load('src/core/main-process.js');
await main.evaluate();
await main.namespace.prepareForCommission();
assert.equal(events.at(-1), 'prepare:common', '真实委托准备入口必须在任何追踪前等待公共视觉准备');
assert.ok(events.includes('main-ui'));
const switching = await load('src/processors/switch-commission-party.js');
await switching.evaluate();
const before = events.length;
assert.equal(await switching.namespace.default.handler({ data: '战斗' }, {}), true);
assert.equal(events.at(-1), 'prepare:根据队伍自动选择', '换队边界（含沿用当前队伍）必须重新核对真实所选策略');
assert.ok(events.length > before);
const party = await load('src/core/commission-party-switcher.js');
await party.evaluate();
events.length = 0;
assert.equal(await party.namespace.prepareCommissionBattleParty({ commissionName: 'fixture', type: 'Basic', country: '蒙德', location: 'location' }), true);
assert.equal(events.at(-1), 'prepare:根据队伍自动选择', '不换队不能跳过所选策略的准备');
const npc = await load('src/core/npc-executor.js');
await npc.evaluate();
events.length = 0;
await npc.namespace.executeNpcCommission({ name: 'fixture', country: '蒙德', location: 'location' }, {}, '123456789');
assert.ok(events.indexOf('prepare:根据队伍自动选择') >= 0);
assert.ok(events.indexOf('navigation-page') > events.indexOf('prepare:根据队伍自动选择'), 'NPC真实链也应准备完再开始追踪UI');
console.log(JSON.stringify({ passed: 4, scope: 'real JS module graph; only host/file/game boundaries substituted; no desktop' }));
