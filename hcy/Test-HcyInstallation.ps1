[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BetterGIRoot,

    [string]$ForkRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$installRoot = Join-Path ([System.IO.Path]::GetFullPath($BetterGIRoot)) 'User\JsScript'
$forkRootPath = [System.IO.Path]::GetFullPath($ForkRoot)
$mappingPath = Join-Path $forkRootPath 'hcy\packages.json'
if (-not (Test-Path -LiteralPath $mappingPath -PathType Leaf)) {
    throw "HCY package mapping not found: $mappingPath"
}

$mapping = Get-Content -LiteralPath $mappingPath -Raw | ConvertFrom-Json
foreach ($entry in $mapping.packages) {
    $packageRoot = Join-Path $installRoot $entry.targetFolder
    $manifestPath = Join-Path $packageRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "HCY installed package not found: $($entry.targetFolder)"
    }

    $sourceManifestPath = Join-Path $forkRootPath "repo\js\$($entry.sourceFolder)\manifest.json"
    $sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
    $installedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $expectedVersion = "$($sourceManifest.version)-hcy.$($entry.revision)"
    if ([string]$installedManifest.version -ne $expectedVersion) {
        throw "HCY package version mismatch for $($entry.targetFolder): expected $expectedVersion, found $($installedManifest.version)"
    }

    $savedFiles = @($installedManifest.saved_files | ForEach-Object { ([string]$_).Replace('\', '/') })
    foreach ($preservedFile in @($entry.preserveFiles)) {
        if ($savedFiles -notcontains ([string]$preservedFile).Replace('\', '/')) {
            throw "HCY package $($entry.targetFolder) does not declare preserved state: $preservedFile"
        }
    }

    foreach ($marker in $entry.requiredMarkers) {
        $markerPath = Join-Path $packageRoot $marker.file
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw "HCY package marker file not found: $markerPath"
        }
        $source = Get-Content -LiteralPath $markerPath -Raw
        if (-not $source.Contains([string]$marker.text, [StringComparison]::Ordinal)) {
            throw "HCY package marker missing in $($entry.targetFolder)/$($marker.file): $($marker.text)"
        }
    }
}

[PSCustomObject]@{
    status = 'passed'
    packageCount = @($mapping.packages).Count
    installRoot = $installRoot
}
