import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../repo/js/StarfieldRaimentCollection/main.js', import.meta.url), 'utf8');
const archive = fs.readFileSync(new URL('../repo/js/StarfieldRaimentCollection/assets/archive.json', import.meta.url), 'utf8');
for (const [guid, expected] of [['45694132064', 41000], ['24339714898', 61000]]) {
    test(`real entry executes the archive for the GUID actually entered: ${guid}`, async () => {
        const other = guid === '45694132064' ? '24339714898' : '45694132064';
        let playing = false;
        let typed;
        let observedDelay;
        const stop = new Error('external game boundary: observed first archive command');
        const result = (exists = false, text = '') => ({ isExist: () => exists, text, Click() {} });
        const context = vm.createContext({
            settings: { EULA: true, extra_count: '0', g_uid: `${guid},${other}` },
            RecognitionObject: { TemplateMatch: (path) => ({ path }), Ocr: () => ({}) },
            file: { ReadImageMatSync: path => path, readTextSync: () => archive },
            genshin: { returnMainUi: async () => { playing = false; } },
            log: { info() {}, error() {}, debug() {} },
            click() {}, keyPress() {}, keyDown() {}, keyUp() {}, inputText: value => { typed = value; },
            sleep: async ms => { if (ms >= 40000) { observedDelay = ms; throw stop; } },
            captureGameRegion: () => ({
                dispose() {},
                Find: ro => result(ro.path?.endsWith('targetIcon.png') || ro.path?.endsWith('active0.png') ||
                    (ro.path?.endsWith('mainUI.png') && !playing) || (ro.path?.endsWith('Exit.png') && playing)),
                FindMulti: () => ({ count: 1, 0: { text: '开始游戏', Click: () => { playing = true; } } })
            })
        });
        await assert.rejects(vm.runInContext(source, context, { timeout: 2000 }), error => error === stop);
        assert.equal(typed, guid);
        assert.equal(observedDelay, expected);
    });
}
