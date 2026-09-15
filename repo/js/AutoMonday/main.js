(async function () {
    if (typeof taskResult === 'undefined' || typeof taskResult.requireExplicitOutcome !== 'function' ||
        typeof taskResult.report !== 'function' || typeof taskResult.check !== 'function') {
        throw new Error('[BGI_TASK_RESULT_REQUIRED] 周一自动化需要支持明确任务结果的BetterGI版本');
    }
    taskResult.requireExplicitOutcome();
    if (typeof file.compareExchangeTextSync !== 'function') {
        taskResult.report('Failed', 'HOST_ATOMIC_STORAGE_REQUIRED');
        return;
    }
    const nativeLog = globalThis.log;
    const log = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
        log[level] = (...args) => { try { nativeLog[level](...args); } catch (_) { /* 诊断不得改变业务结果。 */ } };
    }
    const taskOutcomes = [];
    let recoveryInProgress = false;
    let continuationAllowed = true;
    function checkTask() {
        try { taskResult.check(); }
        catch (error) { continuationAllowed = false; throw error; }
    }
    function taskOutcome(kind, reason) { return { kind, reason }; }
    function finish(kind, reason) { checkTask(); taskResult.report(kind, String(reason).slice(0, 2048)); }
    function taskFailure(error) {
        checkTask();
        const pending = activeAction && progressCache && progressCache.actions[activeAction];
        const needsReconcile = pending || (error.code && /^(CD_|PROGRESS_|CONSUMPTION_)/.test(error.code));
        return taskOutcome(needsReconcile ? 'NeedsReconcile' : 'Failed',
            error.code || (pending ? 'CONSUMPTION_RESULT_UNKNOWN' : 'TASK_EXCEPTION'));
    }
    function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
    function readUiRows(phase, rect = [0, 0, 1920, 1080], notBefore = 0) {
        checkTask();
        let frame;
        try {
            frame = captureGameRegion();
            const source = frame.FrameStamp;
            const at = source && source.IsKnown ? Number(source.CapturedAt.ToUnixTimeMilliseconds()) : NaN;
            if (!Number.isFinite(at) || at < notBefore || Date.now() - at < 0 || Date.now() - at > 2000)
                throw codedError('UI_SOURCE_UNAVAILABLE', '非战斗UI源帧无效或过期');
            const found = frame.findMulti(RecognitionObject.ocr(...rect));
            const rows = [];
            for (let i = 0; i < found.count; i++) rows.push({ text: String(found[i].text), x: found[i].x, y: found[i].y,
                width: found[i].width, height: found[i].height });
            checkTask();
            if (Date.now() - at > 2000) throw codedError('UI_SOURCE_UNAVAILABLE', '非战斗UI识别返回时源帧已过期');
            return { source, rows };
        } finally { if (frame) frame.dispose(); }
    }
    function tryReadUiRows(phase, rect, notBefore) {
        try { return readUiRows(phase, rect, notBefore); }
        catch (error) {
            checkTask();
            if (error.code === 'UI_SOURCE_UNAVAILABLE') return null;
            throw error;
        }
    }
    async function nextUiRows(phase, notBefore = 0) {
        const deadline = Date.now() + 3000;
        do {
            const sample = tryReadUiRows(phase, undefined, notBefore);
            if (sample && Date.now() < deadline) return sample;
            await sleep(100);
        } while (Date.now() < deadline);
        throw codedError('UI_SOURCE_UNAVAILABLE', '期限内没有取得新鲜UI帧：' + phase);
    }
    async function requireUiText(text, rect = [0, 0, 1920, 1080], clickIt = false, exact = false) {
        const labels = Array.isArray(text) ? text : [text];
        let last = [];
        const deadline = Date.now() + 3000;
        do {
            const sample = tryReadUiRows(text, rect);
            if (!sample) { await sleep(100); continue; }
            if (Date.now() >= deadline) break;
            last = sample.rows;
            const hit = last.find(row => labels.some(label => exact ? row.text === label : row.text.includes(label)));
            if (hit) { checkTask(); if (clickIt) click(hit.x, hit.y); return hit; }
            await sleep(100);
        } while (Date.now() < deadline);
        log.debug('MONDAY_UI phase={phase} rows={rows}', text,
            last.slice(0, 24).map(row => row.text.replace(/\d{6,}/g, '[number]')).join('|').slice(0, 1000));
        throw codedError('UI_EXPECTED_TEXT_MISSING', '未确认操作页面：' + text);
    }
    async function readWeeklyForgingProgress() {
        await genshin.returnMainUi();
        keyPress('F4');
        await sleep(1000);
        await requireUiText(['本周任务', '每周任务'], [0, 0, 1920, 300], true);
        let previous = null;
        let last = [];
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const sample = tryReadUiRows('weekly-forging-progress');
            if (!sample) { previous = null; await sleep(200); continue; }
            if (Date.now() >= deadline) break;
            last = sample.rows;
            const title = sample.rows.find(row => /锻造.*20|20.*锻造/.test(row.text));
            if (title) {
                const sameRow = sample.rows.filter(row => Math.abs(row.y - title.y) <= Math.max(30, Number(title.height) || 0));
                const count = sameRow.map(row => row.text.match(/(?:^|[^\d])(\d+)\s*[/／]\s*20(?:[^\d]|$)/)).find(Boolean);
                if (count && Number(count[1]) <= 20) {
                    const value = Number(count[1]);
                    if (previous && previous.value === value && sample.source.IsAfter(previous.source)) return value;
                    previous = { value, source: sample.source };
                }
            }
            await sleep(200);
        }
        log.debug('MONDAY_UI phase=weekly-forging-progress rows={rows}',
            last.slice(0, 24).map(row => row.text.replace(/\d{6,}/g, '[number]')).join('|').slice(0, 1000));
        throw codedError('FORGE_GOAL_UNCONFIRMED', '未取得本周锻造20件目标的两帧进度证据');
    }
    // 非战斗UI后置条件：同一张新截图同时满足各项文字证据，只输出标量，不保留截图。
    async function waitForTexts(probes, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        let diagnosticWritten = false;
        do {
            checkTask();
            let frame = null;
            try {
                frame = captureGameRegion();
                if (probes.every(probe => {
                    const rows = frame.findMulti(RecognitionObject.ocr(...probe.rect));
                    for (let i = 0; i < rows.count; i++)
                        if (probe.exact ? rows[i].text === probe.text : rows[i].text.includes(probe.text)) return true;
                    return false;
                })) { checkTask(); return true; }
            } catch (error) {
                checkTask();
                if (!diagnosticWritten) { log.debug('MONDAY_UI 证据读取失败：{reason}', error.message); diagnosticWritten = true; }
            } finally { if (frame) frame.dispose(); }
            await sleep(100);
        } while (Date.now() < deadline);
        log.debug('MONDAY_UI 期限内未确认：{evidence}', probes.map(probe => probe.text).join('+'));
        return false;
    }
    async function recoverBoundary(failureContext) {
        checkTask();
        recoveryInProgress = true;
        if (typeof genshin.recoverMainUi !== 'function')
            throw codedError('HOST_RECOVERY_API_REQUIRED', '需要包含脚本安全恢复接口的BetterGI版本');
        await genshin.recoverMainUi(failureContext || null);
        checkTask();
        recoveryInProgress = false;
    }
    function aggregateOutcomes(outcomes = taskOutcomes) {
        const priority = { Skipped: 0, Completed: 1, Deferred: 2, NeedsReconcile: 3, Failed: 4, Cancelled: 5 };
        let kind = 'Skipped';
        for (const outcome of outcomes)
            if (priority[outcome.kind] > priority[kind]) kind = outcome.kind;
        return taskOutcome(kind, outcomes.length ? outcomes.map(value => `${value.name}:${value.kind}/${value.reason}`).join('; ') : 'NO_ENABLED_TASKS');
    }
    // ===== 1. 预处理部分 =====

    // 人机验证
    if (!settings.ifCheck) { log.error("请阅读readme文件并做好相关设置后再运行此脚本！"); finish('Failed', 'SETTINGS_NOT_CONFIRMED'); return; }

    //初始化配置
    var Material = settings.Material;
    const actiontime = 180;//最大等待时间，单位秒
    const BH = `assets/RecognitionObject/${Material}.png`;
    const ZHIBIANYI = "assets/RecognitionObject/zhibian.png";
    const CHA = "assets/RecognitionObject/cha.png";
    const xingChen = "assets/RecognitionObject/星尘.png";
    const BATTLE_PASS_LEVEL_50 = "assets/RecognitionObject/纪行等级50.png";
    const battlePassLevel50Ro = RecognitionObject.TemplateMatch(
        file.ReadImageMatSync(BATTLE_PASS_LEVEL_50),
        0,
        0,
        1920,
        1080
    );
    const ifAkf = settings.ifAkf;
    const zbyChargingMethod = settings.zbyChargingMethod || settings.chargingMethod || "电气水晶充能";
    const akfChargingMethod = settings.akfChargingMethod || settings.chargingMethod || "电气水晶充能";
    const zbyTeam = settings.ZBYTeamName || settings.TEAMname;
    const akfTeam = settings.AKFTeamName || settings.TEAMname;
    const ifCooking = settings.ifCooking;
    const ifduanZao = settings.ifduanZao;
    const ifShouling = settings.ifShouling;
    const ifMijing = settings.ifMijing;
    const skipCookingWhenBattlePassFull = settings.skipCookingWhenBattlePassFull;
    const skipForgingWhenBattlePassFull = settings.skipForgingWhenBattlePassFull;
    const skipBossWhenBattlePassFull = settings.skipBossWhenBattlePassFull;
    const skipDomainWhenBattlePassFull = settings.skipDomainWhenBattlePassFull;
    const ifbuyNet = settings.ifbuyNet;
    const ifbuyTzq = settings.ifbuyTzq;
    const ifPink = settings.ifPink;
    const ifBlue = settings.ifBlue;
    const ifChange = ifPink || ifBlue;
    const ifZBY = settings.ifZBY;
    const food = settings.food; // 要烹饪的食物
    const cookCount = settings.cookCount;//烹饪数量
    const mineral = settings.mineral;// 矿石种类
    const mineralFile = `assets/RecognitionObject/${mineral}.png`;// 矿石模板路径
    const BossPartyName = settings.BossPartyName;// 战斗队伍
    // OCR对象用于检测战斗文本
    const ocrRo2 = RecognitionObject.Ocr(0, 0, 1920, 1080);

    // 创建材质到ITEM的映射表
    // 养成道具=1，食物=2，材料=3
    const materialToItemMap = {
        "牛角": 1,
        "苹果": 2, "日落果": 2, "泡泡桔": 2,
        "白铁块": 3, "水晶块": 3, "薄荷": 3, "菜": 3,
        "鸡腿": 3, "蘑菇": 3, "鸟蛋": 3, "兽肉": 3, "甜甜花": 3
    };

    // 直接通过映射获取ITEM值（未匹配时默认0）
    const ITEM = materialToItemMap[Material] || 0;

    if (ifZBY && zbyChargingMethod == "法器角色充能" && (!zbyTeam || zbyTeam.trim() === "")) {
        log.error("您选择了法器角色充能，请在配置页面填写包含法器角色的队伍名称！！！");
        finish('Failed', 'ZBY_TEAM_NOT_CONFIGURED');
        return;// 没选就报错后停止
    }

    // 爱可菲任务始终需要切换到包含爱可菲的队伍
    if (ifAkf && (!akfTeam || akfTeam.trim() === "")) {
        log.error("您选择了拥有爱可菲，请在配置页面填写包含爱可菲的队伍名称！！！");
        finish('Failed', 'AKF_TEAM_NOT_CONFIGURED');
        return;// 没选就报错后停止
    }

    const username = settings.username || "默认账户";
    const cdRecordPath = `record/${username}_cd.txt`;// 修改CD记录文件路径，包含用户名
    const progressPath = `record/${username}_progress.v1.json`;
    let progressCache = null;
    let progressSource = null;
    let storageConflict = false;
    const cdSources = new WeakMap();
    let activeAction = null;

    function readProgress() {
        if (progressCache) return progressCache;
        const body = readOptionalText(progressPath);
        progressSource = body;
        if (body === null) return progressCache = { schemaVersion: 1, actions: {} };
        try {
            const value = JSON.parse(body);
            if (value.schemaVersion !== 1 || !value.actions || typeof value.actions !== 'object' || Array.isArray(value.actions))
                throw new Error('invalid progress');
            for (const name of Object.keys(value.actions)) {
                const entry = value.actions[name];
                if (!entry || !['pending', 'confirmed'].includes(entry.state) || typeof entry.startedAt !== 'string' ||
                    !Number.isFinite(new Date(entry.startedAt).getTime()) ||
                    (entry.state === 'confirmed' && (typeof entry.cooldownUntil !== 'string' ||
                        !Number.isFinite(new Date(entry.cooldownUntil).getTime()) || typeof entry.confirmedAt !== 'string' ||
                        !Number.isFinite(new Date(entry.confirmedAt).getTime()) || typeof entry.evidence !== 'string' || !entry.evidence)))
                    throw new Error('invalid action progress');
                if (entry.batch && (typeof entry.batch !== 'object' || Array.isArray(entry.batch) ||
                    !Number.isSafeInteger(entry.batch.total) || entry.batch.total <= 0 ||
                    !Number.isSafeInteger(entry.batch.completed) || entry.batch.completed < 0 || entry.batch.completed > entry.batch.total ||
                    typeof entry.batch.inFlight !== 'boolean' || typeof entry.batch.cooldownUntil !== 'string' ||
                    !Number.isFinite(new Date(entry.batch.cooldownUntil).getTime())))
                    throw new Error('invalid batch progress');
            }
            return progressCache = value;
        } catch (_) { throw codedError('PROGRESS_INVALID', '周一消耗进度损坏，需要复核，不能按空进度执行'); }
    }

    async function saveProgress() {
        checkTask();
        const body = JSON.stringify(progressCache, null, 2);
        if (file.compareExchangeTextSync(progressPath, progressSource, body) !== true) {
            storageConflict = true;
            throw codedError('PROGRESS_WRITE_CONFLICT', '账户进度已由其他运行修改，保留当前记录并停止消费');
        }
        progressSource = body;
        if (readOptionalText(progressPath) !== body) {
            storageConflict = true;
            throw codedError('PROGRESS_WRITE_UNCONFIRMED', '未确认消耗进度已保存，停止本次行动');
        }
        checkTask();
    }

    async function beginAction(name, metadata = {}) {
        const progress = readProgress();
        if (progress.actions[name]) throw codedError('CONSUMPTION_PENDING', '同一消耗行动尚未闭合');
        activeAction = name;
        progress.actions[name] = { ...metadata, state: 'pending', startedAt: new Date().toISOString() };
        await saveProgress();
        log.debug('MONDAY_ACTION action={action} phase=pending-persisted', name);
    }

    async function resumeAction(name) {
        const progress = readProgress();
        const entry = progress.actions[name];
        if (!entry) return null;
        activeAction = name;
        if (entry.state !== 'confirmed') return taskOutcome('NeedsReconcile', 'CONSUMPTION_PENDING');
        const records = await readCDRecords();
        records[name] = entry.cooldownUntil;
        await writeCDRecords(records);
        delete progress.actions[name];
        await saveProgress();
        activeAction = null;
        return new Date(entry.cooldownUntil) > new Date() ? taskOutcome('Completed', 'CONFIRMED_RECEIPT_REPLAYED') : null;
    }

    async function confirmAction(name, cooldownUntil, evidence) {
        const progress = readProgress();
        if (!progress.actions[name]) throw codedError('PROGRESS_MISSING', '缺少本次消耗意图，不能写入完成CD');
        progress.actions[name] = { ...progress.actions[name], state: 'confirmed', cooldownUntil, evidence,
            confirmedAt: new Date().toISOString() };
        await saveProgress();
        return await resumeAction(name);
    }

    // 原生路线/挑战各轮有独立完成回执。准备和重试不能把已确认轮次归零。
    async function runConfirmedBatch(name, total, prepare, runRound, evidence) {
        const resumed = await resumeAction(name);
        if (resumed && resumed.kind !== 'NeedsReconcile') return resumed;
        const progress = readProgress();
        let entry = progress.actions[name];
        if (entry) {
            if (!entry.batch || entry.batch.total !== total || entry.batch.inFlight)
                return taskOutcome('NeedsReconcile', 'BATCH_ROUND_RESULT_UNKNOWN');
        } else {
            if (!isRouteAvailable(name, await readCDRecords())) return taskOutcome('Skipped', 'CD_ACTIVE');
            entry = { state: 'pending', startedAt: new Date().toISOString(),
                batch: { total, completed: 0, inFlight: false, cooldownUntil: getNextMonday4AMISO() } };
            progress.actions[name] = entry;
        }
        activeAction = name;
        const batch = entry.batch;
        if (new Date(batch.cooldownUntil) <= new Date()) return taskOutcome('NeedsReconcile', 'BATCH_PERIOD_EXPIRED');
        await saveProgress();
        if (batch.completed < total) await prepare();
        while (batch.completed < total) {
            checkTask();
            if (new Date(batch.cooldownUntil) <= new Date()) return taskOutcome('NeedsReconcile', 'BATCH_PERIOD_EXPIRED');
            batch.inFlight = true;
            await saveProgress();
            if (await runRound(batch.completed + 1) !== true)
                throw codedError('CONSUMPTION_BATCH_UNCONFIRMED', '本轮原生完成结果未确认');
            checkTask();
            batch.completed++;
            batch.inFlight = false;
            await saveProgress();
            log.info('MONDAY_BATCH action={action} completed={completed}/{total}', name, batch.completed, total);
        }
        return await confirmAction(name, batch.cooldownUntil, evidence);
    }

    // 定义任务列表
    const tasks = [
        { condition: ifZBY, func: autoZhibian, name: "质变仪" },
        { condition: ifAkf, func: autoAkf, name: "爱可菲" },
        { condition: ifCooking, func: Cooking, name: "做菜", cdRouteName: "每周做菜", skipWhenBattlePassFull: skipCookingWhenBattlePassFull },
        { condition: ifduanZao, func: duanZao, name: "锻造", cdRouteName: "每周锻造", skipWhenBattlePassFull: skipForgingWhenBattlePassFull },
        { condition: ifShouling, func: hitBoss, name: "首领", cdRouteName: "每周首领", skipWhenBattlePassFull: skipBossWhenBattlePassFull },
        { condition: ifMijing, func: AutoDomain, name: "秘境", cdRouteName: "每周秘境", skipWhenBattlePassFull: skipDomainWhenBattlePassFull },
        { condition: ifbuyNet, func: buyNet, name: "购买四方八方之网" },
        { condition: ifbuyTzq, func: buyTzq, name: "购买投资券" },
        { condition: ifChange, func: getPinkandBlue, name: "粉球篮球兑换" }
    ];

    // ===== 2. 子函数定义部分 =====

    /**
     * 封装函数，执行图片识别及点击操作（测试中，未封装完成，后续会优化逻辑）
     * @param {string} imagefilePath - 模板图片路径
     * @param {number} timeout - 超时时间(秒)
     * @param {number} afterBehavior - 识别后行为(0:无,1:点击,2:按F键)
     * @param {number} debugmodel - 调试模式(0:关闭,1:详细日志)
     * @param {number} xa - 识别区域X坐标
     * @param {number} ya - 识别区域Y坐标
     * @param {number} wa - 识别区域宽度
     * @param {number} ha - 识别区域高度
     * @param {boolean} clickCenter - 是否点击目标中心
     * @param {number} clickOffsetX - 点击位置X轴偏移量
     * @param {number} clickOffsetY - 点击位置Y轴偏移量
     * @param {number} tt - 匹配阈值(0-1)
     */
    async function imageRecognitionEnhanced(
        imagefilePath = "空参数",
        timeout = 10,
        afterBehavior = 0,
        debugmodel = 0,
        xa = 0,
        ya = 0,
        wa = 1920,
        ha = 1080,
        clickCenter = false,  // 新增：是否点击中心
        clickOffsetX = 0,    // 新增：X轴偏移量
        clickOffsetY = 0,    // 新增：Y轴偏移量
        tt = 0.8
    ) {
        // 参数验证
        if (xa + wa > 1920 || ya + ha > 1080) {
            log.info("图片区域超出屏幕范围");
            return { found: false, error: "区域超出屏幕范围" };
        }

        const startTime = Date.now();
        let captureRegion = null;
        let templateImage = null;
        let result = { found: false };

        try {
            // 读取模板图像
            templateImage = file.ReadImageMatSync(imagefilePath);
            if (!templateImage) {
                throw new Error("无法读取模板图像");
            }

            const Imagidentify = RecognitionObject.TemplateMatch(templateImage, true);
            if (tt !== 0.8) {
                Imagidentify.Threshold = tt;
                Imagidentify.InitTemplate();
            }

            // 循环尝试识别
            for (let attempt = 0; attempt < 10; attempt++) {
                if (Date.now() - startTime > timeout * 1000) {
                    if (debugmodel === 1) {
                        log.info(`${timeout}秒超时退出，未找到图片`);
                    }
                    break;
                }

                captureRegion = captureGameRegion();
                if (!captureRegion) {
                    await sleep(200);
                    continue;
                }

                let croppedRegion = null;
                try {
                    croppedRegion = captureRegion.DeriveCrop(xa, ya, wa, ha);
                    const res = croppedRegion.Find(Imagidentify);

                    if (res.isEmpty()) {
                        if (debugmodel === 1) {
                            log.info("识别图片中...");
                        }
                    } else {
                        // 计算基准点击位置（目标的左上角）
                        let clickX = res.x + xa;
                        let clickY = res.y + ya;

                        // 如果要求点击中心，计算中心点坐标
                        if (clickCenter) {
                            clickX += Math.floor(res.width / 2);
                            clickY += Math.floor(res.height / 2);
                        }

                        // 应用自定义偏移量
                        clickX += clickOffsetX;
                        clickY += clickOffsetY;

                        if (debugmodel === 1) {
                            log.info("计算后点击位置：({x},{y})", clickX, clickY);
                        }

                        // 执行识别后行为
                        if (afterBehavior === 1) {
                            await sleep(1000);
                            click(clickX, clickY);
                        } else if (afterBehavior === 2) {
                            await sleep(1000);
                            keyPress("F");
                        }

                        result = {
                            x: clickX,
                            y: clickY,
                            w: res.width,
                            h: res.height,
                            found: true
                        };
                        break;
                    }
                } finally {
                    if (croppedRegion) croppedRegion.dispose();
                    if (captureRegion) {
                        captureRegion.dispose();
                        captureRegion = null;
                    }
                }

                await sleep(200);
            }
        } catch (error) {
            checkTask();
            log.info(`图像识别错误: ${error.message}`);
            result.error = error.message;
        } finally {
            if (captureRegion) captureRegion.dispose();
            if (templateImage) templateImage.dispose();
        }

        return result;
    }

    /**
     * 文字OCR识别封装函数（支持空文本匹配任意文字）
     * @param {string} text - 要识别的文字，默认为"空参数"，空字符串会匹配任意文字
     * @param {number} timeout - 超时时间，单位为秒，默认为10秒
     * @param {number} afterBehavior - 点击模式，0=不点击，1=点击文字位置，2=按F键，默认为0
     * @param {number} debugmodel - 调试模式，0=无输出，1=基础日志，2=详细输出，3=立即返回，默认为0
     * @param {number} x - OCR识别区域起始X坐标，默认为0
     * @param {number} y - OCR识别区域起始Y坐标，默认为0
     * @param {number} w - OCR识别区域宽度，默认为1920
     * @param {number} h - OCR识别区域高度，默认为1080
     * @param {number} matchMode - 匹配模式，0=包含匹配，1=精确匹配，默认为0
     * @returns {object} 包含识别结果的对象 {text, x, y, found}
     */
    async function textOCREnhanced(
        text = "空参数",
        timeout = 10,
        afterBehavior = 0,
        debugmodel = 0,
        x = 0,
        y = 0,
        w = 1920,
        h = 1080,
        matchMode = 0
    ) {
        const startTime = Date.now();
        const timeoutMs = timeout * 1000;
        let lastResult = null;
        let captureRegion = null; // 用于存储截图对象

        // 只在调试模式1下输出基本信息
        if (debugmodel === 1) {
            if (text === "") {
                log.info(`OCR: 空文本模式 - 匹配任意文字`);
            } else if (text === "空参数") {
                log.warn(`OCR: 使用默认参数"空参数"`);
            }
        }

        while (Date.now() - startTime < timeoutMs) {
            try {
                // 获取截图并进行OCR识别
                captureRegion = captureGameRegion();
                const resList = captureRegion.findMulti(RecognitionObject.ocr(x, y, w, h));

                // 遍历识别结果
                for (let i = 0; i < resList.count; i++) {
                    const res = resList[i];

                    // 检查是否匹配
                    let isMatched = false;
                    if (text === "") {
                        // 空文本匹配任意文字
                        isMatched = true;
                    } else if (matchMode === 1) {
                        // 精确匹配
                        isMatched = res.text === text;
                    } else {
                        // 包含匹配（默认）
                        isMatched = res.text.includes(text);
                    }

                    if (isMatched) {
                        // 只在调试模式1下输出匹配成功信息
                        if (debugmodel === 1) {
                            log.info(`OCR成功: "${res.text}" 位置(${res.x},${res.y})`);
                        }

                        // 调试模式3: 立即返回
                        if (debugmodel === 3) {
                            // 释放内存
                            if (captureRegion) {
                                captureRegion.dispose();
                            }
                            return { text: res.text, x: res.x, y: res.y, found: true };
                        }

                        // 执行后续行为
                        switch (afterBehavior) {
                            case 1: // 点击文字位置
                                await sleep(1000);
                                click(res.x, res.y);
                                break;
                            case 2: // 按F键
                                await sleep(100);
                                keyPress("F");
                                break;
                            default:
                                // 不执行任何操作
                                break;
                        }

                        // 记录最后一个匹配结果但不立即返回
                        lastResult = { text: res.text, x: res.x, y: res.y, found: true };
                    }
                }

                // 释放截图对象内存
                if (captureRegion) {
                    captureRegion.dispose();
                }

                // 如果找到匹配结果，根据调试模式决定是否立即返回
                if (lastResult && debugmodel !== 2) {
                    return lastResult;
                }

                // 短暂延迟后继续下一轮识别
                await sleep(100);

            } catch (error) {
                // 发生异常时释放内存
                if (captureRegion) {
                    captureRegion.dispose();
                }
                log.error(`OCR异常: ${error.message}`);
                await sleep(100);
            }
        }

        if (debugmodel === 1) {
            // 超时处理
            if (text === "") {
                log.info(`OCR超时: ${timeout}秒内未找到任何文字`);
            } else {
                log.info(`OCR超时: ${timeout}秒内未找到"${text}"`);
            }
        }

        // 返回最后一个结果或未找到
        return lastResult || { found: false };
    }

    //判断队内角色
    async function includes(characterName) {
        var avatars = getAvatars();
        for (let i = 0; i < avatars.length; i++) {
            if (avatars[i] === characterName) {
                await keyPress(String(i + 1));
                await sleep(1500);
                return true;
            }
        }
        return false;
    }

    //兑换功能函数，用于自动完成兑换操作
    async function Exchange(exchangeObject, objName) {
        async function usedQuotaVisible() {
            moveMouseTo(1900, 210);
            await sleep(800);
            await leftButtonDown();
            try { await sleep(800); moveMouseTo(1900, 960); await sleep(800); }
            finally { await leftButtonUp(); }
            return (await imageRecognitionEnhanced(`assets/RecognitionObject/待刷新${objName}.png`, 5, 0, 0, 441, 163, 1350, 829, true)).found;
        }
        try {
            await sleep(1000);
            moveMouseTo(1900, 205);
            await leftButtonDown();
            await sleep(1500);
            await leftButtonUp();
            let object = await imageRecognitionEnhanced(exchangeObject, 5, 1, 0, 496, 224, 556, 221, true);
            if (!object.found) {
                log.warn("未找到物品：{objName}，可能本月已兑换", objName);
                if (await usedQuotaVisible()) {
                    log.info("在已兑换的物品中找到了{objName}", objName);
                    return taskOutcome('Skipped', 'FATE_QUOTA_ALREADY_USED');
                } else {
                    log.error("经过查找仍未找到物品：{objName}", objName);
                    return taskOutcome('Failed', 'FATE_ITEM_NOT_FOUND');
                }
            }
            await sleep(1000);

            // 识别"兑换"文字按钮的位置
            let duiHuan = await textOCREnhanced("兑换", 5, 0, 0, 1123, 762, 115, 40, 1);

            // 如果找到"兑换"按钮，则执行点击操作
            if (duiHuan.found) {
                const currency = await imageRecognitionEnhanced(xingChen, 3, 0, 0, 1130, 355, 315, 300);
                if (!currency.found) throw codedError('FATE_CURRENCY_UNCONFIRMED', '未确认兑换窗口使用星尘，禁止支付');
                // 连续点击指定位置4次，每次间隔150毫秒
                for (let i = 0; i < 4; i++) {
                    await click(1290, 600);
                    await sleep(150);
                }

                await beginAction(objName);
                await click(duiHuan.x, duiHuan.y);
                await sleep(1000);
                await keyPress("VK_ESCAPE");
                if (!await usedQuotaVisible()) return taskOutcome('NeedsReconcile', 'FATE_EXCHANGE_UNCONFIRMED');
                const outcome = await confirmAction(objName, getNextMonthFirst4AMISO(), 'FATE_QUOTA_USED_AFTER_EXCHANGE');
                log.info("本月{objName}已确认兑换完成", objName);
                return outcome;
            } else {
                log.warn("未找到兑换按钮，请重试");
                return taskOutcome('Failed', 'FATE_CONFIRMATION_NOT_FOUND');
            }
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行粉球篮球兑换过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }

    }

    // 等待质变仪完成提示出现。 若超时则强制结束流程。
    async function waitTransformer(deployed) {
        var startTime = new Date();
        await sleep(500);
        var NowTime = new Date();

        // 质变仪判断逻辑
        if (deployed) {
            await sleep(800);

            await keyDown("S");
            await sleep(500);
            await keyUp("S");

            if (zbyChargingMethod == "法器角色充能") {
                const ifbblIn = await includes("芭芭拉");
                if (!ifbblIn) { throw new Error("队伍中未包含角色：芭芭拉"); }
            }
            while ((NowTime - startTime) < actiontime * 1000) {
                const ocrRes = await textOCREnhanced("质变产生了以下物质", 0.7, 1, 0, 539, 251, 800, 425);
                if (ocrRes.found) {
                    click(970, 760);
                    return true;
                }
                if (zbyChargingMethod == "法器角色充能") {
                    leftButtonClick();
                    await sleep(150);
                }
                NowTime = new Date();
            }
        }
        await genshin.returnMainUi();
        log.error(`${actiontime}秒超时，结束质变仪流程！`);
        return false;
    }

    // 独立执行爱可菲厨艺机关并等待获得10份料理
    async function runAkfMachine() {
        var startTime = new Date();
        var NowTime = new Date();
        var getFood = 0;
        var lastIncrementTime = 0;
        var rewardVisible = false;
        var rewardAbsentSamples = 0;
        const intervalTime = 3000;

        if (akfChargingMethod == "电气水晶充能") {
            await beginAction('爱可菲');
            const pathCompleted = await AutoPath("全自动爱可菲");
            if (!pathCompleted) {
                throw new Error("爱可菲未能到达电气水晶");
            }
        } else if (akfChargingMethod == "法器角色充能") {
            const ifakfIn = await includes("爱可菲");
            if (!ifakfIn) { throw new Error("队伍中未包含角色:爱可菲"); }

            await beginAction('爱可菲');
            keyDown("E");
            await sleep(1000);
            keyUp("E");

            await sleep(800);
            await includes("芭芭拉");
        }
        while ((NowTime - startTime) < actiontime * 1000) {
            const ifEarn = await textOCREnhanced("获得", 0.2, 0, 3, 159, 494, 75, 44);
            if (ifEarn.found) {
                rewardAbsentSamples = 0;
                const currentTime = new Date().getTime();
                if (!rewardVisible && currentTime - lastIncrementTime >= intervalTime) {
                    getFood++;
                    rewardVisible = true;
                    lastIncrementTime = currentTime;
                    log.warn(`获得料理数量: ${getFood}`);
                    if (getFood >= 10) {
                        log.warn("获得料理数量已达10，结束流程！");
                        await genshin.returnMainUi();
                        return true;
                    }
                }
            } else if (++rewardAbsentSamples >= 2) {
                // 必须先观察到通知消失；一张持续/冻结的“获得”画面不能每三秒算新奖励。
                rewardVisible = false;
            }
            if (akfChargingMethod == "法器角色充能") {
                leftButtonClick();
                await sleep(150);
            }
            await sleep(50);
            NowTime = new Date();
        }
        await genshin.returnMainUi();
        log.error(`${actiontime}秒超时，结束爱可菲流程！`);
        return false;
    }

    //放置质变仪
    async function deployTransformer() {
        //放置质变仪
        await sleep(500);
        await keyPress("B");
        await sleep(1000);

        await handleExpiredItems(); //处理过期物品

        await sleep(1000);
        await click(1067, 57);//点开背包,可做图像识别优化

        const bagOk = await textOCREnhanced("小道具", 3, 0, 3, 126, 17, 99, 53); if (!bagOk.found) { throw new Error("未打开'小道具'页面,请确保背包已正确打开并切换到小道具标签页"); }//确认在小道具界面
        await sleep(500);
        const ZbyResult = await imageRecognitionEnhanced(ZHIBIANYI, 1, 1, 0);//识别质变仪图片
        if (!ZbyResult.found) {
            await genshin.returnMainUi();
            log.warn("'质变仪CD中'或'未找到质变仪!'");
            return false;//质变仪找不到就直接退出
        } else {
            await sleep(1000);
            await click(1699, 1004);
            await sleep(1000);//点击部署操作
            await genshin.returnMainUi();
        }
        return true;
    }

    //参量质变仪放入“薄荷”交互流程
    async function insertMaterial() {
        log.info("请确保所选材料足够，现在开始部署！！");
        //检测并进入质变仪界面
        await middleButtonClick();
        await sleep(1000);
        let Fmeun = await textOCREnhanced("参量质变仪", 2, 2, 0, 1205, 508, 140, 53);//单条F检测
        await keyPress("F");
        let CHAx = await imageRecognitionEnhanced(CHA, 3, 0, 0, 1766, 3, 140, 90);
        if (!Fmeun.found && !CHAx.found) { return false; }

        //检测是否到达材料页面
        const startTransform = await textOCREnhanced("进行质变", 3, 0, 3, 1675, 994, 150, 50); if (!startTransform.found) { throw new Error("质变仪页面未打开"); }//单条F检测
        await sleep(500);
        let itemResult;
        switch (ITEM) {
            case 1:
                await click(863, 47); // 初始化与'1养成道具'相关的设置或资源
                itemResult = await textOCREnhanced("养成道具", 3, 0, 3, 120, 19, 240, 50); if (!itemResult.found) { throw new Error("'养成道具'页面未打开"); }
                break;
            case 2:
                await click(959, 45);// 初始化与'2食物'相关的设置或资源
                itemResult = await textOCREnhanced("食物", 3, 0, 3, 124, 16, 93, 63); if (!itemResult.found) { throw new Error("'食物'页面未打开"); }
                break;
            case 3:
                await click(1050, 50); // 初始化与'3材料'相关的设置或资源
                itemResult = await textOCREnhanced("材料", 3, 0, 3, 124, 16, 93, 63); if (!itemResult.found) { throw new Error("'材料'页面未打开"); }
                break;
            default:
                // 处理未知ITEM值的情况
                break;
        }

        //滚轮预操作
        await moveMouseTo(1287, 131);
        await sleep(100);
        await leftButtonDown();
        await sleep(100);
        await moveMouseTo(1287, 161);
        // 薄荷图片检测
        let YOffset = 0; // Y轴偏移量，根据需要调整
        const maxRetries = 20; // 最大重试次数
        let retries = 0; // 当前重试次数
        while (retries < maxRetries) {
            const ifBh = await imageRecognitionEnhanced(BH, 1, 0, 0, 115, 115, 1155, 845);
            if (ifBh.found) {
                await leftButtonUp();
                await sleep(500);
                await click(ifBh.x, ifBh.y);
                await sleep(1000);
                await click(440, 1008);  //选择最大数量
                await sleep(1000);
                await click(1792, 1019); //质变按钮
                const zbPanel = await textOCREnhanced("参量质变仪", 3, 0, 3, 828, 253, 265, 73);
                if (!zbPanel.found) throw codedError('ZBY_CONFIRMATION_NOT_FOUND', '材料确认页面未出现，禁止提交');
                await sleep(1000);
                await beginAction('质变仪');
                await click(1183, 764); //确认 ;
                await sleep(1000);
                await genshin.returnMainUi();
                return true
            }
            retries++; // 重试次数加1
            //滚轮操作
            YOffset += 50;
            await sleep(500);
            if (retries === maxRetries || 161 + YOffset > 1080) {
                await leftButtonUp();
                await sleep(100);
                await moveMouseTo(1287, 131);
                await genshin.returnMainUi();
                log.error("未找到材料！");
            }
            await moveMouseTo(1287, 161 + YOffset);
            await sleep(300);
        }
        return false;
    }

    //切换队伍
    async function switchPartyIfNeeded(partyName) {
        if (!partyName) {
            await genshin.returnMainUi();
            return;
        }
        try {
            log.info("正在尝试切换至" + partyName);
            if (!await genshin.switchParty(partyName)) {
                log.info("切换队伍失败，前往七天神像重试");
                await genshin.tpToStatueOfTheSeven();
                if (!await genshin.switchParty(partyName)) throw codedError('PARTY_SWITCH_FAILED', '指定队伍未确认切换成功');
            }
        } catch (error) {
            checkTask();
            log.error("队伍切换失败，可能处于联机模式或其他不可切换状态");
            throw error;
        }
    }

    //寻路函数
    async function AutoPath(locationName) {
        try {
            let filePath = `assets/${locationName}.json`;
            const result = await pathingScript.runFile(filePath);
            checkTask();
            if (result?.success !== true) throw codedError('ROUTE_RESULT_UNCONFIRMED', '原生路线未返回完成回执');
            return true;
        } catch (error) {
            checkTask();
            log.error(`执行 ${locationName} 路径时发生错误: ${error.message}`);
            // 到达失败不能作为普通false交给消费步骤继续点击；保留宿主原错误和终止锁。
            throw error;
        }
    }

    // 背包过期物品识别
    async function handleExpiredItems() {
        const ifGuoqi = await textOCREnhanced("物品过期", 1.5, 0, 3, 870, 280, 170, 40);
        if (ifGuoqi.found) {
            log.info("检测到过期物品，正在处理...");
            await sleep(500);
            await click(980, 750); // 点击确认按钮，关闭提示
        } else {
            log.info("未检测到过期物品");
        }
    }

    // 获取当前时间七天后的时间戳
    function getSevenDaysLater() {
        const now = new Date();
        const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 当前时间 + 7天
        return sevenDaysLater.toISOString();
    }

    // 返回当前时间的下周一四点的时间戳
    function getNextMonday4AMISO() {
        const now = new Date();

        // 获取当前是星期几
        const currentDay = now.getDay();

        // 计算距离下周一还有几天
        let daysUntilMonday = 1 - currentDay;
        if (daysUntilMonday <= 0) {
            daysUntilMonday += 7;
        }

        // 创建下周一4点的日期对象
        const nextMonday4AM = new Date(now);
        nextMonday4AM.setDate(now.getDate() + daysUntilMonday);
        nextMonday4AM.setHours(4, 0, 0, 0);

        return nextMonday4AM.toISOString();
    }

    // 返回下月1号四点的时间戳
    function getNextMonthFirst4AMISO() {
        const now = new Date();

        // 获取当前月份并加一个月
        let nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 4, 0, 0, 0);

        return nextMonth.toISOString();
    }

    // 复用宿主无日志读取接口。仅明确NotFound是首次运行，其余I/O错误不得当作空CD。
    function readOptionalText(filePath) {
        checkTask();
        try {
            return file.readTextSyncOrThrow(filePath);
        } catch (error) {
            checkTask();
            let detail = error.hostException;
            for (let i = 0; i < 4 && detail && detail.InnerException; i++) detail = detail.InnerException;
            if (detail && (detail.HResult === -2147024894 || detail.HResult === -2147024893)) return null;
            throw codedError('CD_READ_UNAVAILABLE', '记录读取失败，不能按首次运行重做消耗');
        }
    }

    // 读取CD记录
    async function readCDRecords() {
        let records = {};

        const content = readOptionalText(cdRecordPath);
        if (content !== null) {
                const lines = content.split('\n');

                for (const line of lines) {
                    if (line.trim()) {
                        const [name, timestamp] = line.split('::');
                        if (!name || !timestamp || !Number.isFinite(new Date(timestamp).getTime()))
                            throw codedError('CD_RECORD_INVALID', 'CD记录格式损坏，需要复核');
                        records[name] = timestamp;
                    }
                }

                // 迁移旧版本共用的“质变仪&爱可菲”CD记录。
                // 已存在的新记录优先，避免迁移时覆盖较新的独立CD。
                const legacyRouteName = "质变仪&爱可菲";
                if (records[legacyRouteName]) {
                    if (!records["质变仪"]) {
                        records["质变仪"] = records[legacyRouteName];
                    }
                    if (!records["爱可菲"]) {
                        records["爱可菲"] = records[legacyRouteName];
                    }
                    // 只在内存提供旧键兼容，不因一次读取改写或删除用户旧记录。
                }
        }

        cdSources.set(records, content);
        return records;
    }

    // 写入CD记录
    async function writeCDRecords(records) {
        let content = '';

        for (const name in records) {
            content += `${name}::${records[name]}\n`;
        }

        // 发布包中会携带 record 目录；这里仍为旧安装或目录被删除的情况兜底。
        if (typeof file.mkdir === 'function') {
            try {
                await file.mkdir('record');
            } catch (e) {
                // 目录已存在时部分运行环境也会抛错，交给实际写入结果判断。
            }
        }

        try {
            if (!cdSources.has(records) || file.compareExchangeTextSync(cdRecordPath, cdSources.get(records), content) !== true) {
                storageConflict = true;
                throw codedError('CD_WRITE_CONFLICT', '账户CD已改变，不能覆盖其他运行的完成记录');
            }
            cdSources.set(records, content);
            if (readOptionalText(cdRecordPath) !== content) {
                storageConflict = true;
                throw codedError('CD_WRITE_FAILED', '完成CD未能保存');
            }
        } catch (e) {
            checkTask();
            log.error('写入完成CD失败，保留已确认进度以便恢复，不重复消耗');
            throw codedError('CD_WRITE_FAILED', '完成CD写入失败，需要恢复记录');
        }
    }

    // 检查路线是否可执行（CD是否已刷新）
    function isRouteAvailable(routeName, cdRecords) {
        const now = new Date();

        // 如果记录中没有该路线，说明是第一次执行，可以执行
        if (!cdRecords[routeName]) {
            return true;
        }

        // 检查CD时间是否已过
        const cdTime = new Date(cdRecords[routeName]);
        return now >= cdTime;
    }

    // 自动战斗函数
    async function autoFight(timeout) {
        const cts = new CancellationTokenSource();
        const startTime = Date.now();
        let fightResult = false;
        let native = null;
        let settled = null;
        let failure = null;
        let lastSource = null;
        let confirmations = 0;
        let rejectedFrames = 0;
        let observationOverruns = 0;
        let consecutiveOverruns = 0;
        let maximumObservationMs = 0;
        function isOwnCancellation(error) {
            if (['A task was canceled.', '取消自动任务'].includes(error?.message)) return true;
            let detail = error?.hostException;
            for (let i = 0; i < 5 && detail; i++, detail = detail.InnerException)
                if (detail.HResult === -2146233029) return true;
            return false;
        }
        try {
            // 立即接住原生Promise的终态；不能让拒绝悬空，也不能取消后就开始下一轮传送。
            native = Promise.resolve(dispatcher.runTask(new SoloTask('AutoFight'), cts))
                .then(() => settled = { error: null }, error => settled = { error });
            while (Date.now() - startTime < timeout) {
                checkTask();
                if (settled?.error) throw settled.error;
                let frame = null;
                try {
                    const observationStarted = Date.now();
                    frame = captureGameRegion();
                    const stamp = frame.FrameStamp;
                    if (!stamp?.IsKnown) throw codedError('DOMAIN_FRAME_ID_REQUIRED', '秘境完成确认需要捕获源帧身份');
                    const at = Number(stamp.CapturedAt.ToUnixTimeMilliseconds());
                    const matched = recognizeFightText(frame);
                    const age = Date.now() - at;
                    const observationMs = Date.now() - observationStarted;
                    maximumObservationMs = Math.max(maximumObservationMs, observationMs);
                    if (observationMs > 150) { observationOverruns++; consecutiveOverruns++; }
                    else consecutiveOverruns = 0;
                    if (consecutiveOverruns >= 3)
                        throw codedError('DOMAIN_DECISION_OVERRUN', '连续三次秘境判定超过150ms，取消并排空战斗；不能继续盲打或计为胜利');
                    if (observationMs <= 150 && at > startTime && age >= 0 && age <= 150 && (!lastSource || stamp.IsAfter(lastSource))) {
                        lastSource = stamp;
                        confirmations = matched ? confirmations + 1 : 0;
                    } else { rejectedFrames++; confirmations = 0; }
                    if (confirmations >= 2) { fightResult = true; break; }
                } finally { if (frame) frame.dispose(); }
                if (settled && confirmations === 0) break;
                await sleep(100);
            }
        } catch (error) { failure = error; }
        // 原生输入/借用未退出前不Dispose CTS，不允许下一轮或恢复步骤接管。
        try { cts.cancel(); } catch (error) { failure = failure || error; }
        try {
            const result = native && await native;
            if (result?.error && !isOwnCancellation(result.error)) failure = failure || result.error;
        } catch (error) { failure = failure || error; }
        finally {
            try { cts.dispose(); } catch (error) { failure = failure || error; }
        }
        log.debug('MONDAY_DOMAIN confirmed={confirmed} rejectedFrames={rejected} overruns={overruns} maxObservationMs={maximum}',
            fightResult, rejectedFrames, observationOverruns, maximumObservationMs);
        if (failure) throw failure;
        checkTask();
        return fightResult;
    }

    // 战斗文本识别函数
    function recognizeFightText(captureRegion) {
        try {
            const result = captureRegion.find(ocrRo2);
            const text = result.text;
            const keywords = ["挑战成功", "挑战达成"];

            for (const keyword of keywords) {
                if (text.includes(keyword)) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            log.error("OCR识别出错: {0}", error);
            return false;
        }
    }

    // 自动秘境
    async function fuben() {
        await genshin.tp(1167.9833984375, 662.7353515625);// 太山府

        await sleep(1500);
        keyPress("F");

        if (!(await textOCREnhanced("单人挑战", 8, 1, 0, 1615, 990, 220, 50)).found) return false;
        await sleep(10);
        if (!(await textOCREnhanced("开始挑战", 8, 1, 0, 1615, 990, 220, 50)).found) return false;
        await sleep(10);
        if (!(await textOCREnhanced("地脉异常", 10, 1, 0, 840, 405, 180, 55)).found) return false;

        await sleep(1000);

        let success;
        for (let attempt = 0; attempt < 10; attempt++) {
            success = await textOCREnhanced("启动", 0.5, 0, 3, 1210, 500, 85, 85);
            if (success.found) {
                keyPress("F");
                break;
            } else {
                keyDown("W");
                try { await sleep(2500); } finally { keyUp("W"); }
            }
        }

        if (!success.found) {
            log.warn("未找到秘境启动按钮！");
            return false;
        }
        return true;
    }

    // 质变仪
    async function autoZhibian() {
        try {
            const resumed = await resumeAction('质变仪');
            if (resumed) return resumed;
            // 读取CD记录
            const cdRecords = await readCDRecords();
            const routeName = "质变仪";

            // 检查CD
            if (!isRouteAvailable(routeName, cdRecords)) {
                log.info(routeName + "CD未刷新，跳过本次执行");
                return taskOutcome('Skipped', 'CD_ACTIVE');
            }

            await sleep(500);
            await keyPress("B");
            await sleep(1000);

            await handleExpiredItems(); //处理过期物品

            await sleep(1000);
            await click(1067, 57);//点开背包,可做图像识别优化

            const ifXdj = await textOCREnhanced("小道具", 3, 0, 3, 126, 17, 99, 53); if (!ifXdj.found) { throw new Error("未打开'小道具'页面,请确保背包已正确打开并切换到小道具标签页"); }//确认在小道具界面
            await sleep(500);
            const res1 = await imageRecognitionEnhanced(ZHIBIANYI, 1, 1, 0);//识别质变仪图片
            if (res1.found) {
                await genshin.returnMainUi();
                log.info("质变仪CD已刷新！");
            } else {
                log.warn("'质变仪CD中'或'未找到质变仪!'");
                await genshin.returnMainUi();
                return taskOutcome('Deferred', 'ZBY_AVAILABILITY_UNKNOWN');
            }

            await switchPartyIfNeeded(zbyTeam); //切换到指定队伍

            if (zbyChargingMethod == "电气水晶充能") {
                if (!await AutoPath("全自动质变仪")) throw codedError('ZBY_ROUTE_FAILED', '未确认到达质变仪充能位置');
            } else if (zbyChargingMethod == "法器角色充能") {
                await genshin.tp(-874.724609375, 2276.950439453125);
                await genshin.returnMainUi();
                await sleep(1000);
            }

            const deployed = await deployTransformer();//部署质变仪
            if (!deployed) {
                return taskOutcome('Deferred', 'ZBY_DEPLOYMENT_UNCONFIRMED');
            } else {
                if (!await insertMaterial()) throw codedError('ZBY_MATERIAL_NOT_SUBMITTED', '未完成质变材料选择');
            }

            const completed = await waitTransformer(deployed);//等待质变完成
            if (!completed) return taskOutcome('NeedsReconcile', 'ZBY_RESULT_UNCONFIRMED');
            log.info("任务执行完成！！！");

            // 更新CD记录（设置为6天22小时后）
            const now = new Date();
            const sevenDaysLater = new Date(now.getTime() + ((6 * 24 + 22) * 3600000)); // 当前时间 + 6天22小时
            const outcome = await confirmAction(routeName, sevenDaysLater.toISOString(), 'ZBY_COMPLETION_PANEL');
            log.info("本周质变仪任务已完成！");
            return outcome;
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行质变仪任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 爱可菲
    async function autoAkf() {
        try {
            const resumed = await resumeAction('爱可菲');
            if (resumed) return resumed;
            const cdRecords = await readCDRecords();
            const routeName = "爱可菲";

            if (!isRouteAvailable(routeName, cdRecords)) {
                log.info(routeName + "CD未刷新，跳过本次执行");
                return taskOutcome('Skipped', 'CD_ACTIVE');
            }

            await switchPartyIfNeeded(akfTeam);
            const completed = await runAkfMachine();
            if (!completed) {
                log.warn('爱可菲奖励未确认，保留独立待复核进度，不写完成CD');
                return taskOutcome('NeedsReconcile', 'AKF_REWARDS_UNCONFIRMED');
            }

            const outcome = await confirmAction(routeName, getNextMonday4AMISO(), 'AKF_DISTINCT_REWARD_APPEARANCES');
            log.info("本周爱可菲任务已完成！");
            return outcome;
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行爱可菲任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 每周做菜
    async function Cooking() {
        let altHeld = false;
        let mouseHeld = false;
        try {
            const routeName = "每周做菜";
            const resumed = await resumeAction(routeName);
            if (resumed) return resumed;
            const cdRecords = await readCDRecords();
            if (!isRouteAvailable(routeName, cdRecords)) {
                log.info(routeName + "CD未刷新，跳过本次执行");
                return taskOutcome('Skipped', 'CD_ACTIVE');
            }
            const count = Number(cookCount);
            if (!food || !Number.isSafeInteger(count) || count <= 0)
                throw codedError('COOK_SETTINGS_INVALID', '料理名和正整数烹饪数量必须明确');

            await AutoPath("每周做菜");
            altHeld = true;
            keyDown("VK_MENU");
            try {
                await sleep(500);
                const res1 = await textOCREnhanced("烹饪", 5, 0, 3, 1150, 460, 155, 155);
                if (!res1.found) throw codedError('COOK_ENTRY_NOT_FOUND', '烹饪交互未出现');
                click(res1.x + 15, res1.y + 15);
                await sleep(800);
            } finally { keyUp("VK_MENU"); altHeld = false; }
            await sleep(1000);
            click(145, 1015);// 筛选
            await sleep(800);
            click(195, 1015);// 重置
            await sleep(800);
            click(500, 1020);// 确认筛选
            await sleep(800);

            await moveMouseTo(1287, 131);
            await sleep(100);
            mouseHeld = true;
            await leftButtonDown();
            await sleep(100);
            await moveMouseTo(1287, 161);
            let selected = null;
            for (let attempt = 0; attempt < 20; attempt++) {
                checkTask();
                const candidate = await textOCREnhanced(food, 1, 0, 3, 116, 116, 1165, 880);
                if (candidate.found) { selected = candidate; break; }
                const y = 161 + (attempt + 1) * 50;
                if (y >= 1080) break;
                await moveMouseTo(1287, y);
                await sleep(300);
            }
            await leftButtonUp();
            mouseHeld = false;
            if (!selected) throw codedError('COOK_FOOD_NOT_FOUND', '料理未找到，禁止制作');
            await sleep(500);
            click(selected.x + 50, selected.y - 60);
            await sleep(1000);
            click(1700, 1020);
            await sleep(1000);
            const automatic = await textOCREnhanced("自动烹饪", 5, 1, 0, 725, 1000, 130, 45);
            if (!automatic.found) throw codedError('COOK_AUTOMATIC_UNAVAILABLE', '自动烹饪未确认解锁');
            await sleep(800);
            click(960, 460);
            inputText(String(count));
            if (!await waitForTexts([{ text: String(count), exact: true, rect: [850, 410, 220, 100] }]))
                throw codedError('COOK_QUANTITY_UNCONFIRMED', '数量框没有接受指定数量，可能材料不足或超出上限');

            await beginAction(routeName);
            click(1190, 755);
            await sleep(2500);
            // 沿用仓库AEscoffier_chef的料理结果确认区域；不是固定等待后直接记成功。
            if (!await waitForTexts([{ text: '确认', rect: [934, 884, 76, 39] }]))
                return taskOutcome('NeedsReconcile', 'COOK_RESULT_UNCONFIRMED');
            const outcome = await confirmAction(routeName, getNextMonday4AMISO(), 'COOK_QUANTITY_AND_RESULT_CONFIRMED');
            log.info("本周烹饪任务已确认完成：{count}", count);
            return outcome;
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行烹饪任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        } finally {
            if (mouseHeld) await leftButtonUp();
            if (altHeld) keyUp('VK_MENU');
        }
    }

    // 每周锻造：纪行目标计数是完成权威，四次按钮输入本身不算20件完成。
    async function duanZao() {
        let altHeld = false;
        const routeName = '每周锻造';
        try {
            const resumed = await resumeAction(routeName);
            if (resumed && resumed.kind !== 'NeedsReconcile') return resumed;
            if (!resumed && !isRouteAvailable(routeName, await readCDRecords())) return taskOutcome('Skipped', 'CD_ACTIVE');
            const initial = await readWeeklyForgingProgress();
            if (resumed) {
                const entry = readProgress().actions[routeName];
                if (initial < 20 || !entry.cycleUntil || new Date(entry.cycleUntil) <= new Date())
                    return taskOutcome('NeedsReconcile', 'FORGE_PREVIOUS_CONSUMPTION_UNKNOWN');
                return await confirmAction(routeName, entry.cycleUntil, 'weekly-forge-20/20-two-source-frames');
            }
            if (initial >= 20) return taskOutcome('Skipped', 'WEEKLY_FORGE_GOAL_ALREADY_COMPLETE');
            await genshin.returnMainUi();
            await AutoPath('瓦格纳');
            keyDown('VK_MENU'); altHeld = true;
            await requireUiText('瓦格纳', [1150, 460, 300, 155], true);
            keyUp('VK_MENU'); altHeld = false;
            await sleep(800); click(960, 540); await sleep(1000);
            await requireUiText('委托锻造', [1150, 400, 500, 350], true);
            await sleep(1500); click(960, 540); await sleep(1000);
            const oldRewards = await textOCREnhanced('可收取', 1, 0, 3, 625, 265, 130, 50);
            if (oldRewards.found) {
                await requireUiText('全部领取', [0, 850, 500, 230], true);
                await sleep(1000); await requireUiText('确认', [700, 700, 600, 340], true);
                click(220, 145); await sleep(500);
            }
            click(360, 1015); await sleep(500);
            await requireUiText('武器升级材料', [30, 170, 410, 100], true);
            const recipe = await imageRecognitionEnhanced(mineralFile, 5, 0, 0, 40, 210, 720, 770);
            if (!recipe.found) throw codedError('FORGE_RECIPE_NOT_FOUND', '未确认配置的锻造配方');
            click(recipe.x, recipe.y); await sleep(500);
            await requireUiText('开始锻造', [1400, 850, 520, 230]);
            const cycleUntil = getNextMonday4AMISO();
            await beginAction(routeName, { cycleUntil });
            for (let i = 0; i < 4; i++) {
                await requireUiText('开始锻造', [1400, 850, 520, 230], true);
                await sleep(300);
            }
            // 等待本次队列的真实可收取状态；未知不重发锻造请求，也不写完成CD。
            if (!await waitForTexts([{ text: '可收取', rect: [0, 180, 1000, 750] }], 240000))
                return taskOutcome('NeedsReconcile', 'FORGE_QUEUE_NOT_COLLECTABLE');
            await requireUiText('全部领取', [0, 850, 500, 230], true);
            await sleep(1000); await requireUiText('确认', [700, 700, 600, 340], true);
            const completed = await readWeeklyForgingProgress();
            if (completed < 20) return taskOutcome('NeedsReconcile', 'FORGE_GOAL_NOT_COMPLETE');
            return await confirmAction(routeName, cycleUntil, 'weekly-forge-20/20-two-source-frames');
        } catch (error) {
            log.error('锻造结果未闭合：{reason}', error.message);
            return taskFailure(error);
        } finally { if (altHeld) keyUp('VK_MENU'); }
    }

    // 每周首领
    async function hitBoss() {
        try {
            return await runConfirmedBatch('每周首领', 10, async () => {
                await genshin.tpToStatueOfTheSeven();
                await switchPartyIfNeeded(BossPartyName);
                await sleep(5000);
            }, round => AutoPath(round % 2 === 0 ? '爆炎树' : '急冻树'), 'TEN_NATIVE_BOSS_ROUTES_COMPLETED');
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行首领任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 每周秘境
    async function AutoDomain() {
        try {
            return await runConfirmedBatch('每周秘境', 10, async () => {
                await genshin.tpToStatueOfTheSeven();
                await switchPartyIfNeeded(BossPartyName);
                await sleep(5000);
            }, async round => {
                log.info('正在进行第{round}次秘境挑战', round);
                if (!await fuben()) throw codedError('DOMAIN_ENTRY_UNCONFIRMED', '秘境入口或启动未确认，不启动战斗');
                return await autoFight(120000);
            }, 'TEN_FRESH_DOMAIN_COMPLETIONS');
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行秘境任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 购买四方八方之网
    async function buyNet() {
        try {
            const routeName = "购买四方网";
            const pendingReview = readProgress().actions[routeName]?.state === 'pending';
            const resumed = await resumeAction(routeName);
            if (resumed && !pendingReview) return resumed;
            const cdRecords = await readCDRecords();
            if (!pendingReview && !isRouteAvailable(routeName, cdRecords)) {
                log.info(routeName + "CD未刷新，跳过本次执行");
                return taskOutcome('Skipped', 'CD_ACTIVE');
            }

            await AutoPath("四方八方之网");
            await sleep(800);

            keyPress("F");
            await sleep(1300);

            click(960, 540);// 对话
            await sleep(1000);

            const menu = await textOCREnhanced("购买", 3, 1, 0, 1320, 630, 130, 60);
            if (!menu.found) throw codedError('NET_SHOP_NOT_FOUND', '购买四方网的对话未出现，禁止购买');
            await sleep(1000);

            const item = { text: '四方八方之网', rect: [1300, 100, 590, 600] };
            const soldOut = { text: '已售罄', rect: [1515, 920, 90, 35] };
            if (!await waitForTexts([item])) throw codedError('NET_ITEM_NOT_CONFIRMED', '商店当前物品身份未确认');
            if (await waitForTexts([item, soldOut], 1000)) {
                if (pendingReview)
                    return await confirmAction(routeName, getNextMonday4AMISO(), 'NET_QUOTA_FULFILLED_AT_RECONCILIATION');
                await recoverBoundary();
                return taskOutcome('Skipped', 'NET_ALREADY_SOLD_OUT');
            }
            // 旧支付未知时只核对当前额度；未售罄也不能证明旧支付完全没有发生。
            if (pendingReview) return taskOutcome('NeedsReconcile', 'NET_PAYMENT_STILL_UNKNOWN');
            click(1670, 1015);
            await sleep(800);
            for (let i = 0; i < 7; i++) { click(1290, 600); await sleep(150); }
            if (!await waitForTexts([{ text: '购买', rect: [1100, 740, 200, 90] },
                { text: '四方八方之网', rect: [500, 200, 950, 500] }]))
                throw codedError('NET_CONFIRMATION_NOT_FOUND', '四方网购买确认框未确认，禁止支付');

            await beginAction(routeName);
            click(1175, 780);
            await sleep(1000);
            keyPress('VK_ESCAPE');
            await sleep(300);
            if (!await waitForTexts([item, soldOut])) return taskOutcome('NeedsReconcile', 'NET_PURCHASE_UNCONFIRMED');
            const outcome = await confirmAction(routeName, getNextMonday4AMISO(), 'NET_SELECTED_ITEM_SOLD_OUT_AFTER_PAYMENT');
            log.info("本周四方网购买任务已确认完成");
            return outcome;
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行四方网任务过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 购买与提交是两个独立副作用；购买回执不能被当成提交成功。
    async function buyTzq() {
        const routeName = '投资券';
        const purchaseName = '投资券购买';
        async function openSettlement(runRoute) {
            await genshin.returnMainUi();
            if (runRoute) await AutoPath('投资券');
            keyPress('F'); await sleep(1000); click(960, 540); await sleep(1000);
            await requireUiText('我要结算', [1100, 400, 800, 400], true);
            await sleep(800); click(960, 540); await sleep(500);
        }
        function submitted(rows) {
            return rows.some(row => row.text.includes('投资券')) && rows.some(row =>
                !/未|失败|不能|尚|没有/.test(row.text) && /已提交|已结算|提交成功|结算成功/.test(row.text));
        }
        async function awaitSubmission(notBefore) {
            let confirmedSource = null, last = [];
            const deadline = Date.now() + 4000;
            do {
                const sample = tryReadUiRows('investment-submission', [0, 0, 1920, 1080], notBefore);
                if (!sample) { confirmedSource = null; await sleep(200); continue; }
                if (Date.now() >= deadline) break;
                last = sample.rows;
                if (submitted(last)) {
                    if (confirmedSource && sample.source.IsAfter(confirmedSource)) return true;
                    confirmedSource = sample.source;
                } else confirmedSource = null;
                await sleep(200);
            } while (Date.now() < deadline);
            log.debug('MONDAY_UI phase=investment-submission rows={rows}',
                last.slice(0, 24).map(row => row.text.replace(/\d{6,}/g, '[number]')).join('|').slice(0, 1000));
            return false;
        }
        try {
            // 独立支付未闭合不能被“目前有券”或后续提交成功掩盖。
            // 确认过的支付仅重放其回执，未知支付不再消费也不开始提交。
            const previousPurchase = await resumeAction(purchaseName);
            if (previousPurchase?.kind === 'NeedsReconcile')
                return taskOutcome('NeedsReconcile', 'INVESTMENT_PURCHASE_REQUIRES_REVIEW');
            const resumed = await resumeAction(routeName);
            if (resumed && resumed.kind !== 'NeedsReconcile') return resumed;
            if (!resumed && !isRouteAvailable(routeName, await readCDRecords())) return taskOutcome('Skipped', 'CD_ACTIVE');
            await openSettlement(true);
            const state = (await nextUiRows('investment-state')).rows;
            if (resumed) {
                const entry = readProgress().actions[routeName];
                if (entry.cycleUntil && new Date(entry.cycleUntil) > new Date() && await awaitSubmission(0))
                    return await confirmAction(routeName, entry.cycleUntil, 'investment-settled-two-source-frames');
                return taskOutcome('NeedsReconcile', 'INVESTMENT_PREVIOUS_SUBMISSION_UNKNOWN');
            }
            if (submitted(state) && await awaitSubmission(0)) return taskOutcome('Skipped', 'INVESTMENT_ALREADY_SETTLED');
            if (state.some(row => row.text.includes('没有投资券'))) {
                if (previousPurchase || !isRouteAvailable(purchaseName, await readCDRecords()))
                    return taskOutcome('NeedsReconcile', 'INVESTMENT_PURCHASE_REQUIRES_REVIEW');
                click(960, 540); await sleep(500); click(960, 540); await sleep(500);
                await requireUiText('投资券', [0, 0, 1920, 900]);
                await requireUiText('购买', [1400, 850, 520, 230], true, true);
                await requireUiText('投资券', [500, 200, 900, 500]);
                for (let i = 0; i < 8; i++) { checkTask(); click(1295, 600); await sleep(100); }
                const pay = await requireUiText(['购买', '确认'], [900, 650, 550, 250], false, true);
                const cycleUntil = getNextMonday4AMISO();
                await beginAction(purchaseName, { cycleUntil });
                click(pay.x, pay.y);
                if (!await waitForTexts([{ text: '获得', rect: [500, 100, 900, 300] }, { text: '投资券', rect: [400, 300, 1200, 600] }]))
                    return taskOutcome('NeedsReconcile', 'INVESTMENT_PURCHASE_UNCONFIRMED');
                await confirmAction(purchaseName, cycleUntil, 'investment-item-acquisition-receipt');
                await openSettlement(false);
            }
            // 未观察到“没有”不等于已持有；选择页必须正向显示投资券和交付按钮。
            keyPress('F'); await sleep(500);
            await requireUiText('投资券', [0, 100, 1400, 850]);
            click(110, 185); await sleep(300); click(1235, 815); await sleep(300);
            const submit = await requireUiText(['提交', '交付', '结算'], [1400, 850, 520, 230], false, true);
            const cycleUntil = getNextMonday4AMISO();
            await beginAction(routeName, { cycleUntil });
            click(submit.x, submit.y);
            const submittedAt = Date.now();
            await sleep(300);
            const next = (await nextUiRows('investment-confirmation', submittedAt)).rows;
            // 只有明确的新确认框才允许第二次确认，不能重复盲点同一个提交位置。
            const confirm = next.find(row => row.text === '确认' && row.x >= 800 && row.y >= 650);
            if (!submitted(next) && next.some(row => row.text.includes('投资券')) && confirm) {
                checkTask(); click(confirm.x, confirm.y);
            }
            if (!await awaitSubmission(submittedAt)) return taskOutcome('NeedsReconcile', 'INVESTMENT_SUBMISSION_UNCONFIRMED');
            return await confirmAction(routeName, cycleUntil, 'investment-settled-two-source-frames');
        } catch (error) {
            log.error('投资券结果未闭合：{reason}', error.message);
            return taskFailure(error);
        }
    }

    // 粉球蓝球入口
    async function getPinkandBlue() {
        const outcomes = [];
        for (const [enabled, name] of [[ifPink, '纠缠之缘'], [ifBlue, '相遇之缘']]) {
            if (!enabled) continue;
            checkTask();
            const previous = outcomes[outcomes.length - 1];
            if (previous && !['Completed', 'Skipped'].includes(previous.kind))
                await recoverBoundary(`AutoMonday/${previous.name}:${previous.reason}`);
            activeAction = null;
            outcomes.push({ name, ...await stardustExchange(name) });
        }
        const outcome = aggregateOutcomes(outcomes);
        // 已兑换额度的跳过也可能访问过商店；纯CD跳过则该恢复没有输入。
        if (outcome.kind === 'Skipped') await recoverBoundary();
        return outcome;
    }

    // 粉球蓝球兑换
    async function stardustExchange(routeName) {
        try {
            const resumed = await resumeAction(routeName);
            if (resumed) return resumed;
            // 读取CD记录
            const cdRecords = await readCDRecords();

            // 检查CD
            if (!isRouteAvailable(routeName, cdRecords)) {
                log.info(routeName + "CD未刷新，跳过本次执行");
                return taskOutcome('Skipped', 'CD_ACTIVE');
            }

            log.info("正在进行本月{routeName}兑换……", routeName);
            let ifXingChen = await imageRecognitionEnhanced(xingChen, 5, 0, 0, 1130, 355, 315, 300);
            if (!ifXingChen.found) {
                await genshin.returnMainUi();
                await sleep(1000);
                await keyPress("VK_ESCAPE");
                await sleep(1000);
                await textOCREnhanced("祈愿", 10, 1, 0, 318, 863, 65, 30, 1);
                await textOCREnhanced("尘辉兑换", 10, 1, 0, 100, 1005, 110, 35, 1);
                await textOCREnhanced("星尘兑换", 10, 1, 0, 768, 104, 260, 46, 1);
                ifXingChen = await imageRecognitionEnhanced(xingChen, 5, 0, 0, 1226, 451, 100, 60);
                if (!ifXingChen.found) {
                    await textOCREnhanced("星尘兑换", 10, 1, 0, 768, 104, 260, 46, 1);
                }
                await sleep(1000);
            }

            return await Exchange(`assets/RecognitionObject/${routeName}.png`, routeName);
        } catch (error) {
            if (error.message === "A task was canceled." || error.message === "取消自动任务") { throw error; }
            log.error("执行粉球篮球兑换过程中出现错误: {error}", error.message);
            return taskFailure(error);
        }
    }

    // 版本信息
    async function outputVersion() {
        let scriptVersion, scriptname;
        const manifestContent = file.readTextSync("manifest.json");
        const manifest = JSON.parse(manifestContent);
        scriptVersion = manifest.version;
        scriptname = manifest.name;

        log.warn(`${scriptname}：V${scriptVersion}`);
    }

    // 检查本期纪行是否已达到50级
    async function isBattlePassFull() {
        try {
            await genshin.returnMainUi();
            await keyPress("F4");
            await sleep(1500);

            const battlePassPage = await textOCREnhanced("纪行", 3, 0, 3);
            if (!battlePassPage.found) {
                log.warn("未能打开纪行页面，本次不跳过纪行任务");
                return false;
            }

            // 模板匹配“纪行等级 50”
            for (let attempt = 0; attempt < 3; attempt++) {
                let captureRegion = null;
                try {
                    captureRegion = captureGameRegion();
                    const level50Result = captureRegion.Find(battlePassLevel50Ro);
                    if (!level50Result.isEmpty()) {
                        log.info(
                            "模板匹配到“纪行等级 50”，位置({x},{y},{w},{h})",
                            level50Result.x,
                            level50Result.y,
                            level50Result.width,
                            level50Result.height
                        );
                        return true;
                    }
                } finally {
                    if (captureRegion) {
                        captureRegion.dispose();
                    }
                }
                await sleep(300);
            }

            // OCR“纪行等级 50”
            const levelLabel = await textOCREnhanced("纪行等级", 1, 0, 3);
            if (levelLabel.found) {
                const levelX = Math.max(0, levelLabel.x - 120);
                const levelY = Math.max(0, levelLabel.y - 100);
                const levelW = Math.min(500, 1920 - levelX);
                const levelH = Math.min(220, 1080 - levelY);
                const level50 = await textOCREnhanced("50", 1, 0, 3, levelX, levelY, levelW, levelH, 1);
                if (level50.found) {
                    log.info("检测到本期纪行等级为50级");
                    return true;
                }
            }

            log.info("本期纪行未满，继续执行已启用的纪行任务");
            return false;
        } catch (error) {
            log.warn(`检测纪行等级失败，本次不跳过纪行任务：${error.message}`);
            return false;
        } finally {
            await genshin.returnMainUi();
        }
    }

    // ===== 3. 主函数执行部分 =====

    try {
        //设置分辨率和缩放
        setGameMetrics(1920, 1080, 1);
        await recoverBoundary();

        await outputVersion(); // 输出版本信息

        const shouldCheckBattlePass = tasks.some(task =>
            task.condition && task.skipWhenBattlePassFull
        );
        const battlePassFull = shouldCheckBattlePass
            ? await isBattlePassFull()
            : false;

        // 执行所有启用的任务
        for (const task of tasks) {
            if (task.condition) {
                checkTask();
                if (battlePassFull && task.skipWhenBattlePassFull) {
                    log.info("本期纪行已满，按配置跳过任务：{name}", task.name);
                    taskOutcomes.push({ name: task.name, ...taskOutcome('Skipped', 'BATTLE_PASS_FULL') });
                    continue;
                }
                log.info("开始执行任务：{name}", task.name);
                activeAction = null;
                let outcome;
                try {
                    outcome = await task.func();
                    if (!outcome || !['Completed', 'Skipped', 'Deferred', 'NeedsReconcile', 'Failed', 'Cancelled'].includes(outcome.kind))
                        outcome = taskOutcome('Failed', 'TASK_OUTCOME_MISSING');
                } catch (error) {
                    outcome = taskFailure(error);
                    log.error('周一子任务失败：{name}，{message}', task.name, error.message);
                }
                taskOutcomes.push({ name: task.name, ...outcome });
                if (outcome.kind === 'Cancelled') { finish('Cancelled', 'MONDAY_TASK_CANCELLED'); continuationAllowed = false; return; }
                if (outcome.kind !== 'Skipped')
                    await recoverBoundary(outcome.kind === 'Completed' ? null : `AutoMonday/${task.name}:${outcome.reason}`);
                if (storageConflict) break;
                await sleep(10);
            }
        }
    } catch (error) {
        checkTask();
        if (!continuationAllowed || recoveryInProgress) throw error;
        taskOutcomes.push({ name: '周一入口', ...taskFailure(error) });
        log.error(`执行过程中发生错误：${error.message}`);
    } finally {
        if (continuationAllowed && !recoveryInProgress) await recoverBoundary();
    }

    const outcome = aggregateOutcomes();
    finish(outcome.kind, outcome.reason);

})();
