import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../repo/js/AutoPlan");
const config = () => ({
    bgi_tools: { api: { httpPullJsonConfig: "http://local/auto/plan/json" }, token: {} },
    user: { uid: "test" }, run: {},
});

async function createRuntime({ scan, targets, observationStatus = "REPLANNING",
    nextActions = [], craft, returnMain, bench, resinVisible = false, boss } = {}) {
    const logs = [], scans = [], submissions = [], events = [], claims = [];
    const actions = [...nextActions];
    let now = 0, crafts = 0;
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const restoreMain = async () => { events.push("main"); if (returnMain) await returnMain(crafts); };
    const imageResult = ro => {
        const exists = String(ro?.image?.name).includes("paimon") || resinVisible;
        return { isExist: () => exists, isEmpty: () => !exists, text: "0/200", x: 1500, y: 30, width: 40, height: 40,
            click() {}, Click() {}, dispose() {} };
    };
    const readImage = name => ({ name });
    const ocr = () => ({ kind: "ocr" });
    const context = vm.createContext({
        console, settings: {}, Date: ClockDate,
        sleep: async ms => { now += ms; },
        keyPress: async key => { events.push("key:" + key); }, click() {},
        Pen: class {}, Color: { Red: "red", RoyalBlue: "blue" },
        AutoBossParam: class {}, CountInventoryItemParam: class {},
        GridScreenName: { CharacterDevelopmentItems: "CharacterDevelopmentItems" },
        ItemIconRecognitionMode: { Item: "Item" },
        captureGameRegion: () => ({ width: 1920, height: 1080,
            find: imageResult, findMulti: () => resinVisible ? [{ text: "0/200" }] : [], dispose() {} }),
        genshin: {
            returnMainUi: restoreMain, ReturnMainUi: restoreMain, setBigMapZoomLevel: async () => {},
            tpToStatueOfTheSeven: async () => { events.push("statue"); },
            GoToCraftingBench: async country => { events.push("bench"); if (bench) await bench(country); },
            CraftMaterial: async (name, quantity) => {
                crafts++; events.push("craft:" + name);
                return craft ? craft(name, quantity) : { ActualQuantity: quantity };
            },
        },
        log: Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level, (message, ...args) =>
            logs.push(String(message).replace(/\{(\d+)\}/g, (_, index) => String(args[index])))])),
        RecognitionObject: { TemplateMatch: image => ({ image }), Ocr: ocr, ocr },
        file: { ReadImageMatSync: readImage, readImageMatSync: readImage },
        SoloTask: class { constructor(name, param) { this.name = name; this.param = param; } },
        dispatcher: {
            async RunAutoBossTask() { events.push("boss"); return boss ? boss() : { "蕈王钩喙": 1 }; },
            async RunCountInventoryItemTask(param) { scans.push({ single: param.ItemName }); return 10; },
            async runTask(task) {
            scans.push(task.param);
            return scan ? scan(task.param, scans.length) :
                task.param.iconRecognitionMode === "Item" ? { "霜仙花": 164 } : {};
        }},
        http: { async request(method, url, body) {
            if (url.includes("inventory-reconcile-targets")) return { status_code: 200, body: JSON.stringify({
                code: 200, data: targets ?? { status: "ACTION", actionId: "inventory-1", revision: 1,
                    materialNames: ["霜仙花"], materialNamesByGrid: { Materials: ["霜仙花"] } },
            }) };
            if (url.includes("inventory-observations")) {
                submissions.push(JSON.parse(body));
                return { status_code: 200, body: JSON.stringify({ code: 200,
                    data: { status: observationStatus, observedCount: 1, message: "reported" } }) };
            }
            if (url.includes("next-action")) {
                claims.push(url);
                return { status_code: 200, body: JSON.stringify({ code: 200, data: actions.shift() ?? { status: "DONE" } }) };
            }
            if (url.includes("/actions/")) {
                submissions.push(JSON.parse(body));
                return { status_code: 200, body: JSON.stringify({ code: 200, data: { status: "REPLANNING" } }) };
            }
            throw new Error("unexpected request: " + url);
        }},
    });
    const modules = new Map();
    function load(filename) {
        if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
            identifier: filename, context,
        }));
        return modules.get(filename);
    }
    const entryPath = process.env.AUTO_PLAN_TEST_SOURCE || path.join(root, "utils/cultivation_plan.js");
    const entry = load(entryPath);
    await entry.link((specifier, parent) => load(path.resolve(
        parent.identifier === entryPath ? path.join(root, "utils") : path.dirname(parent.identifier), specifier + ".js")));
    await entry.evaluate();
    return { logs, scans, submissions, events, claims,
        reconcile: () => entry.namespace.runCultivationInventoryReconcile(config()),
        run: () => entry.namespace.runPlanDrivenCultivation(config()),
        physical: modules.get(path.join(root, "utils/physical.js")).namespace.Physical };
}

test("Materials requests use ItemV2 directly and report the final frost flower count", async () => {
    const runtime = await createRuntime();
    assert.equal(await runtime.reconcile(), true);
    assert.deepEqual(runtime.scans.map(scan => scan.iconRecognitionMode), ["Item"]);
    assert.deepEqual(runtime.scans.map(scan => scan.gridScreenName), ["Materials"]);
    assert.equal(runtime.submissions[0].observedOwned["霜仙花"], 164);
    assert(runtime.logs.some(line => /最终.*霜仙花=164/.test(line)));
});

test("missing or null counts remain unknown after exactly one retry, never zero", async () => {
    const runtime = await createRuntime({ scan: () => ({ "霜仙花": null }) });
    await runtime.reconcile();
    assert.equal(runtime.scans.length, 2);
    assert.equal(runtime.submissions[0].observedOwned["霜仙花"], -1);
    assert(runtime.logs.some(line => /最终仍未知.*霜仙花/.test(line)));
});

test("HTTP success with unresolved inventory does not release the next crafting batch", async () => {
    const runtime = await createRuntime({ observationStatus: "NEEDS_RECONCILE" });
    assert.equal(await runtime.reconcile(), false);
});

test("only the explicit NO_TARGETS status may complete an empty reconciliation", async () => {
    for (const status of ["NO_PLAN", "BUSY", "ERROR"]) {
        const runtime = await createRuntime({ targets: { status, materialNames: [] } });
        assert.equal(await runtime.reconcile(), false, status);
        assert.equal(runtime.scans.length, 0);
    }
    const runtime = await createRuntime({ targets: { status: "NO_TARGETS", materialNames: [] } });
    assert.equal(await runtime.reconcile(), true);
});

const batch = { status: "ACTION", actionType: "CRAFT_BATCH", actionId: "craft-1", revision: 1, craftCountry: "蒙德",
    craftActions: [{ materialName: "缺料项", quantity: 2 }, { materialName: "可合成项", quantity: 1 }] };

test("a failed craft reestablishes the crafting page before the next item", async () => {
    const runtime = await createRuntime({ nextActions: [batch],
        craft: name => { if (name === "缺料项") throw new Error("材料不足"); return { ActualQuantity: 1 }; } });
    await runtime.run();
    const start = runtime.events.indexOf("craft:缺料项");
    assert.deepEqual(runtime.events.slice(start, start + 5), ["craft:缺料项", "main", "bench", "craft:可合成项", "main"]);
});

test("failure to exit the crafting page stops instead of scanning inventory on the wrong page", async () => {
    const runtime = await createRuntime({ nextActions: [batch],
        returnMain: count => { if (count > 0) throw new Error("合成页没有关闭"); } });
    await assert.rejects(runtime.run(), /合成页没有关闭/);
    assert.equal(runtime.scans.length, 1);
});

test("terminal combat or cancellation during a batch does not send recovery or later game inputs", async () => {
    for (const message of ["[BGI_COMBAT_UNCONFIRMED] 未结束", "用户取消"]) {
        const runtime = await createRuntime({ nextActions: [batch], craft: () => { throw new Error(message); } });
        await assert.rejects(runtime.run(), new RegExp(message.includes("BGI") ? "BGI_COMBAT_UNCONFIRMED" : "用户取消"));
        assert.deepEqual(runtime.events.slice(runtime.events.indexOf("craft:缺料项")), ["craft:缺料项"]);
        assert.equal(runtime.scans.length, 1);
    }
});

test("missing resin icons stay unknown and do not send a false zero-resin snapshot", async () => {
    const runtime = await createRuntime();
    assert.equal(await runtime.physical.countOriginalResinBackup(), -1);
    assert.equal(await runtime.physical.countCondensedResin(), -1);
    await runtime.run();
    assert.doesNotMatch(runtime.claims[0], /originalResinCount|condensedResinCount/);
    assert(runtime.logs.some(line => line.includes("树脂快照含未知值")));
});

test("an explicitly recognized zero resin count remains zero", async () => {
    const runtime = await createRuntime({ resinVisible: true });
    await runtime.run();
    assert.match(runtime.claims[0], /originalResinCount=0/, runtime.logs.filter(line => line.includes("树脂快照")).join("\n"));
    assert.match(runtime.claims[0], /condensedResinCount=0/);
});

const bossAction = { status: "ACTION", actionType: "WORLD_BOSS", actionId: "boss-1", revision: 1,
    materialName: "蕈王钩喙", reconcileGrid: "CharacterDevelopmentItems", batchLimit: 1,
    plan: { runType: "Boss", autoBoss: { bossName: "翠翎恐蕈", combatStrategyPath: "", reviveRetryCount: 3 } } };

test("a terminal boss exit does not teleport in finally or open inventory afterward", async () => {
    const runtime = await createRuntime({ nextActions: [bossAction],
        boss: () => { throw new Error("[BGI_COMBAT_UNCONFIRMED] 不执行复活重试"); } });
    await assert.rejects(runtime.run(), /BGI_COMBAT_UNCONFIRMED/);
    assert.deepEqual(runtime.events.slice(runtime.events.indexOf("boss")), ["boss"]);
    assert.equal(runtime.scans.length, 1);
});

test("the boss adapter returns actual native rewards to the plan result", async () => {
    const runtime = await createRuntime({ nextActions: [bossAction] });
    await runtime.run();
    const result = runtime.submissions.find(body => body.idempotencyKey === "boss-1:result");
    assert.deepEqual(result.rewards, { "蕈王钩喙": 1 });
    assert.equal(result.succeeded, true);
});

test("terminal inventory scan errors propagate without another scan or a success report", async () => {
    const runtime = await createRuntime({ scan: () => { throw new Error("[BGI_COMBAT_UNCONFIRMED] stop"); } });
    await assert.rejects(runtime.reconcile(), /BGI_COMBAT_UNCONFIRMED/);
    assert.equal(runtime.scans.length, 1);
    assert.equal(runtime.submissions.length, 0);
});

test("legitimate progress can continue through eight crafting batches", async () => {
    const nextActions = Array.from({ length: 8 }, (_, index) => ({ ...batch, actionId: "craft-" + index,
        craftActions: [{ materialName: "可合成项", quantity: 1 }] }));
    const runtime = await createRuntime({ nextActions });
    await runtime.run();
    assert.equal(runtime.events.filter(event => event === "craft:可合成项").length, 8);
    assert.equal(runtime.claims.length, 9);
    assert.equal(runtime.submissions.filter(body => body.terminationReason === "CRAFT_BATCH_COMPLETED").length, 8);
});

test("failed page recovery aborts the batch without another craft or repeated recovery", async () => {
    const runtime = await createRuntime({ nextActions: [batch],
        craft: () => { throw new Error("材料不足"); },
        returnMain: count => { if (count) throw new Error("恢复合成页失败"); } });
    await assert.rejects(runtime.run(), /恢复合成页失败/);
    assert.deepEqual(runtime.events.slice(runtime.events.indexOf("craft:缺料项")), ["craft:缺料项", "main"]);
    assert.equal(runtime.scans.length, 1);
});
