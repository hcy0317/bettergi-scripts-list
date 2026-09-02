import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hcyRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(hcyRoot);
const mappings = JSON.parse(
    fs.readFileSync(path.join(hcyRoot, "packages.json"), "utf8"),
);

assert.equal(mappings.schemaVersion, 1);
assert.equal(mappings.packages.length, 4);
assert.equal(mappings.preserveOfficialSettingDefaults.length, 8);

const cdAwareAutoGather = fs.readFileSync(
    path.join(repoRoot, "repo", "js", "CD-Aware-AutoGather", "main.js"),
    "utf8",
);
assert.match(
    cdAwareAutoGather,
    /HCY_ROUTE_FAILURE_CONTINUATION_BEGIN[\s\S]*pathingScript\.isCancellationRequested[\s\S]*throw error;[\s\S]*路线执行失败，跳过当前路线[\s\S]*continue;[\s\S]*HCY_ROUTE_FAILURE_CONTINUATION_END/,
    "CD-Aware-AutoGather must continue ordinary route failures without swallowing cancellation",
);

const targetFolders = new Set();
for (const entry of mappings.packages) {
    assert.match(entry.targetFolder, /^HCY-/);
    assert.notEqual(entry.sourceFolder, entry.targetFolder);
    assert.equal(typeof entry.preserveFromFolder, "string");
    assert(Array.isArray(entry.preserveFiles));
    assert(Array.isArray(entry.preserveSettingDefaults));
    assert(!targetFolders.has(entry.targetFolder), `duplicate target: ${entry.targetFolder}`);
    targetFolders.add(entry.targetFolder);

    const packageRoot = path.join(repoRoot, "repo", "js", entry.sourceFolder);
    const manifest = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"),
    );
    assert(Array.isArray(manifest.saved_files));

    for (const marker of entry.requiredMarkers) {
        const source = fs.readFileSync(path.join(packageRoot, marker.file), "utf8");
        assert(
            source.includes(marker.text),
            `${entry.sourceFolder}/${marker.file} is missing: ${marker.text}`,
        );
    }

    const javascriptFiles = fs
        .readdirSync(packageRoot, { recursive: true, withFileTypes: true })
        .filter((item) => item.isFile() && item.name.endsWith(".js"));
    for (const file of javascriptFiles) {
        const source = fs.readFileSync(path.join(file.parentPath, file.name), "utf8");
        for (const unsupportedApi of ["keyPressFocused", "clickFocused", "activateWindow"]) {
            assert(
                !source.includes(`.${unsupportedApi}(`),
                `${path.relative(repoRoot, path.join(file.parentPath, file.name))} uses unsupported BetterGI API: ${unsupportedApi}`,
            );
        }
    }
}

const fullyAutoManifest = JSON.parse(
    fs.readFileSync(
        path.join(repoRoot, "repo", "js", "FullyAutoAndSemiAutoTools", "manifest.json"),
        "utf8",
    ),
);
assert(
    fullyAutoManifest.saved_files.includes("pathing/"),
    "official FullyAutoAndSemiAutoTools must preserve its pathing junction",
);
const hcyFullyAutoMapping = mappings.packages.find(
    (entry) => entry.sourceFolder === "FullyAutoAndSemiAutoTools",
);
assert(
    hcyFullyAutoMapping?.preserveFiles.includes("pathing/"),
    "HCY FullyAutoAndSemiAutoTools must preserve its pathing bridge",
);

const cultivationPlan = fs.readFileSync(
    path.join(repoRoot, "repo", "js", "AutoPlan", "utils", "cultivation_plan.js"),
    "utf8",
);
for (const marker of [
    "await Physical.countAllResin()",
    'action.actionType === "CRAFT_BATCH"',
    "for (const craftAction of craftActions)",
    "targets.materialNamesByGrid",
    'async function countInventoryItems(names, gridScreenName, iconRecognitionMode = "GridIcon")',
    'await countInventoryItems(retryNames, gridScreenName, "Item")',
    'if (action.status === "PLAN_NEEDS_RECONCILE")',
]) {
    assert(
        cultivationPlan.includes(marker),
        `AutoPlan cultivation bridge is missing: ${marker}`,
    );
}
assert.equal(
    (cultivationPlan.match(/async function runInventoryReconcileOnce\(/g) ?? []).length,
    1,
    "AutoPlan cultivation bridge must keep one bounded inventory reconcile helper",
);
assert.doesNotMatch(
    cultivationPlan,
    /return true;\s*return /,
    "AutoPlan cultivation bridge must not retain unreachable result branches",
);

const autoPlanMain = fs.readFileSync(
    path.join(repoRoot, "repo", "js", "AutoPlan", "main.js"),
    "utf8",
);
assert.match(
    autoPlanMain,
    /import \{runPlanDrivenCultivation, runCultivationInventoryReconcile\} from '\.\/utils\/cultivation_plan';/,
    "AutoPlan main must import the plan-driven cultivation bridge",
);
assert.match(
    autoPlanMain,
    /await init\(\);[\s\S]*if \(settings\.cultivation_plan_mode\)[\s\S]*await runPlanDrivenCultivation\(config\);[\s\S]*if \(settings\.cultivation_inventory_reconcile_mode\)[\s\S]*await runCultivationInventoryReconcile\(config\);[\s\S]*let runConfig = config\.run\.config;/,
    "AutoPlan main must dispatch cultivation modes before the legacy fixed-plan flow",
);
assert.match(autoPlanMain, /^await main\(\);?$/m, "AutoPlan main must await its lifecycle");
assert.doesNotMatch(autoPlanMain, /\(async function \(\)/, "AutoPlan main must not detach its lifecycle");

const emergencySupplyProcess = JSON.parse(
    fs.readFileSync(
        path.join(
            repoRoot,
            "repo",
            "js",
            "AutoCommissionNova",
            "process",
            "蒙德",
            "NPC",
            "应急补给",
            "龙脊雪山",
            "process.json",
        ),
        "utf8",
    ),
);
const supplyPointInteractions = emergencySupplyProcess.filter(
    (step) => step.type === "在附近交互" && step.data?.text === "应急补给点",
);
assert.equal(
    supplyPointInteractions.length,
    3,
    "应急补给的三个埋放点都必须识别并交互“应急补给点”，不能只盲按 F",
);
assert(
    !emergencySupplyProcess.some(
        (step) => step.type === "按键" && String(step.data).toUpperCase() === "F",
    ),
    "应急补给流程不能保留不校验目标的裸 F 交互",
);

console.log("HCY compatibility package contracts passed");
