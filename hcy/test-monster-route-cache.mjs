import assert from "node:assert/strict";
import test from "node:test";
import * as selection from "../repo/js/FullyAutoAndSemiAutoTools/utils/route-selection.js";

function route(family, author = "@Annijang") {
    return { isFile: true, path: `pathing/敌人与魔物/${family}/${family}${author}/01.json`,
        fullPathNames: ["敌人与魔物", family, `${family}${author}`, "01.json"] };
}

test("a newly selected monster missing from cache is resolved from current subscriptions", async () => {
    const stale = [route("蕈兽")];
    const live = [...stale, route("肌生晶石的妖精")];
    let scans = 0;
    const result = await selection.refreshSelectedRouteCache(stale,
        [{ parentName: "肌生晶石的妖精", options: ["肌生晶石的妖精@Annijang"] }],
        async () => { scans++; return live; });

    assert.equal(scans, 1);
    assert.equal(result.refreshed, true);
    assert.deepEqual(selection.selectRouteNodes(result.nodes, "肌生晶石的妖精", ["肌生晶石的妖精@Annijang"]), [live[1]]);
});

test("a complete cache does not rescan or rewrite its nodes", async () => {
    const cached = [route("肌生晶石的妖精")];
    const result = await selection.refreshSelectedRouteCache(cached,
        [{ parentName: "肌生晶石的妖精", options: ["肌生晶石的妖精@Annijang"] }],
        async () => { throw new Error("unexpected scan"); });
    assert.equal(result.refreshed, false);
    assert.equal(result.nodes, cached);
});

test("one missing option causes only one scan and keeps the selection confined to its family", async () => {
    const cached = [route("肌生晶石的妖精", "@旧路线")];
    const live = [...cached, route("肌生晶石的妖精"), route("蕈兽")];
    let scans = 0;
    const options = ["肌生晶石的妖精@旧路线", "肌生晶石的妖精@Annijang", "不存在"];
    const result = await selection.refreshSelectedRouteCache(cached,
        [{ parentName: "肌生晶石的妖精", options }], async () => { scans++; return live; });
    assert.equal(scans, 1);
    assert.deepEqual(selection.selectRouteNodes(result.nodes, "肌生晶石的妖精", options), live.slice(0, 2));
    assert.equal(cached.length, 1);
});

test("a scan error is propagated instead of accepting an empty successful plan", async () => {
    await assert.rejects(selection.refreshSelectedRouteCache([], [{ parentName: "肌生晶石的妖精", options: ["肌生晶石的妖精@Annijang"] }],
        async () => { throw new Error("目录不可读"); }), /目录不可读/);
});

test("no selected routes do not cause a subscription scan", async () => {
    const result = await selection.refreshSelectedRouteCache([], [{ parentName: "pathing", options: [] }],
        async () => { throw new Error("unexpected scan"); });
    assert.equal(result.refreshed, false);
});
