import assert from "node:assert/strict";
import {
    buildAccountConfigFromLegacy,
    shouldMigrateLegacyConfig,
} from "../repo/js/AutoCommissionNova/src/migrations/legacy-unified-config.js";

const legacy = {
    schemaVersion: 2,
    skipSafeTeleport: true,
    party: {
        global: { default: "钟离" },
        scopes: { "枫丹/Basic/临危受命/枫丹廷区-1": "那维莱特" },
    },
};

const account = buildAccountConfigFromLegacy("123456789", legacy);
assert.equal(account.uid, "123456789");
assert.equal(account.settings.skipSafeTeleport, true);
assert.deepEqual(account.settings.party, legacy.party);
assert.deepEqual(account.commissions, []);
assert.deepEqual(account.branchCompleted, {});

assert.equal(shouldMigrateLegacyConfig({ accountExists: false, legacyExists: true }), true);
assert.equal(shouldMigrateLegacyConfig({ accountExists: true, legacyExists: true }), false);
assert.equal(shouldMigrateLegacyConfig({ accountExists: false, legacyExists: false }), false);

console.log("AutoCommission legacy config migration contracts passed");
