[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot 'repo\js'
$mappingPath = Join-Path $PSScriptRoot 'packages.json'
$mapping = Get-Content -Raw -LiteralPath $mappingPath | ConvertFrom-Json

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

foreach ($entry in $mapping.packages) {
    $sourcePath = Join-Path $sourceRoot $entry.sourceFolder
    $targetPath = Join-Path $DestinationRoot $entry.targetFolder
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "HCY source package not found: $sourcePath"
    }
    if (Test-Path -LiteralPath $targetPath) {
        throw "HCY publish target already exists: $targetPath"
    }

    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse

    $manifestPath = Join-Path $targetPath 'manifest.json'
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $manifest.name = "HCY $($manifest.name)"
    $manifest.version = "$($manifest.version)-hcy.$($entry.revision)"
    $manifest.description = "HCY 兼容维护版。上游包：$($entry.sourceFolder)。$($manifest.description)"
    $manifestJson = $manifest | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText(
        $manifestPath,
        $manifestJson + [Environment]::NewLine,
        $utf8NoBom)

    Write-Output $targetPath
}
