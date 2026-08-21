/**
 * 追踪委托步骤处理器
 */
import { DIALOG_REGIONS } from "../config/index.js";
import { isInTalkUI, bvPageOcrRegion, RO } from "../vision/index.js";
import { defineStep } from "./define-step.js";

const MAX_STALLED_RECOGNITION_FAILURES = 30;
const MAX_CLOSE_RANGE_INTERACTION_ATTEMPTS = 12;
const CLOSE_RANGE_INTERACTION_INTERVAL_MS = 1000;
const ICONLESS_INTERACTION_START_FAILURES = 10;
const MAX_ICONLESS_INTERACTION_ATTEMPTS = 24;
const ICONLESS_INTERACTION_INTERVAL_MS = 1000;
const ICONLESS_SWEEP_STEP_X = 600;
const MAX_UNKNOWN_DISTANCE_INTERACTION_ATTEMPTS = 80;
const backgroundInput = new PostMessage();

function tryPhysicalInput(action) {
    try {
        action();
        return true;
    } catch (error) {
        return false;
    }
}

function tryBackgroundInput(action) {
    try {
        action();
        return true;
    } catch (error) {
        return false;
    }
}

function pressKeyInBothModes(key) {
    const messageSent = tryBackgroundInput(() => backgroundInput.keyPress(key));
    const physicalSent = tryPhysicalInput(() => keyPress(key));
    if (!messageSent && !physicalSent) {
        throw new Error(`无法向游戏窗口发送按键: ${key}`);
    }
}

function keyDownInBothModes(key) {
    backgroundInput.keyDown(key);
    tryPhysicalInput(() => keyDown(key));
}

function keyUpInBothModes(key) {
    backgroundInput.keyUp(key);
    tryPhysicalInput(() => keyUp(key));
}

/**
 * 根据 iconType 取对应的 RO 模板。
 */
function pickIconRo(iconType) {
    if (iconType === "Base") {
        log.info("使用基础委托图标");
        return RO.iconBaseFull;
    } else if (iconType === "Question") {
        log.info("使用问号任务图标");
        return RO.iconQuestion;
    } else if (iconType === "Task") {
        log.info("使用任务图标");
        return RO.iconTask;
    }
    throw new Error("不支持的追踪图标类型: " + iconType);
}

function parseDistance(text) {
    const match = String(text || "").replace(/[oO]/g, "0").match(/(\d+)\s*m/i);
    return match ? Number(match[1]) : null;
}

function updateNavigationFailureState(state, iconFound, observedDistance) {
    if (!iconFound) {
        state.failCount++;
        return state.failCount;
    }

    if (observedDistance !== null &&
        (state.lastProgressDistance === null || observedDistance < state.lastProgressDistance)) {
        state.failCount = 0;
        state.lastProgressDistance = observedDistance;
    }
    return state.failCount;
}

function shouldUseIconlessInteractionFallback(failureCount, iconFound) {
    return !iconFound && failureCount >= ICONLESS_INTERACTION_START_FAILURES;
}

function updateDistanceCacheUnderIcon(cap, iconRes, state) {
    const area = cap.DeriveCrop(
        Math.round(iconRes.x - 55),
        Math.round(iconRes.y + 32),
        130,
        45
    );
    try {
        const result = area.find(RecognitionObject.ocrThis);
        const text = result && result.text ? result.text.trim() : "";
        const distance = parseDistance(text);
        if (distance !== null) {
            state.distance = distance;
            state.missingDistanceCount = 0;
        } else {
            state.missingDistanceCount++;
            if (state.missingDistanceCount >= 10) {
                state.distance = null;
            }
        }
        return distance;
    } finally {
        area.Dispose();
    }
}

async function clickMatchedNpcFromOcr(targetText) {
    if (!targetText) return false;

    const results = bvPageOcrRegion(DIALOG_REGIONS.DIALOG_OPTIONS);
    for (let i = 0; i < results.count; i++) {
        const item = results[i];
        if (!item.text || !item.text.includes(targetText)) continue;

        log.info("检测到目标交互项，点击进入对话: {text}", item.text);
        keyDownInBothModes("VK_MENU");
        try {
            await sleep(200);
            if (!tryPhysicalInput(() => item.click())) {
                throw new Error("无法向游戏窗口发送目标交互点击");
            }
            await sleep(100);
            leftButtonClick();
        } finally {
            keyUpInBothModes("VK_MENU");
        }
        return true;
    }

    return false;
}

/**
 * 自动导航到 NPC 对话位置
 *
 * 通过地图图标匹配和前进检测，自动导航到目标NPC位置
 * 支持多种图标类型和到达后自动对话功能
 *
 * 坐标说明（基于1920×1080分辨率）：
 * - 屏幕中心约在 (960, 540)
 * - 图标在 (900-1020, <540) 范围内认为视角已调正
 * - 图标Y坐标 >= 520 时说明目标在镜头背后，需大幅调整X轴转身
 *
 * @param {Object} options - 配置选项
 * @param {string} [options.npcName] - 目标 NPC 名称
 * @param {string} [options.iconType] - 图标类型 "Base"|"Question"|"Task"
 * @param {boolean} [options.autoTalk] - 到达后是否自动对话
 * @returns {Promise<void>}
 */
async function autoNavigateToTalk(options = {}) {
    const { npcName = "", iconType = "", autoTalk = false } = options;

    // 目标NPC名称（用于到达检测）
    const targetText = npcName;
    const iconTemplateRO = pickIconRo(iconType);

    // 前进次数计数器（用于超时检测）
    let forwardAttemptCount = 0;
    let lookedDownOnce = false;
    const navigationState = { icon: null, distance: null, missingDistanceCount: 0 };

    middleButtonClick();
    await sleep(800);

    // 停止信号（用于终止后台异步任务）
    const cancel = { flag: false };
    let recognitionError = null;
    let interactionError = null;
    const recognitionState = { failCount: 0, lastProgressDistance: null };

    const recognitionTask = async () => {
        while (!cancel.flag) {
            await sleep(100);
            try {
                const cap = captureGameRegion();
                try {
                    const iconRes = cap.Find(iconTemplateRO);

                    // 识别失败处理
                    if (iconRes.isEmpty()) {
                        const failureCount = updateNavigationFailureState(recognitionState, false, null);
                        navigationState.icon = null;
                        log.warn("图标识别失败，无进展失败次数: {count}/{limit}", failureCount, MAX_STALLED_RECOGNITION_FAILURES);
                        if (failureCount === 1 || failureCount % 5 === 0) {
                            pressKeyInBothModes("v");
                        }
                        await sleep(250);
                        if (failureCount === MAX_STALLED_RECOGNITION_FAILURES) {
                            log.warn("任务图标已连续30次不可见，继续使用有界移动并按F交互兜底");
                        }
                        continue;
                    }

                    navigationState.icon = { x: iconRes.x, y: iconRes.y };
                    const observedDistance = updateDistanceCacheUnderIcon(cap, iconRes, navigationState);
                    updateNavigationFailureState(recognitionState, true, observedDistance);
                } finally { cap.Dispose(); }
            } catch (e) {
                log.error("图标/距离识别异常: {e}", e);
            }
        }
    };

    /**
     * 持续微调视角的异步任务。
     * @param {Object} [options]
     * @param {number|null} [options.maxAdjustCount] - 最大调整次数，null 表示持续调整
     * @param {boolean} [options.stopWhenAligned] - 连续稳定后是否提前返回
     * @param {boolean} [options.pathingTurn] - 寻路中使用更大的转头幅度
     * @returns {Promise<boolean>} 是否在未取消状态下结束
     */
    const adjustTask = async ({ maxAdjustCount = null, stopWhenAligned = false, pathingTurn = false } = {}) => {
        let adjustCount = 0;
        let stableCount = 0;
        while (!cancel.flag && (maxAdjustCount === null || adjustCount < maxAdjustCount)) {
            adjustCount++;
            await sleep(250);
            const icon = navigationState.icon;
            if (!icon) {
                stableCount = 0;
                continue;
            }

            if (Math.abs(icon.x - 960) <= 80 && icon.y < 540) {
                stableCount++;
                if (stopWhenAligned && stableCount >= 2) return true;
                continue;
            }
            stableCount = 0;

            if (icon.y >= 520 && !lookedDownOnce) {
                lookedDownOnce = true;
                log.debug("图标位于画面下方，先下拉镜头后重新判断");
                moveMouseBy(0, 520);
                continue;
            }

            const offsetX = icon.x - 960;
            const yFactor = Math.max(0, Math.min(1, (icon.y - 360) / 420));
            const useAcceleratedTurn = pathingTurn && navigationState.distance === null;
            const gain = useAcceleratedTurn
                ? 1.6 + yFactor * 2.0
                : 0.55 + yFactor * 0.55;
            const maxMove = useAcceleratedTurn
                ? 900 + yFactor * 1100
                : 320 + yFactor * 360;
            const moveX = Math.round(Math.max(-maxMove, Math.min(maxMove, offsetX * gain)));
            if (moveX !== 0) moveMouseBy(moveX, 0);
        }
        return !cancel.flag;
    };

    // === 异步：持续前进 ===
    const moveTask = async () => {
        let jump = 1;
        let closeRangeInteractionAttempts = 0;
        let nextCloseRangeInteractionAt = 0;
        let iconlessInteractionAttempts = 0;
        let nextIconlessInteractionAt = 0;
        let unknownDistanceInteractionAttempts = 0;
        while (!cancel.flag) {
            if (navigationState.distance !== null && navigationState.distance <= 3) {
                keyUpInBothModes("w");
                const now = Date.now();
                if (now >= nextCloseRangeInteractionAt) {
                    if (closeRangeInteractionAttempts >= MAX_CLOSE_RANGE_INTERACTION_ATTEMPTS) {
                        interactionError = new Error("近距离连续按F仍未进入对话");
                        log.error(interactionError.message);
                        cancel.flag = true;
                        return;
                    }

                    closeRangeInteractionAttempts++;
                    log.info("已进入近距离，按F尝试进入对话: {attempt}/{limit}", closeRangeInteractionAttempts, MAX_CLOSE_RANGE_INTERACTION_ATTEMPTS);
                    pressKeyInBothModes("F");
                    nextCloseRangeInteractionAt = now + CLOSE_RANGE_INTERACTION_INTERVAL_MS;
                }
                await sleep(200);
                continue;
            }
            if (shouldUseIconlessInteractionFallback(
                    recognitionState.failCount,
                    navigationState.icon !== null)) {
                keyUpInBothModes("w");
                const now = Date.now();
                if (now >= nextIconlessInteractionAt) {
                    if (iconlessInteractionAttempts >= MAX_ICONLESS_INTERACTION_ATTEMPTS) {
                        interactionError = new Error("未识别到任务图标且连续移动并按F仍未进入对话");
                        log.error(interactionError.message);
                        cancel.flag = true;
                        return;
                    }

                    iconlessInteractionAttempts++;
                    log.info(
                        "图标不可见，横向扫视并按F尝试交互: {attempt}/{limit}",
                        iconlessInteractionAttempts,
                        MAX_ICONLESS_INTERACTION_ATTEMPTS);
                    moveMouseBy(ICONLESS_SWEEP_STEP_X, 0);
                    await sleep(250);
                    if (iconlessInteractionAttempts % 4 === 0) {
                        keyDownInBothModes("w");
                        await sleep(350);
                        keyUpInBothModes("w");
                        await sleep(100);
                        forwardAttemptCount++;
                    }
                    pressKeyInBothModes("F");
                    nextIconlessInteractionAt = now + ICONLESS_INTERACTION_INTERVAL_MS;
                }
                await sleep(200);
                continue;
            }
            if (autoTalk &&
                navigationState.icon !== null &&
                navigationState.distance === null) {
                if (unknownDistanceInteractionAttempts >= MAX_UNKNOWN_DISTANCE_INTERACTION_ATTEMPTS) {
                    interactionError = new Error("目标图标可见但距离不可读，连续微移并按F仍未进入对话");
                    log.error(interactionError.message);
                    cancel.flag = true;
                    return;
                }

                unknownDistanceInteractionAttempts++;
                log.info(
                    "目标图标可见但距离不可读，短步前进并按F尝试交互: {attempt}/{limit}",
                    unknownDistanceInteractionAttempts,
                    MAX_UNKNOWN_DISTANCE_INTERACTION_ATTEMPTS);
                keyDownInBothModes("w");
                await sleep(300);
                keyUpInBothModes("w");
                await sleep(100);
                pressKeyInBothModes("F");
                forwardAttemptCount++;
                await sleep(200);
                continue;
            }
            if (navigationState.distance !== null && navigationState.distance < 5) {
                keyDownInBothModes("w");
                await sleep(600);
                keyUpInBothModes("w");
                await sleep(100);
                forwardAttemptCount++;
                continue;
            }

            jump++;
            keyDownInBothModes("w");
            await sleep(1000);
            if (jump % 2 === 0) {
                pressKeyInBothModes("VK_SPACE");
                await sleep(100);
            }

            keyUpInBothModes("w");
            await sleep(200);
            forwardAttemptCount++;
        }
    };

    // 距离/图标识别高频刷新缓存，镜头校正低频读取缓存，避免频繁转头。
    recognitionTask();

    // 先执行预对准，连续稳定后提前开始前进，避免启动前来回摆动。
    await adjustTask({
        maxAdjustCount: 24,
        stopWhenAligned: true,
    });
    if (cancel.flag) {
        if (recognitionError) throw recognitionError;
        return;
    }

    // === 启动并行异步任务 ===
    adjustTask({ pathingTurn: true });
    moveTask();

    // === 阶段2：OCR 到达检测主循环 ===
    while (!cancel.flag) {
        await sleep(500);
        try {
            if (autoTalk) {
                await clickMatchedNpcFromOcr(targetText);
            }

            if (isInTalkUI()) {
                log.info("已进入对话界面");
                cancel.flag = true;
            } else if (forwardAttemptCount > 300) {
                cancel.flag = true;
                throw new Error("前进时间超时");
            }
        } catch (error) {
            if (cancel.flag) throw error;
            log.warn("目标交互OCR检测异常: {error}", error.message || error);
        }
    }

    // 将后台任务失败交给委托执行器重试或跳过。
    if (interactionError) throw interactionError;
    if (recognitionError) throw recognitionError;
}

const run = async (step) => {
    const targetNpc = step.data.npc || "";
    const iconType = step.data.iconType;
    const autoTalk = step.data.autoTalk;

    log.info("执行追踪委托，目标NPC: {target}，图标类型: {type}", targetNpc, iconType);
    await autoNavigateToTalk({ npcName: targetNpc, iconType: iconType, autoTalk: autoTalk });
    log.info("追踪委托执行完成");
};

export default defineStep({
    type: "追踪委托",
    category: "交互方法",
    dataSpec: {
        kind: "object",
        fields: {
            npc: {
                type: "string",
                label: "交互名称",
                nonEmpty: true,
                alwaysVisible: true,
                hint: "填写要匹配的 NPC 名称或交互项文字，例如“采摘”。",
            },
            iconType: {
                type: "string",
                label: "追踪图标",
                default: "Base",
                alwaysVisible: true,
                options: [
                    { value: "Base", label: "基础委托（Base）" },
                    { value: "Question", label: "问号任务（Question）" },
                    { value: "Task", label: "任务（Task）" },
                ],
            },
            autoTalk: {
                type: "boolean",
                label: "自动点击交互项",
                default: false,
                alwaysVisible: true,
            },
        },
        validate: data => data.autoTalk && !data.npc?.trim() ? "追踪委托启用 autoTalk 时必须填写 data.npc" : "",
    },
    run,
});
