import { PATHS } from "../config/index.js";
import { normalizeUid, writeUserConfig } from "../loaders/user-config.js";
import { buildAccountConfigFromLegacy, shouldMigrateLegacyConfig } from "./legacy-unified-config.js";

const LEGACY_CONFIG_PATH = "Data/user-config.json";

export function migrateLegacyUnifiedConfig(uid) {
    const normalizedUid = normalizeUid(uid);
    if (!normalizedUid) return false;

    const accountPath = `${PATHS.ACCOUNT_CONFIG_DIR}/${normalizedUid}.json`;
    if (!shouldMigrateLegacyConfig({
        accountExists: file.isFile(accountPath),
        legacyExists: file.isFile(LEGACY_CONFIG_PATH),
    })) {
        return false;
    }

    const raw = file.readTextSync(LEGACY_CONFIG_PATH);
    if (!raw) throw new Error(`旧统一用户配置为空，请修复 ${LEGACY_CONFIG_PATH}`);

    let legacyConfig;
    try {
        legacyConfig = JSON.parse(raw);
    } catch (error) {
        throw new Error(`旧统一用户配置解析失败，请修复 ${LEGACY_CONFIG_PATH}: ${error.message}`);
    }

    writeUserConfig(buildAccountConfigFromLegacy(normalizedUid, legacyConfig));
    log.info("已将旧统一用户配置迁移到当前 UID 账号文件: {uid}", normalizedUid);
    return true;
}
