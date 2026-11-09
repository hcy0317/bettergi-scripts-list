import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../repo/js/AutoCommissionNova");

async function loadEntry(enterNative) {
    const calls = { native: [], legacy: [], info: [], error: [] };
    const genshin = { returnMainUi: async () => calls.legacy.push("returnMainUi") };
    if (enterNative) {
        genshin.enterCommissionScreen = (...args) => {
            calls.native.push(args);
            return enterNative(...args);
        };
    }
    const context = vm.createContext({
        genshin,
        OpenCvSharp: { OpenCvSharp: {
            Rect: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } },
        } },
        log: {
            info: (...args) => calls.info.push(args),
            error: (...args) => calls.error.push(args),
            warn() {}, debug() {},
        },
        PostMessage: class {
            constructor() { calls.legacy.push("PostMessage"); }
            keyPress(key) { calls.legacy.push(["background-key", key]); }
        },
        keyPress: key => calls.legacy.push(["key", key]),
        click: (...args) => calls.legacy.push(["click", ...args]),
        sleep: async ms => calls.legacy.push(["sleep", ms]),
        BvPage: class {
            constructor() { calls.legacy.push("BvPage"); }
            locator() {
                return {
                    withRetryAction(action) {
                        return { async waitFor() { calls.legacy.push("waitFor"); action(); } };
                    },
                };
            }
        },
    });
    const modules = new Map();
    function moduleFor(filename) {
        assert.ok(filename.startsWith(root + path.sep), "module stays within the real Nova source");
        if (!modules.has(filename)) {
            modules.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
                context, identifier: filename,
            }));
        }
        return modules.get(filename);
    }
    async function load(relative) {
        const mod = moduleFor(path.join(root, relative));
        if (mod.status === "unlinked") {
            await mod.link((specifier, parent) => {
                assert.ok(specifier.startsWith("."), "only real relative source dependencies are loaded");
                return moduleFor(path.resolve(path.dirname(parent.identifier), specifier));
            });
        }
        if (mod.status === "linked") await mod.evaluate();
        return mod.namespace;
    }
    return { entry: await load("src/vision/ui-detector.js"), calls, load };
}

test("commission entry waits for Native confirmation and sends no legacy input", async () => {
    let confirm;
    const native = new Promise(resolve => { confirm = resolve; });
    const { entry, calls } = await loadEntry(() => native);
    let settled = false;
    const result = entry.enterCommissionScreen().then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    try {
        assert.equal(calls.native.length, 1);
        assert.deepEqual(calls.native[0], []);
        assert.equal(settled, false, "input submission is not page confirmation");
        assert.equal(calls.info.length, 0);
        assert.deepEqual(calls.legacy, []);
    } finally {
        confirm();
    }
    assert.equal(await result, true);
    assert.equal(calls.info.length, 1);
    assert.equal(calls.info[0][0], "已进入委托界面");
    assert.equal(calls.error.length, 0);
});

for (const reason of ["The operation was canceled.", "界面转换超时：commission-page-entry"]) {
    test("Native rejection remains false without retry or legacy input: " + reason, async () => {
        const { entry, calls } = await loadEntry(async () => { throw new Error(reason); });
        assert.equal(await entry.enterCommissionScreen(), false);
        assert.equal(calls.native.length, 1);
        assert.deepEqual(calls.legacy, []);
        assert.equal(calls.info.length, 0);
        assert.equal(calls.error.length, 1);
        assert.equal(calls.error[0][0], "进入委托界面失败: {error}");
        assert.equal(calls.error[0][1], reason);
    });
}

test("a build without the Native capability fails clearly without a fallback", async () => {
    const { entry, calls } = await loadEntry();
    assert.equal(await entry.enterCommissionScreen(), false);
    assert.equal(calls.native.length, 0);
    assert.deepEqual(calls.legacy, []);
    assert.equal(calls.info.length, 0);
    assert.equal(calls.error.length, 1);
    assert.match(calls.error[0][1], /genshin\.enterCommissionScreen/);
    assert.match(calls.error[0][1], /0\.66\.3-alpha\.1/);
});

test("the existing callers retain the shared vision entry", async () => {
    const { entry, load } = await loadEntry(async () => {});
    const vision = await load("src/vision/index.js");
    assert.equal(vision.enterCommissionScreen, entry.enterCommissionScreen);
    for (const relative of ["src/core/main-process.js", "src/recognition/completion-detector.js"]) {
        const source = fs.readFileSync(path.join(root, relative), "utf8");
        assert.match(source, /import\s*\{[^}]*\benterCommissionScreen\b[^}]*\}\s*from\s*["']\.\.\/vision\/index\.js["']/);
        assert.match(source, /await\s+enterCommissionScreen\(\)/);
    }
});
