import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../repo/js/PurchaseArtifacts/main.js", import.meta.url), "utf8");

function run({ userName, uid = 123456789 } = {}) {
    const reads = [], writes = [];
    const settings = { merchants: ["蒙德商人"] };
    if (userName !== undefined) settings.userName = userName;
    const completion = vm.runInNewContext(source, {
        settings, console, sleep: async () => {},
        log: { info() {}, warn() {}, error() {}, debug() {} },
        notification: { send() {} },
        genshin: { returnMainUi: async () => {}, uid: async () => uid },
        file: {
            async readText(path) {
                reads.push(path);
                return JSON.stringify([{ name: "蒙德-蒙德城-石榴", time: "2099-12-31T00:00:00+08:00", count: 5 }]);
            },
            async writeText(path, value) { writes.push({ path, value }); },
        },
    }, { filename: "PurchaseArtifacts/main.js" });
    return { completion, reads, writes };
}

test("unconfigured account keeps UID-isolated merchant history", async () => {
    const first = run({ uid: 123456789 });
    const second = run({ uid: 987654321 });
    await Promise.all([first.completion, second.completion]);
    assert.deepEqual(first.reads, ["record/123456789/records.json"]);
    assert.deepEqual(second.reads, ["record/987654321/records.json"]);
    assert.equal(first.writes.length + second.writes.length, 0);
});

test("unknown UID cannot fall back to shared account history", async () => {
    const task = run({ userName: "", uid: 0 });
    await assert.rejects(task.completion, /UID/);
    assert.deepEqual(task.reads, []);
    assert.deepEqual(task.writes, []);
});

test("explicit manual account is supported but parent path is rejected", async () => {
    const manual = run({ userName: "account-a", uid: 0 });
    await manual.completion;
    assert.deepEqual(manual.reads, ["record/account-a/records.json"]);
    const parent = run({ userName: ".." });
    await assert.rejects(parent.completion, /账户/);
    assert.deepEqual(parent.reads, []);
});
