/**
 * 主流程模块
 * 脚本的主入口逻辑
 */
import { loadSupportedCommissions, saveCommissionsData } from "../data/index.js";
import { recognizeCommissions, initCommissionReferenceData } from "../recognition/index.js";
import { executeCommissionTracking } from "./commission-executor.js";
import { enterCommissionScreen } from "../vision/index.js";
import { loadGlobalConfig } from "../loaders/global-config.js";
import { scanCommissionScopes } from "../loaders/process-scope.js";

async function enterCommissionScreenWithRetry(maxAttempts = 2) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (await enterCommissionScreen()) {
            return;
        }

        if (attempt < maxAttempts) {
            log.warn("第 {attempt}/{maxAttempts} 次进入委托界面失败，返回主界面后重试", attempt, maxAttempts);
            await genshin.returnMainUi();
            await sleep(1000);
        }
    }

    throw new Error(`连续${maxAttempts}次无法进入委托界面，已停止识别以避免使用无效截图`);
}

function validateRecognitionSnapshot(commissions) {
    if (!Array.isArray(commissions) || commissions.length !== 4) {
        throw new Error(`委托识别结果不完整：预期4个槽位，实际${Array.isArray(commissions) ? commissions.length : 0}个`);
    }

    const ids = new Set();
    for (const commission of commissions) {
        const id = Number(commission?.id);
        if (!Number.isInteger(id) || id < 1 || id > 4 || ids.has(id)) {
            throw new Error(`委托识别结果包含无效或重复槽位：${commission?.id}`);
        }
        if (typeof commission?.name !== "string" || commission.name.trim() === "") {
            throw new Error(`第${id}个委托名称识别为空`);
        }
        ids.add(id);
    }

    return commissions;
}

/**
 * 委托识别主函数
 * @param {Array} [commissionScopes] - 可复用的流程范围快照；不传时扫描一次流程目录
 * @returns {Promise<Array>} 识别到的委托列表；失败时返回 []
 */
export async function identification(commissionScopes) {
    try {
        log.info("开始执行委托识别");

        await genshin.returnMainUi();

        const scopes = commissionScopes ?? scanCommissionScopes().list;

        const supportedCommissions = await loadSupportedCommissions(scopes);

        await initCommissionReferenceData(supportedCommissions, scopes);

        await enterCommissionScreenWithRetry();

        const commissions = validateRecognitionSnapshot(
            await recognizeCommissions(supportedCommissions));

        if (commissions && commissions.length > 0) {
            await saveCommissionsData(commissions);
            log.info("委托识别完成，共识别到 {total} 个委托，其中 {supported} 个受支持",
                commissions.length, commissions.filter(function (c) { return c.supported; }).length);
        } else {
            throw new Error("委托识别失败或未识别到任何委托");
        }
        return commissions;
    } catch (error) {
        log.error("识别委托时出错: {error}", error.message);
        log.debug("错误详情: {error}", error);
        throw error;
    }
}

/**
 * 委托前准备工作：前往七天神像
 */
export async function prepareForCommission() {
    log.info("开始执行委托前准备");
    await genshin.returnMainUi();
    const globalConfig = loadGlobalConfig();
    if (!globalConfig.skipSafeTeleport) {
        try {
            await genshin.tpToStatueOfTheSeven();
        } catch (error) {
            log.warn("委托前安全传送失败，将在当前主世界位置继续执行: {error}", error.message);
            await genshin.returnMainUi();
        }
    }
}

/**
 * 主流程执行函数
 * @param {Object} stepRegistry - 步骤处理器注册表
 * @param {Array} [commissionScopes] - 启动阶段生成的流程范围快照
 */
export async function executeMainProcess(stepRegistry, commissionScopes) {
    try {
        // 先前往安全点，确保已离开尘歌壶等无法打开冒险之证的区域。
        await prepareForCommission();

        await identification(commissionScopes);

        const allCompleted = await executeCommissionTracking(stepRegistry);
        if (!allCompleted) {
            throw new Error(`每日委托未全部完成，请检查本次委托日志`);
        }

        const globalConfig = loadGlobalConfig();
        if (!globalConfig.skipSafeTeleport) {
            log.info("前往安全地点");
            try {
                await genshin.tpToStatueOfTheSeven();
            } catch (error) {
                log.warn("每日委托已完成，但前往安全地点失败: {error}", error.message);
                await genshin.returnMainUi();
            }
        }
        log.info("每日委托执行完成");

    } catch (error) {
        log.error("执行主流程时出错: {error}", error.message);
        throw error;
    }
}

