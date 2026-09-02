import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hcyRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(hcyRoot);
const entries = JSON.parse(
    fs.readFileSync(path.join(hcyRoot, "combat-strategies.json"), "utf8"),
);

assert.equal(entries.schemaVersion, 1);
assert.equal(entries.strategies.length, 12);

const names = new Set();
for (const strategy of entries.strategies) {
    assert(!names.has(strategy.file), `duplicate strategy: ${strategy.file}`);
    names.add(strategy.file);

    const source = fs.readFileSync(path.join(repoRoot, "repo", "combat", strategy.file));
    const actualHash = crypto.createHash("sha256").update(source).digest("hex");
    assert.equal(actualHash, strategy.sha256, strategy.file);
}

console.log("HCY combat strategy contracts passed");
