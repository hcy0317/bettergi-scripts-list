# AutoPlan 桥接唯一来源

主源为 `repo/js/AutoPlan/utils/cultivation_plan.js`。Tools 中同名资源是固定导出产物，不在两个仓库各自修改逻辑。

在 Scripts 仓库执行：

```powershell
node hcy/export-autoplan-bridge.mjs --tools-root <Tools源码根>
node hcy/export-autoplan-bridge.mjs --tools-root <Tools源码根> --check
node --experimental-vm-modules --test hcy/test-autoplan-bridge-export.mjs hcy/test-cultivation-runtime.mjs
```

第一次迁移已有未标记副本，需要核对其 UTF-8/LF 正规化内容的 SHA256，再显式提供 `--adopt-current <sha256>`；无匹配摘要不会覆盖。之后副本若偏离已声明摘要，会拒绝更新，必须先审查该差异。导出不联网，不操作 BetterGI 安装目录。

Tools 将 `cultivation/autoplan` 资源原样打包，并在安装桥接前校验 `bridge-source.json`。已有安装标记属于另一个主源版本时，生成配置会拒绝覆盖或降级代码；正式部署必须成对更新 `utils/cultivation_plan.js` 和 `utils/bridge-source.json`。用户配置、库存和CD记录不属于桥接产物。

LF 是产物合同的一部分。两个仓库的局部 `.gitattributes` 保证相关文件不被 checkout 转换成 CRLF；Maven 不得对该资源目录作变量插值。
