import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const builder = fs.readFileSync(new URL("../build/build.js", import.meta.url), "utf8");

function buildFixture({ bom = false, merging = false } = {}) {
    const tempBase = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempBase, "bgi-index-fixture-"));
    try {
        const buildDir = path.join(root, "build");
        const route = path.join(root, "repo/pathing/fixture/route.json");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(path.dirname(route), { recursive: true });
        const original = Buffer.from((bom ? "\uFEFF" : "") + JSON.stringify({ info: { name: "fixture", version: "1.0" }, positions: [] }));
        fs.writeFileSync(route, original);
        const incoming = "a".repeat(40);
        const oldTime = "2026-09-01 12:00:00 +0800";
        const newTime = "2026-09-11 14:00:00 +0800";
        const git = {
            execSync(command) { return Buffer.from(command.startsWith("git log") ? oldTime : "main"); },
            execFileSync(command, args) {
                assert.equal(command, "git");
                if (args.includes("MERGE_HEAD")) {
                    if (!merging) throw new Error("No merge in progress");
                    return incoming;
                }
                if (args[0] === "log") return args.includes(incoming) ? newTime : oldTime;
                throw new Error("Unexpected git read");
            },
        };
        vm.runInNewContext(builder, {
            require: name => name === "child_process" ? git : require(name),
            __dirname: buildDir, process: { argv: ["node", "build.js", "--force"], platform: "win32" },
            console: { log() {}, warn() {}, error() {} }, Buffer,
        });
        const index = JSON.parse(fs.readFileSync(path.join(root, "repo.json"), "utf8"));
        return { original, after: fs.readFileSync(route), entry: index.indexes[0].children[0].children[0] };
    } finally {
        const resolved = path.resolve(root);
        assert(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith("bgi-index-fixture-"));
        assert(!fs.lstatSync(resolved).isSymbolicLink());
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

test("index generation never rewrites source routes when stripping BOM for parsing", () => {
    const result = buildFixture({ bom: true });
    assert.deepEqual(result.after, result.original);
    assert.equal(result.entry.version, "1.0");
});

test("an in-progress merge includes incoming history when dating newly added routes", () => {
    const result = buildFixture({ merging: true });
    assert.equal(result.entry.lastUpdated, "2026-09-11 14:00:00");
});
