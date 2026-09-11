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
$activeFolders = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$groupRoot = Join-Path ([IO.Path]::GetFullPath($BetterGIRoot)) 'User\ScriptGroup'
if (Test-Path -LiteralPath $groupRoot -PathType Container) {
    foreach ($groupFile in Get-ChildItem -LiteralPath $groupRoot -File -Filter '*.json') {
        $group = Get-Content -LiteralPath $groupFile.FullName -Raw | ConvertFrom-Json
        foreach ($project in @($group.projects)) {
            if ($project.type -eq 'Javascript' -and $project.status -ne 'Disabled' -and
                -not [string]::IsNullOrWhiteSpace([string]$project.folderName)) {
                $null = $activeFolders.Add([string]$project.folderName)
            }
        }
    }
}
$checkedActiveFolders = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
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

    $markerFolders = @([string]$entry.targetFolder)
    if ($activeFolders.Contains([string]$entry.sourceFolder)) {
        $markerFolders += [string]$entry.sourceFolder
        $null = $checkedActiveFolders.Add([string]$entry.sourceFolder)
    }
    foreach ($folder in $markerFolders) {
        foreach ($marker in $entry.requiredMarkers) {
            $markerPath = Join-Path (Join-Path $installRoot $folder) $marker.file
            if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
                throw "Installed script marker file not found: $markerPath"
            }
            $source = Get-Content -LiteralPath $markerPath -Raw
            if (-not $source.Contains([string]$marker.text, [StringComparison]::Ordinal)) {
                throw "Installed script marker missing in $folder/$($marker.file): $($marker.text)"
            }
        }
    }
}

[PSCustomObject]@{
    status = 'passed'
    packageCount = @($mapping.packages).Count
    activeSourcePackageCount = $checkedActiveFolders.Count
    installRoot = $installRoot
}
