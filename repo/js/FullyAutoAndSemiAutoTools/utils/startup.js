export function normalizeUid(value) {
    const uid = String(value ?? '').trim();
    return /^\d{6,12}$/.test(uid) ? uid : '';
}

export function normalizeUidMapEntries(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const entries = raw.length === 2 && !Array.isArray(raw[0]) && Array.isArray(raw[1])
        ? [raw]
        : raw;

    return entries
        .filter(entry => Array.isArray(entry) && entry.length >= 2 && Array.isArray(entry[1]))
        .map(entry => [normalizeUid(entry[0]), entry[1]]);
}

export function selectUidValue(raw, uid, isUsable = value => Array.isArray(value) && value.length > 0) {
    const entries = normalizeUidMapEntries(raw);
    const normalizedUid = normalizeUid(uid);
    const exact = entries.find(([entryUid, value]) => entryUid === normalizedUid && isUsable(value));

    if (exact) {
        return {key: exact[0], value: exact[1], usedFallback: false};
    }

    const usable = entries.filter(([, value]) => isUsable(value));
    const fallback = usable.length === 1 && usable[0][0] === ''
        ? usable[0]
        : undefined;

    return fallback
        ? {key: fallback[0], value: fallback[1], usedFallback: true}
        : {key: '', value: undefined, usedFallback: false};
}

export function upsertUidValue(raw, uid, value) {
    const normalizedUid = normalizeUid(uid);
    const map = new Map(normalizeUidMapEntries(raw));
    map.set(normalizedUid, value);

    if (normalizedUid) {
        map.delete('');
    }

    return [...map];
}

export function findLatestUid(...recordLists) {
    return recordLists
        .flatMap(records => Array.isArray(records) ? records : [])
        .map(record => ({
            uid: normalizeUid(record?.uid),
            timestamp: Math.max(
                Number(record?.timestamp) || 0,
                Array.isArray(record?.paths)
                    ? record.paths.reduce(
                        (latest, pathRecord) => Math.max(latest, Number(pathRecord?.timestamp) || 0),
                        0
                    )
                    : 0
            ),
        }))
        .filter(record => record.uid && record.timestamp > 0)
        .sort((left, right) => right.timestamp - left.timestamp)[0]?.uid || '';
}

export function findUniqueUid(...uidLists) {
    const uids = new Set(
        uidLists
            .flatMap(values => Array.isArray(values) ? values : [values])
            .map(normalizeUid)
            .filter(Boolean)
    );
    return uids.size === 1 ? [...uids][0] : '';
}

export function resolveUid(detectedUid, storedUid, cachedUids = []) {
    return normalizeUid(detectedUid)
        || normalizeUid(storedUid)
        || findUniqueUid(cachedUids);
}

export function filterUsablePathNodes(nodes, readText) {
    const usable = [];
    const skipped = [];

    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (node?.isFile !== true || typeof node.path !== 'string' || node.path.trim() === '') {
            continue;
        }

        try {
            const content = readText(node.path);
            if (typeof content !== 'string' || content.trim() === '') {
                throw new Error(`empty path file: ${node.path}`);
            }
            JSON.parse(content);
            usable.push(node);
        } catch (error) {
            const message = String(error?.message || error);
            const isMissingPath = /Could not find file|Could not find a part of the path|FileNotFoundException|ENOENT|file not found|找不到(?:指定的)?文件|未能找到文件|系统找不到指定的文件/i.test(message);
            if (!isMissingPath) {
                throw error;
            }
            skipped.push({path: node.path, error: message});
        }
    }

    return {usable, skipped};
}
