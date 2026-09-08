$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'Test-HcyInstallation.ps1'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempBase ("bgi-active-script-" + [Guid]::NewGuid().ToString('N'))
try {
    $fork = Join-Path $fixtureRoot 'fork'
    $installation = Join-Path $fixtureRoot 'installed'
    $source = Join-Path $fork 'repo\js\AutoCommissionNova'
    $alias = Join-Path $installation 'User\JsScript\HCY-AutoCommission'
    $active = Join-Path $installation 'User\JsScript\AutoCommissionNova'
    $groups = Join-Path $installation 'User\ScriptGroup'
    New-Item -ItemType Directory -Path (Join-Path $fork 'hcy'),$source,$alias,$active,$groups -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fork 'hcy\packages.json') -Encoding utf8 -Value '{"packages":[{"sourceFolder":"AutoCommissionNova","targetFolder":"HCY-AutoCommission","revision":3,"preserveFiles":[],"requiredMarkers":[{"file":"executor.js","text":"throw error;"}]}]}'
    Set-Content -LiteralPath (Join-Path $source 'manifest.json') -Encoding utf8 -Value '{"version":"1.0.2"}'
    Set-Content -LiteralPath (Join-Path $alias 'manifest.json') -Encoding utf8 -Value '{"version":"1.0.2-hcy.3","saved_files":[]}'
    Set-Content -LiteralPath (Join-Path $alias 'executor.js') -Encoding utf8 -Value 'throw error;'
    Set-Content -LiteralPath (Join-Path $active 'executor.js') -Encoding utf8 -Value 'return false;'
    $group = Join-Path $groups 'daily.json'
    Set-Content -LiteralPath $group -Encoding utf8 -Value '{"projects":[{"type":"Javascript","status":"Enabled","folderName":"AutoCommissionNova"}]}'
    $before = (Get-FileHash -LiteralPath $group).Hash
    $rejected = $false
    try { & $validator -BetterGIRoot $installation -ForkRoot $fork | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch 'AutoCommissionNova') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'The active official entry was stale, but validation checked only the unused HCY alias.' }
    Set-Content -LiteralPath (Join-Path $active 'executor.js') -Encoding utf8 -Value 'throw error;'
    & $validator -BetterGIRoot $installation -ForkRoot $fork | Out-Null
    if ((Get-FileHash -LiteralPath $group).Hash -ne $before) { throw 'Validation changed the user task configuration.' }
    'Active script entry validation passed'
}
finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if (-not $resolved.StartsWith($tempBase.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'bgi-active-script-*') { throw 'Unsafe fixture cleanup target.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
