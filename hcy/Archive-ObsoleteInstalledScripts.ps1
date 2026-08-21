[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$OfficialSourceRoot,

    [Parameter(Mandatory)]
    [string]$BetterGIRoot,

    [Parameter(Mandatory)]
    [string]$BackupRoot,

    [string]$TransactionId = (Get-Date -Format 'yyyyMMdd-HHmmss'),

    [switch]$Apply,

    [switch]$AllowRunningBetterGI
)

$ErrorActionPreference = 'Stop'

function Add-FolderReferences {
    param(
        [object]$Node,
        [System.Collections.Generic.HashSet[string]]$References
    )

    if ($null -eq $Node -or $Node -is [string]) {
        return
    }
    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [PSCustomObject]) {
        foreach ($item in $Node) {
            Add-FolderReferences -Node $item -References $References
        }
        return
    }

    foreach ($property in @($Node.PSObject.Properties)) {
        if ($property.Name -eq 'folderName' -and $property.Value -is [string]) {
            [void]$References.Add($property.Value)
        }
        else {
            Add-FolderReferences -Node $property.Value -References $References
        }
    }
}

$officialRoot = [System.IO.Path]::GetFullPath($OfficialSourceRoot)
$betterGIRootPath = [System.IO.Path]::GetFullPath($BetterGIRoot)
$installedRoot = [System.IO.Path]::GetFullPath((Join-Path $betterGIRootPath 'User\JsScript'))
$groupRoot = Join-Path $betterGIRootPath 'User\ScriptGroup'
$installedPrefix = $installedRoot.TrimEnd('\') + '\'
if (-not (Test-Path -LiteralPath $officialRoot -PathType Container)) {
    throw "Official script source root not found: $officialRoot"
}
if (-not (Test-Path -LiteralPath $installedRoot -PathType Container)) {
    throw "BetterGI script installation root not found: $installedRoot"
}

$folderReferences = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
if (Test-Path -LiteralPath $groupRoot -PathType Container) {
    foreach ($groupFile in Get-ChildItem -LiteralPath $groupRoot -File -Filter *.json) {
        $group = Get-Content -LiteralPath $groupFile.FullName -Raw | ConvertFrom-Json
        Add-FolderReferences -Node $group -References $folderReferences
    }
}

$officialByName = @{}
foreach ($directory in Get-ChildItem -LiteralPath $officialRoot -Directory) {
    $manifestPath = Join-Path $directory.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        continue
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifestName = [string]$manifest.name
    if ([string]::IsNullOrWhiteSpace($manifestName)) {
        continue
    }
    if (-not $officialByName.ContainsKey($manifestName)) {
        $officialByName[$manifestName] = @()
    }
    $officialByName[$manifestName] += $directory.Name
}

$candidates = @()
foreach ($directory in Get-ChildItem -LiteralPath $installedRoot -Directory) {
    if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        continue
    }
    $manifestPath = Join-Path $directory.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        continue
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifestName = [string]$manifest.name
    if (-not $officialByName.ContainsKey($manifestName) -or $officialByName[$manifestName].Count -ne 1) {
        continue
    }

    $canonicalFolder = [string]$officialByName[$manifestName][0]
    if ($directory.Name -eq $canonicalFolder -or $folderReferences.Contains($directory.Name)) {
        continue
    }

    $candidates += [PSCustomObject]@{
        folder = $directory.Name
        manifestName = $manifestName
        canonicalFolder = $canonicalFolder
        source = $directory.FullName
    }
}

if (-not $Apply) {
    $candidates | Sort-Object folder
    return
}

if (-not $AllowRunningBetterGI -and @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'BetterGI.exe is running. Close it before archiving obsolete scripts.'
}

$archiveRoot = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $BackupRoot $TransactionId))) 'obsolete-scripts'
foreach ($candidate in $candidates) {
    $sourcePath = [System.IO.Path]::GetFullPath($candidate.source)
    if (-not $sourcePath.StartsWith($installedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Obsolete script candidate is outside the installation root: $sourcePath"
    }

    $canonicalPath = Join-Path $installedRoot $candidate.canonicalFolder
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Container)) {
        throw "Canonical installed package is missing for $($candidate.folder): $canonicalPath"
    }

    $archivePath = Join-Path $archiveRoot $candidate.folder
    if (Test-Path -LiteralPath $archivePath) {
        throw "Obsolete script archive target already exists: $archivePath"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $archivePath) -Force | Out-Null
    Move-Item -LiteralPath $sourcePath -Destination $archivePath
}

$candidates | Sort-Object folder
