/**
 * Basic 攀高危险 - 摧毁哨塔步骤处理器
 */
import { PATHS } from "../config/index.js";
import { RO } from "../vision/index.js";
import { defineStep } from "./define-step.js";
import { isCancellationError } from "../utils/error-utils.js";
import { readTrackedDescriptionText } from "./commission-desc-utils.js";

const WATCHTOWER_CONFIG = {
    /** 单次执行最多摧毁的哨塔数量；攀高危险最多两个，之后的任务图标可能属于其他委托。 */
    maxDestroyCount: 2,
    /** 距离阈值：OCR 识别到哨塔距离小于该值时，停止靠近并进入攻击阶段。 */
    distanceThreshold: 3,
    /** 距离文字连续识别失败上限：达到后认为当前图标不是哨塔，直接结束步骤。 */
    missingDistanceLimit: 5,
    /** 靠近阶段超时时间（毫秒）：超过后仍未进入距离阈值则返回失败。 */
    approachTimeout: 45 * 1000,
    /** 攻击阶段超时时间（毫秒）：进度未变化且未识别到完成提示时停止攻击。 */
    attackTimeout: 30 * 1000,
    /** 战斗期间 OCR 轮询间隔（毫秒）。 */
    statusPollInterval: 200,
    /** 单次前进时长（毫秒）：视角对准图标后按住 W 前进的时间。 */
    forwardMs: 600,
    /** 与乐流奔引一致的“委托完成”提示区域。 */
    completionRegion: new OpenCvSharp.OpenCvSharp.Rect(880, 165, 160, 45),
    /** 距离文字 OCR 区域：以任务图标坐标为基准偏移后裁剪，识别形如 23m 的整数距离。 */
    distanceRegion: {
        /** OCR 区域相对图标 x 坐标的偏移。 */
        offsetX: -55,
        /** OCR 区域相对图标 y 坐标的偏移。 */
        offsetY: 32,
        /** OCR 区域宽度。 */
        width: 130,
        /** OCR 区域高度。 */
        height: 45,
    },
};

const NAVIGATION_ICON = "图标寻路";
const NAVIGATION_PATH = "路径追踪";
/** 每轮优先执行的护盾角色，命中多名时严格保持此顺序。 */
const SHIELD_PRIORITY = ["钟离", "诺艾尔", "绮良良", "茜特菈莉", "迪奥娜", "莱依拉", "托马", "辛焱", "蓝砚"];
const ATTACK_RESULT = {
    PROGRESS: "progress",
    COMPLETED: "completed",
    TIMEOUT: "timeout",
};

function resolveStepOptions(step) {
    if (step.data === undefined || step.data === null) {
        return { navigation: NAVIGATION_ICON, paths: [] };
    }
    if (typeof step.data !== "object" || Array.isArray(step.data)) {
        throw new Error("摧毁哨塔步骤 data 必须是对象");
    }

    const navigation = step.data.navigation || NAVIGATION_ICON;
    if (navigation !== NAVIGATION_ICON && navigation !== NAVIGATION_PATH) {
        throw new Error(`摧毁哨塔步骤 navigation 只能是“${NAVIGATION_ICON}”或“${NAVIGATION_PATH}”`);
    }
    const legacyPath = typeof step.data.path === "string" ? step.data.path.trim() : "";
    const path1 = typeof step.data.path1 === "string" ? step.data.path1.trim() : "";
    const path2 = typeof step.data.path2 === "string" ? step.data.path2.trim() : "";
    if (navigation === NAVIGATION_PATH) {
        if (legacyPath && (path1 || path2)) {
            throw new Error("摧毁哨塔步骤不能混用 data.path 与 data.path1/data.path2");
        }
        if (!legacyPath && (!path1 || !path2)) {
            throw new Error("摧毁哨塔步骤使用路径追踪时必须同时配置 data.path1 和 data.path2");
        }
    }
    return { navigation, paths: navigation === NAVIGATION_PATH ? (legacyPath ? [legacyPath] : [path1, path2]) : [] };
}

/**
 * 解析“丘丘人哨塔0/2”一类委托描述。
 * @returns {{current: number, total: number}|null}
 */
export function parseWatchtowerProgress(text) {
    const normalized = String(text || "")
        .replace(/\s/g, "")
        .replace(/[oO]/g, "0")
        .replace(/[|\\]/g, "/");
    const match = normalized.match(/丘丘人哨塔[:：]?[（(]?(\d+)\/(\d+)(?!\d)/);
    if (!match) return null;
    const current = Number(match[1]), total = Number(match[2]);
    return Number.isInteger(current) && Number.isInteger(total) && total >= 1 && total <= 2 && current <= total
        ? { current, total } : null;
}

function readDestroyStatus(context) {
    const capture = captureGameRegion();
    try {
        const descriptionText = readTrackedDescriptionText(context, capture);
        const rect = WATCHTOWER_CONFIG.completionRegion;
        const area = capture.DeriveCrop(rect.X, rect.Y, rect.Width, rect.Height);
        let completionText;
        try { completionText = String(area.find(RecognitionObject.ocrThis)?.text || "").trim(); }
        finally { area.Dispose(); }
        return {
            source: capture.FrameStamp,
            progress: parseWatchtowerProgress(descriptionText),
            completed: completionText.includes("委托完成"),
        };
    } catch (error) {
        if (isCancellationError(error)) throw error;
        log.debug("摧毁哨塔状态 OCR 失败: {error}", error.message);
        return { source: capture.FrameStamp, progress: null, completed: false };
    } finally { capture.Dispose(); }
}

async function readInitialStatus(context) {
    let previous = null;
    // A single low OCR baseline would turn the old count into false progress later.
    // Bound acquisition by sample count as well as source freshness; misses do not renew it.
    for (let sample = 0; sample < 16; sample++) {
        const current = readDestroyStatus(context);
        const capturedAt = Number(current.source?.CapturedAt?.ToUnixTimeMilliseconds());
        const age = Date.now() - capturedAt;
        const fresh = current.source?.IsKnown && age >= 0 && age <= 1000;
        if (fresh && previous) {
            const previousAt = Number(previous.source.CapturedAt.ToUnixTimeMilliseconds());
            const previousAge = Date.now() - previousAt;
            const sameProgress = previous.progress && current.progress &&
                previous.progress.current === current.progress.current && previous.progress.total === current.progress.total;
            const sameCompletion = previous.completed && current.completed;
            if (current.source.IsAfter(previous.source) && capturedAt - previousAt >= WATCHTOWER_CONFIG.statusPollInterval &&
                previousAge >= 0 && previousAge <= 1000 && (sameProgress || sameCompletion)) {
                current.confirmedBaseline = !!sameProgress;
                current.confirmedComplete = !!(sameCompletion || sameProgress && current.progress.current === current.progress.total);
                return current;
            }
        }
        previous = fresh ? current : null;
        if (sample < 15) await sleep(WATCHTOWER_CONFIG.statusPollInterval);
    }
    throw new Error("BGI_COMBAT_EVIDENCE_UNAVAILABLE: 哨塔起点进度未取得双新帧稳定证据，不启动战斗");
}

/**
 * 从 OCR 文本中解析整数米距离，例如 23m。
 * @param {string} text - OCR 文本
 * @returns {number|null}
 */
function parseDistance(text) {
    const match = String(text || "").replace(/[oO]/g, "0").match(/(\d+)\s*m/i);
    return match ? Number(match[1]) : null;
}

/**
 * 查找任务图标，优先使用中心限定区域基础委托图标，失败后回退到全屏基础委托图标。
 * @param {Object} cap - captureGameRegion() 返回的截图对象
 * @returns {Object|null} 图标匹配结果
 */
function findTaskIcon(cap) {
    const centerIconRes = cap.Find(RO.iconBase);
    if (centerIconRes && !centerIconRes.isEmpty()) return centerIconRes;

    const iconRes = cap.Find(RO.iconBaseFull);
    if (!iconRes || iconRes.isEmpty()) return null;
    return iconRes;
}

/**
 * 判断全屏范围内是否仍存在基础委托图标。
 * @returns {boolean}
 */
function hasAnyBaseIcon() {
    const cap = captureGameRegion();
    try {
        const iconRes = cap.Find(RO.iconBaseFull);
        return !!iconRes && !iconRes.isEmpty();
    } finally {
        cap.Dispose();
    }
}

/**
 * 根据任务图标位置计算距离文字 OCR 裁剪区域。
 * @param {Object} iconRes - 任务图标匹配结果
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function makeDistanceRegion(iconRes) {
    const cfg = WATCHTOWER_CONFIG.distanceRegion;
    const x = Math.round(iconRes.x + cfg.offsetX);
    const y = Math.round(iconRes.y + cfg.offsetY);
    const { width, height } = cfg;
    return { x, y, width, height };
}

/**
 * 从任务图标下方 OCR 距离文本。
 * @param {Object} cap - captureGameRegion() 返回的截图对象
 * @param {Object} iconRes - 任务图标匹配结果
 * @returns {{text: string, distance: number|null}}
 */
function readDistanceFromCapture(cap, iconRes) {
    const region = makeDistanceRegion(iconRes);
    const area = cap.DeriveCrop(region.x, region.y, region.width, region.height);
    try {
        const result = area.find(RecognitionObject.ocrThis);
        const text = result && result.text ? result.text.trim() : "";
        return { text, distance: parseDistance(text) };
    } finally {
        area.Dispose();
    }
}

/**
 * 根据任务图标位置调整镜头朝向。
 * @param {Object} iconRes - 任务图标匹配结果
 * @param {Object} state - 靠近阶段的临时状态
 * @returns {boolean} true 表示图标已在正前方范围，可前进
 */
function adjustViewToIcon(iconRes, state) {
    if (iconRes.x >= 900 && iconRes.x <= 1020 && iconRes.y < 540) {
        return true;
    }

    if (iconRes.y >= 600 && !state.lookedDownOnce) {
        state.lookedDownOnce = true;
        log.debug("图标位于画面下方，先下拉镜头后重新判断");
        moveMouseBy(0, 540);
        return false;
    }

    const distanceToCenter = iconRes.x - 960;
    moveMouseBy(parseInt(Math.round(distanceToCenter) * 0.8), 0);
    return false;
}

/**
 * 按住 W 前进指定时间，并确保最后释放按键。
 * @param {number} duration - 前进时长（毫秒）
 * @returns {Promise<void>}
 */
async function walkForward(duration) {
    keyDown("w");
    try {
        await sleep(duration);
    } finally {
        keyUp("w");
    }
}

/**
 * 持续识别任务图标、调整镜头并向哨塔靠近，直到距离小于阈值。
 * @returns {Promise<boolean|null>} true 表示成功靠近哨塔，null 表示当前图标不是哨塔
 */
async function approachWatchtower() {
    middleButtonClick();
    await sleep(800);

    const startTime = Date.now();
    let failCount = 0;
    let missingDistanceCount = 0;
    const adjustState = { lookedDownOnce: false };
    while (Date.now() - startTime < WATCHTOWER_CONFIG.approachTimeout) {
        const cap = captureGameRegion();
        try {
            const iconRes = findTaskIcon(cap);
            if (!iconRes) {
                failCount++;
                log.warn("任务图标识别失败，连续失败次数: {count}/8", failCount);
                if (failCount >= 8) return false;
                await sleep(300);
                continue;
            }

            failCount = 0;
            if (!adjustViewToIcon(iconRes, adjustState)) {
                await sleep(250);
                continue;
            }

            const { text, distance } = readDistanceFromCapture(cap, iconRes);
            if (distance !== null) {
                missingDistanceCount = 0;
                log.debug("哨塔距离: {distance}m", distance);
                if (distance < WATCHTOWER_CONFIG.distanceThreshold) {
                    return true;
                }
            } else {
                missingDistanceCount++;
                log.warn("未解析到哨塔距离文本: {text}，连续失败次数: {count}/{limit}", text, missingDistanceCount, WATCHTOWER_CONFIG.missingDistanceLimit);
                if (missingDistanceCount >= WATCHTOWER_CONFIG.missingDistanceLimit) {
                    log.info("连续未识别到距离文字，判断当前图标不是哨塔，结束摧毁哨塔步骤");
                    return null;
                }
                await sleep(300);
                continue;
            }

            await walkForward(WATCHTOWER_CONFIG.forwardMs);
        } finally {
            cap.Dispose();
        }
        await sleep(1);
    }

    log.warn("靠近哨塔超时");
    return false;
}

/**
 * 获取 ClearScript 暴露的 C# string[] 中的角色名。
 * @param {Object} avatars - getAvatars() 返回值
 * @param {number} index - 0 基索引
 * @returns {string}
 */
function getAvatarName(avatars, index) {
    return String(avatars.GetValue(index));
}

/**
 * 从已校验的简易策略行中读取角色名。
 * @param {string} line - 格式为“角色名 动作”的策略行
 * @returns {string}
 */
function getStrategyAvatarName(line) {
    return line.match(/^(\S+)/)[1];
}

/**
 * 从统一角色策略文件加载简易策略，并筛选当前队伍中的角色。
 * @returns {string[]} 护盾角色优先、其余角色保持策略文件顺序的当前队伍策略行
 */
function loadCurrentTeamStrategies() {
    const avatars = getAvatars();
    const currentNames = new Set();
    for (let i = 0; i < avatars.Length; i++) {
        currentNames.add(getAvatarName(avatars, i));
    }

    if (!file.isFile(PATHS.AVATAR_STRATEGIES)) throw new Error(`角色策略文件不存在: ${PATHS.AVATAR_STRATEGIES}`);
    const configured = JSON.parse(file.readTextSync(PATHS.AVATAR_STRATEGIES));
    const strategies = Object.entries(configured)
        .filter(([avatarName]) => currentNames.has(avatarName))
        .map(([avatarName, value]) => {
            if (!value || typeof value.script !== "string" || !value.script.trim()) {
                throw new Error(`哨塔简易策略格式错误: ${avatarName}`);
            }
            return `${avatarName} ${value.script.trim()}`;
        });

    if (strategies.length === 0) {
        throw new Error("当前队伍没有匹配到哨塔简易策略");
    }
    const shieldOrder = new Map(SHIELD_PRIORITY.map((name, index) => [name, index]));
    const shieldStrategies = strategies
        .filter((line) => shieldOrder.has(getStrategyAvatarName(line)))
        .sort((left, right) => shieldOrder.get(getStrategyAvatarName(left)) - shieldOrder.get(getStrategyAvatarName(right)));
    const otherStrategies = strategies.filter((line) => !shieldOrder.has(getStrategyAvatarName(line)));
    log.info("当前队伍匹配到 {shieldCount} 条护盾优先策略、{otherCount} 条普通策略", shieldStrategies.length, otherStrategies.length);
    return [...shieldStrategies, ...otherStrategies];
}

function requireCombatSessionProtocol() {
    if (typeof dispatcher.ReadCombatSessionProtocol !== "function" ||
        dispatcher.ReadCombatSessionProtocol() !== "bgi.external-combat.v1" ||
        typeof dispatcher.CreateCombatSession !== "function") {
        throw new Error("当前 BetterGI 不支持外部进度持续战斗会话，请升级到含该能力的构建；不会回退旧循环");
    }
}

/** 同一个哨塔只创建一次会话；监测循环只提交带原始源帧身份的数据，不发送键鼠。 */
async function attackUntilDestroyed(initial, strategies, context, targetId) {
    if (!initial.confirmedBaseline || !initial.source?.IsKnown || !initial.progress || initial.progress.current >= initial.progress.total) {
        throw new Error("BGI_COMBAT_EVIDENCE_UNAVAILABLE: 未确认本哨塔起点进度，不启动战斗");
    }
    const combat = dispatcher.CreateCombatSession(strategies.join("\n"), targetId, initial.source,
        initial.progress.current, initial.progress.total, WATCHTOWER_CONFIG.attackTimeout);
    log.debug("WATCHTOWER_SESSION source=AutoCommissionNova/basic-destroy-watchtower session={session} target={target}",
        combat.SessionId, combat.TargetId);
    let failure = null;
    try {
        while (!combat.IsCompleted) {
            const status = readDestroyStatus(context);
            combat.SubmitProgress(combat.SessionId, combat.TargetId, status.source,
                status.progress ? status.progress.current : -1,
                status.progress ? status.progress.total : initial.progress.total, status.completed);
            if (!combat.IsCompleted) await sleep(WATCHTOWER_CONFIG.statusPollInterval);
        }
        const result = await combat.WaitAsync();
        if (result.Status === "CompletedByExternalProgress")
            return result.Reason === "commission-completed" ? ATTACK_RESULT.COMPLETED : ATTACK_RESULT.PROGRESS;
        if (result.Status === "TimedOut") return ATTACK_RESULT.TIMEOUT;
        if (result.Status === "Cancelled") throw new Error("取消自动任务");
        throw new Error("BGI_COMBAT_SESSION_FAILED: " + result.Status + ": " + result.Reason);
    } catch (error) { failure = error; throw error; }
    finally {
        try { await combat.DisposeAsync(); }
        catch (cleanup) {
            if (failure) throw new AggregateError([failure, cleanup], "哨塔监测与会话清理均失败");
            throw cleanup;
        }
    }
}

/**
 * 图标寻路会循环处理剩余哨塔；路径追踪按配置顺序处理路径终点处的哨塔。
 * 每座哨塔均在到达后才切换近战角色并开始普通攻击。
 * @returns {Promise<boolean>} 是否成功完成哨塔处理
 */
async function destroyAllWatchtowers(options, context) {
    let processedCount = 0;
    // 菜单收束和固定等待在接近前完成，到点后不再空站着做这些准备。
    await genshin.returnMainUi();
    await sleep(500);

    const pathCount = options.paths.length;
    while (processedCount < WATCHTOWER_CONFIG.maxDestroyCount &&
        (options.navigation === NAVIGATION_PATH ? processedCount < pathCount : hasAnyBaseIcon())) {
        if (options.navigation === NAVIGATION_PATH) {
            const fullPath = context.resolveResource(options.paths[processedCount]);
            log.info("使用路径追踪前往第 {count} 个哨塔: {path}", processedCount + 1, fullPath);
            await runCommissionPath(fullPath, context);
            log.info("已到达第 {count} 条路径终点，开始准备攻击哨塔", processedCount + 1);
        }
        log.info("开始处理第 {count} 个哨塔", processedCount + 1);

        if (options.navigation === NAVIGATION_ICON) {
            const approachResult = await approachWatchtower();
            if (approachResult === null) {
                return true;
            }
            if (!approachResult) {
                if (!hasAnyBaseIcon()) {
                    log.info("靠近过程中全屏基础委托图标已消失，结束摧毁哨塔步骤");
                    return true;
                }
                return false;
            }
        }

        const arrivedAt = Date.now();
        // 路径可能改变队伍；先读取策略，再采集新鲜起点帧，不拿加载前的旧截图启动会话。
        const strategyAt = Date.now();
        const attackStrategies = loadCurrentTeamStrategies();
        const strategyMs = Date.now() - strategyAt;
        const statusAt = Date.now();
        const initialStatus = await readInitialStatus(context);
        const statusMs = Date.now() - statusAt;
        if (initialStatus.confirmedComplete) return true;
        if (initialStatus.progress) {
            log.info("攻击前哨塔摧毁进度: {current}/{total}", initialStatus.progress.current, initialStatus.progress.total);
        } else {
            log.warn("攻击前未识别到哨塔起点进度，证据不足，不能启动会话");
        }

        log.debug("WATCHTOWER_HANDOFF arrivalToCombatMs={total} statusMs={status} strategyMs={strategy}",
            Date.now() - arrivedAt, statusMs, strategyMs);

        const attackResult = await attackUntilDestroyed(initialStatus, attackStrategies, context, "watchtower-" + (processedCount + 1));
        if (attackResult === ATTACK_RESULT.COMPLETED) {
            return true;
        }
        if (attackResult === ATTACK_RESULT.TIMEOUT &&
            !(options.navigation === NAVIGATION_PATH && pathCount === 2 && processedCount === 0)) {
            return false;
        }
        if (attackResult === ATTACK_RESULT.TIMEOUT) {
            log.warn("第一座哨塔攻击软超时，继续执行第二条路径");
        }

        processedCount++;
        await sleep(500);
    }

    if (processedCount >= WATCHTOWER_CONFIG.maxDestroyCount) {
        log.info("已达到最大处理数量 {count}，停止继续处理哨塔", WATCHTOWER_CONFIG.maxDestroyCount);
        return true;
    }

    log.info("摧毁哨塔步骤完成，共处理 {count} 个", processedCount);
    return true;
}

export default defineStep({
    type: "摧毁哨塔",
    category: "特定委托对策",
    dataSpec: {
        kind: "object",
        optional: true,
        fields: {
            navigation: {
                type: "string",
                label: "寻路方式",
                default: NAVIGATION_ICON,
                alwaysVisible: true,
                options: [NAVIGATION_ICON, NAVIGATION_PATH],
            },
            path: { type: "string", label: "旧版路径文件", nonEmpty: true, resource: "path" },
            path1: { type: "string", label: "哨塔1路径", nonEmpty: true, resource: "path" },
            path2: { type: "string", label: "哨塔2路径", nonEmpty: true, resource: "path" },
        },
        validate: data => {
            const navigation = data.navigation || NAVIGATION_ICON;
            const hasLegacyPath = data.path !== undefined;
            const hasPath1 = data.path1 !== undefined;
            const hasPath2 = data.path2 !== undefined;
            if (navigation === NAVIGATION_ICON && (hasLegacyPath || hasPath1 || hasPath2)) {
                return "摧毁哨塔使用图标寻路时不能配置路径文件";
            }
            if (navigation === NAVIGATION_PATH && hasLegacyPath && (hasPath1 || hasPath2)) {
                return "摧毁哨塔不能混用 data.path 与 data.path1/data.path2";
            }
            if (navigation === NAVIGATION_PATH && !hasLegacyPath && (!hasPath1 || !hasPath2)) {
                return "摧毁哨塔使用路径追踪时必须同时配置 data.path1 和 data.path2";
            }
            return "";
        },
    },
    run: async (step, context) => {
        try {
            requireCombatSessionProtocol(); // 在归位、路径或任何键鼠输入之前拒绝旧/不兼容构建。
            const options = resolveStepOptions(step);
            log.info("开始执行摧毁哨塔步骤，寻路方式: {navigation}", options.navigation);

            return await destroyAllWatchtowers(options, context);
        } catch (error) {
            if (isCancellationError(error)) throw error;
            log.error("执行摧毁哨塔步骤时出错: {error}", error.message);
            log.debug("详情: {error}", error.stack);
            throw error;
        }
    },
});
import { runCommissionPath } from "../utils/path-healing-recovery.js";
