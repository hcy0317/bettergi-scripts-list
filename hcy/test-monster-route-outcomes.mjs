import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const raw = fs.readFileSync(new URL("../repo/js/FullyAutoAndSemiAutoTools/main.js", import.meta.url), "utf8");
// 只隔离启动/游戏/文件I/O；main、runMap、runList均执行原生产函数。
const begin = raw.indexOf("(async function () {");
const end = raw.indexOf("async function main() {", begin);
assert(begin >= 0 && end > begin);
const source = (raw.slice(0, begin) + raw.slice(end)).replace(/^import .*;\r?$/gm, "");

function runtime(failure) {
    const calls = [];
    const context = vm.createContext({ settings: {}, sleep: async () => {},
        log: Object.fromEntries(["info", "debug", "warn", "error"].map(x => [x, () => {}])),
        pathingScript: { isCancellationRequested: false },
        runGamePath: async path => { calls.push(path); if (path === failure) throw new Error("required fragment failed"); },
    });
    vm.runInContext(source + `
        runPath = runGamePath;
        saveRecordPaths = async () => {};
        saveRecord = async () => {};
        debugKey = async () => {};
        Record.errorPaths.add("historical-failure");
        needRunMap.set("group-a", {paths:[{path:"failed"},{path:"good-a"}]});
        needRunMap.set("group-b", {paths:[{path:"good-b"}]});
    `, context);
    return { calls, run: () => vm.runInContext("main()", context),
        successful: () => vm.runInContext("[...Record.paths]", context) };
}

test("a partial route failure attempts later groups but does not complete the script", async () => {
    const run = runtime("failed");
    await assert.rejects(run.run(), /路线.*失败|failed/i);
    assert.deepEqual(run.calls, ["failed", "good-a", "good-b"]);
    assert.deepEqual(Array.from(run.successful()), ["good-a", "good-b"]);
});

test("historical route failures do not poison an otherwise successful new run", async () => {
    const run = runtime(null);
    await run.run();
    assert.deepEqual(run.calls, ["failed", "good-a", "good-b"]);
});
