[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot 'repo\combat'
$mappingPath = Join-Path $PSScriptRoot 'combat-strategies.json'
$mapping = Get-Content -Raw -LiteralPath $mappingPath | ConvertFrom-Json

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

foreach ($entry in $mapping.strategies) {
    $sourcePath = Join-Path $sourceRoot $entry.file
    $targetPath = Join-Path $DestinationRoot $entry.file
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "HCY combat strategy not found: $sourcePath"
    }
    if (Test-Path -LiteralPath $targetPath) {
        throw "HCY combat publish target already exists: $targetPath"
    }

    Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    Write-Output $targetPath
}
