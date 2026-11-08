import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../repo/js/AutoPlan");
const dummyUid = "123456789";
const config = (uid = dummyUid) => ({
    bgi_tools: { api: { httpPullJsonConfig: "http://local/auto/plan/json" }, token: {} },
    user: { uid }, run: {},
});

async function createRuntime({ scan, targets, observationStatus = "REPLANNING",
    nextActions = [], craft, returnMain, bench, resinVisible = false, boss, outcomeApi = true, mapResinBridge, captureFrame, userUid = dummyUid, configFirst = false } = {}) {
    const logs = [], scans = [], submissions = [], events = [], claims = [], outcomes = [], requests = [];
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
        console, settings: configFirst ? {cultivation_plan_mode: true, key: "current-revision",
            bgi_tools_http_pull_json_config: "http://local/auto/plan/json"} : {}, Date: ClockDate,
        taskResult: outcomeApi ? { requireExplicitOutcome() {}, check() {}, report(kind, reason) { outcomes.push({kind, reason}); } } : undefined,
        sleep: async ms => { now += ms; },
        keyPress: async key => { events.push("key:" + key); }, click() {},
        Pen: class {}, Color: { Red: "red", RoyalBlue: "blue" },
        AutoBossParam: class {}, CountInventoryItemParam: class {},
        AutoDomainParam: class { SetResinPriorityList() {} },
        GridScreenName: { CharacterDevelopmentItems: "CharacterDevelopmentItems" },
        ItemIconRecognitionMode: { Item: "Item" },
        captureGameRegion: captureFrame ? () => captureFrame({ imageResult, events }) : (() => ({ width: 1920, height: 1080,
            find: imageResult, findMulti: () => resinVisible ? [{ text: "0/200" }] : [], dispose() {} })),
        genshin: {
            ...(configFirst ? {uid: async () => { events.push("uid"); return Number(dummyUid); }} : {}),
            returnMainUi: restoreMain, ReturnMainUi: restoreMain, setBigMapZoomLevel: async () => {},
            exitDomain: async () => { events.push("exit-domain"); },
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
        file: { ReadImageMatSync: readImage, readImageMatSync: readImage,
            ...(configFirst ? {readTextSync(name) {
                if (name === "manifest.json") return JSON.stringify({name: "fixture", version: "0.1.4",
                    key: "current-revision", last_key: "previous-revision", settings_ui: "settings.json", authors: [{name: "fixture"}]});
                if (name === "settings.json") return "[]";
                throw new Error("unexpected configuration IO: " + name);
            }} : {}) },
        SoloTask: class { constructor(name, param) { this.name = name; this.param = param; } },
        dispatcher: {
            ...(mapResinBridge ? { readMapResin: mapResinBridge } : {}),
            async RunAutoDomainTask() { events.push("domain"); return {"霜仙花": 1}; },
            async RunAutoBossTask() { events.push("boss"); return boss ? boss() : { "蕈王钩喙": 1 }; },
            async RunCountInventoryItemTask(param) { scans.push({ single: param.ItemName }); return 10; },
            async runTask(task) {
            scans.push(task.param);
            return scan ? scan(task.param, scans.length) :
                task.param.iconRecognitionMode === "Item" ? { "霜仙花": 164 } : {};
        }},
        http: { async request(method, url, body) {
            requests.push({method, url, body});
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
    function resolveModule(specifier, parent) {
        const filename = specifier.endsWith(".js") ? specifier : specifier + ".js";
        return load(path.resolve(parent.identifier === entryPath ? path.join(root, "utils") : path.dirname(parent.identifier), filename));
    }
    function load(filename) {
        if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
            identifier: filename, context,
        }));
        return modules.get(filename);
    }
    const entryPath = process.env.AUTO_PLAN_TEST_SOURCE || path.join(root, "utils/cultivation_plan.js");
    const entry = load(entryPath);
    const linkRoot = configFirst ? load(path.join(root, "config/config.js")) : entry;
    await linkRoot.link(resolveModule);
    await linkRoot.evaluate();
    if (configFirst) {
        await linkRoot.namespace.buildInitConfigSettings();
        await linkRoot.namespace.initSettings();
        await linkRoot.namespace.initConfig();
    }
    return { logs, scans, submissions, events, claims, outcomes, requests, moduleGraph: modules, linkRoot,
        reconcile: () => entry.namespace.runCultivationInventoryReconcile(config(userUid)),
        run: () => entry.namespace.runPlanDrivenCultivation(config(userUid)),
        physical: modules.get(path.join(root, "utils/physical.js")).namespace.Physical,
        handlers: modules.get(path.join(root, "utils/load_check_run.js")).namespace.taskHandlerMap };
}

test("actual static config initialization evaluates shared task identities and the real handler graph", async () => {
    const runtime = await createRuntime({configFirst: true});
    const configModule = runtime.moduleGraph.get(path.join(root, "config/config.js"));
    const planModule = runtime.moduleGraph.get(path.join(root, "utils/cultivation_plan.js"));
    const handlersModule = runtime.moduleGraph.get(path.join(root, "utils/load_check_run.js"));
    const taskTypesModule = runtime.moduleGraph.get(path.join(root, "config/task_types.js"));
    assert.equal(runtime.linkRoot, configModule, "start with the actual config, not a plan-first shortcut");
    for (const module of [configModule, planModule, handlersModule, taskTypesModule]) {
        assert(module instanceof vm.SourceTextModule, "every cycle participant must be actual repository source");
        assert.equal(module.status, "evaluated");
    }
    assert(configModule.dependencySpecifiers.includes("../utils/cultivation_plan"));
    assert(configModule.dependencySpecifiers.includes("./task_types"));
    assert(handlersModule.dependencySpecifiers.includes("../config/task_types"));
    assert(runtime.events.includes("uid"), "the actual native UID adapter must run during initialization");
    assert(planModule.dependencySpecifiers.includes("./load_check_run"));
    assert(handlersModule.dependencySpecifiers.includes("../config/config"));
    assert.equal(typeof planModule.namespace.requireCanonicalUid, "function");
    const actualConfig = configModule.namespace.config;
    const expectedTypes = ["秘境", "地脉", "幽境", "Boss"];
    const defaults = taskTypesModule.namespace.DEFAULT_RUN_TYPES;
    assert.deepEqual(Array.from(defaults), expectedTypes);
    assert(Object.isFrozen(defaults));
    assert.notEqual(actualConfig.user.runTypes, defaults, "config must own its mutable copy");
    assert.equal(Object.isFrozen(actualConfig.user.runTypes), false);
    assert.deepEqual(Array.from(actualConfig.user.runTypes), expectedTypes);
    actualConfig.user.runTypes.push("mutable-fixture");
    assert.equal(actualConfig.user.runTypes.pop(), "mutable-fixture");
    assert.deepEqual(Array.from(defaults), expectedTypes);
    const handlers = handlersModule.namespace.taskHandlerMap;
    assert.deepEqual(Object.keys(handlers), expectedTypes);
    assert.deepEqual(expectedTypes.map(type => handlers[type].target),
        ["autoDomain", "autoLeyLineOutcrop", "autoStygianOnslaught", "autoBoss"]);
    for (const type of expectedTypes) for (const member of ["build", "buildKey", "run"])
        assert.equal(typeof handlers[type][member], "function");
    assert.equal(String(actualConfig.user.uid), dummyUid);
    assert.equal(actualConfig.path.record, "record/" + dummyUid + ".json");
    actualConfig.user.uid = Number(dummyUid);
    actualConfig.bgi_tools.api.httpPullJsonConfig = "http://local/auto/plan/json";
    await planModule.namespace.runCultivationInventoryReconcile(actualConfig);
    await planModule.namespace.runPlanDrivenCultivation(actualConfig);
    assert(runtime.requests.some(request => request.url.includes("inventory-reconcile-targets")));
    assert(runtime.requests.some(request => request.url.includes("next-action")));
    for (const request of runtime.requests) {
        if (request.url.includes("inventory-reconcile-targets") || request.url.includes("next-action"))
            assert.equal(new URL(request.url).searchParams.get("uid"), dummyUid);
    }
    assert(runtime.outcomes.every(result => result.kind !== "Failed"));
});

for (const entry of ["reconcile", "run"]) {
    test("actual " + entry + " entry rejects invalid UID before serializing any API request", async () => {
        for (const uid of [0, false, {}, {toString: () => dummyUid}, "uid-" + dummyUid]) {
            const runtime = await createRuntime({userUid: uid});
            assert.equal(typeof runtime[entry], "function", "the existing real module entry must be loaded");
            let failure;
            try { await runtime[entry](); } catch (error) { failure = error; }
            assert.equal(runtime.requests.length, 0, "invalid UID must not reach the real request boundary");
            assert(failure, "invalid UID must reject the managed invocation");
            assert.match(String(failure.message), /UID|账号|未确认/i);
            assert.equal(runtime.outcomes.length, 1);
            assert.equal(runtime.outcomes[0].kind, "Failed");
            assert.equal(runtime.scans.length, 0);
            assert.equal(runtime.claims.length, 0);
        }
    });
}

test("canonical integer and string UIDs retain their exact query identity in both real entries", async () => {
    for (const uid of [Number(dummyUid), dummyUid]) for (const entry of ["reconcile", "run"]) {
        const runtime = await createRuntime({userUid: uid});
        await runtime[entry]();
        const targets = runtime.requests.filter(request => request.url.includes("inventory-reconcile-targets"));
        assert(targets.length > 0, "the positive control must reach the real inventory request");
        for (const request of runtime.requests) {
            if (request.url.includes("inventory-reconcile-targets") || request.url.includes("next-action"))
                assert.equal(new URL(request.url).searchParams.get("uid"), dummyUid);
        }
        if (entry === "run") assert(runtime.claims.length > 0, "the positive plan control must reach next-action");
        assert.equal(runtime.outcomes.length, 1);
        assert.notEqual(runtime.outcomes[0].kind, "Failed");
    }
});

test("managed BUSY cannot be reported as a completed script", async () => {
    const runtime = await createRuntime({nextActions: [{status: "BUSY", message: "lease held"}]});
    await runtime.run();
    assert.equal(runtime.outcomes.length, 1);
    assert.equal(runtime.outcomes[0].kind, "Deferred");
    assert(!runtime.events.includes("key:M"), "BUSY must not start a resin map scan");
    assert(runtime.claims[0].includes("prepareOnly=true"));
});

test("old action reconciliation does not require a resin snapshot first", async () => {
    const runtime = await createRuntime({nextActions: [
        {status: "NEEDS_RECONCILE", actionId: "old", revision: 1, materialName: "霜仙花"},
        {status: "COMPLETED"},
    ]});
    await runtime.run();
    assert(!runtime.events.includes("key:M"));
    assert.equal(runtime.submissions.filter(x => x.idempotencyKey === "old:result").length, 1);
});

for (const [status, kind] of [["COMPLETED", "Completed"], ["NO_PLAN", "Skipped"],
    ["NO_TARGETS", "Skipped"], ["WAITING", "Deferred"], ["UNKNOWN_STATUS", "NeedsReconcile"]]) {
    test(`managed terminal ${status} preserves ${kind}`, async () => {
        const runtime = await createRuntime({nextActions: [{status}]});
        await runtime.run();
        assert.equal(runtime.outcomes.length, 1);
        assert.equal(runtime.outcomes[0].kind, kind);
    });
}

test("COMPLETED with an unresolved final inventory is not completion", async () => {
    const runtime = await createRuntime({nextActions: [{status: "COMPLETED"}], observationStatus: "NEEDS_RECONCILE"});
    await runtime.run();
    assert.equal(runtime.outcomes[0].kind, "NeedsReconcile");
    assert.match(runtime.outcomes[0].reason, /FINAL_INVENTORY_UNRESOLVED/);
});

test("an old host without the result protocol stops before game or HTTP work", async () => {
    const runtime = await createRuntime({outcomeApi: false});
    await assert.rejects(runtime.run(), /BGI_TASK_OUTCOME_UNSUPPORTED/);
    assert.deepEqual(runtime.events, []);
    assert.deepEqual(runtime.claims, []);
    assert.deepEqual(runtime.scans, []);
});

test("NO_TARGETS reconciliation is a skip, although its legacy boolean is true", async () => {
    const runtime = await createRuntime({targets: {status: "NO_TARGETS"}});
    assert.equal(await runtime.reconcile(), true);
    assert.equal(runtime.outcomes[0].kind, "Skipped");
});

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
    for (const message of ["[BGI_COMBAT_UNCONFIRMED] 未结束", "[BGI_TASK_CANCELLED] 用户取消"]) {
        const runtime = await createRuntime({ nextActions: [batch], craft: () => { throw new Error(message); } });
        await assert.rejects(runtime.run(), new RegExp(message.includes("COMBAT") ? "BGI_COMBAT_UNCONFIRMED" : "BGI_TASK_CANCELLED"));
        assert.deepEqual(runtime.events.slice(runtime.events.indexOf("craft:缺料项")), ["craft:缺料项"]);
        assert.equal(runtime.scans.length, 1);
    }
});

test("missing resin icons stay unknown and do not send a false zero-resin snapshot", async () => {
    const runtime = await createRuntime({nextActions: [{status: "NEEDS_RESIN_SNAPSHOT"}, {status: "WAITING"}]});
    assert.equal(await runtime.physical.countOriginalResinBackup(), -1);
    assert.equal(await runtime.physical.countCondensedResin(), -1);
    await runtime.run();
    assert.equal(runtime.claims.length, 2);
    assert(runtime.claims[0].includes("prepareOnly=true"));
    assert.doesNotMatch(runtime.claims[1], /originalResinCount|condensedResinCount/);
    assert(runtime.logs.some(line => line.includes("树脂快照含未知值")));
});

test("an explicitly recognized zero resin count remains zero", async () => {
    const runtime = await createRuntime({ resinVisible: true,
        scan: () => ({ "须臾树脂": 0, "脆弱树脂": 0 }),
        nextActions: [{status: "NEEDS_RESIN_SNAPSHOT"}, {status: "WAITING"}] });
    await runtime.run();
    assert.equal(runtime.claims.length, 2);
    assert.doesNotMatch(runtime.claims[0], /originalResinCount/);
    assert.match(runtime.claims[1], /originalResinCount=0/, runtime.logs.filter(line => line.includes("树脂快照")).join("\n"));
    assert.match(runtime.claims[1], /condensedResinCount=0/);
});

test("resin snapshot reads consumables from the inventory, never the map replenishment pane", async () => {
    const runtime = await createRuntime({ scan: () => ({ "须臾树脂": 2, "脆弱树脂": 37 }) });
    const physical = runtime.physical;
    physical.countOriginalResin = async () => { throw new Error("obsolete map OCR"); };
    physical.countOriginalResinBackup = async () => 120;
    physical.countCondensedResin = async () => 3;
    physical.openReplenishResinUi = async () => { throw new Error("wrong page"); };
    const snapshot = await physical.countAllResin();
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
        originalResinCount: 120, condensedResinCount: 3,
        transientResinCount: 2, fragileResinCount: 37,
    });
    assert.equal(runtime.scans.length, 1);
    assert.equal(runtime.scans[0].gridScreenName, "PreciousItems");
    assert.deepEqual(Array.from(runtime.scans[0].itemNames), ["须臾树脂", "脆弱树脂"]);
    assert.equal(runtime.scans[0].iconRecognitionMode, "Item");
});

test("actual physical preserves new-host observations without changing absent-provenance snapshot shape", async () => {
    // These Node host mocks test JS ownership/envelopes, not CLR source-stamp validation.
    for (const state of ["known", "unknown", "no-observation"]) {
        const captures = [];
        const observation = state === "no-observation" ? null : {
            schema: "bgi.map-resin.v1",
            original: { known: state === "known", count: state === "known" ? 120 : null },
            condensed: { known: true, count: 3 }, sourceBefore: null, sourceAfter: null,
            inputAuthorized: false,
        };
        let ownedFrame, bridgeCalls = 0, rowsDisposed = 0, arraysDisposed = 0;
        const runtime = await createRuntime({
            scan: () => ({ "须臾树脂": 2, "脆弱树脂": 37 }),
            captureFrame: ({ imageResult, events }) => {
                let scene = "main";
                for (const event of events) {
                    if (event === "key:M") scene = "map";
                    if (event === "main") scene = "main";
                }
                const stamp = { fixture: "capture", sequence: captures.length + 1, scene };
                const frame = { width: 1920, height: 1080, frameStamp: stamp, scene,
                    disposed: 0, icons: [], mainChecks: [],
                    find(ro) {
                        const base = imageResult(ro);
                        const name = String(ro?.image?.name).toLowerCase();
                        const paimon = name.includes("paimon");
                        const resin = name.endsWith("original_resin.png") || name.endsWith("condensed_resin.png");
                        const exists = (paimon && scene === "main") || (resin && scene === "map");
                        const result = { ...base, disposed: 0, isExist: () => exists, isEmpty: () => !exists,
                            dispose() { this.disposed++; } };
                        if (paimon) frame.mainChecks.push(exists);
                        if (resin) frame.icons.push(result);
                        return result;
                    }, findMulti: () => [], dispose() { this.disposed++; } };
                captures.push(frame);
                return frame;
            },
            mapResinBridge: (frame, rois, readText) => {
                bridgeCalls++;
                ownedFrame = frame;
                assert.equal(frame.scene, "map");
                assert(runtime.events.includes("key:M"), "the actual openMap must prepare the map UI");
                const prelude = captures.find(candidate => candidate !== frame && candidate.scene === "main" && candidate.mainChecks.includes(true));
                assert(prelude, "the actual toMainUi must confirm a main frame before map reading");
                assert.equal(prelude.disposed, 1);
                assert.notEqual(prelude.frameStamp, frame.frameStamp);
                assert.equal(frame.disposed, 0);
                assert(rois.original && rois.condensed);
                assert(frame.icons.every(icon => icon.isExist() && !icon.isEmpty()));
                if (!observation) return null;
                observation.sourceBefore = frame.frameStamp;
                observation.sourceAfter = frame.frameStamp;
                for (const kind of ["original", "condensed"]) {
                    const texts = kind === "original" ? (state === "known" ? ["120", "/", "200"] : []) : ["3"];
                    const rows = texts.map(text => ({ text, dispose() { rowsDisposed++; } }));
                    rows.dispose = () => { arraysDisposed++; };
                    const result = readText({ width: rois[kind].width, height: rois[kind].height,
                        frameStamp: frame.frameStamp, findMulti: () => rows }, kind);
                    assert.equal(result.source, frame.frameStamp);
                    assert.deepEqual(Array.from(result.texts), texts);
                }
                return observation;
            },
        });
        runtime.physical.countOriginalResinBackup = async () => { throw new Error("new host must not recapture using legacy OCR"); };
        runtime.physical.countCondensedResin = async () => { throw new Error("new host must not enter legacy condensed fallback"); };
        const snapshot = await runtime.physical.countAllResin();
        const expected = { originalResinCount: state === "known" ? 120 : -1,
            condensedResinCount: observation ? 3 : -1, transientResinCount: 2, fragileResinCount: 37 };
        if (observation) expected.mapResinObservation = observation;
        assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), expected);
        assert.equal(Object.hasOwn(snapshot, "mapResinObservation"), observation !== null);
        if (observation) assert.equal(snapshot.mapResinObservation, observation);
        assert.equal(bridgeCalls, 1);
        // UI preparation/recovery has its own captures; only the resin helper owns this one.
        assert.equal(captures.filter(frame => frame.icons.length !== 0).length, 1);
        const afterOwned = captures.filter(frame => frame.frameStamp.sequence > ownedFrame.frameStamp.sequence);
        assert(afterOwned.some(frame => frame.scene === "map" && frame.mainChecks.includes(false)));
        assert(afterOwned.some(frame => frame.scene === "main" && frame.mainChecks.includes(true)));
        assert(captures.every(frame => frame.disposed === 1));
        assert.equal(ownedFrame.disposed, 1);
        assert.equal(ownedFrame.icons.length, 2);
        assert(ownedFrame.icons.every(icon => icon.disposed === 1));
        assert.equal(arraysDisposed, observation ? 2 : 0);
        assert.equal(rowsDisposed, state === "known" ? 4 : state === "unknown" ? 1 : 0);
        assert.equal(runtime.scans.length, 1);
        assert.equal(runtime.scans[0].gridScreenName, "PreciousItems");
    }
});

test("actual physical helper rethrows bridge code errors and still releases its owned frame", async () => {
    const failure = new Error("map-resin bridge code failed");
    let captured = 0, ownedFrame;
    const runtime = await createRuntime({
        captureFrame: () => {
            captured++;
            const frame = { width: 1920, height: 1080, disposed: 0, icons: [],
                find() {
                    const icon = { x: 1500, y: 30, disposed: 0, isExist: () => true,
                        dispose() { this.disposed++; } };
                    frame.icons.push(icon);
                    return icon;
                }, dispose() { this.disposed++; } };
            return frame;
        },
        mapResinBridge: frame => { ownedFrame = frame; throw failure; },
    });
    const before = captured;
    assert.throws(() => runtime.physical.readMapResinFromCurrentFrame(), error => error === failure);
    assert.equal(captured, before + 1);
    assert.equal(ownedFrame.disposed, 1);
    assert.equal(ownedFrame.icons.length, 2);
    assert(ownedFrame.icons.every(icon => icon.disposed === 1));
});

test("missing or invalid inventory resin quantities remain unknown", async () => {
    const runtime = await createRuntime({ scan: () => ({ "脆弱树脂": -2 }) });
    runtime.physical.countOriginalResinBackup = async () => 120;
    runtime.physical.countCondensedResin = async () => 3;
    const snapshot = await runtime.physical.countAllResin();
    assert.equal(snapshot.transientResinCount, -1);
    assert.equal(snapshot.fragileResinCount, -1);
});

test("verified native inventory evidence carries confirmed absence without inventing missing zeroes", async () => {
    for (const coverageComplete of [true, false]) {
        const runtime = await createRuntime({scan: () => ({schema: "bgi.inventory-count.v1",
            counts: {"脆弱树脂": 38, "须臾树脂": coverageComplete ? 0 : -1}, coverageComplete,
            reason: coverageComplete ? "verified-top-to-bottom" : "page-overlap-not-unique"})});
        runtime.physical.countOriginalResinBackup = async () => 120;
        runtime.physical.countCondensedResin = async () => 3;
        const result = await runtime.physical.countAllResin();
        assert.equal(result.fragileResinCount, 38);
        assert.equal(result.transientResinCount, coverageComplete ? 0 : -1);
        assert.equal(runtime.scans[0].includeScanEvidence, true);
    }
});

test("a resin snapshot belongs only to the immediately claimed action", async () => {
    const action = { status: "ACTION", actionType: "DOMAIN", actionId: "domain-1", revision: 1,
        materialName: "霜仙花", plan: { runType: "秘境", autoDomain: {} } };
    const runtime = await createRuntime({nextActions: [
        {status: "NEEDS_RESIN_SNAPSHOT"}, action, {...action, actionId: "domain-2"}, {status: "DONE"},
    ]});
    const snapshot = {originalResinCount: 120, condensedResinCount: 3, transientResinCount: 2, fragileResinCount: 37};
    let scans = 0;
    runtime.physical.countAllResin = async () => { scans++; return snapshot; };
    const received = [];
    runtime.handlers["秘境"].run = async (_, context) => { received.push(context); return {"霜仙花": 1}; };
    await runtime.run();
    assert.equal(scans, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(received[0].resinSnapshot)), snapshot);
    assert.equal(received[1].resinSnapshot, null);
    assert.doesNotMatch(runtime.claims[2], /originalResinCount/);
});

test("the real domain handler consumes a provided snapshot without another scan", async () => {
    const runtime = await createRuntime();
    runtime.physical.countAllResin = async () => { throw new Error("duplicate scan"); };
    await runtime.handlers["秘境"].run({}, {resinSnapshot: {
        originalResinCount: 120, condensedResinCount: 0, transientResinCount: -1, fragileResinCount: -1,
    }});
    assert.equal(runtime.events.filter(value => value === "domain").length, 1);
});

test("unknown selected resin cannot be reported as insufficient inventory", async () => {
    const runtime = await createRuntime();
    await assert.rejects(runtime.handlers["秘境"].run({}, {resinSnapshot: {
        originalResinCount: -1, condensedResinCount: 0, transientResinCount: -1, fragileResinCount: -1,
    }}), /树脂数量未确认/);
    assert(!runtime.events.includes("domain"));
});

test("an ordinary resin scan failure is not immediately retried by the claimed domain", async () => {
    const runtime = await createRuntime({nextActions: [
        {status: "NEEDS_RESIN_SNAPSHOT"},
        {status: "ACTION", actionType: "DOMAIN", actionId: "domain-failure", revision: 1,
            materialName: "霜仙花", plan: {runType: "秘境", autoDomain: {}}},
    ]});
    let scans = 0;
    runtime.physical.countAllResin = async () => { scans++; throw new Error("inventory interface unavailable"); };
    await assert.rejects(runtime.run(), /树脂数量未确认/);
    assert.equal(scans, 1);
    assert.doesNotMatch(runtime.claims[1], /originalResinCount/);
    assert(!runtime.events.includes("domain"));
});

test("inventory cancellation does not reopen the map or run final recovery", async () => {
    let eventsBeforeCancellation;
    const runtime = await createRuntime({resinVisible: true, scan: () => {
        eventsBeforeCancellation = runtime.events.length;
        throw new Error("OperationCanceledException");
    }});
    await assert.rejects(runtime.physical.countAllResin(), /OperationCanceledException/);
    assert.equal(runtime.scans.length, 1);
    assert.equal(runtime.events.filter(event => event === "key:M").length, 1);
    assert.equal(runtime.events.length, eventsBeforeCancellation);
});

const bossAction = { status: "ACTION", actionType: "WORLD_BOSS", actionId: "boss-1", revision: 1,
    materialName: "蕈王钩喙", reconcileGrid: "CharacterDevelopmentItems", batchLimit: 1,
    plan: { runType: "Boss", autoBoss: { bossName: "翠翎恐蕈", combatStrategyPath: "", reviveRetryCount: 3 } } };

test("new completed business cause permits one more inventory scan in the same run", async () => {
    const runtime = await createRuntime({ nextActions: [
        { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: "INITIAL" },
        { ...bossAction },
        { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: "ACTION:boss-1" },
        { ...bossAction, actionId: "boss-2" },
        { status: "COMPLETED" },
    ] });
    await runtime.run();
    assert.equal(runtime.events.filter(event => event === "boss").length, 2);
    assert.equal(runtime.submissions.filter(body => body.idempotencyKey === "boss-1:result").length, 1);
    assert.equal(runtime.submissions.filter(body => body.idempotencyKey === "boss-2:result").length, 1);
    assert.equal(runtime.outcomes[0].kind, "Completed");
});

for (const cause of [undefined, null, "", 4, {}, "untrusted", "ACTION:", "ACTION:boss-old"]) {
    test(`same normalized cause cannot gain scan budget from revision or target changes: ${JSON.stringify(cause)}`, async () => {
        const runtime = await createRuntime({ nextActions: [
            { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: cause, revision: 1 },
            { ...bossAction },
            { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: cause, revision: 2, materialName: "new-target" },
            { ...bossAction, actionId: "must-not-run" },
        ] });
        await runtime.run();
        assert.equal(runtime.events.filter(event => event === "boss").length, 1);
        assert.equal(runtime.claims.length, 3);
        assert.equal(runtime.submissions.filter(body => typeof body.observedOwned === "object").length, 3,
            "only start, one cause, and final scan; final success cannot rewrite the drive outcome");
        assert.equal(runtime.outcomes[0].kind, "NeedsReconcile");
        assert.match(runtime.outcomes[0].reason, /ALREADY_ATTEMPTED/);
    });
}

test("an unresolved cause scan does not refund the attempt or claim another action", async () => {
    const runtime = await createRuntime({ observationStatus: "NEEDS_RECONCILE", nextActions: [
        { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: "ACTION:known" }, { ...bossAction },
    ] });
    await runtime.run();
    assert.equal(runtime.claims.length, 1);
    assert(!runtime.events.includes("boss"));
    assert.equal(runtime.outcomes[0].kind, "NeedsReconcile");
});

test("one post-scan claim that stays blocked cannot start another cause loop", async () => {
    const runtime = await createRuntime({ nextActions: [
        { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: "INITIAL" },
        { status: "PLAN_NEEDS_RECONCILE", inventoryReconcileCause: "ACTION:new" }, { ...bossAction },
    ] });
    await runtime.run();
    assert.equal(runtime.claims.length, 2);
    assert(!runtime.events.includes("boss"));
    assert.equal(runtime.outcomes[0].kind, "NeedsReconcile");
});

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

test("an ordinary boss failure recovers before reporting authoritative inventory", async () => {
    const runtime = await createRuntime({ nextActions: [bossAction],
        boss: () => { throw new Error("奖励识别超时"); } });
    await assert.rejects(runtime.run(), /奖励识别超时/);
    assert(runtime.events.slice(runtime.events.indexOf("boss")).includes("statue"));
    const result = runtime.submissions.find(body => body.idempotencyKey === "boss-1:result");
    assert.equal(result.observedOwned, 10);
    assert.equal(result.succeeded, false);
    assert.equal(runtime.claims.length, 1);
});

test("a legacy void boss result relies on the inventory ledger instead of declaring no rewards", async () => {
    const runtime = await createRuntime({ nextActions: [bossAction], boss: () => undefined });
    await runtime.run();
    const result = runtime.submissions.find(body => body.idempotencyKey === "boss-1:result");
    assert.equal(result.observedOwned, 10);
    assert.deepEqual(result.rewards, {});
    assert.equal(result.terminationReason, "COMPLETED:INVENTORY_RECONCILED");
    assert.equal(runtime.claims.length, 2);
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
