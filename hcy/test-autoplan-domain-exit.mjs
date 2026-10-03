import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../repo/js/AutoPlan/utils/tool.js', import.meta.url), 'utf8');
async function runtime({exitDomain, stuck = false, allowPrompt = true, initial = 'domain', revivePrompt = false} = {}) {
    let now = 0, confirmationAt = null, prompt = initial === 'prompt';
    const events = [];
    const phase = () => confirmationAt === null ? initial :
        stuck ? 'domain' : now < confirmationAt + 800 ? 'domain' : now < confirmationAt + 3500 ? 'loading' : 'world';
    class ClockDate extends Date { static now() { return now; } }
    const context = vm.createContext({
        settings: {debug:false}, Date: ClockDate, genshin: exitDomain ? {exitDomain} : {},
        log: Object.fromEntries(['info','warn','error','debug'].map(level => [level, () => {}])),
        Pen: class {}, Color: new Proxy({}, {get: (_, name) => name}),
        sleep: async ms => { now += ms; },
        keyPress: async key => { events.push('key:' + key); if (allowPrompt && phase() === 'domain') prompt = true; },
        file: {ReadImageMatSync: path => ({path})},
        RecognitionObject: {TemplateMatch: () => ({kind:'template'}), Ocr: () => ({kind:'ocr'})},
        captureGameRegion() {
            const current = phase(), hasPrompt = prompt;
            const result = text => ({text, isExist: () => true, isEmpty: () => false,
                click() { events.push('click:' + text); if (text === '确认') { confirmationAt = now; prompt = false; } }});
            return {
                find() { return {isEmpty: () => current !== 'domain' && current !== 'world'}; },
                findMulti() { const rows = hasPrompt ? [result('退出秘境'), result('确认')] : []; if (revivePrompt) rows.push(result('使用道具复苏角色')); rows.count = rows.length; return rows; },
                dispose() {},
            };
        },
    });
    const module = new vm.SourceTextModule(source, {context});
    await module.link(() => { throw new Error('unexpected import'); });
    await module.evaluate();
    return {exit: () => module.namespace.outDomainUI(), events, now: () => now, phase};
}

test('native domain exit is awaited before the caller can resume', async () => {
    let resolve, calls = 0, completed = false;
    const host = new Promise(done => { resolve = done; });
    const run = await runtime({initial:'prompt', exitDomain: () => { calls++; return host; }});
    const pending = run.exit().then(() => { completed = true; });
    try {
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(calls, 1);
        assert.equal(completed, false);
        assert.deepEqual(run.events, []);
    } finally { resolve(); await pending; }
    assert.equal(completed, true);
});

test('legacy exit waits through delayed loading after one confirmed exit input', async () => {
    const run = await runtime({initial:'prompt'});
    await run.exit();
    assert.equal(run.phase(), 'world');
    assert.equal(run.events.filter(event => event === 'click:确认').length, 1);
});

test('native failure is preserved without legacy input or retry', async () => {
    const failure = new Error('native exit cancelled or failed');
    let calls = 0;
    const run = await runtime({exitDomain: async () => { calls++; throw failure; }});
    await assert.rejects(run.exit(), error => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(run.events, []);
});

test('legacy confirmation without loading times out instead of continuing inside the domain', async () => {
    const run = await runtime({initial:'prompt', stuck:true});
    await assert.rejects(run.exit(), /未确认退出秘境/);
    assert.equal(run.events.filter(event => event === 'click:确认').length, 1);
    assert(run.now() >= 20000 && run.now() < 21000);
});

test('legacy main HUD without any exit confirmation is not evidence of leaving the domain', async () => {
    const run = await runtime({allowPrompt:false});
    await assert.rejects(run.exit(), /未确认退出秘境/);
    assert.equal(run.events.filter(event => event === 'click:确认').length, 0);
    assert.equal(run.events.filter(event => event === 'key:ESCAPE').length, 3);
});

test('native exit can finish when the host already confirmed the overworld', async () => {
    const run = await runtime({initial:'world', exitDomain:async () => {}});
    await run.exit();
    assert.deepEqual(run.events, []);
});

test('legacy ambiguous revive evidence never authorizes a confirmation click', async () => {
    const run = await runtime({initial:'prompt', revivePrompt:true});
    await assert.rejects(run.exit(), /未确认退出秘境/);
    assert.equal(run.events.filter(event => event === 'click:确认').length, 0);
});
