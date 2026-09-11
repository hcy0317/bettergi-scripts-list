/**
 * 乐流奔引步骤处理器
 * 循环识别 MoonLightIcon；完成才成功，失败或循环期限到达交回委托级重试。
 * 本地兼容修复：上游 1.0.3 的该循环没有失败/期限出口。
 */
import { RO } from "../vision/index.js";
import { bvPageOcrRegion, bvPageOcrRegionText } from "../vision/ocr-utils.js";
import { defineStep } from "./define-step.js";
import { rethrowIfCancellation } from "../utils/error-utils.js";

const CHECK_INTERVAL_MS = 500;
const LOOP_TIMEOUT_MS = 120000;
const FAILURE_CHECK_INTERVAL_MS = 2000;
const COMPLETION_REGION = new OpenCvSharp.OpenCvSharp.Rect(880, 165, 160, 45);

function isCommissionCompleted() {
    try {
        const text = bvPageOcrRegionText(COMPLETION_REGION);
        if (text.includes("委托完成")) {
            log.info("识别到委托完成文本: {text}", text);
            return true;
        }
        return false;
    } catch (error) {
        rethrowIfCancellation(error);
        log.debug("乐流奔引委托完成 OCR 失败: {error}", error.message);
        return false;
    }
}

function readChallengeFailure() {
    try {
        // 失败提示不限定在完成提示的小区域；限频全屏读取，只接受明确提示。
        const results = bvPageOcrRegion();
        for (let i = 0; i < results.count; i++) {
            const text = String(results[i].text || "").replace(/\s/g, "");
            if (/^(挑战失败|挑战超时)[!！。]?$/.test(text)) return text;
        }
    } catch (error) {
        rethrowIfCancellation(error);
        log.debug("乐流奔引失败提示 OCR 不可用: {error}", error.message);
    }
    return null;
}

export default defineStep({
    type: "乐流奔引",
    category: "特定委托对策",
    dataSpec: { kind: "none" },
    run: async () => {
        const page = new BvPage();
        const started = Date.now();
        let nextFailureCheck = started;

        log.info("开始执行乐流奔引步骤，循环检测月光图标");
        while (Date.now() - started < LOOP_TIMEOUT_MS) {
            if (isCommissionCompleted()) {
                return true;
            }

            if (Date.now() >= nextFailureCheck) {
                nextFailureCheck = Date.now() + FAILURE_CHECK_INTERVAL_MS;
                const failure = readChallengeFailure();
                if (failure) throw new Error(`[MUSIC_FLOW_FAILED] ${failure}，停止当前步骤并交回委托重试`);
            }

            if (page.locator(RO.moonLightIcon).isExist()) {
                log.info("识别到月光图标，按 T 触发");
                keyPress("t");
                await sleep(300);
            }

            await sleep(CHECK_INTERVAL_MS);
        }
        // registry.process 不消费 handler 的 false 返回值，因此必须抛错交回上层。
        throw new Error("[MUSIC_FLOW_TIMEOUT] 乐流奔引120秒内未确认完成，停止当前步骤并交回委托重试");
    },
});
