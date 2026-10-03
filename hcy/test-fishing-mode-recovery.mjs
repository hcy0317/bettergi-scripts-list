import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../repo/js/AutoFishingTeyvat/multiplayer-recovery.js', import.meta.url), 'utf8');
async function fixture(visible) {
    let acquired = 0, disposed = 0, waited = 0;
    const context = vm.createContext({
        genshin: { returnMainUi: async () => {} },
        sleep: async ms => { waited += ms; if (waited > 15000) throw new Error('external deadline exceeded'); },
        keyPress() {},
        file: { ReadImageMatSync: path => ({ path, dispose() {} }) },
        RecognitionObject: { TemplateMatch: mat => ({ path: mat.path }), Ocr: () => ({ ocr: true }) },
        captureGameRegion: () => {
            acquired++;
            return { dispose: () => disposed++, Find: ro => ({ isExist: () => ro.path?.endsWith('single.png') || visible,
                text: ro.ocr ? '123456789' : '' }) };
        }
    });
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => { throw new Error('unexpected import'); });
    await module.evaluate();
    return { run: () => module.namespace.recoverSinglePlayerUid('bgiMultiUser'), counts: () => ({ acquired, disposed, waited }) };
}
test('missing tutorial terminates with explicit failure and releases every screenshot', async () => {
    const f = await fixture(false);
    await assert.rejects(f.run(), /FISHING_MODE_UNCONFIRMED/);
    const c = f.counts();
    assert.equal(c.acquired, c.disposed);
    assert.ok(c.acquired <= 22 && c.waited <= 11000);
});
test('confirmed single-player UID is returned only after readable tutorial evidence', async () => {
    const f = await fixture(true);
    const result = await f.run();
    assert.equal(result.uid, '123456789');
    assert.equal(result.changed, true);
    assert.equal(f.counts().acquired, f.counts().disposed);
});
