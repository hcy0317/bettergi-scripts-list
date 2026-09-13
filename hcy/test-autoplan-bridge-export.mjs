import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
        assert.match(source, /\$\{name\}/);
        assert.equal((await exportAutoPlanBridge({toolsRoot: root, check: true})).sha256, exported.sha256);
        assert.equal((await exportAutoPlanBridge({toolsRoot: root})).changed, false);
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^bgi-bridge-export-/);
        await rm(root, {recursive: true, force: true});
    }
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
