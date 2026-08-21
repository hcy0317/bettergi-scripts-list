# HCY BetterGI 脚本维护线

本分支以官方 `release` 为基线，只在 `hcy/main` 保留 HCY 独有兼容行为。官方包与 HCY 包使用不同安装目录，禁止再对 `User/JsScript` 中的官方包做字符串替换或启动前补丁。

## 仓库边界

- `upstream`：官方仓库，只拉取。
- `hcy`：`hcy0317` 账号下的 fork，只向这里提交和推送。
- `repo/js/*`：可通过常规 Git 三方合并审查的 HCY 源码差异。
- `hcy/packages.json`：官方包到独立 `HCY-*` 包的映射、运行状态迁移规则和完整性标记。
- `hcy/combat-strategies.json`：HCY 独有战斗策略及其 SHA-256 合同。

## 更新上游

```powershell
git fetch upstream release
git switch hcy/main
git merge upstream/release
node .\hcy\test-packages.mjs
node .\hcy\test-auto-commission-legacy-config.mjs
node .\hcy\test-combat-strategies.mjs
& .\hcy\test-installation-updater.ps1
& .\hcy\test-script-group-references.ps1
& .\hcy\test-obsolete-script-archive.ps1
```

合并冲突必须在本仓库解决。不得通过更新后再次运行旧 `Apply-*LocalPatch.ps1` 来隐藏冲突。

## 更新本机安装

先关闭 BetterGI。以下三个操作共享同一个事务标识，旧包、旧脚本组和乱码副本都会进入备份目录，不会直接删除。

```powershell
$transaction = Get-Date -Format 'yyyyMMdd-HHmmss'
$betterGIRoot = 'C:\Users\hcy\Programs\Genshin Tools\BetterGI'
$forkRoot = (Get-Location).Path
$officialRoot = Join-Path $betterGIRoot '.codex-tmp\scripts-6d6a11c\repo\js'
$backupRoot = Join-Path $betterGIRoot '.codex-backups\script-updates'

& .\hcy\Update-BetterGIInstallation.ps1 `
    -OfficialSourceRoot $officialRoot `
    -ForkRoot $forkRoot `
    -BetterGIRoot $betterGIRoot `
    -BackupRoot $backupRoot `
    -TransactionId $transaction `
    -Apply

& .\hcy\Update-ScriptGroupReferences.ps1 `
    -ScriptGroupRoot (Join-Path $betterGIRoot 'User\ScriptGroup') `
    -MappingPath .\hcy\packages.json `
    -BackupRoot $backupRoot `
    -TransactionId $transaction `
    -Apply

& .\hcy\Archive-ObsoleteInstalledScripts.ps1 `
    -OfficialSourceRoot $officialRoot `
    -BetterGIRoot $betterGIRoot `
    -BackupRoot $backupRoot `
    -TransactionId $transaction `
    -Apply

& .\hcy\Test-HcyInstallation.ps1 -BetterGIRoot $betterGIRoot
```

`Update-BetterGIInstallation.ps1` 以官方快照重建规范包，只从旧目录复制清单声明的 `saved_files`；HCY 包从旧包迁移显式列出的状态文件。未声明的陈旧源码不会混入新包。
