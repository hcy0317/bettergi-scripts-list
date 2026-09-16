import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const sourcePath = new URL('../repo/js/AutoMonday/main.js', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');

test('production recognition helpers stay pure and debug does not change input or timing', async () => {
    const helpers = source.slice(source.indexOf('    function uiSourceFresh('), source.indexOf('    async function includes('));
    assert.ok(helpers.includes('async function findUiText('));
    for (const debug of [0, 1, 2, 3]) {
        let now = 1000, inputs = 0, disposed = 0;
        const context = vm.createContext({
            Date: { now: () => now }, checkTask() {}, sleep: async ms => { now += ms; },
            log: { info() {}, warn() {}, error() {} }, click() { inputs++; }, keyPress() { inputs++; },
            RecognitionObject: { ocr: (...roi) => ({ roi }), TemplateMatch: () => ({}) },
            file: { ReadImageMatSync: () => ({ dispose() {} }) },
            captureGameRegion: () => ({
                FrameStamp: { IsKnown: true, CapturedAt: { ToUnixTimeMilliseconds: () => now } },
                dispose() { disposed++; },
                findMulti: () => ({ count: 1, 0: { text: '目标', x: 10, y: 20 } }),
                DeriveCrop: () => ({ dispose() {}, Find: () => ({ isEmpty: () => false, x: 10, y: 20, width: 30, height: 40 }) })
            })
        });
        vm.runInContext(helpers, context);
        assert.equal((await vm.runInContext(`findUiText('目标', 1, 1, ${debug})`, context)).found, true);
        assert.equal((await vm.runInContext(`findUiImage('asset', 1, 1, ${debug})`, context)).found, true);
        assert.equal(inputs, 0);
        assert.equal(now, 1000);
        assert.equal(disposed, 2);
        await vm.runInContext(`textOCREnhanced('目标', 1, 1, ${debug})`, context);
        assert.equal(inputs, 1);
        assert.equal(now, 1000);
    }
});

function replay(options = {}) {
    let now = Date.UTC(2026, 8, 14, 4), explicit = false, legacyMissingReads = 0, recoveryCalls = 0, capturedFrames = 0;
    const logs = [], reports = [], inputs = [], writes = [], data = new Map(Object.entries(options.files || {}));
    let concurrentInjected = false, statueRecoveries = 0;
    function injectConcurrentProgress(path) {
        if (!concurrentInjected && options.concurrentProgress && path.endsWith('_progress.v1.json')) {
            concurrentInjected = true;
            data.set(path, options.concurrentProgress);
        }
    }
    const game = { page: 'world', placed: false, partyAttempts: 0, consumedAt: null, akfEAt: null, receiptClosed: false, consumptionProofs: [],
        forgeCount: options.forgeCount || 0, forgeQueued: 0, forgeInputs: [],
        templateDisposals: [], cropsCreated: 0, cropsDisposed: 0,
        investmentOwned: options.investmentOwned === true, investmentLocation: false, investmentDismiss: 0,
        investmentPurchases: [], investmentSubmissions: [], investmentSettled: options.investmentSettled === true,
        netSoldOut: options.netAlreadySoldOut === true, netPurchases: 0, netPurchaseProofs: [],
        fateSoldOut: { ...(options.fatesAlreadySoldOut || {}) }, fatePurchases: [], selectedFate: null,
        cookQuantity: '1', cooked: [], holdingMouse: false, heldKeys: new Set(), bossRoutes: 0,
        domainEntries: 0, nativeFights: 0, activeFights: 0, drainedFights: 0, disposedCts: 0, fightStartedAt: null, fightEndedAt: null };
    class ReplayDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const absent = () => ({ isEmpty: () => true });
    function findImage(ro) {
        const path = ro.imagePath || '';
        if (options.cancelDuringMaterialSearch && path.endsWith('薄荷.png') && game.page === 'material') {
            options.cancelled = true;
            throw new Error('cancelled during material search');
        }
        if (options.forging && game.page === 'forge-recipes' && path.endsWith('/锻造水晶块.png'))
            return { isEmpty: () => false, x: 100, y: 60, width: 50, height: 50 };
        if (options.domain && !path) return { text: game.activeFights && now - game.fightStartedAt >= 1000 ?
            options.domain === 'weak-text' ? '目标达成' : '挑战成功' : '' };
        if (options.fatesShop) {
            const hit = (x = 100, y = 60) => ({ isEmpty: () => false, x, y, width: 50, height: 50 });
            if (path.endsWith('/星尘.png') && ['stardust-list', 'fate-confirm'].includes(game.page)) return hit();
            for (const [name, x] of [['纠缠之缘', 100], ['相遇之缘', 300]]) {
                if (game.page !== 'stardust-list') continue;
                if (path.endsWith(`/待刷新${name}.png`) && game.fateSoldOut[name]) return hit();
                if (path.endsWith(`/${name}.png`) && !game.fateSoldOut[name]) return hit(x);
            }
            return absent();
        }
        const found = options.transformerSuccess &&
            ((path.endsWith('zhibian.png') && game.page === 'gadget') ||
                (path.endsWith('薄荷.png') && game.page === 'material') ||
                (path.endsWith('cha.png') && game.page === 'material'));
        return found ? { isEmpty: () => false, x: 300, y: 300, width: 50, height: 50 } : absent();
    }
    function findText(ro = {}) {
        let words = [];
        if (options.akfRewardMode && game.akfEAt !== null) {
            const elapsed = now - game.akfEAt - 5000;
            if (options.akfRewardMode === 'frozen' || (elapsed >= 0 && elapsed < 40000 && elapsed % 4000 < 700))
                words = ['获得'];
        }
        if (options.transformerSuccess) {
            if (game.page === 'gadget') words = ['小道具', ...(options.wrongDeployButton ? ['装备'] : ['部署'])];
            if (game.page === 'material') words = ['进行质变', '材料', options.insufficientMaterials ? '149/150' : '150/150'];
            if (game.page === 'material-confirm') words = ['参量质变仪', options.changedMaterialConfirmation ? '购买' : '确认'];
            if (game.page === 'world' && game.placed && game.consumedAt === null) words = ['参量质变仪'];
            if (game.page === 'world' && game.consumedAt !== null && now - game.consumedAt >= 2500 && !game.receiptClosed)
                words = ['质变产生了以下物质'];
        }
        let result = words.map(text => ({ text, x: 300, y: 300, width: 50, height: 50 }));
        if (options.netShop) {
            const label = (text, x, y) => ({ text, x, y, width: 60, height: 25 });
            result = game.page === 'net-dialogue' ? [label('购买四方八方之网', 1400, 650)] :
                game.page === 'net-shop' ? [label('四方八方之网', 1400, 200),
                    ...(game.netSoldOut ? [label('已售罄', 1550, 935)] : [label('购买', 1670, 1015)])] :
                game.page === 'net-quantity' ? [label('购买', 1175, 780), label('四方八方之网', 900, 400)] :
                game.page === 'net-reward' ? [label('获得', 900, 260), label('四方八方之网', 900, 540)] : [];
            if (ro.roi) {
                const [x, y, w, h] = ro.roi;
                result = result.filter(item => item.x >= x && item.x < x + w && item.y >= y && item.y < y + h);
            }
        }
        if (options.fatesShop) {
            const label = (text, x, y) => ({ text, x, y, width: 50, height: 25 });
            result = game.page === 'menu' ? [label('祈愿', 340, 880)] :
                game.page === 'wish' ? [label('尘辉兑换', 130, 1020)] :
                game.page === 'exchange-tabs' ? [label('星尘兑换', 800, 120)] :
                game.page === 'fate-confirm' ? [label('兑换', 1170, 780)] : [];
            if (ro.roi) {
                const [x, y, w, h] = ro.roi;
                result = result.filter(item => item.x >= x && item.x < x + w && item.y >= y && item.y < y + h);
            }
        }
        if (options.cooking) {
            const label = (text, x, y) => ({ text, x, y, width: 50, height: 25 });
            result = game.page === 'cook-world' ? [label('烹饪', 1190, 490)] :
                game.page === 'cook-recipes' ? [label(options.settings.food, 400, 400)] :
                game.page === 'cook-mode' ? [label('自动烹饪', 790, 1015)] :
                game.page === 'cook-quantity' ? [label(game.cookQuantity, 960, 460)] :
                game.page === 'cook-receipt' && now - game.cooked.at(-1).at >= 2500 ? [label('确认', 965, 900)] : [];
            if (ro.roi) {
                const [x, y, w, h] = ro.roi;
                result = result.filter(item => item.x >= x && item.x < x + w && item.y >= y && item.y < y + h);
            }
        }
        if (options.domain) {
            const label = (text, x, y) => ({ text, x, y, width: 50, height: 25 });
            result = game.page === 'domain-solo' ? [label('单人挑战', 1700, 1015)] :
                game.page === 'domain-start' ? [label('开始挑战', 1700, 1015)] :
                game.page === 'domain-leyline' ? [label('地脉异常', 900, 430)] :
                game.page === 'domain-before-start' ? [label('启动', 1250, 530)] : [];
            if (options.domain === 'no-entry') result = [];
        }
        if (options.forging) {
            const label = (text, x, y) => ({ text, x, y, width: 160, height: 25 });
            result = game.page === 'weekly-tabs' ? [label('本周任务', 400, 120)] :
                game.page === 'weekly-forge' ? [label('锻造20件物品', 450, 350), label(`${game.forgeCount}/20`, 1500, options.forging === 'wrong-row' ? 650 : 350)] :
                game.page === 'forge-npc' ? [label('瓦格纳', 1190, 500)] :
                game.page === 'forge-dialogue' ? [label('委托锻造', 1300, 520)] :
                game.page === 'forge-filter' ? [label('武器升级材料', 100, 200)] :
                game.page === 'forge-ready' ? [label('开始锻造', 1760, 1015),
                    ...(game.forgeQueued && options.forging !== 'unknown' ? [label('可收取', 625, 265), label('全部领取', 180, 1015)] : [])] :
                game.page === 'forge-reward' ? [label('确认', 980, 900)] : [];
            if (ro.roi) {
                const [x, y, w, h] = ro.roi;
                result = result.filter(item => item.x >= x && item.x < x + w && item.y >= y && item.y < y + h);
            }
        }
        if (options.investment) {
            const label = (text, x, y) => ({ text, x, y, width: 130, height: 25 });
            result = game.page === 'investment-dialogue' ? [label('我要结算', 1400, 600)] :
                game.page === 'investment-state' ? [label(game.investmentSettled ? '投资券已结算' : game.investmentOwned ? '投资券' : '没有投资券', 900, 940)] :
                game.page === 'investment-shop' ? [label('投资券', 1400, 200), label('购买', 1700, 1000)] :
                game.page === 'investment-quantity' ? [label('投资券', 900, 400), label('购买', 1180, 780)] :
                game.page === 'investment-purchased' ? [label('获得', 900, 260), label('投资券', 900, 500)] :
                game.page === 'investment-selection' ? [label('投资券', 110, 185)] :
                game.page === 'investment-submit' ? [label('投资券', 900, 400), label('提交', 1620, 1020)] :
                game.page === 'investment-submitted' ? [label('投资券', 900, 400), label('提交成功', 900, 600)] : [];
            if (ro.roi) {
                const [x, y, w, h] = ro.roi;
                result = result.filter(item => item.x >= x && item.x < x + w && item.y >= y && item.y < y + h);
            }
        }
        result.count = result.length;
        return result;
    }
    const frame = () => {
        if (options.domain === 'slow-capture' && game.activeFights) now += 300;
        const captureTime = options.domain === 'frozen' && game.fightStartedAt !== null ? Math.min(now, game.fightStartedAt + 1000) : now;
        const capturedAt = Math.floor((captureTime - (++capturedFrames <= (options.staleUiFrames || 0) ? 5000 : 0)) / 50) * 50;
        const stamp = { IsKnown: true, SessionId: 'test-capture', Sequence: capturedAt / 50,
            CapturedAt: { ToUnixTimeMilliseconds: () => capturedAt },
            IsAfter: other => other.SessionId === 'test-capture' && capturedAt / 50 > other.Sequence };
        return { FrameStamp: stamp, dispose() {}, findMulti: findText, Find: findImage, find: findImage,
            DeriveCrop: () => { game.cropsCreated++; return { Find: findImage, find: findImage, dispose() { game.cropsDisposed++; } }; } };
    };
    function press(key) {
        inputs.push(['key', key]);
        if (key === 'B') game.page = 'bag';
        if (options.investment && key === 'F' && game.investmentLocation) {
            if (game.page === 'world' || game.page === 'investment-npc') game.page = 'investment-dialogue';
            else if (game.page === 'investment-state' && game.investmentOwned) game.page = 'investment-selection';
        }
        if (options.forging && key === 'F4') game.page = 'weekly-tabs';
        if (key === 'F' && game.placed && !options.dropMaterialInteraction) game.page = 'material';
        if (key === 'F' && game.page === 'net-npc') game.page = 'net-dialogue';
        if (key === 'VK_ESCAPE' && ['net-quantity', 'net-reward'].includes(game.page)) game.page = 'net-shop';
        if (options.fatesShop && key === 'VK_ESCAPE') {
            if (game.page === 'world') game.page = 'menu';
            else if (['fate-confirm', 'fate-reward'].includes(game.page)) game.page = 'stardust-list';
        }
        if (options.domain && key === 'F') {
            if (game.page === 'domain-entrance') game.page = 'domain-solo';
            else if (game.page === 'domain-before-start') { game.page = 'domain-arena'; game.domainEntries++; }
        }
    }
    function click(x, y) {
        inputs.push(['click', x, y]);
        if (options.investment) {
            if (x === 1400 && y === 600 && game.page === 'investment-dialogue') { game.page = 'investment-state'; game.investmentDismiss = 0; }
            if (x === 960 && y === 540 && game.page === 'investment-state' && !game.investmentOwned && ++game.investmentDismiss >= 3)
                game.page = 'investment-shop';
            if (x === 1700 && y === 1000 && game.page === 'investment-shop') game.page = 'investment-quantity';
            if (x === 1180 && y === 780 && game.page === 'investment-quantity') {
                game.investmentPurchases.push(data.get('record/test-account_progress.v1.json'));
                if (options.investment !== 'purchase-unknown') { game.investmentOwned = true; game.page = 'investment-purchased'; }
            }
            if (x === 1235 && y === 815 && game.page === 'investment-selection') game.page = 'investment-submit';
            if (x === 1620 && y === 1020 && game.page === 'investment-submit') {
                game.investmentSubmissions.push(data.get('record/test-account_progress.v1.json'));
                if (options.investment !== 'submit-unknown') { game.investmentSettled = true; game.page = 'investment-submitted'; }
            }
        }
        if (options.forging) {
            if (x === 400 && y === 120 && game.page === 'weekly-tabs') game.page = 'weekly-forge';
            if (x === 1190 && y === 500 && game.page === 'forge-npc') game.page = 'forge-dialogue';
            if (x === 1300 && y === 520 && game.page === 'forge-dialogue') game.page = 'forge-recipes';
            if (x === 360 && y === 1015 && game.page === 'forge-recipes') game.page = 'forge-filter';
            if (x === 100 && y === 200 && game.page === 'forge-filter') game.page = 'forge-recipes';
            if (x === 140 && y === 270 && game.page === 'forge-recipes') game.page = 'forge-ready';
            if (x === 1760 && y === 1015 && game.page === 'forge-ready') {
                game.forgeInputs.push(data.get('record/test-account_progress.v1.json'));
                game.forgeQueued += 5;
            }
            if (x === 180 && y === 1015 && game.page === 'forge-ready') {
                game.forgeCount = options.forging === 'partial' ? 10 : Math.min(20, game.forgeCount + game.forgeQueued);
                game.forgeQueued = 0;
                game.page = 'forge-reward';
            }
            if (x === 980 && y === 900 && game.page === 'forge-reward') game.page = 'forge-recipes';
        }
        if (x === 1067 && y === 57 && game.page === 'bag') game.page = 'gadget';
        if (x === 1699 && y === 1004 && game.page === 'gadget' && !options.dropTransformerPlacement) {
            game.placed = true; game.page = 'world';
        }
        if (x === 1792 && y === 1019 && game.page === 'material') game.page = 'material-confirm';
        if (x === 1183 && y === 764 && game.page === 'material-confirm') {
            game.consumptionProofs.push(data.get('record/test-account_progress.v1.json'));
            game.consumedAt = now;
            game.page = 'world';
        }
        if (x === 970 && y === 760 && game.consumedAt !== null) game.receiptClosed = true;
        if (x === 1400 && y === 650 && game.page === 'net-dialogue') game.page = 'net-shop';
        if (x === 1670 && y === 1015 && game.page === 'net-shop' && !game.netSoldOut) game.page = 'net-quantity';
        if (x === 1175 && y === 780 && game.page === 'net-quantity') {
            game.netPurchaseProofs.push(data.get('record/test-account_progress.v1.json'));
            game.netPurchases++;
            if (options.netShop !== 'unknown') { game.netSoldOut = true; game.page = 'net-reward'; }
        }
        if (options.fatesShop) {
            if (x === 340 && y === 880 && game.page === 'menu') game.page = 'wish';
            if (x === 130 && y === 1020 && game.page === 'wish') game.page = 'exchange-tabs';
            if (x === 800 && y === 120 && game.page === 'exchange-tabs') game.page = 'stardust-list';
            if ((x === 621 || x === 821) && y === 309 && game.page === 'stardust-list') {
                game.selectedFate = x === 621 ? '纠缠之缘' : '相遇之缘';
                game.page = 'fate-confirm';
            }
            if (x === 1170 && y === 780 && game.page === 'fate-confirm') {
                game.fatePurchases.push({ name: game.selectedFate, progress: data.get('record/test-account_progress.v1.json') });
                if (options.fatesShop[game.selectedFate] !== 'unknown') {
                    game.fateSoldOut[game.selectedFate] = true;
                    game.page = 'fate-reward';
                }
            }
        }
        if (options.cooking) {
            if (x === 1205 && y === 505 && game.page === 'cook-world') game.page = 'cook-recipes';
            if (x === 450 && y === 340 && game.page === 'cook-recipes') game.page = 'cook-detail';
            if (x === 1700 && y === 1020 && game.page === 'cook-detail') game.page = 'cook-mode';
            if (x === 790 && y === 1015 && game.page === 'cook-mode') game.page = 'cook-quantity';
            if (x === 1190 && y === 755 && game.page === 'cook-quantity') {
                game.cooked.push({ count: Number(game.cookQuantity), at: now, progress: data.get('record/test-account_progress.v1.json') });
                game.page = options.cooking === 'unknown' ? 'cook-quantity' : 'cook-receipt';
            }
        }
        if (options.domain) {
            if (x === 1700 && y === 1015 && game.page === 'domain-solo') game.page = 'domain-start';
            else if (x === 1700 && y === 1015 && game.page === 'domain-start') game.page = 'domain-leyline';
            if (x === 900 && y === 430 && game.page === 'domain-leyline') game.page = 'domain-before-start';
        }
    }
    function read(path, optional) {
        if (path === 'manifest.json') return '{"name":"AutoMonday","version":"test"}';
        if (optional && options.readError) {
            const error = new Error('read failed');
            error.hostException = { HResult: -2146232828, InnerException: { HResult: options.readError } };
            throw error;
        }
        if (data.has(path)) return data.get(path);
        if (!optional) legacyMissingReads++;
        const error = new Error('file not found');
        error.hostException = { HResult: -2146232828, InnerException: { HResult: -2147024894 } };
        throw error;
    }
    class NativeCancellation {
        isCancellationRequested = false;
        drained = false;
        cancel() { this.isCancellationRequested = true; this.onCancel?.(); }
        dispose() { assert.equal(this.drained, true, 'native input must drain before disposing its token'); game.disposedCts++; }
    }
    const context = vm.createContext({
        Date: ReplayDate,
        settings: { ifCheck: true, ifZBY: true, Material: '薄荷', username: 'test-account', ...options.settings },
        sleep: async ms => { now += Number(ms); },
        setGameMetrics() {},
        keyPress: press,
        keyDown: key => { inputs.push(['down', key]); game.heldKeys.add(key); if (key === 'E') game.akfEAt = now; },
        keyUp: key => { inputs.push(['up', key]); game.heldKeys.delete(key); },
        leftButtonClick: () => inputs.push(['attack']),
        leftButtonDown: () => { inputs.push(['left-down']); game.holdingMouse = true; },
        leftButtonUp: () => { inputs.push(['left-up']); game.holdingMouse = false; },
        middleButtonClick: () => inputs.push(['middle']),
        moveMouseTo: (x, y) => inputs.push(['move', x, y]),
        getAvatars: () => ['爱可菲', '芭芭拉'],
        click,
        inputText: value => { inputs.push(['text', value]); game.cookQuantity = options.clampedCookQuantity || String(value); },
        captureGameRegion: frame,
        CancellationTokenSource: NativeCancellation,
        SoloTask: class { constructor(name) { this.name = name; } },
        dispatcher: { runTask: (task, ct) => {
            assert.equal(task.name, 'AutoFight');
            assert.equal(game.page, 'domain-arena');
            game.nativeFights++; game.activeFights++; game.fightStartedAt = now;
            if (options.domain === 'native-failure') {
                ct.drained = true; game.activeFights--; game.drainedFights++;
                return Promise.reject(new Error('native battle failed'));
            }
            return new Promise(resolve => { ct.onCancel = () => setTimeout(() => {
                ct.drained = true; game.activeFights--; game.drainedFights++; game.fightEndedAt = now; resolve();
            }, 1); });
        } },
        pathingScript: { runFile: async path => {
            inputs.push(['route', path]);
            if (options.routeFails) throw new Error('route did not complete');
            if (path.endsWith('急冻树.json') || path.endsWith('爆炎树.json')) {
                game.bossRoutes++;
                if (game.bossRoutes === options.failBossRoute) throw new Error('native fight not confirmed');
            }
            if (options.netShop && path.endsWith('四方八方之网.json')) game.page = 'net-npc';
            if (options.forging && path.endsWith('瓦格纳.json')) game.page = 'forge-npc';
            if (options.investment && path.endsWith('投资券.json')) { game.page = 'investment-npc'; game.investmentLocation = true; }
            if (options.cooking && path.endsWith('每周做菜.json')) game.page = 'cook-world';
            return options.routeWithoutReceipt ? undefined : { success: true };
        } },
        genshin: { switchParty: async () => { game.partyAttempts++; return !options.partyFailure &&
            (!options.partyTemporary || game.partyAttempts > 1); },
            tpToStatueOfTheSeven: async () => { inputs.push(['statue']); statueRecoveries++; },
            inspectWorldUi: () => JSON.stringify({ kind: options.worldUnsafe &&
                (statueRecoveries === 0 || options.worldRecoveryFails) || options.partyTemporary && game.partyAttempts > 0 && statueRecoveries === 0
                ? 'TemporarilyUnavailable' : 'Unknown',
                reason: 'recorded-world-observation',
                canProbe: (!options.worldUnsafe || statueRecoveries > 0 && !options.worldRecoveryFails) &&
                    !(options.partyTemporary && game.partyAttempts > 0 && statueRecoveries === 0),
                source: { known: true, capturedAtUnixMs: now } }),
            tp: async () => { assert.equal(game.activeFights, 0, 'teleport cannot overlap the previous native battle'); game.page = 'domain-entrance'; },
            returnMainUi: async () => { game.page = 'world'; }, recoverMainUi: async () => {
            recoveryCalls++;
            if (options.recoveryFails) throw new Error('native recovery failed');
            game.page = 'world';
        } },
        file: {
            ReadImageMatSync: path => ({ path, dispose() { game.templateDisposals.push(path); } }),
            readTextSync: path => read(path, false),
            readTextSyncOrThrow: path => read(path, true),
            readText: async path => read(path, false),
            isFile: path => data.has(path),
            createDirectory: () => true,
            mkdir: async () => {},
            writeText: async (path, body) => {
                injectConcurrentProgress(path);
                writes.push([path, body]);
                if (options.writeFails) return false;
                if (!options.dropCdWrites || !path.endsWith('_cd.txt')) data.set(path, body);
                return true;
            },
            compareExchangeTextSync: (path, expected, body) => {
                injectConcurrentProgress(path);
                writes.push([path, body]);
                if (options.writeFails || (data.has(path) ? data.get(path) : null) !== expected) return false;
                if (!options.dropCdWrites || !path.endsWith('_cd.txt')) data.set(path, body);
                return true;
            }
        },
        RecognitionObject: { TemplateMatch: image => ({ imagePath: image.path, InitTemplate() {} }),
            Ocr: (...roi) => ({ roi }), ocr: (...roi) => ({ roi }) },
        log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(kind => [kind, (...args) => {
            if (options.loggerFails) throw new Error('log unavailable');
            logs.push({ kind, text: args.join(' ') });
        }])),
        taskResult: { check() { if (options.cancelled) throw new Error('cancelled'); },
            requireExplicitOutcome() { explicit = true; }, report: (...args) => reports.push(args) }
    });
    const snapshot = () => ({ explicit, reports, logs, inputs, writes, data, legacyMissingReads, recoveryCalls, game });
    return vm.runInContext(source, context, { timeout: 1000, filename: sourcePath.pathname }).then(snapshot,
        error => { error.replay = snapshot(); throw error; });
}

test('the complete production main reports the missing gadget page as failure without a completed CD', async () => {
    const result = await replay();
    assert.equal(result.explicit, true);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0][0], 'Failed');
    assert.ok(result.logs.some(entry => entry.text.includes("未打开'小道具'")));
    assert.equal(result.writes.some(([path]) => path.endsWith('_cd.txt')), false);
    assert.equal(result.legacyMissingReads, 0);
});

test('a concurrent account intent is not overwritten and no second consumption starts', async () => {
    const foreign = JSON.stringify({ schemaVersion: 1, actions: { '质变仪': {
        state: 'pending', startedAt: '2026-09-14T04:00:00.000Z', owner: 'another-run'
    } } });
    const result = await replay({ transformerSuccess: true, concurrentProgress: foreign });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.data.get('record/test-account_progress.v1.json'), foreign);
    assert.equal(result.game.consumptionProofs.length, 0);
    assert.equal(result.data.has('record/test-account_cd.txt'), false);
});

for (const [setting, route] of [['ifduanZao', '每周锻造'], ['ifbuyTzq', '投资券']]) {
    test(`${route} keeps a valid existing cooldown as an explicit skip without UI input`, async () => {
        const result = await replay({ settings: { ifZBY: false, [setting]: true },
            files: { 'record/test-account_cd.txt': `${route}::2026-09-21T04:00:00.000Z\n` } });
        assert.equal(result.reports[0][0], 'Skipped');
        assert.deepEqual(result.inputs, []);
        assert.equal(result.writes.length, 0);
    });
}

test('unconfirmed forging clicks cannot write a successful weekly cooldown', async () => {
    const result = await replay({ settings: { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' } });
    assert.equal(result.data.has('record/test-account_cd.txt'), false);
    assert.notEqual(result.reports[0][0], 'Completed');
});

test('forging confirms the actual weekly 20 item counter after collecting instead of counting button inputs', async () => {
    const result = await replay({ settings: { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' }, forging: 'success' });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.forgeCount, 20);
    assert.equal(result.game.forgeInputs.length, 4);
    assert.ok(result.game.forgeInputs.every(value => JSON.parse(value).actions['每周锻造'].state === 'pending'));
    assert.match(result.data.get('record/test-account_cd.txt'), /每周锻造::/);
});

test('image matching disposes cropped frames and its loaded template after a successful operation', async () => {
    const result = await replay({ settings: { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' }, forging: 'success' });
    assert.equal(result.reports[0][0], 'Completed');
    assert.ok(result.game.cropsCreated > 0);
    assert.equal(result.game.cropsDisposed, result.game.cropsCreated);
    assert.ok(result.game.templateDisposals.includes('assets/RecognitionObject/锻造水晶块.png'));
});

test('a transient stale noncombat UI frame is retried inside the original phase deadline', async () => {
    const result = await replay({ settings: { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' },
        forging: 'success', staleUiFrames: 1 });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.forgeInputs.length, 4);
});

test('partial forged output remains pending and cannot replay material consumption', async () => {
    const settings = { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' };
    const first = await replay({ settings, forging: 'partial' });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.game.forgeCount, 10);
    assert.equal(first.data.has('record/test-account_cd.txt'), false);
    const second = await replay({ settings, forging: 'success', forgeCount: 10, files: Object.fromEntries(first.data) });
    assert.equal(second.reports[0][0], 'NeedsReconcile');
    assert.equal(second.game.forgeInputs.length, 0);
    const reconciled = await replay({ settings, forging: 'success', forgeCount: 20, files: Object.fromEntries(first.data) });
    assert.equal(reconciled.reports[0][0], 'Completed');
    assert.equal(reconciled.game.forgeInputs.length, 0);
});

test('an unrelated weekly 20 counter cannot authorize forging completion or consumption', async () => {
    const result = await replay({ settings: { ifZBY: false, ifduanZao: true, mineral: '锻造水晶块' }, forging: 'wrong-row', forgeCount: 20 });
    assert.equal(result.reports[0][0], 'Failed');
    assert.equal(result.game.forgeInputs.length, 0);
    assert.equal(result.data.has('record/test-account_cd.txt'), false);
});

test('unconfirmed investment submission cannot write a successful weekly cooldown', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyTzq: true } });
    assert.equal(result.data.has('record/test-account_cd.txt'), false);
    assert.notEqual(result.reports[0][0], 'Completed');
});

for (const investmentOwned of [false, true]) {
    test(`investment purchase and submission have separate receipts (owned=${investmentOwned})`, async () => {
        const result = await replay({ settings: { ifZBY: false, ifbuyTzq: true }, investment: 'success', investmentOwned });
        assert.equal(result.reports[0][0], 'Completed');
        assert.equal(result.game.investmentPurchases.length, investmentOwned ? 0 : 1);
        assert.equal(result.game.investmentSubmissions.length, 1);
        assert.equal(JSON.parse(result.game.investmentSubmissions[0]).actions['投资券'].state, 'pending');
        if (!investmentOwned) assert.equal(JSON.parse(result.game.investmentPurchases[0]).actions['投资券购买'].state, 'pending');
        assert.match(result.data.get('record/test-account_cd.txt'), /(?:^|\n)投资券::/);
    });
}

test('unknown investment payment prevents both another purchase and downstream submission', async () => {
    const settings = { ifZBY: false, ifbuyTzq: true };
    const first = await replay({ settings, investment: 'purchase-unknown' });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.game.investmentPurchases.length, 1);
    assert.equal(first.game.investmentSubmissions.length, 0);
    const second = await replay({ settings, investment: 'success', files: Object.fromEntries(first.data) });
    assert.equal(second.reports[0][0], 'NeedsReconcile');
    assert.equal(second.game.investmentPurchases.length, 0);
    assert.equal(second.game.investmentSubmissions.length, 0);
    const arrivedWithoutReceipt = await replay({ settings, investment: 'success', investmentOwned: true, files: Object.fromEntries(first.data) });
    assert.equal(arrivedWithoutReceipt.reports[0][0], 'NeedsReconcile');
    assert.equal(arrivedWithoutReceipt.game.investmentSubmissions.length, 0);
});

test('a confirmed investment purchase does not hide an unknown submission or permit it to repeat', async () => {
    const settings = { ifZBY: false, ifbuyTzq: true };
    const first = await replay({ settings, investment: 'submit-unknown' });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.game.investmentSubmissions.length, 1);
    assert.match(first.data.get('record/test-account_cd.txt'), /投资券购买::/);
    assert.doesNotMatch(first.data.get('record/test-account_cd.txt'), /(?:^|\n)投资券::/);
    const second = await replay({ settings, investment: 'success', investmentOwned: true, files: Object.fromEntries(first.data) });
    assert.equal(second.reports[0][0], 'NeedsReconcile');
    assert.equal(second.game.investmentPurchases.length, 0);
    assert.equal(second.game.investmentSubmissions.length, 0);
    const reconciled = await replay({ settings, investment: 'success', investmentSettled: true, files: Object.fromEntries(first.data) });
    assert.equal(reconciled.reports[0][0], 'Completed');
    assert.equal(reconciled.game.investmentSubmissions.length, 0);
});

test('a failed shop route cannot issue later purchase input or write a completion CD', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, routeFails: true });
    assert.equal(result.reports[0][0], 'Failed');
    assert.deepEqual(result.inputs, [['route', 'assets/四方八方之网.json']]);
    assert.equal(result.writes.length, 0);
});

test('a route without the native success receipt cannot authorize shop input', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, netShop: 'success', routeWithoutReceipt: true });
    assert.equal(result.reports[0][0], 'Failed');
    assert.deepEqual(result.inputs, [['route', 'assets/四方八方之网.json']]);
    assert.equal(result.writes.length, 0);
});

test('the net purchase persists intent before payment and requires the selected item to become sold out', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, netShop: 'success' });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.netPurchases, 1);
    assert.equal(JSON.parse(result.game.netPurchaseProofs[0]).actions['购买四方网'].state, 'pending');
    assert.match(result.data.get('record/test-account_cd.txt'), /购买四方网::/);
    assert.equal(JSON.parse(result.data.get('record/test-account_progress.v1.json')).actions['购买四方网'], undefined);
});

test('an unknown net payment remains pending and the next run cannot pay again', async () => {
    const settings = { ifZBY: false, ifbuyNet: true };
    const first = await replay({ settings, netShop: 'unknown' });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.game.netPurchases, 1);
    assert.equal(first.data.has('record/test-account_cd.txt'), false);
    const second = await replay({ settings, netShop: 'success', files: Object.fromEntries(first.data) });
    assert.equal(second.reports[0][0], 'NeedsReconcile');
    assert.equal(second.game.netPurchases, 0);
    assert.equal(second.inputs.some(input => input[0] === 'click' && input[1] === 1670 && input[2] === 1015), false);
});

test('a pending net payment can reconcile a fresh sold-out quota without reopening payment', async () => {
    const files = { 'record/test-account_progress.v1.json': JSON.stringify({ schemaVersion: 1,
        actions: { '购买四方网': { state: 'pending', startedAt: '2026-09-14T03:00:00Z' } } }) };
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, netShop: 'success', netAlreadySoldOut: true, files });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.netPurchases, 0);
    assert.equal(result.inputs.some(input => input[0] === 'click' && input[1] === 1670 && input[2] === 1015), false);
    assert.match(result.data.get('record/test-account_cd.txt'), /购买四方网::/);
});

test('a lost CD write retains the confirmed receipt and retries only the record, never the payment', async () => {
    const settings = { ifZBY: false, ifbuyNet: true };
    const first = await replay({ settings, netShop: 'success', dropCdWrites: true });
    assert.equal(first.game.netPurchases, 1);
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(JSON.parse(first.data.get('record/test-account_progress.v1.json')).actions['购买四方网'].state, 'confirmed');
    const second = await replay({ settings, netShop: 'success', files: Object.fromEntries(first.data) });
    assert.equal(second.reports[0][0], 'Completed');
    assert.equal(second.game.netPurchases, 0);
    assert.match(second.data.get('record/test-account_cd.txt'), /购买四方网::/);
});

test('a net intent persistence failure cannot submit payment', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, netShop: 'success', writeFails: true });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.game.netPurchases, 0);
});

test('an active net CD skips without visiting the shop', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true },
        files: { 'record/test-account_cd.txt': '购买四方网::2099-01-01T00:00:00Z\n' } });
    assert.equal(result.reports[0][0], 'Skipped');
    assert.deepEqual(result.inputs, []);
    assert.deepEqual(result.writes, []);
});

test('a visibly sold out net is skipped after restoring the main UI without payment', async () => {
    const result = await replay({ settings: { ifZBY: false, ifbuyNet: true }, netShop: 'success', netAlreadySoldOut: true });
    assert.equal(result.reports[0][0], 'Skipped');
    assert.equal(result.game.netPurchases, 0);
    assert.equal(result.game.page, 'world');
});

test('both requested fates confirm their own post-exchange quota and keep separate receipts', async () => {
    const result = await replay({ settings: { ifZBY: false, ifPink: true, ifBlue: true }, fatesShop: {} });
    assert.equal(result.reports[0][0], 'Completed');
    assert.deepEqual(result.game.fatePurchases.map(item => item.name), ['纠缠之缘', '相遇之缘']);
    for (const item of result.game.fatePurchases)
        assert.equal(JSON.parse(item.progress).actions[item.name].state, 'pending');
    assert.match(result.data.get('record/test-account_cd.txt'), /纠缠之缘::/);
    assert.match(result.data.get('record/test-account_cd.txt'), /相遇之缘::/);
    assert.deepEqual(JSON.parse(result.data.get('record/test-account_progress.v1.json')).actions, {});
});

test('cooking verifies the chosen quantity before consuming and confirms the result panel before CD', async () => {
    const result = await replay({ settings: { ifZBY: false, ifCooking: true, food: '提瓦特煎蛋', cookCount: '20' }, cooking: 'success' });
    assert.equal(result.game.cooked.length, 1);
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.cooked[0].count, 20);
    assert.equal(JSON.parse(result.game.cooked[0].progress).actions['每周做菜'].state, 'pending');
    assert.match(result.data.get('record/test-account_cd.txt'), /每周做菜::/);
    assert.equal(result.game.holdingMouse, false);
    assert.equal(result.game.heldKeys.size, 0);
});

test('the weekly boss batch completes only after ten confirmed native routes', async () => {
    const result = await replay({ settings: { ifZBY: false, ifShouling: true } });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.bossRoutes, 10);
    assert.match(result.data.get('record/test-account_cd.txt'), /每周首领::/);
    const checkpoints = result.writes.filter(([path]) => path.endsWith('_progress.v1.json'))
        .map(([, text]) => JSON.parse(text).actions['每周首领']).filter(Boolean);
    assert.ok(checkpoints.some(item => item.batch?.completed === 10 && !item.batch.inFlight));
});

test('domain rounds join the cancelled native battle before teleporting or recording completion', async () => {
    const result = await replay({ settings: { ifZBY: false, ifMijing: true }, domain: 'success' });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.domainEntries, 10);
    assert.equal(result.game.nativeFights, 10);
    assert.equal(result.game.drainedFights, 10);
    assert.equal(result.game.disposedCts, 10);
    assert.equal(result.game.activeFights, 0);
    assert.match(result.data.get('record/test-account_cd.txt'), /每周秘境::/);
});

for (const mode of ['weak-text', 'frozen', 'native-failure', 'slow-capture']) {
    test(`domain ${mode} cannot count a victory or leave a native battle running`, async () => {
        const result = await replay({ settings: { ifZBY: false, ifMijing: true }, domain: mode });
        assert.equal(result.reports[0][0], 'NeedsReconcile');
        assert.equal(result.game.nativeFights, 1);
        assert.equal(result.game.activeFights, 0);
        assert.equal(result.game.drainedFights, 1);
        assert.equal(result.game.disposedCts, 1);
        assert.equal(result.data.has('record/test-account_cd.txt'), false);
        assert.equal(JSON.parse(result.data.get('record/test-account_progress.v1.json')).actions['每周秘境'].batch.completed, 0);
        if (mode === 'slow-capture') assert.ok(result.game.fightEndedAt - result.game.fightStartedAt <= 1500,
            'repeated decision overruns must not keep the blind native battle running for the full timeout');
    });
}

test('a domain entry failure cannot start combat or write completion CD', async () => {
    const result = await replay({ settings: { ifZBY: false, ifMijing: true }, domain: 'no-entry' });
    assert.notEqual(result.reports[0][0], 'Completed');
    assert.equal(result.game.nativeFights, 0);
    assert.equal(result.data.has('record/test-account_cd.txt'), false);
});

test('unknown boss completion retains confirmed rounds and prevents replaying the batch', async () => {
    const settings = { ifZBY: false, ifShouling: true };
    const first = await replay({ settings, failBossRoute: 4 });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    const progress = JSON.parse(first.data.get('record/test-account_progress.v1.json')).actions['每周首领'].batch;
    assert.equal(progress.completed, 3);
    assert.equal(progress.inFlight, true);
    assert.equal(first.data.has('record/test-account_cd.txt'), false);
    const next = await replay({ settings, files: Object.fromEntries(first.data) });
    assert.equal(next.reports[0][0], 'NeedsReconcile');
    assert.equal(next.game.bossRoutes, 0);
});

test('a verified between-round checkpoint resumes only the seven remaining boss routes', async () => {
    const files = { 'record/test-account_progress.v1.json': JSON.stringify({ schemaVersion: 1, actions: {
        '每周首领': { state: 'pending', startedAt: '2026-09-14T03:00:00Z',
            batch: { total: 10, completed: 3, inFlight: false, cooldownUntil: '2026-09-21T03:00:00Z' } }
    } }) };
    const result = await replay({ settings: { ifZBY: false, ifShouling: true }, files });
    assert.equal(result.reports[0][0], 'Completed');
    const routes = result.inputs.filter(input => input[0] === 'route');
    assert.equal(routes.length, 7);
    assert.equal(routes[0][1], 'assets/爆炎树.json');
});

test('clamped cooking quantity cannot spend ingredients or write a completion CD', async () => {
    const result = await replay({ settings: { ifZBY: false, ifCooking: true, food: '提瓦特煎蛋', cookCount: '20' },
        cooking: 'success', clampedCookQuantity: '3' });
    assert.equal(result.reports[0][0], 'Failed');
    assert.equal(result.game.cooked.length, 0);
    assert.equal(result.writes.length, 0);
    assert.equal(result.game.holdingMouse, false);
    assert.equal(result.game.heldKeys.size, 0);
});

test('unconfirmed cooking cannot write CD and cannot consume ingredients on the next run', async () => {
    const settings = { ifZBY: false, ifCooking: true, food: '提瓦特煎蛋', cookCount: '20' };
    const first = await replay({ settings, cooking: 'unknown' });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.game.cooked.length, 1);
    assert.equal(first.data.has('record/test-account_cd.txt'), false);
    const next = await replay({ settings, cooking: 'success', files: Object.fromEntries(first.data) });
    assert.equal(next.reports[0][0], 'NeedsReconcile');
    assert.equal(next.game.cooked.length, 0);
});

test('one completed fate cannot hide the other fate payment uncertainty', async () => {
    const settings = { ifZBY: false, ifPink: true, ifBlue: true };
    const first = await replay({ settings, fatesShop: { '纠缠之缘': 'unknown' } });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.doesNotMatch(first.data.get('record/test-account_cd.txt'), /纠缠之缘::/);
    assert.match(first.data.get('record/test-account_cd.txt'), /相遇之缘::/);
    const next = await replay({ settings, fatesShop: {}, files: Object.fromEntries(first.data) });
    assert.equal(next.reports[0][0], 'NeedsReconcile');
    assert.equal(next.game.fatePurchases.length, 0);
});

test('script updates retain the pending and confirmed consumption journal', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../repo/js/AutoMonday/manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest.saved_files.includes('record/*_progress.v1.json'));
});

test('an existing active CD is a typed skip and is not rewritten', async () => {
    const result = await replay({ files: { 'record/test-account_cd.txt': '质变仪::2099-01-01T00:00:00.000Z\n' } });
    assert.equal(result.reports[0][0], 'Skipped');
    assert.equal(result.inputs.length, 0);
    assert.equal(result.writes.length, 0);
});

test('unreadable CD is not treated as a first run', async () => {
    const result = await replay({ readError: -2147024891 });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.inputs.length, 0);
    assert.equal(result.writes.length, 0);
});

test('a damaged CD is not treated as a first run', async () => {
    const result = await replay({ files: { 'record/test-account_cd.txt': '质变仪::broken-date' } });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.inputs.length, 0);
    assert.equal(result.writes.length, 0);
});

test('no enabled subtask is not completed work', async () => {
    const result = await replay({ settings: { ifZBY: false } });
    assert.equal(result.reports[0][0], 'Skipped');
    assert.equal(result.inputs.length, 0);
});

test('logger faults cannot change the result or issue additional game input', async () => {
    const normal = await replay();
    const failing = await replay({ loggerFails: true });
    assert.deepEqual(failing.reports, normal.reports);
    assert.deepEqual(failing.inputs, normal.inputs);
    assert.deepEqual(failing.writes, normal.writes);
});

test('failed native recovery is rethrown rather than converted to normal return', async () => {
    await assert.rejects(replay({ recoveryFails: true }), error => {
        assert.equal(error.replay.reports.length, 0);
        assert.equal(error.replay.inputs.length, 0);
        assert.equal(error.replay.recoveryCalls, 1);
        return true;
    });
});

test('the host cancellation guard stops before recovery or task input', async () => {
    await assert.rejects(replay({ cancelled: true }), error => {
        assert.equal(error.replay.reports.length, 0);
        assert.equal(error.replay.inputs.length, 0);
        assert.equal(error.replay.recoveryCalls, 0);
        return true;
    });
});

test('an Akf reward timeout records uncertainty, never a completed CD, and cannot consume again', async () => {
    const settings = { ifZBY: false, ifAkf: true, AKFTeamName: '厨房', akfChargingMethod: '法器角色充能' };
    const first = await replay({ settings });
    assert.equal(first.reports[0][0], 'NeedsReconcile');
    assert.equal(first.writes.some(([path]) => path.endsWith('_cd.txt')), false);
    const pending = JSON.parse(first.data.get('record/test-account_progress.v1.json'));
    assert.equal(pending.actions['爱可菲'].state, 'pending');
    const next = await replay({ settings, files: Object.fromEntries(first.data) });
    assert.equal(next.reports[0][0], 'NeedsReconcile');
    assert.equal(next.inputs.some(input => input[0] === 'down' && input[1] === 'E'), false);
});

test('an unacknowledged intent write cannot deploy the Akf machine', async () => {
    const result = await replay({ settings: { ifZBY: false, ifAkf: true, AKFTeamName: '厨房', akfChargingMethod: '法器角色充能' }, writeFails: true });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.inputs.some(input => input[0] === 'down' && input[1] === 'E'), false);
});

test('a confirmed receipt only finalizes records and does not repeat the physical action', async () => {
    const files = { 'record/test-account_progress.v1.json': JSON.stringify({ schemaVersion: 1, actions: {
        '爱可菲': { state: 'confirmed', startedAt: '2026-09-14T03:00:00Z', confirmedAt: '2026-09-14T03:01:00Z',
            cooldownUntil: '2099-01-01T00:00:00Z', evidence: 'AKF_REWARD_OCR_COUNT' }
    } }) };
    const result = await replay({ settings: { ifZBY: false, ifAkf: true, AKFTeamName: '厨房' }, files });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.inputs.length, 0);
    assert.equal(JSON.parse(result.data.get('record/test-account_progress.v1.json')).actions['爱可菲'], undefined);
    assert.match(result.data.get('record/test-account_cd.txt'), /爱可菲::2099/);
});

test('a malformed confirmed record is not sufficient proof for a completion CD', async () => {
    const files = { 'record/test-account_progress.v1.json': JSON.stringify({ schemaVersion: 1, actions: {
        '爱可菲': { state: 'confirmed', startedAt: '2026-09-14T03:00:00Z', cooldownUntil: '2099-01-01T00:00:00Z' }
    } }) };
    const result = await replay({ settings: { ifZBY: false, ifAkf: true, AKFTeamName: '厨房' }, files });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.writes.length, 0);
});

test('a pending transformer consumption prevents opening another material submission', async () => {
    const result = await replay({ files: { 'record/test-account_progress.v1.json': JSON.stringify({ schemaVersion: 1,
        actions: { '质变仪': { state: 'pending', startedAt: '2026-09-14T03:00:00Z' } } }) } });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.inputs.length, 0);
    assert.equal(result.writes.length, 0);
});

test('unconfirmed placement does not proceed to material interaction', async () => {
    const result = await replay({ transformerSuccess: true, dropTransformerPlacement: true });
    assert.equal(result.reports[0][0], 'Deferred');
    assert.match(result.reports[0][1], /ZBY_DEPLOYMENT_UNCONFIRMED/);
    assert.equal(result.game.consumptionProofs.length, 0);
    assert.equal(result.inputs.some(input => input[0] === 'key' && input[1] === 'F'), false);
    assert.equal(result.writes.some(([path]) => path.endsWith('_cd.txt')), false);
});

for (const fault of ['wrongDeployButton', 'dropMaterialInteraction', 'insufficientMaterials', 'changedMaterialConfirmation']) {
    test(`transformer ${fault} cannot submit consumption or stamp cooldown`, async () => {
        const result = await replay({ transformerSuccess: true, [fault]: true });
        assert.notEqual(result.reports[0][0], 'Completed');
        assert.equal(result.game.consumptionProofs.length, 0);
        assert.equal(result.game.heldKeys.size, 0);
        assert.equal(result.game.holdingMouse, false);
        assert.equal(result.writes.some(([path]) => path.endsWith('_cd.txt')), false);
    });
}

test('unsafe weekly entry uses one existing statue recovery before any bag input', async () => {
    const result = await replay({ transformerSuccess: true, worldUnsafe: true });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.inputs.filter(input => input[0] === 'statue').length, 1);
    assert.equal(result.inputs[0][0], 'statue');
});

test('unresolved unsafe weekly entry does not retry recovery or open the bag', async () => {
    const result = await replay({ transformerSuccess: true, worldUnsafe: true, worldRecoveryFails: true });
    assert.notEqual(result.reports[0][0], 'Completed');
    assert.equal(result.inputs.filter(input => input[0] === 'statue').length, 1);
    assert.equal(result.inputs.some(input => input[0] === 'key' && input[1] === 'B'), false);
    assert.equal(result.game.consumptionProofs.length, 0);
});

test('cancelling material search cannot leave the drag mouse pressed', async () => {
    await assert.rejects(replay({ transformerSuccess: true, cancelDuringMaterialSearch: true }), error => {
        assert.equal(error.replay.game.holdingMouse, false);
        assert.equal(error.replay.game.consumptionProofs.length, 0);
        return /cancelled/.test(error.message);
    });
});

test('a failed party name does not authorize a blind teleport or repeated switch', async () => {
    const result = await replay({ transformerSuccess: true, partyFailure: true, settings: { ZBYTeamName: '不存在' } });
    assert.notEqual(result.reports[0][0], 'Completed');
    assert.equal(result.game.partyAttempts, 1);
    assert.equal(result.inputs.filter(input => input[0] === 'statue').length, 0);
});

test('party failure cannot spend a second recovery after unsafe entry already recovered', async () => {
    const result = await replay({ transformerSuccess: true, worldUnsafe: true, partyFailure: true, settings: { ZBYTeamName: '水队' } });
    assert.equal(result.inputs.filter(input => input[0] === 'statue').length, 1);
    assert.equal(result.game.partyAttempts, 1);
});

test('fresh temporary party rejection can use the same single recovery owner', async () => {
    const result = await replay({ transformerSuccess: true, partyTemporary: true, settings: { ZBYTeamName: '水队' } });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.inputs.filter(input => input[0] === 'statue').length, 1);
    assert.equal(result.game.partyAttempts, 2);
});

test('the full transformer path persists intent before material input and confirms a real completion panel', async () => {
    // External UI model: bag -> gadget -> material -> confirmation, then a completion panel after 2500ms.
    // This validates the production control path, not the real game's OCR or coordinates.
    const result = await replay({ transformerSuccess: true });
    assert.equal(result.reports[0][0], 'Completed');
    assert.equal(result.game.consumptionProofs.length, 1);
    assert.equal(JSON.parse(result.game.consumptionProofs[0]).actions['质变仪'].state, 'pending');
    assert.ok(result.game.receiptClosed);
    assert.match(result.data.get('record/test-account_cd.txt'), /质变仪::/);
    assert.equal(JSON.parse(result.data.get('record/test-account_progress.v1.json')).actions['质变仪'], undefined);
});

test('one persistently visible reward notification cannot be counted as ten rewards', async () => {
    const result = await replay({ settings: { ifZBY: false, ifAkf: true, AKFTeamName: '厨房', akfChargingMethod: '法器角色充能' }, akfRewardMode: 'frozen' });
    assert.equal(result.reports[0][0], 'NeedsReconcile');
    assert.equal(result.writes.some(([path]) => path.endsWith('_cd.txt')), false);
});

test('ten distinct reward appearances still complete the supported Akf route', async () => {
    const result = await replay({ settings: { ifZBY: false, ifAkf: true, AKFTeamName: '厨房', akfChargingMethod: '法器角色充能' }, akfRewardMode: 'pulses' });
    assert.equal(result.reports[0][0], 'Completed');
    assert.match(result.data.get('record/test-account_cd.txt'), /爱可菲::/);
});
