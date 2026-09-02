[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptGroupRoot,

    [Parameter(Mandatory)]
    [string]$MappingPath,

    [Parameter(Mandatory)]
    [string]$BackupRoot,

    [string]$TransactionId = (Get-Date -Format 'yyyyMMdd-HHmmss'),

    [switch]$Apply,

    [switch]$AllowRunningBetterGI
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$groupRootPath = [System.IO.Path]::GetFullPath($ScriptGroupRoot)
$mappingFilePath = [System.IO.Path]::GetFullPath($MappingPath)
if (-not (Test-Path -LiteralPath $groupRootPath -PathType Container)) {
    throw "Script-group root not found: $groupRootPath"
}
if (-not (Test-Path -LiteralPath $mappingFilePath -PathType Leaf)) {
    throw "HCY package mapping not found: $mappingFilePath"
}

$mappingDocument = Get-Content -LiteralPath $mappingFilePath -Raw | ConvertFrom-Json
$folderMapping = @{}
foreach ($entry in $mappingDocument.packages) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.preserveFromFolder) -or
        [string]::IsNullOrWhiteSpace([string]$entry.targetFolder)) {
        continue
    }
    $folderMapping[[string]$entry.preserveFromFolder] = [string]$entry.targetFolder
}

function Update-FolderReferences {
    param([object]$Node)

    if ($null -eq $Node -or $Node -is [string]) {
        return
    }

    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [PSCustomObject]) {
        foreach ($item in $Node) {
            Update-FolderReferences -Node $item
        }
        return
    }

    foreach ($property in @($Node.PSObject.Properties)) {
        if ($property.Name -eq 'folderName' -and $property.Value -is [string] -and $folderMapping.ContainsKey($property.Value)) {
            $property.Value = $folderMapping[$property.Value]
            $script:replacementCount++
            continue
        }
        Update-FolderReferences -Node $property.Value
    }
}

$changes = @()
foreach ($file in Get-ChildItem -LiteralPath $groupRootPath -File -Filter *.json | Sort-Object Name) {
    $document = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    $script:replacementCount = 0
    Update-FolderReferences -Node $document
    if ($script:replacementCount -eq 0) {
        continue
    }

    $changes += [PSCustomObject]@{
        path = $file.FullName
        replacementCount = $script:replacementCount
        document = $document
    }
}

if (-not $Apply) {
    $changes | Select-Object path, replacementCount
    return
}

if (-not $AllowRunningBetterGI -and @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'BetterGI.exe is running. Close it before changing script-group references.'
}

$backupDirectory = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $BackupRoot $TransactionId))) 'script-groups'
foreach ($change in $changes) {
    $relativePath = [System.IO.Path]::GetRelativePath($groupRootPath, $change.path)
    $backupPath = Join-Path $backupDirectory $relativePath
    if (Test-Path -LiteralPath $backupPath) {
        throw "Script-group backup already exists: $backupPath"
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
    Copy-Item -LiteralPath $change.path -Destination $backupPath
    $json = $change.document | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($change.path, $json + [Environment]::NewLine, $utf8NoBom)
}

$changes | Select-Object path, replacementCount
