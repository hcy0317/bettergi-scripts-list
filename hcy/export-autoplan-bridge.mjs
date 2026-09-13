import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const sourcePath = 'repo/js/AutoPlan/utils/cultivation_plan.js';
const sourceFile = fileURLToPath(new URL('../' + sourcePath, import.meta.url));
const resourceDirectory = 'bgi-tools/src/main/resources/cultivation/autoplan';
const repository = 'https://github.com/hcy0317/bettergi-scripts-list';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

async function optionalRead(file) {
    try { return await readFile(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function requirePlainPath(root, relative) {
    let cursor = root;
    for (const part of ['', ...relative.split('/')]) {
        cursor = part ? path.join(cursor, part) : cursor;
        try {
            if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symbolic link/reparse target rejected: ${cursor}`);
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return path.join(root, ...relative.split('/'));
}

/** 显式源码导出，不联网；已有vendor必须与其清单或显式adoption摘要匹配。 */
export async function exportAutoPlanBridge({toolsRoot, check = false, adoptCurrent} = {}) {
    if (!toolsRoot) throw new Error('An explicit --tools-root is required');
    const requested = path.resolve(toolsRoot);
    if ((await lstat(requested)).isSymbolicLink()) throw new Error('Tools root cannot be a link');
    const root = await realpath(requested);
    const pom = await requirePlainPath(root, 'bgi-tools/pom.xml');
    if (!/<artifactId>\s*bgi-tools\s*<\/artifactId>/.test(await readFile(pom, 'utf8')))
        throw new Error('The selected directory is not the bgi-tools source repository');
    const sourceStat = await lstat(sourceFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 1024 * 1024)
        throw new Error('Canonical bridge must be a bounded regular source file');
    const content = canonical(await readFile(sourceFile));
    const sha256 = digest(content);
    const target = await requirePlainPath(root, resourceDirectory + '/cultivation_plan.js');
    const manifestPath = await requirePlainPath(root, resourceDirectory + '/bridge-source.json');
    const before = await optionalRead(target);
    const beforeManifest = await optionalRead(manifestPath);
    if (beforeManifest) {
        const manifest = JSON.parse(beforeManifest.toString('utf8'));
        if (manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.sourcePath !== sourcePath
            || manifest.normalization !== 'utf8-lf' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
            || !before || digest(canonical(before)) !== manifest.sha256)
            throw new Error('Vendor content drifted from its declared source; refusing to overwrite');
    } else if (before && digest(canonical(before)) !== adoptCurrent) {
        throw new Error('Existing unpinned vendor requires --adopt-current with its exact canonical SHA256');
    }
    const manifest = JSON.stringify({schemaVersion: 1, repository, sourcePath, normalization: 'utf8-lf', sha256}, null, 2) + '\n';
    const changed = !before || !before.equals(Buffer.from(content, 'utf8'))
        || !beforeManifest || !beforeManifest.equals(Buffer.from(manifest, 'utf8'));
    if (check && changed) throw new Error('AutoPlan vendor is not the canonical export; regenerate it explicitly');
    if (!check && changed) {
        await mkdir(path.dirname(target), {recursive: true});
        // 清单最后发布；中断时消费者校验失败，不会把半套资源当作有效桥接。
        for (const [file, value] of [[target, content], [manifestPath, manifest]]) {
            const temporary = file + `.export-${process.pid}.tmp`;
            await writeFile(temporary, value, {encoding: 'utf8', flag: 'wx'});
            await rename(temporary, file);
        }
    }
    return {sha256, changed, target};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--check') options.check = true;
        else if (args[i] === '--tools-root' && args[i + 1]) options.toolsRoot = args[++i];
        else if (args[i] === '--adopt-current' && args[i + 1]) options.adoptCurrent = args[++i];
        else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    }
    console.log(JSON.stringify(await exportAutoPlanBridge(options)));
}
