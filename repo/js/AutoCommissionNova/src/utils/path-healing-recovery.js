import { rethrowIfCancellation } from "./error-utils.js";

function readRoute(path) {
    try {
        const json = file.readTextSync(path);
        if (typeof json !== "string" || json.length > 1024 * 1024) return null;
        const route = JSON.parse(json);
        if (!Array.isArray(route.positions) || route.positions.length === 0 || route.positions.length > 10000) return null;
        const map = route.info?.map_name;
        if (typeof map !== "string" || !map.trim()) return null;
        return { path, json, map, positions: route.positions };
    } catch { return null; } // 缺少可验证快照不改变普通RunFile行为，只禁用父流程重规划。
}

function pureNavigation(route) {
    return route?.positions[0]?.type === "teleport" && route.positions.every(point =>
        ["teleport", "path", "target", "orientation"].includes(point.type) &&
        (point.action == null || point.action === "") &&
        Number.isFinite(point.x) && Number.isFinite(point.y));
}

/** 仅在当前委托上下文内保存成功的纯导航快照；不共享、不重放业务宏。 */
export async function runCommissionPath(path, context, rememberNavigation = false) {
    const snapshot = readRoute(path);
    if (rememberNavigation) context.healingNavigationCheckpoint = null;
    try {
        const result = await pathingScript.runFile(path);
        if (rememberNavigation && pureNavigation(snapshot) && readRoute(path)?.json === snapshot.json)
            context.healingNavigationCheckpoint = snapshot;
        return result;
    } catch (error) {
        rethrowIfCancellation(error);
        const checkpoint = context.healingNavigationCheckpoint;
        if (!String(error?.message ?? error).includes("[BGI_HEALING_REPLAN_REQUIRED]") ||
            rememberNavigation || !pureNavigation(checkpoint) || !snapshot ||
            snapshot.positions[0].type === "teleport" || snapshot.map !== checkpoint.map ||
            (context.healingReplans ?? 0) >= 1 || readRoute(path)?.json !== snapshot.json ||
            readRoute(checkpoint.path)?.json !== checkpoint.json) throw error;

        context.healingReplans = (context.healingReplans ?? 0) + 1;
        log.info("已确认回血，沿本委托先前完成的纯导航返回后，重试尚未开始的路径片段一次");
        const returned = await pathingScript.run(checkpoint.json);
        if (returned?.success !== true) throw new Error("回血返回导航未取得成功回执，禁止继续委托片段");
        return await pathingScript.runFile(path); // 不形成循环，任何再次失败均向原父流程传播。
    }
}
