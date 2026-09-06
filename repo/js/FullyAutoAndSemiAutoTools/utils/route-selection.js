function treeLevelDepth(name) {
    const match = /^treeLevel_(\d+)_/.exec(String(name ?? ""));
    return match ? Number.parseInt(match[1], 10) : -1;
}

export function getEffectiveSelectedOptions(settingsName, selectedOptions, selectionMap) {
    const options = Array.from(selectedOptions ?? []);
    const currentDepth = treeLevelDepth(settingsName);
    if (currentDepth < 0 || !(selectionMap instanceof Map)) return options;

    return options.filter(option => !Array.from(selectionMap.entries()).some(([childName, child]) => {
        if (treeLevelDepth(childName) <= currentDepth) return false;
        const childOptions = Array.from(child?.options ?? []);
        if (childOptions.length === 0) return false;
        const label = String(child?.label ?? "");
        const normalizedOption = String(option ?? "").trim();
        return label.includes(`《${normalizedOption}》`) ||
            label.includes(`[${normalizedOption}]`);
    }));
}

export function selectRouteNodes(nodes, parentName, selectedOptions) {
    const options = Array.from(selectedOptions ?? []);
    return (Array.isArray(nodes) ? nodes : []).filter(item => {
        if (item?.isFile !== true || !Array.isArray(item.fullPathNames)) return false;
        const hitParent = parentName === "pathing" || item.fullPathNames.includes(parentName);
        return hitParent && options.some(option =>
            item.fullPathNames.some(name => typeof name === "string" && name.includes(option)));
    });
}

// 缓存不包含新订阅的已选路线时，仅重扫一次；不改选择、CD 或其他 UID 的记录。
export async function refreshSelectedRouteCache(cachedNodes, selections, scanPaths) {
    const missing = selections.some(({ parentName, options }) =>
        options.some(option => selectRouteNodes(cachedNodes, parentName, [option]).length === 0));
    if (!missing) return { nodes: cachedNodes, refreshed: false };

    const nodes = await scanPaths();
    if (!Array.isArray(nodes)) throw new Error("当前订阅路线扫描结果无效");
    return { nodes, refreshed: true };
}
