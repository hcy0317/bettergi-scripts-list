import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv[2];
assert(baseline, "Provide the pre-merge baseline commit");
const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "--diff-filter=ACMTU", "-z", baseline, "--", "repo"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const failures = [];
let jsonCount = 0, jsCount = 0, manifestCount = 0;
for (const relative of changed) {
    const file = path.resolve(root, relative);
    if (!fs.existsSync(file) || !/\.(json|js)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    try {
        assert(!/^<{7,8} |^>{7,8} /m.test(text), "unresolved merge marker");
        if (file.endsWith(".js")) {
            // Compile syntax only. Never link/evaluate game modules or send input.
            new vm.SourceTextModule(text, { identifier: relative });
            jsCount++;
        } else {
            const value = JSON.parse(text);
            jsonCount++;
            if (path.basename(file) === "manifest.json") {
                for (const key of ["main", "settings_ui"]) {
                    if (typeof value[key] !== "string" || !value[key]) continue;
                    const target = path.resolve(path.dirname(file), value[key]);
                    assert(target.startsWith(path.dirname(file) + path.sep), `${key} escapes package`);
                    assert(fs.existsSync(target), `missing ${key}: ${value[key]}`);
                }
                manifestCount++;
            }
        }
    } catch (error) {
        failures.push(`${relative}: ${error.message}`);
    }
}
console.log(JSON.stringify({ changedFiles: changed.length, jsonCount, jsCount, manifestCount, failures }, null, 2));
assert.equal(failures.length, 0, "Changed upstream content failed integrity checks");
