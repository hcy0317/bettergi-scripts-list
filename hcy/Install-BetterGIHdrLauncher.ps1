[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BetterGIRoot,

    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Join-Path $PSScriptRoot 'launcher'
$destinationRoot = [System.IO.Path]::GetFullPath($BetterGIRoot)
$launcherFiles = @(
    'Start-BetterGI-HDR.ps1',
    'Start-BetterGI-HDR.cmd'
)

if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
    throw "BetterGI root not found: $destinationRoot"
}

$operations = foreach ($file in $launcherFiles) {
    $sourcePath = Join-Path $sourceRoot $file
    $destinationPath = Join-Path $destinationRoot $file
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "HDR launcher source not found: $sourcePath"
    }

    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash
    $destinationHash = if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationPath).Hash
    }
    else {
        $null
    }

    [pscustomobject]@{
        file = $file
        source = $sourcePath
        destination = $destinationPath
        current = $sourceHash -eq $destinationHash
        sourceHash = $sourceHash
        destinationHash = $destinationHash
    }
}

if ($Apply) {
    foreach ($operation in $operations) {
        Copy-Item -LiteralPath $operation.source -Destination $operation.destination -Force
    }
}

[pscustomobject]@{
    mode = if ($Apply) { 'apply' } else { 'check' }
    changed = [bool]($Apply -and @($operations | Where-Object { -not $_.current }).Count -gt 0)
    files = @($operations)
} | ConvertTo-Json -Depth 5
