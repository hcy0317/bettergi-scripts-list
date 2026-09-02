[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$OfficialSourceRoot,

    [string]$ForkRoot,

    [string]$PolicyPath,

    [string]$SubscriptionPath,

    [Parameter(Mandatory)]
    [string]$BetterGIRoot,

    [Parameter(Mandatory)]
    [string]$BackupRoot,

    [string]$TransactionId = (Get-Date -Format 'yyyyMMdd-HHmmss'),

    [switch]$Apply,

    [switch]$AllowRunningBetterGI
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Copy-FileSystemEntry {
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$Destination
    )

    $sourceItem = Get-Item -LiteralPath $Source -Force
    $isReparsePoint = ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isReparsePoint) {
        if ($sourceItem.LinkType -notin @('Junction', 'SymbolicLink')) {
            throw "Unsupported reparse point type '$($sourceItem.LinkType)': $Source"
        }
        $linkTarget = [string]$sourceItem.Target
        if ([string]::IsNullOrWhiteSpace($linkTarget)) {
            throw "Link target is missing: $Source"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
        $existingTarget = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        if ($null -ne $existingTarget) {
            if (($existingTarget.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
                throw "Preserved link conflicts with a non-link staging entry: $Destination"
            }
            Remove-Item -LiteralPath $Destination -Force
        }
        New-Item -ItemType $sourceItem.LinkType -Path $Destination -Target $linkTarget -Force | Out-Null
        return
    }

    if ($sourceItem.PSIsContainer) {
        Copy-DirectoryContents -Source $sourceItem.FullName -Destination $Destination
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $sourceItem.FullName -Destination $Destination -Force
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
        $target = Join-Path $Destination $child.Name
        Copy-FileSystemEntry -Source $child.FullName -Destination $target
    }
}

function Get-SavedFilePatterns {
    param([string[]]$ManifestPaths)

    $patterns = foreach ($manifestPath in $ManifestPaths) {
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            continue
        }

        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        foreach ($pattern in @($manifest.saved_files)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$pattern)) {
                ([string]$pattern).Replace('/', '\')
            }
        }
    }

    @($patterns | Sort-Object -Unique)
}

function Copy-PreservedFiles {
    param(
        [Parameter(Mandatory)]
        [string]$InstalledPackage,

        [Parameter(Mandatory)]
        [string]$StagedPackage,

        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        $normalizedPattern = $pattern.TrimStart('\')
        $literalRelativePath = $normalizedPattern.TrimEnd('\')
        $literalSource = Join-Path $InstalledPackage $literalRelativePath

        if ($normalizedPattern -notmatch '[*?[]') {
            $literalItem = $null
            try {
                $literalItem = Get-Item -LiteralPath $literalSource -Force -ErrorAction Stop
            }
            catch [System.Management.Automation.ItemNotFoundException] {
            }
            catch [System.IO.FileNotFoundException] {
            }
            catch [System.IO.DirectoryNotFoundException] {
            }
            if ($null -ne $literalItem) {
                $literalTarget = Join-Path $StagedPackage $literalRelativePath
                Copy-FileSystemEntry -Source $literalItem.FullName -Destination $literalTarget
            }
            continue
        }

        $matches = @(Get-ChildItem -Path (Join-Path $InstalledPackage $normalizedPattern) -Force -ErrorAction SilentlyContinue)
        foreach ($match in $matches) {
            $relativePath = [System.IO.Path]::GetRelativePath($InstalledPackage, $match.FullName)
            $target = Join-Path $StagedPackage $relativePath
            Copy-FileSystemEntry -Source $match.FullName -Destination $target
        }
    }
}

function Copy-SettingDefaults {
    param(
        [Parameter(Mandatory)]
        [string]$SourcePackage,

        [Parameter(Mandatory)]
        [string]$StagedPackage,

        [string[]]$SettingNames
    )

    if (@($SettingNames).Count -eq 0) {
        return
    }

    $sourcePath = Join-Path $SourcePackage 'settings.json'
    $stagedPath = Join-Path $StagedPackage 'settings.json'
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Settings-default migration source not found: $sourcePath"
    }
    if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf)) {
        throw "Settings-default migration target not found: $stagedPath"
    }

    $sourceSettings = @(Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json)
    $stagedSettings = @(Get-Content -LiteralPath $stagedPath -Raw | ConvertFrom-Json)
    foreach ($settingName in $SettingNames) {
        $sourceMatches = @($sourceSettings | Where-Object { $_.name -eq $settingName })
        $stagedMatches = @($stagedSettings | Where-Object { $_.name -eq $settingName })
        if ($sourceMatches.Count -ne 1 -or $stagedMatches.Count -ne 1) {
            throw "Expected one '$settingName' setting in both $sourcePath and $stagedPath."
        }
        if ($stagedMatches[0].PSObject.Properties.Name -contains 'default') {
            $stagedMatches[0].default = $sourceMatches[0].default
        }
        else {
            $stagedMatches[0] | Add-Member -NotePropertyName default -NotePropertyValue $sourceMatches[0].default
        }
    }

    $json = ConvertTo-Json -InputObject $stagedSettings -Depth 100
    [System.IO.File]::WriteAllText($stagedPath, $json + [Environment]::NewLine, $utf8NoBom)
}

$officialRootPath = [System.IO.Path]::GetFullPath($OfficialSourceRoot)
$betterGIRootPath = [System.IO.Path]::GetFullPath($BetterGIRoot)
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $betterGIRootPath 'User\JsScript'))
$expectedInstallPrefix = $betterGIRootPath.TrimEnd('\') + '\'
if (-not $installRoot.StartsWith($expectedInstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved script installation root is outside BetterGI: $installRoot"
}
if (-not (Test-Path -LiteralPath $officialRootPath -PathType Container)) {
    throw "Official script source root not found: $officialRootPath"
}
if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
    throw "BetterGI script installation root not found: $installRoot"
}

$officialPackages = @(Get-ChildItem -LiteralPath $officialRootPath -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') -PathType Leaf
} | Sort-Object Name)
if ($officialPackages.Count -eq 0) {
    throw "No official script packages found under: $officialRootPath"
}

$subscriptionFilePath = if (-not [string]::IsNullOrWhiteSpace($SubscriptionPath)) {
    [System.IO.Path]::GetFullPath($SubscriptionPath)
}
else {
    Join-Path $betterGIRootPath 'User\Subscriptions\bettergi-scripts-list.json'
}
if (Test-Path -LiteralPath $subscriptionFilePath -PathType Leaf) {
    $subscriptionEntries = @(Get-Content -LiteralPath $subscriptionFilePath -Raw | ConvertFrom-Json)
    $subscribedPackageNames = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $subscriptionEntries) {
        $normalized = ([string]$entry).Replace('\', '/').Trim('/')
        if (-not $normalized.StartsWith('js/', [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $packageName = $normalized.Substring(3).Split('/')[0]
        if (-not [string]::IsNullOrWhiteSpace($packageName)) {
            $null = $subscribedPackageNames.Add($packageName)
        }
    }

    $availablePackageNames = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]@($officialPackages.Name),
        [StringComparer]::OrdinalIgnoreCase)
    $missingSubscriptions = @($subscribedPackageNames | Where-Object {
        -not $availablePackageNames.Contains($_)
    } | Sort-Object)
    if ($missingSubscriptions.Count -gt 0) {
        throw "Subscribed official packages are missing from the source: $($missingSubscriptions -join ', ')"
    }

    $officialPackages = @($officialPackages | Where-Object {
        $subscribedPackageNames.Contains($_.Name)
    })
}

$policyDocument = $null
$policyFilePath = $null
if (-not [string]::IsNullOrWhiteSpace($PolicyPath)) {
    $policyFilePath = [System.IO.Path]::GetFullPath($PolicyPath)
}
elseif (-not [string]::IsNullOrWhiteSpace($ForkRoot)) {
    $policyFilePath = Join-Path ([System.IO.Path]::GetFullPath($ForkRoot)) 'hcy\packages.json'
}
if ($null -ne $policyFilePath) {
    if (-not (Test-Path -LiteralPath $policyFilePath -PathType Leaf)) {
        throw "HCY installation policy not found: $policyFilePath"
    }
    $policyDocument = Get-Content -LiteralPath $policyFilePath -Raw | ConvertFrom-Json
}

$officialSettingDefaults = @{}
foreach ($entry in @($policyDocument.preserveOfficialSettingDefaults)) {
    $officialSettingDefaults[[string]$entry.folder] = @($entry.settings)
}

$operations = @($officialPackages | ForEach-Object {
    $package = $_
    $installedPackage = Join-Path $installRoot $package.Name
    $sourceManifest = Join-Path $package.FullName 'manifest.json'
    $installedManifest = Join-Path $installedPackage 'manifest.json'
    $manifest = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json

    [PSCustomObject]@{
        kind = 'official'
        name = $package.Name
        version = [string]$manifest.version
        source = $package.FullName
        destination = $installedPackage
        existed = Test-Path -LiteralPath $installedPackage -PathType Container
        savedFiles = @(Get-SavedFilePatterns -ManifestPaths @($sourceManifest, $installedManifest))
        preserveSources = @($installedPackage)
        preserveSettingDefaults = if ($officialSettingDefaults.ContainsKey($package.Name)) {
            @($officialSettingDefaults[$package.Name])
        }
        else {
            @()
        }
        settingsSource = $installedPackage
    }
})

if (-not [string]::IsNullOrWhiteSpace($ForkRoot)) {
    $forkRootPath = [System.IO.Path]::GetFullPath($ForkRoot)
    $hcyManifestPath = Join-Path $forkRootPath 'hcy\packages.json'
    $hcyPublisherPath = Join-Path $forkRootPath 'hcy\Publish-HcyPackages.ps1'
    if (-not (Test-Path -LiteralPath $hcyManifestPath -PathType Leaf)) {
        throw "HCY package manifest not found: $hcyManifestPath"
    }
    if (-not (Test-Path -LiteralPath $hcyPublisherPath -PathType Leaf)) {
        throw "HCY package publisher not found: $hcyPublisherPath"
    }

    $hcyManifest = if ($policyFilePath -eq $hcyManifestPath -and $null -ne $policyDocument) {
        $policyDocument
    }
    else {
        Get-Content -LiteralPath $hcyManifestPath -Raw | ConvertFrom-Json
    }
}

if (-not $Apply) {
    $plan = @($operations)
    if ($null -ne $hcyManifest) {
        foreach ($mapping in $hcyManifest.packages) {
            $sourceManifestPath = Join-Path $forkRootPath "repo\js\$($mapping.sourceFolder)\manifest.json"
            $sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
            $targetPath = Join-Path $installRoot $mapping.targetFolder
            $plan += [PSCustomObject]@{
                kind = 'hcy'
                name = [string]$mapping.targetFolder
                version = "$($sourceManifest.version)-hcy.$($mapping.revision)"
                source = Join-Path $forkRootPath "repo\js\$($mapping.sourceFolder)"
                destination = $targetPath
                existed = Test-Path -LiteralPath $targetPath -PathType Container
                savedFiles = @($mapping.preserveFiles)
                preserveSources = @(Join-Path $installRoot $mapping.preserveFromFolder)
                preserveSettingDefaults = @($mapping.preserveSettingDefaults)
                settingsSource = if (Test-Path -LiteralPath $targetPath -PathType Container) {
                    $targetPath
                }
                else {
                    Join-Path $installRoot $mapping.preserveFromFolder
                }
            }
        }
    }
    $plan
    return
}

if (-not $AllowRunningBetterGI -and @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'BetterGI.exe is running. Close it before applying script updates.'
}

$transactionRoot = [System.IO.Path]::GetFullPath((Join-Path $BackupRoot $TransactionId))
if (Test-Path -LiteralPath $transactionRoot) {
    throw "Transaction target already exists: $transactionRoot"
}

$stagingRoot = Join-Path $transactionRoot '.staging'
$packagesBackupRoot = Join-Path $transactionRoot 'packages'
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path $packagesBackupRoot -Force | Out-Null

if ($null -ne $hcyManifest) {
    $hcyPublishedRoot = Join-Path $transactionRoot '.hcy-published'
    & $hcyPublisherPath -DestinationRoot $hcyPublishedRoot | Out-Null

    foreach ($mapping in $hcyManifest.packages) {
        $sourcePackage = Join-Path $hcyPublishedRoot $mapping.targetFolder
        $installedPackage = Join-Path $installRoot $mapping.targetFolder
        $legacyPackage = Join-Path $installRoot $mapping.preserveFromFolder
        $sourceManifest = Join-Path $sourcePackage 'manifest.json'
        $installedManifest = Join-Path $installedPackage 'manifest.json'
        $legacyManifest = Join-Path $legacyPackage 'manifest.json'
        $manifest = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
        $savedFiles = @(
            Get-SavedFilePatterns -ManifestPaths @($sourceManifest, $installedManifest, $legacyManifest)
            @($mapping.preserveFiles) | ForEach-Object { ([string]$_).Replace('/', '\') }
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique

        $operations += [PSCustomObject]@{
            kind = 'hcy'
            name = [string]$mapping.targetFolder
            version = [string]$manifest.version
            source = $sourcePackage
            destination = $installedPackage
            existed = Test-Path -LiteralPath $installedPackage -PathType Container
            savedFiles = @($savedFiles)
            preserveSources = @($legacyPackage, $installedPackage)
            preserveSettingDefaults = @($mapping.preserveSettingDefaults)
            settingsSource = if (Test-Path -LiteralPath $installedPackage -PathType Container) {
                $installedPackage
            }
            else {
                $legacyPackage
            }
        }
    }
}

foreach ($operation in $operations) {
    $stagedPackage = Join-Path $stagingRoot $operation.name
    Copy-DirectoryContents -Source $operation.source -Destination $stagedPackage
    foreach ($preserveSource in @($operation.preserveSources)) {
        if (Test-Path -LiteralPath $preserveSource -PathType Container) {
            Copy-PreservedFiles -InstalledPackage $preserveSource -StagedPackage $stagedPackage -Patterns $operation.savedFiles
        }
    }
    if (@($operation.preserveSettingDefaults).Count -gt 0) {
        Copy-SettingDefaults `
            -SourcePackage $operation.settingsSource `
            -StagedPackage $stagedPackage `
            -SettingNames $operation.preserveSettingDefaults
    }
}

$transaction = [ordered]@{
    schemaVersion = 1
    transactionId = $TransactionId
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    officialSourceRoot = $officialRootPath
    subscriptionPath = if (Test-Path -LiteralPath $subscriptionFilePath -PathType Leaf) {
        $subscriptionFilePath
    }
    else {
        $null
    }
    betterGIRoot = $betterGIRootPath
    status = 'prepared'
    packages = @($operations)
}
$transactionPath = Join-Path $transactionRoot 'transaction.json'
$transaction | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $transactionPath -Encoding UTF8

foreach ($operation in $operations) {
    $stagedPackage = Join-Path $stagingRoot $operation.name
    $backupPackage = Join-Path $packagesBackupRoot $operation.name
    if ($operation.existed) {
        Move-Item -LiteralPath $operation.destination -Destination $backupPackage
    }

    try {
        Move-Item -LiteralPath $stagedPackage -Destination $operation.destination
    }
    catch {
        if ($operation.existed -and -not (Test-Path -LiteralPath $operation.destination) -and (Test-Path -LiteralPath $backupPackage)) {
            Move-Item -LiteralPath $backupPackage -Destination $operation.destination
        }
        throw
    }
}

$transaction.status = 'applied'
$transaction.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
$transaction | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $transactionPath -Encoding UTF8

[PSCustomObject]@{
    transactionId = $TransactionId
    transactionPath = $transactionPath
    packageCount = $operations.Count
    status = $transaction.status
}
