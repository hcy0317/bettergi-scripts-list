import {taskHandlerMap} from "./load_check_run";
import {Physical} from "./physical";

function apiHeaders(token) {
    const headers = {"Content-Type": "application/json"};
    const name = String(token?.name ?? "").trim();
    const value = String(token?.value ?? "").trim();
    if (name && value) headers[name] = value;
    return headers;
}

function cultivationApiBase(planJsonUrl) {
    const value = String(planJsonUrl ?? "").trim();
    const suffix = "/auto/plan/json";
    const index = value.indexOf(suffix);
    if (index < 0) {
        throw new Error(`计划驱动模式无法从旧计划地址推导养成 API: ${value}`);
    }
    return value.slice(0, index) + "/auto/plan/cultivation";
}

async function requestJson(method, url, body, token) {
    const response = await http.request(
        method,
        url,
        JSON.stringify(body ?? {}),
        JSON.stringify(apiHeaders(token)));
    if (response.status_code !== 200 || !response.body) {
        throw new Error(`养成计划 API 请求失败: ${method} ${url}, HTTP ${response.status_code}`);
    }
    const envelope = JSON.parse(response.body);
    if (envelope?.code !== 200) {
        throw new Error(`养成计划 API 返回失败: ${envelope?.message ?? "unknown"}`);
    }
    return envelope.data;
}

async function observeOwned(materialName, reconcileGrid) {
    if (reconcileGrid !== "CharacterDevelopmentItems") {
        log.warn(`[计划驱动] 暂不支持库存页 {0}，停止并等待重新清点`, reconcileGrid);
        return null;
    }
    const param = new CountInventoryItemParam();
    param.GridScreenName = GridScreenName.CharacterDevelopmentItems;
    param.ItemName = materialName;
    param.IconRecognitionMode = ItemIconRecognitionMode.Item;
    const value = await dispatcher.RunCountInventoryItemTask(param);
    const observed = Number(value);
    if (!Number.isFinite(observed)) return null;
    return Math.trunc(observed);
}

async function countInventoryItems(names, gridScreenName, iconRecognitionMode = "GridIcon") {
    return await dispatcher.runTask(new SoloTask("CountInventoryItem", {
        gridScreenName,
        itemNames: names,
        iconRecognitionMode,
    }));
}

async function scanResinSnapshot() {
    try {
        const snapshot = await Physical.countAllResin();
        const normalized = {
            originalResinCount: Math.max(0, Number(snapshot?.originalResinCount) || 0),
            condensedResinCount: Math.max(0, Number(snapshot?.condensedResinCount) || 0),
            transientResinCount: Math.max(0, Number(snapshot?.transientResinCount) || 0),
            fragileResinCount: Math.max(0, Number(snapshot?.fragileResinCount) || 0),
        };
        log.info("[计划驱动] 树脂快照：原粹={0}，浓缩={1}，须臾={2}，脆弱={3}",
            normalized.originalResinCount,
            normalized.condensedResinCount,
            normalized.transientResinCount,
            normalized.fragileResinCount);
        return normalized;
    } catch (error) {
        log.warn("[计划驱动] 树脂快照识别失败，保留 AutoDomain 自身预检：{0}",
            error?.message ?? String(error));
        return null;
    }
}

function resinSnapshotQuery(snapshot) {
    if (!snapshot) return "";
    return `&originalResinCount=${encodeURIComponent(snapshot.originalResinCount)}`
        + `&condensedResinCount=${encodeURIComponent(snapshot.condensedResinCount)}`
        + `&transientResinCount=${encodeURIComponent(snapshot.transientResinCount)}`
        + `&fragileResinCount=${encodeURIComponent(snapshot.fragileResinCount)}`;
}

async function observeOwnedByGrid(materialNamesByGrid, fallbackNames) {
    const grouped = materialNamesByGrid && typeof materialNamesByGrid === "object"
        ? materialNamesByGrid
        : {CharacterDevelopmentItems: Array.from(fallbackNames ?? [])};
    const observedOwned = {};
    for (const [gridScreenName, namesValue] of Object.entries(grouped)) {
        const names = Array.from(namesValue ?? []).map(String).filter(Boolean);
        if (names.length === 0) continue;
        let result = {};
        log.info(`[计划驱动] 在 {0} 页复核 {1}`, gridScreenName, names.join("、"));
        try {
            const iconRecognitionMode = gridScreenName === "CharacterDevelopmentItems"
                ? "Item"
                : "GridIcon";
            result = await countInventoryItems(names, gridScreenName, iconRecognitionMode);
        } catch (error) {
            log.error(`[计划驱动] {0} 页库存批量识别失败，将该页缺失项显式上报未知：{1}`,
                gridScreenName,
                error?.message ?? String(error));
        }
        for (const name of names) {
            const count = Number(result?.[name]);
            observedOwned[name] = Number.isFinite(count) && count >= 0 ? Math.trunc(count) : -1;
        }

        const retryNames = names.filter(name => observedOwned[name] < 0);
        if (retryNames.length > 0) {
            log.warn(`[计划驱动] {0} 页首次识别未知，仅对缺失项再复查一次：{1}`,
                gridScreenName,
                retryNames.join("、"));
            try {
                const retryResult = await countInventoryItems(retryNames, gridScreenName, "Item");
                for (const name of retryNames) {
                    const count = Number(retryResult?.[name]);
                    if (Number.isFinite(count) && count >= 0) {
                        observedOwned[name] = Math.trunc(count);
                    }
                }
            } catch (error) {
                log.warn(`[计划驱动] {0} 页缺失项复查失败，未知项将保留上次可信库存：{1}`,
                    gridScreenName,
                    error?.message ?? String(error));
            }
        }
    }
    return observedOwned;
}
function toPlainRewards(value) {
    const rewards = {};
    if (!value) return rewards;
    for (const name of Object.keys(value)) {
        const count = Number(value[name]);
        if (Number.isFinite(count) && count > 0) rewards[name] = Math.trunc(count);
    }
    return rewards;
}

async function reportResult(baseUrl, action, executorId, observedOwned, succeeded, reason, rewards, token) {
    const url = `${baseUrl}/execution/actions/${encodeURIComponent(action.actionId)}/result`;
    return requestJson("POST", url, {
        executorId,
        expectedRevision: action.revision,
        idempotencyKey: `${action.actionId}:result`,
        succeeded,
        observedOwned,
        rewards,
        terminationReason: reason,
    }, token);
}

export async function runCultivationInventoryReconcile(config) {
    const baseUrl = cultivationApiBase(config.bgi_tools.api.httpPullJsonConfig);
    const uid = String(config.user.uid ?? "").trim();
    if (!uid) throw new Error("库存复核模式缺少 UID");
    const executorId = `inventory-${uid}-${Date.now()}`;
    const targets = await requestJson(
        "POST", `${baseUrl}/execution/inventory-reconcile-targets?uid=${encodeURIComponent(uid)}`
            + `&executorId=${encodeURIComponent(executorId)}`,
        null, config.bgi_tools.token);
    if (targets.status === "BUSY") {
        log.warn("[计划驱动] 组末库存复核未取得租约：{0}", targets.message);
        return false;
    }
    const materialNames = Array.from(targets?.materialNames ?? []);
    if (materialNames.length === 0) {
        log.info("[计划驱动] 当前没有需要组末复核的地方特产或怪物材料");
        return true;
    }
    log.info("[计划驱动] 组末权威库存复核：{0}", materialNames.join("、"));
    const observedOwned = await observeOwnedByGrid(targets.materialNamesByGrid, materialNames);
    const response = await requestJson(
        "POST", `${baseUrl}/execution/inventory-observations?uid=${encodeURIComponent(uid)}`,
        {
            actionId: targets.actionId,
            executorId,
            expectedRevision: targets.revision,
            idempotencyKey: `${targets.actionId}:result`,
            observedOwned,
        },
        config.bgi_tools.token);
    log.info("[计划驱动] 组末库存回写完成：{0} 项，{1}", response.observedCount, response.message);
    return true;
}

async function executeAction(baseUrl, action, executorId, token) {
    const plan = action.plan;
    const handler = plan ? taskHandlerMap[plan.runType] : null;
    if (!handler) throw new Error(`计划器发放了不支持的行动类型: ${plan?.runType}`);

    log.info(`[计划驱动] 行动 {0}：{1}，账本还需 {2}，本批上限 {3}`,
        action.actionType, action.materialName, action.remaining, action.batchLimit);
    log.info(`[计划驱动] 选择原因：{0}`, action.message);

    let executionError = null;
    let rewards = {};
    try {
        rewards = toPlainRewards(await handler.run(plan[handler.target]));
        log.info(`[计划驱动] 实际奖励：{0}`, JSON.stringify(rewards));
    } catch (error) {
        executionError = error;
        log.error(`[计划驱动] 行动执行异常：{0}`, error?.message ?? String(error));
    }

    let observedOwned = null;
    try {
        observedOwned = await observeOwned(action.materialName, action.reconcileGrid);
        log.info(`[计划驱动] 权威库存复核：{0}={1}`, action.materialName, observedOwned);
    } catch (error) {
        log.error(`[计划驱动] 背包复核失败：{0}`, error?.message ?? String(error));
    }

    const result = await reportResult(
        baseUrl, action, executorId, observedOwned,
        executionError == null && Object.keys(rewards).length > 0,
        executionError != null
            ? `FAILED:${executionError?.message ?? executionError}`
            : Object.keys(rewards).length === 0 ? "NO_PROGRESS:NO_REWARDS" : "COMPLETED",
        rewards, token);
    log.info(`[计划驱动] 回写状态：{0}，{1}`, result.status, result.message);

    if (executionError) throw executionError;
    if (Object.keys(rewards).length === 0) {
        log.warn(`[计划驱动] 行动未产生奖励，重新领取以选择批量合成或安全停止`);
        return result.status === "STOPPED_NO_PROGRESS";
    }
    return result.status === "REPLANNING";
}

async function executeCraftBatchAction(baseUrl, action, executorId, config) {
    const craftActions = Array.isArray(action.craftActions) ? action.craftActions : [];
    if (craftActions.length === 0) {
        log.error("[计划驱动] 批量合成行动没有可执行材料");
        return {shouldContinue: false, shouldReconcile: false};
    }

    const rewards = {};
    const failures = [];
    try {
        log.info("[计划驱动] 前往 {0} 合成台，将连续执行 {1} 个合成步骤",
            action.craftCountry, craftActions.length);
        await genshin.GoToCraftingBench(action.craftCountry);
        for (const craftAction of craftActions) {
            try {
                log.info("[计划驱动] 批量合成：{0} x{1}",
                    craftAction.materialName, craftAction.quantity);
                const craftResult = await genshin.CraftMaterial(
                    craftAction.materialName,
                    craftAction.quantity,
                    craftAction.materialType);
                const actualQuantity = Number(
                    craftResult?.actualQuantity ?? craftResult?.ActualQuantity ?? 0);
                if (Number.isFinite(actualQuantity) && actualQuantity > 0) {
                    rewards[craftAction.materialName] =
                        (rewards[craftAction.materialName] ?? 0) + Math.trunc(actualQuantity);
                } else {
                    failures.push(`${craftAction.materialName}:未取得有效合成数量`);
                }
            } catch (error) {
                const message = error?.message ?? String(error);
                failures.push(`${craftAction.materialName}:${message}`);
                log.error("[计划驱动] 批量合成单项失败：{0}，{1}",
                    craftAction.materialName, message);
            }
        }
    } finally {
        try {
            await genshin.ReturnMainUi();
        } catch (error) {
            log.warn(`[计划驱动] 合成后返回主界面失败：{0}`, error?.message ?? String(error));
        }
    }

    const completedAny = Object.keys(rewards).length > 0;
    const terminationReason = completedAny
        ? failures.length === 0
            ? "CRAFT_BATCH_COMPLETED"
            : `CRAFT_BATCH_PARTIAL:${failures.join("|")}`
        : `NO_PROGRESS:CRAFT_BATCH_FAILED:${failures.join("|")}`;
    const result = await reportResult(
        baseUrl, action, executorId, 0,
        completedAny,
        terminationReason,
        rewards, config.bgi_tools.token);
    log.info("[计划驱动] 批量合成回写状态：{0}，成功 {1}/{2} 项，{3}",
        result.status,
        Object.keys(rewards).length,
        craftActions.length,
        result.message);
    return {
        shouldContinue: result.status === "REPLANNING",
        shouldReconcile: true,
    };
}

async function runInventoryReconcileOnce(config, state, reason) {
    if (state.attempted) {
        log.warn("[计划驱动] 本轮已完成一次完整库存复核，不再重复检查：{0}", reason);
        return {performed: false, succeeded: true};
    }
    state.attempted = true;
    log.warn("[计划驱动] 本轮执行一次完整库存复核：{0}", reason);
    return {
        performed: true,
        succeeded: await runCultivationInventoryReconcile(config),
    };
}

async function refreshCurrentOwned(config, phase) {
    log.warn("[计划驱动] {0}刷新当前拥有", phase);
    try {
        const refreshed = await runCultivationInventoryReconcile(config);
        if (!refreshed) {
            log.warn("[计划驱动] {0}库存刷新未闭合；保留上次可信库存，不把单个未知材料升级为配置组失败", phase);
            return false;
        }
        return true;
    } catch (error) {
        log.error("[计划驱动] {0}库存刷新失败，保留上次可信库存：{1}",
            phase,
            error?.message ?? String(error));
        return false;
    }
}

async function executeCraftAction(baseUrl, action, executorId, config) {
    let craftResult = null;
    let executionError = null;
    try {
        log.info(`[计划驱动] 前往 {0} 合成台，将合成 {1} x{2}`,
            action.craftCountry, action.materialName, action.batchLimit);
        await genshin.GoToCraftingBench(action.craftCountry);
        craftResult = await genshin.CraftMaterial(
            action.materialName, action.batchLimit, action.craftMaterialType);
    } catch (error) {
        executionError = error;
        log.error(`[计划驱动] 材料合成失败：{0}`, error?.message ?? String(error));
    } finally {
        try {
            await genshin.ReturnMainUi();
        } catch (error) {
            log.warn(`[计划驱动] 合成后返回主界面失败：{0}`, error?.message ?? String(error));
        }
    }

    const actualQuantity = Number(craftResult?.actualQuantity ?? craftResult?.ActualQuantity ?? 0);
    let observedOwned = null;
    try {
        observedOwned = await observeOwned(action.materialName, "CharacterDevelopmentItems");
    } catch (error) {
        log.error(`[计划驱动] 合成产物库存复核失败：{0}`, error?.message ?? String(error));
    }
    const rewards = Number.isFinite(actualQuantity) && actualQuantity > 0
        ? {[action.materialName]: Math.trunc(actualQuantity)}
        : {};
    const result = await reportResult(
        baseUrl, action, executorId, observedOwned,
        executionError == null && Object.keys(rewards).length > 0,
        executionError == null ? "CRAFT_COMPLETED" : `FAILED:${executionError?.message ?? executionError}`,
        rewards, config.bgi_tools.token);
    log.info(`[计划驱动] 合成回写状态：{0}，{1}`, result.status, result.message);
    if (executionError) throw executionError;
    if (Object.keys(rewards).length === 0) return false;
    return result.status === "REPLANNING";
}

export async function runPlanDrivenCultivation(config) {
    const baseUrl = cultivationApiBase(config.bgi_tools.api.httpPullJsonConfig);
    const uid = String(config.user.uid ?? "").trim();
    if (!uid) throw new Error("计划驱动模式缺少 UID");
    const executorId = `autoplan-${uid}-${Date.now()}`;
    config.run.exclude_run_exception = false;
    config.run.loop_plan = false;
    const inventoryReconcileState = {attempted: false};
    log.info(`[计划驱动] 已启用：合成按完整批次执行，其余任务每次领取一个行动`);

    const startRefreshCompleted = await refreshCurrentOwned(config, "计划开始前");
    if (!startRefreshCompleted) {
        log.warn("[计划驱动] 计划开始前库存存在未知项，继续使用上次可信库存；计划器可再请求一次有界复核");
    }
    let resinSnapshot = await scanResinSnapshot();
    try {
        while (true) {
            const claimUrl = `${baseUrl}/execution/next-action?uid=${encodeURIComponent(uid)}`
                + `&executorId=${encodeURIComponent(executorId)}`
                + resinSnapshotQuery(resinSnapshot);
            const action = await requestJson("POST", claimUrl, {}, config.bgi_tools.token);
            if (action.status === "NEEDS_RECONCILE") {
                log.warn(`[计划驱动] 上一行动仅执行背包复核，不再消耗树脂：{0}`, action.materialName);
                let observedOwned = null;
                try {
                    observedOwned = await observeOwned(action.materialName, action.reconcileGrid);
                } catch (error) {
                    log.error(`[计划驱动] 补充背包复核失败：{0}`, error?.message ?? String(error));
                }
                const result = await reportResult(
                    baseUrl, action, executorId, observedOwned, false, "RECONCILE_ONLY",
                    {}, config.bgi_tools.token);
                if (result.status === "REPLANNING") continue;
                log.info(`[计划驱动] 停止领取：{0}，{1}`, result.status, result.message);
                return;
            }
            if (action.status === "PLAN_NEEDS_RECONCILE") {
                const reconcile = await runInventoryReconcileOnce(
                    config, inventoryReconcileState, `计划请求复核：${action.message}`);
                if (reconcile.succeeded && reconcile.performed) {
                    const afterReconcile = await requestJson(
                        "POST", claimUrl, {}, config.bgi_tools.token);
                    if (afterReconcile.status === "ACTION" || afterReconcile.status === "NEEDS_RECONCILE") {
                        action.status = afterReconcile.status;
                        Object.assign(action, afterReconcile);
                    } else {
                        log.warn("[计划驱动] 完整库存复核后仍未开放行动，本轮停止：{0}，{1}",
                            afterReconcile.status, afterReconcile.message);
                        return;
                    }
                } else if (!reconcile.succeeded) {
                    log.warn("[计划驱动] 完整库存复核未闭合，停止本轮执行");
                    return;
                } else {
                    return;
                }
            }
            if (action.status !== "ACTION") {
                log.info(`[计划驱动] 停止领取：{0}，{1}`, action.status, action.message);
                return;
            }
            if (action.actionType === "CRAFT_BATCH") {
                const batchResult = await executeCraftBatchAction(
                    baseUrl, action, executorId, config);
                if (batchResult.shouldReconcile) {
                    log.warn("[计划驱动] 批量合成后强制完整库存复核");
                    if (!await runCultivationInventoryReconcile(config)) return;
                }
                if (!batchResult.shouldContinue) return;
                continue;
            }
            if (action.actionType === "CRAFT") {
            const shouldContinue = await executeCraftAction(baseUrl, action, executorId, config);
            if (!shouldContinue) return;
            log.warn("[计划驱动] 合成 {0} 后强制完整库存复核", action.materialName);
            if (!await runCultivationInventoryReconcile(config)) return;
            continue;
        }
        const shouldContinue = await executeAction(
                baseUrl, action, executorId, config.bgi_tools.token);
            if (action.actionType === "DOMAIN" || action.actionType === "WORLD_BOSS") {
                resinSnapshot = await scanResinSnapshot();
            }
            if (!shouldContinue) return;
        }
    } finally {
        if (startRefreshCompleted) {
            await refreshCurrentOwned(config, "计划结束后");
        }
    }
}
