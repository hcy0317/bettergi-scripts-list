$ErrorActionPreference = 'Stop'

$archiver = Join-Path $PSScriptRoot 'Archive-ObsoleteInstalledScripts.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bettergi-script-archive-{0}" -f [Guid]::NewGuid().ToString('N'))

try {
    $officialRoot = Join-Path $fixtureRoot 'official'
    $installRoot = Join-Path $fixtureRoot 'install'
    $scriptRoot = Join-Path $installRoot 'User\JsScript'
    $groupRoot = Join-Path $installRoot 'User\ScriptGroup'
    $backupRoot = Join-Path $fixtureRoot 'backup'
    $officialPackage = Join-Path $officialRoot 'Canonical'
    $installedCanonical = Join-Path $scriptRoot 'Canonical'
    $installedDuplicate = Join-Path $scriptRoot 'BrokenName'

    New-Item -ItemType Directory -Path $officialPackage,$installedCanonical,$installedDuplicate,$groupRoot -Force | Out-Null
    $manifest = '{"name":"Same package","version":"1.0.0","main":"main.js"}'
    Set-Content -LiteralPath (Join-Path $officialPackage 'manifest.json') -Encoding UTF8 -Value $manifest
    Set-Content -LiteralPath (Join-Path $installedCanonical 'manifest.json') -Encoding UTF8 -Value $manifest
    Set-Content -LiteralPath (Join-Path $installedDuplicate 'manifest.json') -Encoding UTF8 -Value $manifest
    Set-Content -LiteralPath (Join-Path $installedDuplicate 'legacy.js') -Encoding UTF8 -Value 'const legacy = true;'
    Set-Content -LiteralPath (Join-Path $groupRoot 'group.json') -Encoding UTF8 -Value '{"projects":[{"folderName":"Canonical"}]}'

    & $archiver `
        -OfficialSourceRoot $officialRoot `
        -BetterGIRoot $installRoot `
        -BackupRoot $backupRoot `
        -TransactionId 'fixture' `
        -Apply `
        -AllowRunningBetterGI | Out-Null

    if (Test-Path -LiteralPath $installedDuplicate) {
        throw 'The unreferenced duplicate package was not archived.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $backupRoot 'fixture\obsolete-scripts\BrokenName\legacy.js') -PathType Leaf)) {
        throw 'The duplicate package was not recoverably archived.'
    }
    if (-not (Test-Path -LiteralPath $installedCanonical -PathType Container)) {
        throw 'The canonical package was changed.'
    }

    Write-Output 'BetterGI obsolete script archive contracts passed'
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
