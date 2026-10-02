import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = new URL('../repo/js/AutoCommissionNova/src/utils/path-healing-recovery.js', import.meta.url);
const signal = '[BGI_HEALING_REPLAN_REQUIRED] confirmed';
const route = (first, action = '', map = 'Teyvat') => JSON.stringify({info: {map_name: map}, positions: [
    {type: first, x: 1, y: 2, action}, {type: 'path', x: 3, y: 4, action: ''}
]});

async function setup(options = {}) {
    const events = [], owner = {};
    const files = {'parent.json': route('teleport', options.parentAction), 'fragment.json': route('target', '', options.map)};
    let calls = 0;
    const context = vm.createContext({
        file: {readTextSync: name => files[name]}, log: {info() {}},
        pathingScript: {
            runFile: async name => {
                events.push(name);
                if (name === 'parent.json' && options.parentFails) throw Error('parent-failed');
                if (name === 'fragment.json' && (++calls === 1 || options.alwaysFails)) {
                    if (options.changeParent) files['parent.json'] += ' ';
                    throw Error(options.error ?? signal);
                }
                return {success: true};
            },
            run: async json => {
                events.push('return');
                assert.equal(json, files['parent.json']);
                if (options.returnFails) throw Error('return-failed');
                return options.noReceipt ? undefined : {success: true};
            }
        }
    });
    const module = new vm.SourceTextModule(fs.readFileSync(source, 'utf8'), {context});
    await module.link(async () => {
        const errors = new vm.SourceTextModule(fs.readFileSync(new URL('../repo/js/AutoCommissionNova/src/utils/error-utils.js', import.meta.url), 'utf8'), {context});
        await errors.link(() => { throw Error('unexpected import'); });
        return errors;
    });
    await module.evaluate();
    const run = module.namespace.runCommissionPath;
    if (!options.noParent) await run('parent.json', owner, true);
    return {run: () => run('fragment.json', owner), events, owner};
}

test('confirmed healing at an unstarted fragment returns through the successful navigation once', async () => {
    const value = await setup();
    assert.equal((await value.run()).success, true);
    assert.deepEqual(value.events, ['parent.json', 'fragment.json', 'return', 'fragment.json']);
    assert.equal(value.owner.healingReplans, 1);
});

for (const options of [{noParent: true}, {parentAction: 'combat_script'}, {map: 'OtherMap'}, {changeParent: true},
    {error: 'ordinary-failure'}, {error: signal + ' operation was canceled'}, {error: signal + ' BGI_COMBAT_UNCONFIRMED'}]) {
    test(`no replan for missing, stale, unsafe or terminal evidence: ${JSON.stringify(options)}`, async () => {
        const value = await setup(options);
        await assert.rejects(value.run());
        assert.equal(value.events.includes('return'), false);
    });
}

for (const options of [{returnFails: true}, {noReceipt: true}]) {
    test(`unconfirmed return cannot retry the fragment: ${JSON.stringify(options)}`, async () => {
        const value = await setup(options);
        await assert.rejects(value.run());
        assert.equal(value.events.filter(e => e === 'fragment.json').length, 1);
    });
}

test('a second fragment failure propagates without a recovery loop', async () => {
    const value = await setup({alwaysFails: true});
    await assert.rejects(value.run(), /BGI_HEALING_REPLAN_REQUIRED/);
    await assert.rejects(value.run(), /BGI_HEALING_REPLAN_REQUIRED/);
    assert.equal(value.events.filter(e => e === 'return').length, 1);
});

test('an unsuccessful parent never becomes a checkpoint', async () => {
    await assert.rejects(setup({parentFails: true}), /parent-failed/);
});
