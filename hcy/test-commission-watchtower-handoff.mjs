import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../repo/js/AutoCommissionNova');
async function scenario({ complete = false, routeError = false, combatError = false } = {}) {
    const events = [];
    let arrived = false, descriptions = 0, release, disposed = false, script = '';
    const token = { IsCancellationRequested: false };
    const context = vm.createContext({
        log: { info() {}, debug() {}, warn() {}, error() {} },
        OpenCvSharp: { OpenCvSharp: { Rect: class {} } },
        genshin: { returnMainUi: async () => events.push('prepare-ui') },
        sleep: async ms => events.push(`sleep:${ms}:${arrived ? 'arrived' : 'before'}`),
        pathingScript: { runFile: async () => { events.push('path'); if (routeError) throw Error('route-failed'); arrived = true; } },
        getAvatars: () => { events.push('team'); return { Length: 1, GetValue: () => arrived ? '琴' : '钟离' }; },
        file: { isFile: () => true, readTextSync: () => JSON.stringify({ '琴': { script: 'attack(1)' }, '钟离': { script: 'e(hold)' } }) },
        dispatcher: {
            GetLinkedCancellationTokenSource: () => ({ Token: token, Cancel() { token.IsCancellationRequested = true; release?.(); }, Dispose() { disposed = true; } }),
            RunCombatScript: async text => { events.push('combat'); script = text; if (combatError) throw Error('combat-failed'); await new Promise(resolve => { release = resolve; }); },
            waitForTask: async task => { await task; return true; }
        }
    });
    const dependencies = {
        '../config/index.js': { PATHS: { AVATAR_STRATEGIES: 'fixture' } },
        '../vision/index.js': { RO: {} },
        '../vision/ocr-utils.js': { bvPageOcrRegionText: () => complete ? '委托完成' : '' },
        './define-step.js': { defineStep: value => value },
        '../utils/error-utils.js': { isCancellationError: error => error.message === 'cancelled' },
        './commission-desc-utils.js': { readTrackedDescriptionText: () => { events.push('status'); return descriptions++ === 0 ? '丘丘人哨塔0/2' : '丘丘人哨塔2/2'; } }
    };
    const processor = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/processors/basic-destroy-watchtower.js'), 'utf8'), { context });
    await processor.link(async spec => {
        if (spec === '../utils/async-task-retirement.js') {
            const retirement = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/utils/async-task-retirement.js'), 'utf8'), { context });
            await retirement.link(() => { throw Error('Unexpected retirement dependency'); });
            return retirement;
        }
        const exports = dependencies[spec];
        assert.ok(exports, spec);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await processor.evaluate();
    let result, error;
    try { result = await processor.namespace.default.run({ data: { navigation: '路径追踪', path: 'fixture.json' } }, { resolveResource: x => x }); }
    catch (caught) { error = caught; }
    return { events, result, error, disposed, script };
}

const normal = await scenario();
assert.equal(normal.error, undefined);
assert.equal(normal.result, true);
assert.ok(normal.events.indexOf('prepare-ui') < normal.events.indexOf('path'), normal.events.join(','));
assert.ok(normal.events.includes('sleep:500:before'));
assert.ok(normal.events.indexOf('status') < normal.events.indexOf('combat'));
assert.ok(normal.events.indexOf('team') > normal.events.indexOf('path'));
assert.equal(normal.script, '琴 attack(1)');
assert.equal(normal.disposed, true);
const complete = await scenario({ complete: true });
assert.equal(complete.result, true);
assert.equal(complete.events.includes('combat'), false);
const route = await scenario({ routeError: true });
assert.equal(route.error.message, 'route-failed');
assert.equal(route.events.includes('combat'), false);
const failure = await scenario({ combatError: true });
assert.equal(failure.error.message, 'combat-failed');
assert.equal(failure.disposed, true);
console.log(JSON.stringify({ passed: 4, scope: 'actual watchtower step + retirement, offline boundary VM; no game' }));
