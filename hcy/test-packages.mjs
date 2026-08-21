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

const targetFolders = new Set();
for (const entry of mappings.packages) {
    assert.match(entry.targetFolder, /^HCY-/);
    assert.notEqual(entry.sourceFolder, entry.targetFolder);
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
}

console.log("HCY compatibility package contracts passed");
