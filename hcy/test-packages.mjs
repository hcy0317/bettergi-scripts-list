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

console.log("HCY compatibility package contracts passed");
