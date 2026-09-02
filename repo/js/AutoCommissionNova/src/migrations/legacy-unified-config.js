function isPlainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
}

export function shouldMigrateLegacyConfig({ accountExists, legacyExists }) {
    return !accountExists && legacyExists;
}

export function buildAccountConfigFromLegacy(uid, legacyConfig) {
    const normalizedUid = String(uid ?? "").trim();
    if (!/^\d+$/.test(normalizedUid)) throw new Error(`无效 UID: ${uid}`);

    const legacy = isPlainObject(legacyConfig) ? legacyConfig : {};
    const party = isPlainObject(legacy.party) ? legacy.party : {};
    return {
        uid: normalizedUid,
        timestamp: "",
        scriptVersion: "1.0.0",
        bgiVersion: "",
        settings: {
            skipSafeTeleport: legacy.skipSafeTeleport === true,
            party: {
                global: isPlainObject(party.global) ? party.global : {},
                scopes: isPlainObject(party.scopes) ? party.scopes : {},
            },
        },
        commissions: [],
        branchCompleted: {},
    };
}
