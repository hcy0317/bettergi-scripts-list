const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const libPath = path.join(root, 'repo/js/CD-Aware-AutoGather/lib/lib.js');
const mainPath = path.join(root, 'repo/js/CD-Aware-AutoGather/main.js');
const fakeUid = '1'.repeat(9);

function loadFunction(file, name, io) {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('async function ' + name + '(');
    assert.notEqual(start, -1);
    const next = source.indexOf('\n/**', start + 1);
    const code = source.slice(start, next < 0 ? source.length : next);
    return vm.runInNewContext(code + '\n' + name, io, { filename: file });
}

function accountFixture(fragments) {
    const calls = { captures: 0, disposes: 0, rois: [], errors: [] };
    const list = Object.assign(fragments, { count: fragments.length });
    const region = { width: 1920, height: 1080,
        findMulti() { return list; }, dispose() { calls.disposes++; } };
    const read = loadFunction(libPath, 'getGameAccount', {
        captureGameRegion() { calls.captures++; return region; },
        RecognitionObject: { ocr(...roi) { calls.rois.push(roi); return {}; } },
        log: { error(message) { calls.errors.push(message); }, debug() {} }
    });
    return { read, calls, region, list };
}

test('whole account read binds split UID label to adjacent digits in the same image', async () => {
    const fixture = accountFixture([
        { text: 'UID:', x: 1690, y: 1053, width: 40, height: 22 },
        { text: fakeUid, x: 1734, y: 1053, width: 118, height: 22 }
    ]);
    assert.equal(await fixture.read(true, false), fakeUid);
    assert.equal(fixture.calls.captures, 1);
    assert.equal(fixture.calls.disposes, 1);
    assert.deepEqual(fixture.calls.rois, [[1440, 810, 480, 270]]);
    assert.deepEqual(fixture.calls.errors, []);
});

test('whole host UID flow refuses identity read after multiplayer wait success=false', async () => {
    const calls = [];
    const flow = loadFunction(mainPath, 'getCoOpModeAndHostUid', {
        genshin: { async returnMainUi() { calls.push('main'); } },
        keyPress(key) { calls.push('key:' + key); },
        async waitForTextAppear(text) { calls.push('wait:' + text); return { success: false }; },
        async getGameAccount() { calls.push('identity'); return fakeUid; },
        async isTextExistedInRegion() { calls.push('mode'); return true; },
        log: { info() {}, error() {}, debug() {} }
    });
    await assert.rejects(flow(), /多人游戏/);
    assert.deepEqual(calls, ['main', 'key:F2', 'wait:多人游戏']);
});

function box(text, x = 1690, y = 1053, width = 174, height = 22) {
    return { text, x, y, width, height };
}

for (const [name, fragments] of [
    ['digits without UID label', [box(fakeUid)]],
    ['covered UID label without value', [box('UID:')]],
    ['UID and digits on different rows', [box('UID:', 1690, 1010, 40), box(fakeUid, 1734, 1053, 118)]],
    ['far-away digits in the ROI', [box('UID:', 1450, 1053, 40), box(fakeUid, 1780, 1053, 118)]],
    ['digits before the label', [box(fakeUid, 1450, 1053, 118), box('UID:', 1800, 1053, 40)]],
    ['foreign profile UID outside the original ROI', [box('UID:' + fakeUid, 623, 192, 118)]],
    ['two conflicting adjacent values', [box('UID:', 1690, 1053, 40), box(fakeUid, 1734, 1053, 118), box('2'.repeat(9), 1735, 1053, 118)]],
    ['conflicting combined UID labels', [box('UID:' + fakeUid, 1690, 1000), box('UID:' + '2'.repeat(9))]],
    ['unrelated digits in a UID phrase', [box('UID: ' + fakeUid + ' LV90')]],
    ['short partial identity', [box('UID:182')]],
    ['zero failure marker', [box('UID:' + '0'.repeat(9))]],
    ['zero split failure marker', [box('UID:', 1690, 1053, 40), box('0'.repeat(9), 1734, 1053, 118)]],
    ['oversized numeric identity', [box('UID:' + '1'.repeat(12))]],
    ['malformed box', [box('UID:' + fakeUid, NaN)]],
    ['non-positive box', [box('UID:' + fakeUid, 1690, 1053, -1)]],
    ['confusable non-UID label', [box('U1D:' + fakeUid)]]
]) {
    test('whole account read rejects ' + name, async () => {
        const fixture = accountFixture(fragments);
        assert.equal(await fixture.read(true, false), '默认账号');
        assert.equal(fixture.calls.captures, 1);
        assert.equal(fixture.calls.disposes, 1);
        assert.deepEqual(fixture.calls.errors, ['未能提取到UID']);
        assert.ok(fixture.calls.errors.every(message => !message.includes(fakeUid)));
    });
}

for (const value of [fakeUid, '1'.repeat(10)]) {
    test('whole account accepts a complete labelled current UID format of length ' + value.length, async () => {
        const fixture = accountFixture([box('UID： ' + value)]);
        assert.equal(await fixture.read(true, false), value);
        assert.equal(fixture.calls.disposes, 1);
        assert.deepEqual(fixture.calls.errors, []);
    });
}

test('whole account retains default multi-account opt-out and mask behavior', async () => {
    const disabled = accountFixture([]);
    assert.equal(await disabled.read(), '默认账号');
    assert.equal(disabled.calls.captures, 0);
    assert.deepEqual(disabled.calls.errors, []);
    const enabled = accountFixture([box('UID:' + fakeUid)]);
    assert.equal(await enabled.read(true), 'xxxx11111');
    assert.equal(enabled.calls.captures, 1);
    assert.equal(enabled.calls.disposes, 1);
});

test('whole account preserves native-list Count and disposes the captured image on OCR exception', async () => {
    const counted = accountFixture([box('UID:' + fakeUid)]);
    delete counted.list.count;
    counted.list.Count = 1;
    assert.equal(await counted.read(true, false), fakeUid);
    const failure = accountFixture([]);
    failure.region.findMulti = () => { throw new Error('fixture OCR failed'); };
    await assert.rejects(failure.read(true, false), /fixture OCR failed/);
    assert.equal(failure.calls.captures, 1);
    assert.equal(failure.calls.disposes, 1);
});

function hostFixture(options = {}) {
    const { profileReady = { success: true }, mode = 'single', uid = fakeUid } = options;
    const ready = Object.prototype.hasOwnProperty.call(options, 'ready') ? options.ready : { success: true };
    const calls = { keys: [], waits: [], accounts: [], main: 0, profileReads: 0, sleeps: [], clicks: [] };
    const flow = loadFunction(mainPath, 'getCoOpModeAndHostUid', {
        genshin: { async returnMainUi() { calls.main++; } },
        keyPress(key) { calls.keys.push(key); },
        async waitForTextAppear(...args) { calls.waits.push(JSON.parse(JSON.stringify(args))); return args[0] === '多人游戏' ? ready : profileReady; },
        async getGameAccount(...args) { calls.accounts.push(args); return uid; },
        async isTextExistedInRegion() { return mode === 'single'; },
        async getTextInRegion(rect) { if (rect[0] === 1560) return mode === 'guest' ? '离开队伍' : ''; calls.profileReads++; return fakeUid; },
        click(...args) { calls.clicks.push(args); },
        async recognizeTextAndClick() { return { success: true }; },
        async sleep(ms) { calls.sleeps.push(ms); },
        log: { info() {}, error() {}, debug() {} }
    });
    return { flow, calls };
}

for (const ready of [{}, null, undefined, true, { success: 'true' }]) {
    test('whole host flow requires an explicit boolean success result ' + JSON.stringify(ready), async () => {
        const fixture = hostFixture({ ready });
        await assert.rejects(fixture.flow(), /多人游戏/);
        assert.deepEqual(fixture.calls.accounts, []);
        assert.deepEqual(fixture.calls.keys, ['F2']);
        assert.deepEqual(fixture.calls.waits, [['多人游戏', [130, 20, 129, 57]]]);
    });
}

for (const mode of ['single', 'host']) {
    test('whole confirmed ' + mode + ' flow preserves one F2 and the existing wait arguments', async () => {
        const fixture = hostFixture({ mode });
        const result = await fixture.flow();
        assert.equal(result.uid, fakeUid);
        assert.equal(result.coOpMode, mode !== 'single');
        assert.deepEqual(fixture.calls.keys, ['F2']);
        assert.deepEqual(fixture.calls.accounts, [[true, false]]);
        assert.deepEqual(fixture.calls.waits, [['多人游戏', [130, 20, 129, 57]]]);
        assert.deepEqual(fixture.calls.sleeps, []);
        assert.deepEqual(fixture.calls.clicks, []);
        assert.equal(fixture.calls.main, 2);
    });
}

test('whole guest flow does not read a profile after its confirmation failed', async () => {
    const fixture = hostFixture({ mode: 'guest', profileReady: { success: false } });
    await assert.rejects(fixture.flow(), /角色展柜/);
    assert.equal(fixture.calls.profileReads, 0);
    assert.deepEqual(fixture.calls.sleeps, []);
    assert.deepEqual(fixture.calls.keys, ['F2']);
    assert.equal(fixture.calls.waits.length, 2);
});

test('whole confirmed guest flow retains its existing host-profile navigation and cadence', async () => {
    const fixture = hostFixture({ mode: 'guest' });
    const result = await fixture.flow();
    assert.equal(result.uid, fakeUid);
    assert.equal(result.coOpMode, true);
    assert.deepEqual(fixture.calls.keys, ['F2']);
    assert.deepEqual(fixture.calls.clicks, [[332, 218]]);
    assert.deepEqual(fixture.calls.sleeps, [100]);
    assert.equal(fixture.calls.profileReads, 1);
});

test('whole host flow never publishes the default-account failure marker as UID', async () => {
    const fixture = hostFixture({ uid: '默认账号' });
    await assert.rejects(fixture.flow(), /世界主人UID/);
});
