import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../repo/js/AutoCommissionNova');
let passed = 0;

async function scenario(kind) {
  const timers = [];
  let started = 0, joined = 0, disposed = 0;
  const work = token => {
    started++;
    return new Promise(resolve => {
      if (token.IsCancellationRequested) resolve();
      else token.listeners.push(resolve);
    });
  };
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  const readText = region => {
    if (kind === 'defense') return started > 0 && region.y === 165 ? '委托完成' : '';
    return region === 'description' || region === 'description-second'
      ? `摧毁丘丘人哨塔${started ? 2 : 1}/2` : '';
  };
  const globals = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    OpenCvSharp: { OpenCvSharp: { Rect } },
    AutoFightParam: class { constructor(strategy) { this.strategy = strategy; } },
    genshin: { returnMainUi: async () => {}, uid: async () => '123456789' },
    getAvatars: () => ({ Length: 1, GetValue: () => '钟离' }),
    pathingScript: { runFile: async () => {} },
    file: {
      isFile: name => name === 'avatar-strategies.json',
      isDirectory: () => false,
      isFolder: () => false,
      readTextSync: name => {
        assert.equal(name, 'avatar-strategies.json');
        return JSON.stringify({ 钟离: { script: 'e(hold),attack(1)' } });
      },
      readDirectorySync: () => [],
      listFiles: () => [],
    },
    sleep: milliseconds => milliseconds >= 10000
      ? new Promise(resolve => timers.push({ milliseconds, resolve })) : Promise.resolve(),
    dispatcher: {
      GetLinkedCancellationTokenSource() {
        const token = { IsCancellationRequested: false, listeners: [] };
        return {
          Token: token,
          Cancel() { token.IsCancellationRequested = true; token.listeners.splice(0).forEach(resolve => resolve()); },
          Dispose() { disposed++; },
        };
      },
      RunCombatScript: (_script, _actor, token) => work(token),
      RunAutoFightTask: (_param, token) => work(token),
      async waitForTask(task, timeout) { assert.equal(timeout, 10000); joined++; await task; return true; },
    },
  };
  const context = vm.createContext(globals);
  const mock = new Map([
    ['src/config/index.js', {
      PATHS: { AVATAR_STRATEGIES: 'avatar-strategies.json', ACCOUNT_CONFIG_DIR: 'accounts', COMMISSION_CATALOG: 'catalog' },
      OCR_REGIONS: { COMMISSION_DETAIL: 'description', COMMISSION_DETAIL_SECOND_LINE: 'description-second' },
      THRESHOLDS: { UID: .9, COMMISSION_DESC: .9 },
      COMMISSION_TYPE: { BASIC: 'Basic', NPC: 'NPC' },
    }],
    ['src/vision/index.js', { RO: {}, bvPageOcrRegionText: readText }],
    ['src/vision/ocr-utils.js', { bvPageOcrRegionText: readText }],
    ['src/recognition/index.js', {
      standardizeCommissionName() { throw new Error('unexpected name OCR branch'); },
      calculateSimilarity() { throw new Error('unexpected similarity branch'); },
    }],
  ]);
  const cache = new Map();
  async function load(file) {
    const key = file.replaceAll('\\', '/');
    if (cache.has(key)) return cache.get(key);
    let module;
    if (mock.has(key)) {
      const values = mock.get(key);
      module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context, identifier: key });
    } else {
      module = new vm.SourceTextModule(fs.readFileSync(path.join(root, key), 'utf8'), { context, identifier: key });
    }
    cache.set(key, module);
    await module.link((specifier, parent) => load(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), specifier))));
    return module;
  }
  try {
    if (kind === 'defense') {
      const accounts = await load('src/utils/account-utils.js');
      await accounts.evaluate();
      assert.equal(await accounts.namespace.getCurrentUid({ knownUids: ['123456789'] }), '123456789');
    }
    const module = await load(`src/processors/${kind === 'tower' ? 'basic-destroy-watchtower' : 'impregnable-defense'}.js`);
    await module.evaluate();
    const data = kind === 'tower' ? { navigation: '路径追踪', path1: 'tower1.json', path2: 'tower2.json' }
      : { wave1: { '-1': 'wave1.json' } };
    assert.equal(await module.namespace.default.handler({ data }, { resolveResource: value => value }), true);
    assert.equal(started, 1);
    assert.equal(timers.length, 0, '完成步骤不得遗留Promise.race的10秒计时分支');
    assert.equal(joined, 1);
    assert.equal(disposed, 1);
    passed++;
  } finally {
    // 旧行为红测也不遗留真实计时器或后台工作。
    timers.forEach(timer => timer.resolve());
  }
}

await scenario('tower');
await scenario('defense');
console.log(JSON.stringify({ passed, scope: 'real public processor/defineStep/config parsing, external game and host task boundaries only' }));
