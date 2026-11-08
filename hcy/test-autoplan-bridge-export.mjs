import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {test} from 'node:test';
import {exportAutoPlanBridge} from './export-autoplan-bridge.mjs';

test('the canonical bridge is exported byte-for-byte and verified without a second source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-bridge-export-'));
    try {
        await mkdir(path.join(root, 'bgi-tools'), {recursive: true});
        await writeFile(path.join(root, 'bgi-tools', 'pom.xml'), '<project><artifactId>bgi-tools</artifactId></project>');
        const exported = await exportAutoPlanBridge({toolsRoot: root});
        const source = (await readFile(new URL('../repo/js/AutoPlan/utils/cultivation_plan.js', import.meta.url), 'utf8'))
            .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const target = path.join(root, 'bgi-tools/src/main/resources/cultivation/autoplan/cultivation_plan.js');
        assert.equal(await readFile(target, 'utf8'), source);
        const distributedManifest = await readFile(new URL('../repo/js/AutoPlan/utils/bridge-source.json', import.meta.url), 'utf8');
        assert.equal(distributedManifest, await readFile(path.join(path.dirname(target), 'bridge-source.json'), 'utf8'));
        assert.equal(JSON.parse(distributedManifest).sha256, exported.sha256);
        assert.match(source, /\$\{name\}/);
        assert.equal((await exportAutoPlanBridge({toolsRoot: root, check: true})).sha256, exported.sha256);
        assert.equal((await exportAutoPlanBridge({toolsRoot: root})).changed, false);
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^bgi-bridge-export-/);
        await rm(root, {recursive: true, force: true});
    }
});

test('check mode cannot mutate the distributed source manifest', async () => {
    await assert.rejects(exportAutoPlanBridge({check: true, writeSourceManifest: true}), /cannot write/);
});

test('resource validation rejects noncanonical bytes and unrelated vendor edits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-bridge-export-'));
    try {
        await mkdir(path.join(root, 'bgi-tools'), {recursive: true});
        await writeFile(path.join(root, 'bgi-tools', 'pom.xml'), '<artifactId>bgi-tools</artifactId>');
        const {target} = await exportAutoPlanBridge({toolsRoot: root});
        const original = await readFile(target, 'utf8');
        await writeFile(target, original.replace(/\n/g, '\r\n'));
        await assert.rejects(exportAutoPlanBridge({toolsRoot: root, check: true}), /canonical export/);
        await exportAutoPlanBridge({toolsRoot: root});
        await writeFile(target, original + '// unrelated edit\n');
        await assert.rejects(exportAutoPlanBridge({toolsRoot: root}), /drifted/);
        assert.equal(await readFile(target, 'utf8'), original + '// unrelated edit\n');
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^bgi-bridge-export-/);
        await rm(root, {recursive: true, force: true});
    }
});

test('first bridge install can link the canonical plan beside a supported untouched old config', async () => {
    const clientRoot = await mkdtemp(path.join(os.tmpdir(), 'bgi-bridge-export-'));
    try {
        // Supported Java first-install closure: main exists, no manifest yet; only plan + bridge manifest are added.
        // The client-owned config is not replaced. This case tests its JS consumer, not Java file installation.
        const mainPath = path.join(clientRoot, 'main.js');
        const oldMain = '// existing client-owned entry, preserved by first bridge installation\n';
        await writeFile(mainPath, oldMain);
        assert.equal(await readFile(mainPath, 'utf8'), oldMain);
        await assert.rejects(readFile(path.join(clientRoot, 'manifest.json')), {code: 'ENOENT'});
        assert.equal(typeof vm.SourceTextModule, 'function', 'use the existing --experimental-vm-modules runner');
        const dummyUid = '123456789';
        const config = {user: {uid: dummyUid}, run: {},
            bgi_tools: {api: {httpPullJsonConfig: 'http://local/auto/plan/json'}, token: {}}};
        const requests = [], outcomes = [];
        const context = vm.createContext({
            console, Date,
            taskResult: {requireExplicitOutcome() {}, check() {}, report(kind, reason) { outcomes.push({kind, reason}); }},
            log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}])),
            http: {async request(method, url, body) {
                requests.push({method, url, body});
                const status = url.includes('inventory-reconcile-targets') ? 'NO_TARGETS'
                    : url.includes('next-action') ? 'NO_PLAN' : null;
                assert(status, 'only the existing target/claim endpoints are expected');
                return {status_code: 200, body: JSON.stringify({code: 200, data: {status}})};
            }},
        });
        const oldExports = {config, LoadType: {}, LoadMap: new Map(),
            getMultiCheckboxMap: async () => new Map(), getValueByMultiCheckboxName: async () => [],
            checkKey: async () => {}, buildInitConfigSettings: async () => {},
            initSettings: async () => {}, initConfig: async () => {}};
        const legacyConfig = new vm.SyntheticModule(Object.keys(oldExports), function () {
            for (const [name, value] of Object.entries(oldExports)) this.setExport(name, value);
        }, {context});
        const taskHandlerMap = new Map();
        class Physical {
            static async countAllResin() { throw new Error('NO_PLAN must not request map-resin input'); }
        }
        const handlers = new vm.SyntheticModule(['taskHandlerMap'], function () {
            this.setExport('taskHandlerMap', taskHandlerMap);
        }, {context});
        const physical = new vm.SyntheticModule(['Physical'], function () {
            this.setExport('Physical', Physical);
        }, {context});
        for (const dependency of [legacyConfig, handlers, physical]) {
            await dependency.link(() => { throw new Error('fixture dependency unexpectedly imports another module'); });
            await dependency.evaluate();
        }
        assert.deepEqual(Object.keys(legacyConfig.namespace).sort(), Object.keys(oldExports).sort());
        assert.equal(Object.hasOwn(legacyConfig.namespace, 'requireCanonicalUid'), false,
            'the supported old config has its real old exports, not the newly added helper');
        assert.equal(handlers.namespace.taskHandlerMap, taskHandlerMap);
        assert.equal(physical.namespace.Physical, Physical);
        const source = await readFile(new URL('../repo/js/AutoPlan/utils/cultivation_plan.js', import.meta.url), 'utf8');
        const plan = new vm.SourceTextModule(source, {context,
            identifier: path.join(clientRoot, 'utils/cultivation_plan.js')});
        const imports = {'./load_check_run': handlers, './physical': physical, '../config/config': legacyConfig};
        // The old-config missing export below is the supported consumer regression, not an incomplete random mock.
        await plan.link(specifier => {
            assert(Object.hasOwn(imports, specifier), 'all canonical plan imports must be resolved: ' + specifier);
            return imports[specifier];
        });
        await plan.evaluate();
        for (const name of ['runCultivationInventoryReconcile', 'runPlanDrivenCultivation']) {
            config.user.uid = dummyUid;
            const before = requests.length;
            await plan.namespace[name](config);
            const sent = requests.slice(before);
            assert(sent.some(request => request.url.includes('inventory-reconcile-targets')));
            for (const request of sent) assert.equal(new URL(request.url).searchParams.get('uid'), dummyUid);
            config.user.uid = 0;
            const afterValid = requests.length;
            await assert.rejects(plan.namespace[name](config), /UID|账号|未确认/i);
            assert.equal(requests.length, afterValid, 'native unknown must not be accepted by the old-client bridge');
            assert.equal(outcomes.at(-1).kind, 'Failed');
        }
        assert.equal(await readFile(mainPath, 'utf8'), oldMain);
    } finally {
        assert.equal(path.dirname(clientRoot), path.resolve(os.tmpdir()));
        assert.match(path.basename(clientRoot), /^bgi-bridge-export-/);
        await rm(clientRoot, {recursive: true, force: true});
    }
});
