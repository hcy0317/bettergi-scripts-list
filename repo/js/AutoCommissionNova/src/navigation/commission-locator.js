/**
 * 委托目标查找/追踪模块
 * - findCommissionTarget: 激活追踪 + 识别并返回大地图坐标
 * - trackCommission:      仅激活追踪，不识别坐标（executor 启动时使用）
 */
import { OCR_REGIONS } from "../config/index.js";
import { enterCommissionScreen, isInMainUI } from "../vision/index.js";
import { findCommissionIndex, getCommissionPosition, clickCommissionAndOpenMap } from "../recognition/index.js";

import { RO } from "../vision/templates/index.js";
import { normalizePosition } from "./position-utils.js";
import { isCancellationError } from "../utils/error-utils.js";

function tryPhysicalInput(action) {
    try {
        action();
        return true;
    } catch (error) {
        if (isCancellationError(error)) throw error;
        return false;
    }
}

function clickTrackingInBothModes() {
    const physicalSent = tryPhysicalInput(() => click(1693, 1000));
    if (!physicalSent) {
        throw new Error("无法向游戏窗口发送追踪点击");
    }
}

function closeMapInBothModes() {
    if (!tryPhysicalInput(() => keyPress("VK_ESCAPE"))) {
        throw new Error("无法向游戏窗口发送关闭地图按键");
    }
}

async function finishMapTransaction() {
    closeMapInBothModes();
    await sleep(150);
    await genshin.returnMainUi();
    if (!isInMainUI()) throw new Error("commission-main-ui-unavailable");
}

/**
 * 寻找委托目标位置并追踪
 * @param {string} commissionName - 委托名称
 * @returns {Promise<Object|null>} 位置对象
 */
export async function findCommissionTarget(commissionName) {
    let failure = null;
    let position = null;
    let mapOpened = false;
    try {
        const page = new BvPage();
        await genshin.returnMainUi();
        await enterCommissionScreen();
        const foundIndex = await findCommissionIndex(commissionName);
        if (foundIndex === -1) throw new Error("commission-position-unavailable: 未找到委托 " + commissionName);
        await clickCommissionAndOpenMap(page, foundIndex);
        mapOpened = true;
        await page.locator(RO.track).waitFor();
        const tracking = page.locator("停止追踪", OCR_REGIONS.COMMISSION_TRACKING);
        if (!tracking.isExist()) {
            await tracking.withRetryInterval(1000).withRetryAction(clickTrackingInBothModes).waitFor();
            await sleep(150);
        }
        // Tracking can change the page. The coordinate reader requires the map to remain open.
        await page.locator(RO.track).waitFor();
        position = normalizePosition(await getCommissionPosition());
        if (!position) throw new Error("commission-position-unavailable: " + commissionName);
    } catch (error) {
        if (isCancellationError(error)) throw error;
        failure = error;
    }
    try {
        if (mapOpened) await finishMapTransaction();
        else {
            await genshin.returnMainUi();
            if (!isInMainUI()) throw new Error("commission-main-ui-unavailable");
        }
    } catch (cleanupError) {
        if (isCancellationError(cleanupError)) throw cleanupError;
        const error = new Error("commission-position-unavailable: 页面清理失败; " +
            (failure ? failure.message + "; " : "") + cleanupError.message);
        error.cause = failure;
        error.cleanupError = cleanupError;
        throw error;
    }
    if (failure) throw failure;
    return position;
}

/**
 * 仅激活委托追踪，不识别坐标
 * 委托坐标在 OCR 识别阶段已存入 commission.commissionPosition，executor 启动时
 * 只需要激活追踪点供后续寻路使用，不需要再读一次大地图
 * @param {string} commissionName - 委托名称
 * @returns {Promise<boolean>} 是否成功激活追踪
 */
export async function trackCommission(commissionName) {
    try {
        const page = new BvPage();
        log.debug("开始追踪委托: {name}", commissionName);
        await genshin.returnMainUi();

        await enterCommissionScreen();

        const foundIndex = await findCommissionIndex(commissionName);
        if (foundIndex === -1) {
            log.warn("未找到委托: {name}", commissionName);
            return false;
        }

        await clickCommissionAndOpenMap(page, foundIndex);

        await page.locator("停止追踪", OCR_REGIONS.COMMISSION_TRACKING).withRetryInterval(1000).withRetryAction(clickTrackingInBothModes).waitFor();
        await page.locator("停止追踪", OCR_REGIONS.COMMISSION_TRACKING).withRetryInterval(1000).withRetryAction(closeMapInBothModes).waitForDisappear();

        await genshin.returnMainUi();

        return true;
    } catch (error) {
        if (isCancellationError(error)) throw error;
        log.error("追踪委托时出错: {error}", error.message);
        log.debug("错误详情:", error);
        return false;
    }
}
