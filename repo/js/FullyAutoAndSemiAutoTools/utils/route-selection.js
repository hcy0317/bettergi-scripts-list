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
