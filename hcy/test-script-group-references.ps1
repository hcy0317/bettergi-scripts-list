$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$updater = Join-Path $PSScriptRoot 'Update-ScriptGroupReferences.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bettergi-script-groups-{0}" -f [Guid]::NewGuid().ToString('N'))

try {
    $groupRoot = Join-Path $fixtureRoot 'groups'
    $backupRoot = Join-Path $fixtureRoot 'backup'
    New-Item -ItemType Directory -Path $groupRoot -Force | Out-Null
    $groupPath = Join-Path $groupRoot 'daily.json'
    Set-Content -LiteralPath $groupPath -Encoding UTF8 -Value @'
{
  "projects": [
    { "folderName": "AutoCommission", "name": "commission" },
    { "folderName": "FullyAutoAndSemiAutoTools", "name": "routes" },
    { "folderName": "Unrelated", "name": "keep" }
  ]
}
'@

    & $updater `
        -ScriptGroupRoot $groupRoot `
        -MappingPath (Join-Path $PSScriptRoot 'packages.json') `
        -BackupRoot $backupRoot `
        -TransactionId 'fixture' `
        -Apply `
        -AllowRunningBetterGI | Out-Null

    $updated = Get-Content -LiteralPath $groupPath -Raw | ConvertFrom-Json
    $folderNames = @($updated.projects.folderName)
    if ($folderNames[0] -ne 'HCY-AutoCommission') {
        throw 'AutoCommission group reference was not migrated.'
    }
    if ($folderNames[1] -ne 'HCY-FullyAutoAndSemiAutoTools') {
        throw 'FullyAuto group reference was not migrated.'
    }
    if ($folderNames[2] -ne 'Unrelated') {
        throw 'An unrelated script-group reference was changed.'
    }

    $backupPath = Join-Path $backupRoot 'fixture\script-groups\daily.json'
    if ((Get-Content -LiteralPath $backupPath -Raw) -notmatch '"AutoCommission"') {
        throw 'The original script-group file was not backed up.'
    }

    Write-Output 'BetterGI script-group reference migration contracts passed'
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
