$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$updater = Join-Path $PSScriptRoot 'Update-BetterGIInstallation.ps1'
$validator = Join-Path $PSScriptRoot 'Test-HcyInstallation.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bettergi-script-update-{0}" -f [Guid]::NewGuid().ToString('N'))

try {
    $officialRoot = Join-Path $fixtureRoot 'official'
    $installRoot = Join-Path $fixtureRoot 'install'
    $backupRoot = Join-Path $fixtureRoot 'backup'
    $officialPackage = Join-Path $officialRoot 'Alpha'
    $installedPackage = Join-Path $installRoot 'User\JsScript\Alpha'
    $officialAutoCode = Join-Path $officialRoot 'AutoCode'
    $installedAutoCode = Join-Path $installRoot 'User\JsScript\AutoCode'
    $officialUnsubscribed = Join-Path $officialRoot 'Unsubscribed'
    $subscriptionRoot = Join-Path $installRoot 'User\Subscriptions'

    New-Item -ItemType Directory -Path (Join-Path $officialPackage 'state') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $installedPackage 'state') -Force | Out-Null
    New-Item -ItemType Directory -Path $officialAutoCode,$installedAutoCode,$officialUnsubscribed,$subscriptionRoot -Force | Out-Null

    Set-Content -LiteralPath (Join-Path $officialPackage 'manifest.json') -Encoding UTF8 -Value @'
{
  "name": "Alpha",
  "version": "2.0.0",
  "main": "main.js",
  "saved_files": ["state/*.json"]
}
'@
    Set-Content -LiteralPath (Join-Path $officialPackage 'main.js') -Encoding UTF8 -Value 'const version = 2;'
    Set-Content -LiteralPath (Join-Path $officialPackage 'state\default.json') -Encoding UTF8 -Value '{"value":"official"}'

    Set-Content -LiteralPath (Join-Path $installedPackage 'manifest.json') -Encoding UTF8 -Value @'
{
  "name": "Alpha",
  "version": "1.0.0",
  "main": "main.js",
  "saved_files": ["state/*.json"]
}
'@
    Set-Content -LiteralPath (Join-Path $installedPackage 'main.js') -Encoding UTF8 -Value 'const version = 1;'
    Set-Content -LiteralPath (Join-Path $installedPackage 'state\default.json') -Encoding UTF8 -Value '{"value":"user"}'
    Set-Content -LiteralPath (Join-Path $installedPackage 'stale.js') -Encoding UTF8 -Value 'throw new Error("stale");'
    Set-Content -LiteralPath (Join-Path $officialAutoCode 'manifest.json') -Encoding UTF8 -Value '{"name":"AutoCode","version":"2.0.0","main":"main.js","saved_files":[]}'
    Set-Content -LiteralPath (Join-Path $officialAutoCode 'main.js') -Encoding UTF8 -Value 'const version = 2;'
    Set-Content -LiteralPath (Join-Path $officialAutoCode 'settings.json') -Encoding UTF8 -Value '[{"name":"username"}]'
    Set-Content -LiteralPath (Join-Path $installedAutoCode 'manifest.json') -Encoding UTF8 -Value '{"name":"AutoCode","version":"1.0.0","main":"main.js","saved_files":[]}'
    Set-Content -LiteralPath (Join-Path $installedAutoCode 'main.js') -Encoding UTF8 -Value 'const version = 1;'
    Set-Content -LiteralPath (Join-Path $installedAutoCode 'settings.json') -Encoding UTF8 -Value '[{"name":"username","default":"fixture-user"}]'
    Set-Content -LiteralPath (Join-Path $officialUnsubscribed 'manifest.json') -Encoding UTF8 -Value '{"name":"Unsubscribed","version":"1.0.0","main":"main.js","saved_files":[]}'
    Set-Content -LiteralPath (Join-Path $officialUnsubscribed 'main.js') -Encoding UTF8 -Value 'throw new Error("must not install");'
    Set-Content -LiteralPath (Join-Path $subscriptionRoot 'bettergi-scripts-list.json') -Encoding UTF8 -Value @'
[
  "js/Alpha",
  "js/AutoCode",
  "pathing/敌人与魔物"
]
'@

    & $updater `
        -OfficialSourceRoot $officialRoot `
        -PolicyPath (Join-Path $PSScriptRoot 'packages.json') `
        -BetterGIRoot $installRoot `
        -BackupRoot $backupRoot `
        -TransactionId 'fixture' `
        -Apply `
        -AllowRunningBetterGI | Out-Null

    if ((Get-Content -LiteralPath (Join-Path $installedPackage 'main.js') -Raw) -notmatch 'version = 2') {
        throw 'Official package content was not updated.'
    }
    if ((Get-Content -LiteralPath (Join-Path $installedPackage 'state\default.json') -Raw) -notmatch 'user') {
        throw 'saved_files content was not preserved.'
    }
    if (Test-Path -LiteralPath (Join-Path $installedPackage 'stale.js')) {
        throw 'Undeclared stale content survived the replacement.'
    }
    $autoCodeSettingsPath = Join-Path $installedAutoCode 'settings.json'
    $autoCodeSettingsRaw = Get-Content -LiteralPath $autoCodeSettingsPath -Raw
    if (-not $autoCodeSettingsRaw.TrimStart().StartsWith('[')) {
        throw 'Official-package settings must remain a JSON array after default migration.'
    }
    $autoCodeSettings = $autoCodeSettingsRaw | ConvertFrom-Json
    if (@($autoCodeSettings | Where-Object { $_.name -eq 'username' })[0].default -ne 'fixture-user') {
        throw 'The declared official-package setting default was not preserved.'
    }
    if (Test-Path -LiteralPath (Join-Path $installRoot 'User\JsScript\Unsubscribed')) {
        throw 'An unsubscribed official package was installed.'
    }

    $backupPackage = Join-Path $backupRoot 'fixture\packages\Alpha'
    if ((Get-Content -LiteralPath (Join-Path $backupPackage 'main.js') -Raw) -notmatch 'version = 1') {
        throw 'The previous installed package was not backed up.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $backupRoot 'fixture\transaction.json') -PathType Leaf)) {
        throw 'The update transaction manifest was not written.'
    }

    $legacyFullyAuto = Join-Path $installRoot 'User\JsScript\FullyAutoAndSemiAutoTools'
    New-Item -ItemType Directory -Path $legacyFullyAuto -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $legacyFullyAuto 'config') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyFullyAuto 'config\uidSettings.json') -Encoding UTF8 -Value '{"uid":"fixture"}'
    $legacyArtifacts = Join-Path $installRoot 'User\JsScript\AAA-Artifacts-Bulk-Supply'
    New-Item -ItemType Directory -Path $legacyArtifacts -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyArtifacts 'settings.json') -Encoding UTF8 -Value @'
[
  { "name": "accountName", "default": "fixture-account" }
]
'@

    & $updater `
        -OfficialSourceRoot $officialRoot `
        -ForkRoot $repoRoot `
        -BetterGIRoot $installRoot `
        -BackupRoot $backupRoot `
        -TransactionId 'fixture-hcy' `
        -Apply `
        -AllowRunningBetterGI | Out-Null

    $hcyFullyAuto = Join-Path $installRoot 'User\JsScript\HCY-FullyAutoAndSemiAutoTools'
    if (-not (Test-Path -LiteralPath (Join-Path $hcyFullyAuto 'main.js') -PathType Leaf)) {
        throw 'The HCY compatibility package was not published independently.'
    }
    if ((Get-Content -LiteralPath (Join-Path $hcyFullyAuto 'config\uidSettings.json') -Raw) -notmatch 'fixture') {
        throw 'The declared legacy HCY package state was not preserved.'
    }
    $hcyManifest = Get-Content -LiteralPath (Join-Path $hcyFullyAuto 'manifest.json') -Raw | ConvertFrom-Json
    if (@($hcyManifest.saved_files) -notcontains 'config/uidSettings.json') {
        throw 'The generated HCY manifest does not retain its compatibility state contract.'
    }
    $hcyArtifactSettings = Get-Content -LiteralPath (Join-Path $installRoot 'User\JsScript\HCY-AAA-Artifacts-Bulk-Supply\settings.json') -Raw | ConvertFrom-Json
    $accountName = @($hcyArtifactSettings | Where-Object { $_.name -eq 'accountName' })
    if ($accountName.Count -ne 1 -or $accountName[0].default -ne 'fixture-account') {
        throw 'The declared legacy setting default was not migrated into the HCY package.'
    }
    & $validator -BetterGIRoot $installRoot -ForkRoot $repoRoot | Out-Null

    Write-Output 'BetterGI installation updater contract passed'
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
