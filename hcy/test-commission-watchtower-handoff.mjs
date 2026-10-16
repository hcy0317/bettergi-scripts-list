import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../repo/js/AutoCommissionNova');
async function scenario({ complete = false, routeError = false, combatError = false, monitorError = false,
    realStrategies = false, baselineMisread = false, unstableBaseline = false, staleBaseline = false, repeatBaseline = false,
    completionNoise = false,
    protocol = 'bgi.external-combat.v1' } = {}) {
    const events = [];
    let arrived = false, descriptions = 0, disposed = false, script = '', sequence = 0, now = Date.now(), sessions = 0;
    const submitted = [];
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        log: { info() {}, debug() {}, warn() {}, error() {} },
        OpenCvSharp: { OpenCvSharp: { Rect: class { constructor(x,y,width,height) { Object.assign(this,{X:x,Y:y,Width:width,Height:height}); } } } },
        RecognitionObject: { ocrThis: {} },
        captureGameRegion: () => {
            if (monitorError && sessions > 0) throw Error('monitor-failed');
            const captured = now - (staleBaseline ? 1500 : 0);
            const frameSequence = repeatBaseline ? 1 : ++sequence;
            return {
                FrameStamp: { Sequence: frameSequence, IsKnown: true, IsAfter: old => frameSequence > old.Sequence,
                    CapturedAt: { ToUnixTimeMilliseconds: () => captured } },
                DeriveCrop: () => ({ find: () => ({ text: complete || completionNoise && frameSequence === 2 ? '委托完成' : '' }), Dispose() {} }),
                Dispose() {}
            };
        },
        genshin: { returnMainUi: async () => events.push('prepare-ui') },
        sleep: async ms => { now += ms; events.push(`sleep:${ms}:${arrived ? 'arrived' : 'before'}`); },
        pathingScript: { runFile: async () => { events.push('path'); if (routeError) throw Error('route-failed'); arrived = true; } },
        getAvatars: () => { events.push('team'); return { Length: 1, GetValue: () => realStrategies ? '钟离' : arrived ? '琴' : '钟离' }; },
        file: { isFile: () => true, readTextSync: () => realStrategies
            ? fs.readFileSync(path.join(root, 'config/avatar-strategies.json'), 'utf8')
            : JSON.stringify({ '琴': { script: 'attack(1)' }, '钟离': { script: 'e(hold)' } }) },
        dispatcher: {
            ReadCombatSessionProtocol: protocol === null ? undefined : () => protocol,
            CreateCombatSession: (text, target, source, initial, total) => {
                events.push('combat'); sessions++; script = text;
                assert.equal(source.IsKnown, true); assert.equal(initial, baselineMisread ? 1 : 0); assert.equal(total, 2);
                let observations = 0, lastCount = null, stopped = combatError;
                const result = { Status: combatError ? 'Failed' : 'CompletedByExternalProgress', Reason: combatError ? 'combat-failed' : 'commission-completed' };
                return {
                    SessionId: 'session', TargetId: target, get IsCompleted() { return stopped; },
                    SubmitProgress: (id, t, frame, count, all, completed) => {
                        assert.equal(id, 'session'); assert.equal(t, target); assert.equal(frame.IsKnown, true);
                        submitted.push(count);
                        observations = count === lastCount && (completed || count > initial) ? observations + 1 : 1;
                        lastCount = count;
                        if (observations >= 2 && (completed || count > initial)) stopped = true;
                        return true;
                    },
                    WaitAsync: async () => { assert.equal(stopped, true); return result; },
                    DisposeAsync: async () => { disposed = true; stopped = true; }
                };
            }
        }
    });
    const dependencies = {
        '../config/index.js': { PATHS: { AVATAR_STRATEGIES: 'fixture' } },
        '../vision/index.js': { RO: {} },
        '../vision/ocr-utils.js': { bvPageOcrRegionText: () => complete ? '委托完成' : '' },
        './define-step.js': { defineStep: value => value },
        '../utils/error-utils.js': { isCancellationError: error => error.message === 'cancelled',
            rethrowIfCancellation: error => { if (error.message === 'cancelled' || error.message.includes('BGI_COMBAT_UNCONFIRMED')) throw error; } },
        './commission-desc-utils.js': { readTrackedDescriptionText: (_, capture) => {
            assert.equal(capture.FrameStamp.IsKnown, true);
            events.push('status');
            const index = descriptions++;
            const count = unstableBaseline && sessions === 0 ? index % 2 : baselineMisread
                ? [0, 1, 1, 1, 1, 2, 2][Math.min(index, 6)] : index < 2 ? 0 : 2;
            return `丘丘人哨塔${count}/2`;
        } }
    };
    const processor = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/processors/basic-destroy-watchtower.js'), 'utf8'), { context });
    await processor.link(async spec => {
        if (spec === '../utils/async-task-retirement.js') {
            const retirement = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/utils/async-task-retirement.js'), 'utf8'), { context });
            await retirement.link(() => { throw Error('Unexpected retirement dependency'); });
            return retirement;
        }
        if (spec === '../utils/path-healing-recovery.js') {
            const recovery = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/utils/path-healing-recovery.js'), 'utf8'), { context });
            await recovery.link(() => {
                const exports = dependencies['../utils/error-utils.js'];
                return new vm.SyntheticModule(Object.keys(exports), function () {
                    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
                }, { context });
            });
            return recovery;
        }
        const exports = dependencies[spec];
        assert.ok(exports, spec);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await processor.evaluate();
    for (const noise of ['丘丘人哨塔-1/2', '丘丘人哨塔9/2', '丘丘人哨塔1/0', '丘丘人哨塔1/3', '丘丘人哨塔1/20'])
        assert.equal(processor.namespace.parseWatchtowerProgress(noise), null, noise);
    let result, error;
    try { result = await processor.namespace.default.run({ data: { navigation: '路径追踪', path: 'fixture.json' } }, { resolveResource: x => x }); }
    catch (caught) { error = caught; }
    return { events, result, error, disposed, script, sessions, submitted };
}

const normal = await scenario();
assert.equal(normal.error, undefined);
assert.equal(normal.result, true);
assert.ok(normal.events.indexOf('prepare-ui') < normal.events.indexOf('path'));
assert.ok(normal.events.indexOf('status') < normal.events.indexOf('combat'));
assert.ok(normal.events.indexOf('team') > normal.events.indexOf('path'));
assert.equal(normal.script, '琴 attack(1)');
assert.equal(normal.sessions, 1);
assert.equal(normal.disposed, true);
const complete = await scenario({ complete: true });
assert.equal(complete.result, true);
assert.equal(complete.events.includes('combat'), false);
const route = await scenario({ routeError: true });
assert.equal(route.error.message, 'route-failed');
assert.equal(route.events.includes('combat'), false);
const failure = await scenario({ combatError: true });
assert.match(failure.error.message, /combat-failed/);
assert.equal(failure.disposed, true);
const monitor = await scenario({ monitorError: true });
assert.match(monitor.error.message, /monitor-failed/);
assert.equal(monitor.disposed, true);
const real = await scenario({ realStrategies: true });
assert.equal(real.error, undefined);
assert.equal(real.script, '钟离 e(hold),q(optional),attack(1.2)');
assert.equal(real.sessions, 1);
for (const protocol of [null, 'bgi.external-combat.v0']) {
    const incompatible = await scenario({ protocol });
    assert.match(incompatible.error.message, /升级|不支持/);
    assert.deepEqual(incompatible.events, []);
}
const noisyStart = await scenario({ baselineMisread: true });
assert.equal(noisyStart.error, undefined);
assert.equal(noisyStart.sessions, 1);
assert.deepEqual(noisyStart.submitted, [1, 1, 2, 2]);
for (const invalid of ['unstableBaseline', 'staleBaseline', 'repeatBaseline']) {
    const unavailable = await scenario({ [invalid]: true });
    assert.match(unavailable.error?.message || '', /EVIDENCE_UNAVAILABLE/);
    assert.equal(unavailable.sessions, 0);
}
const noisyCompletion = await scenario({ completionNoise: true });
assert.equal(noisyCompletion.error, undefined);
assert.equal(noisyCompletion.sessions, 1);
console.log(JSON.stringify({ passed: 13, scope: 'actual watchtower adapter, stable baseline, config loader, retirement and protocol gate; offline VM, native API verified separately in V8 tests' }));
