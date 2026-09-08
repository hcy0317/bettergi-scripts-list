import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../repo/js/CD-Aware-AutoGather");

async function createRuntime({
    failPosition = false, failRoute = false, failRecovery = false, cancel = false, terminal = false,
    filter = "", exposeCancellation = true, cancelAfterRoute = false, paths, selectedRoutes = [],
} = {}) {
    const writes = new Map();
    const routes = [];
    const logs = [];
    let positionReads = 0;
    let recoveries = 0;
    let cancelled = false;
    const routePaths = paths ?? ["矿物\\虹滴晶\\01.json", "矿物\\虹滴晶\\02.json", "地方特产\\蒙德\\落落莓\\01.json",
        "食材与炼金\\甜甜花\\01.json", "食材与炼金\\薄荷\\01.json", "食材与炼金\\兽肉\\01.json"];
    const routeJson = JSON.stringify({ info: { map_name: "Teyvat" }, positions: [{ x: 0, y: 0 }] });
    const context = vm.createContext({
        settings: { runMode: "test", partyName: "采集", manualSetAccountName: "test",
            filterPathByKeywords: filter,
            selectRoute_虹滴晶: selectedRoutes,
            selectForgingOre: ["虹滴晶"], selectLocalSpecialty_蒙德: ["落落莓"] },
        console,
        log: Object.fromEntries(["info", "debug", "warn", "error"].map(level => [level, (...args) => logs.push(args.join(" "))])),
        setGameMetrics() {},
        RealtimeTimer: function () {},
        dispatcher: { addTimer() {} },
        getAvatars: () => ["钟离"],
        sleep: async () => { if (cancelled) throw new Error("用户取消"); },
        file: {
            IsExists: name => writes.has(name) || fs.existsSync(path.join(sourceRoot, name)),
            readTextSync(name) {
                if (writes.has(name)) return writes.get(name);
                return fs.readFileSync(path.join(sourceRoot, name), "utf8");
            },
            ReadPathSync: () => [],
            writeTextSync: (name, text) => writes.set(name, text),
        },
        genshin: {
            tpToStatueOfTheSeven: async () => {},
            switchParty: async () => true,
            getPositionFromMap: async () => {
                positionReads++;
                if (failPosition && positionReads === 1) throw new Error("不在主界面，无法识别小地图坐标");
                return { x: positionReads * 100, y: 0 };
            },
            returnMainUi: async () => { recoveries++; if (failRecovery) throw new Error("主界面恢复失败"); },
        },
        pathingScript: {
            ReadPathSync: prefix => routePaths.filter(name => name.startsWith(prefix + "\\")),
            IsFolder: () => false,
            get isCancellationRequested() { return exposeCancellation ? cancelled : undefined; },
            readTextSync: () => routeJson,
            runFileFromUser: async name => {
                routes.push(name);
                if (terminal) throw new Error("[BGI_COMBAT_UNCONFIRMED] 战斗仍在进行");
                if (cancel) { cancelled = true; throw new Error("用户取消"); }
                if (failRoute && routes.length === 1) throw new Error("传送失败");
                if (cancelAfterRoute) cancelled = true;
            },
        },
    });
    await vm.runInContext(fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8"), context);
    vm.runInContext("worldInfo = { coOpMode: false }; currentParty = '采集';", context);
    return {
        writes, routes, logs, get recoveries() { return recoveries; },
        runGather: () => vm.runInContext("runGatherMode()", context),
        scan: () => vm.runInContext("runScanMode()", context),
        async run() {
            await vm.runInContext(`runPathTaskIfCooldownExpired("虹滴晶", {
                current: 0, target: null,
                tasks: [{ coolType: "46小时", recordFile: "record/test.txt", refreshTime: {},
                    jsonFiles: ["矿物\\\\虹滴晶\\\\01.json", "矿物\\\\虹滴晶\\\\02.json"] }]
            })`, context);
        },
    };
}

test("a route failure followed by failed UI recovery stops before the next route", async () => {
    const runtime = await createRuntime({ failRoute: true, failRecovery: true });
    await assert.rejects(runtime.run(), /主界面恢复失败/);
    assert.equal(runtime.routes.length, 1);
    assert.equal(runtime.writes.has("record/test.txt"), false);
});

test("unfinished combat stops gathering without recovery inputs or cooldown credit", async () => {
    const runtime = await createRuntime({ terminal: true });
    await assert.rejects(runtime.run(), /BGI_COMBAT_UNCONFIRMED/);
    assert.equal(runtime.routes.length, 1);
    assert.equal(runtime.recoveries, 0);
    assert.equal(runtime.writes.has("record/test.txt"), false);
});

test("position recognition failure is isolated to its route and does not consume cooldown", async () => {
    const runtime = await createRuntime({ failPosition: true });
    await runtime.run();
    assert.deepEqual(runtime.routes, ["矿物\\虹滴晶\\02.json"]);
    assert.match(runtime.writes.get("record/test.txt"), /02\.json/);
    assert.doesNotMatch(runtime.writes.get("record/test.txt"), /01\.json/);
});

test("ordinary route failure continues later routes without recording a failed route", async () => {
    const runtime = await createRuntime({ failRoute: true });
    await runtime.run();
    assert.equal(runtime.routes.length, 2);
    assert.match(runtime.writes.get("record/test.txt"), /02\.json/);
    assert.doesNotMatch(runtime.writes.get("record/test.txt"), /01\.json/);
});

test("user cancellation is not turned into a route failure", async () => {
    const runtime = await createRuntime({ cancel: true });
    await assert.rejects(runtime.run(), /用户取消/);
    assert.equal(runtime.routes.length, 1);
    assert.equal(runtime.writes.size, 0);
});

test("cancellation also stops hosts without the optional pathing status property", async () => {
    const runtime = await createRuntime({ cancel: true, exposeCancellation: false });
    await assert.rejects(runtime.run(), /用户取消/);
    assert.equal(runtime.routes.length, 1);
    assert.equal(runtime.writes.size, 0);
});

test("cancellation after a completed route preserves its cooldown before stopping", async () => {
    const runtime = await createRuntime({ cancelAfterRoute: true, exposeCancellation: false });
    await assert.rejects(runtime.run(), error => error.name === "UserCancelled");
    assert.equal(runtime.routes.length, 1);
    assert.match(runtime.writes.get("record/test.txt"), /01\.json/);
    assert.doesNotMatch(runtime.writes.get("record/test.txt"), /02\.json/);
});

test("gather attempts later materials before reporting partial failure", async () => {
    const runtime = await createRuntime({ failRoute: true });
    await assert.rejects(runtime.runGather(), /路线.*失败/);
    assert.deepEqual(runtime.routes, ["矿物\\虹滴晶\\01.json", "矿物\\虹滴晶\\02.json", "地方特产\\蒙德\\落落莓\\01.json"]);
    assert.doesNotMatch(runtime.writes.get("record/test/矿物_虹滴晶.txt"), /01\.json/);
    assert.match(runtime.writes.get("record/test/地方特产_蒙德_落落莓.txt"), /01\.json/);
});

test("a group route filter does not shrink the shared material selection schema", async () => {
    const runtime = await createRuntime({ filter: "regex:虹滴晶" });
    await runtime.scan();
    const schema = JSON.parse(runtime.writes.get("settings.json"));
    const foods = schema.find(field => field.name === "selectFoodAndAlchemy");
    assert.deepEqual(foods?.options, ["薄荷", "兽肉", "甜甜花"]);
    await runtime.runGather();
    assert.deepEqual(runtime.routes, ["矿物\\虹滴晶\\01.json", "矿物\\虹滴晶\\02.json"]);
});

test("default route group is chosen from groups surviving the path filter", async () => {
    const runtime = await createRuntime({ filter: "include:B",
        paths: ["矿物\\虹滴晶\\A\\01.json", "矿物\\虹滴晶\\B\\02.json"] });
    await runtime.runGather();
    assert.deepEqual(runtime.routes, ["矿物\\虹滴晶\\B\\02.json"]);
    const schema = JSON.parse(runtime.writes.get("settings.json"));
    assert.deepEqual(schema.find(field => field.name === "selectRoute_虹滴晶").options, ["A", "B"]);
});

test("an explicitly selected excluded group is not replaced by an unselected one", async () => {
    const runtime = await createRuntime({ filter: "include:B", selectedRoutes: ["A"],
        paths: ["矿物\\虹滴晶\\A\\01.json", "矿物\\虹滴晶\\B\\02.json"] });
    await runtime.runGather();
    assert.deepEqual(runtime.routes, []);
});

test("default group order is unchanged without a path filter", async () => {
    const runtime = await createRuntime({
        paths: ["矿物\\虹滴晶\\A\\01.json", "矿物\\虹滴晶\\B\\02.json"] });
    await runtime.runGather();
    assert.deepEqual(runtime.routes, ["矿物\\虹滴晶\\A\\01.json"]);
});
