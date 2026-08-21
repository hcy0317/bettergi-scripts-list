[CmdletBinding()]
param(
    [switch]$Check,

    [switch]$NoLaunch,

    [string]$BetterGIRoot = $PSScriptRoot,

    [ValidateRange(30, 1800)]
    [int]$WindowReadyTimeoutSeconds = 600,

    [ValidateRange(100, 5000)]
    [int]$WindowPollIntervalMilliseconds = 500,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BetterGIArguments
)

$ErrorActionPreference = 'Stop'
$BetterGIRoot = [System.IO.Path]::GetFullPath($BetterGIRoot)
$BetterGIExe = Join-Path $BetterGIRoot 'BetterGI.exe'
$CaptureModeScript = Join-Path $BetterGIRoot 'scripts\bettergi-scheduler\Set-BetterGICaptureMode.ps1'
$ConfigPath = Join-Path $BetterGIRoot 'User\config.json'
$LogPath = Join-Path $BetterGIRoot 'scripts\bettergi-scheduler\logs\bettergi-normal-hdr-launcher.log'

$RequiredCaptureMode = 'WindowsGraphicsCaptureHdr'
$RequiredShowLogBox = 'False'
$RequiredShowStatus = 'False'
$RequiredAutoPickKey = 'YY'
$RequiredCpuOcr = 'False'

function Write-LauncherLog {
    param([Parameter(Mandatory)][string]$Message)

    $logDirectory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
        '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message)
}

function Assert-LauncherPrerequisites {
    foreach ($requiredFile in @($BetterGIExe, $CaptureModeScript, $ConfigPath)) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Required BetterGI launcher file not found: $requiredFile"
        }
    }
}

function Get-BetterGIProcessForCurrentSession {
    $currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $candidates = @(Get-Process -Name BetterGI -ErrorAction SilentlyContinue | Where-Object {
        if ($_.SessionId -ne $currentSessionId) {
            return $false
        }

        try {
            $processPath = $_.Path
            if ([string]::IsNullOrWhiteSpace($processPath)) {
                $processPath = $_.MainModule.FileName
            }
            if ([string]::IsNullOrWhiteSpace($processPath)) {
                return $true
            }
            return [System.IO.Path]::GetFullPath($processPath) -eq $BetterGIExe
        }
        catch {
            return $true
        }
    } | Sort-Object `
        @{ Expression = { if ($_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Responding) { 1 } else { 0 } }; Descending = $true }, `
        @{ Expression = 'StartTime'; Descending = $true })

    return $candidates | Select-Object -First 1
}

function Wait-BetterGIResponsiveWindow {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process]$Process
    )

    $deadline = [datetime]::UtcNow.AddSeconds($WindowReadyTimeoutSeconds)
    while ([datetime]::UtcNow -lt $deadline) {
        try {
            $Process.Refresh()
            if ($Process.HasExited) {
                return [pscustomobject]@{
                    ready = $false
                    exited = $true
                    windowHandle = 0
                }
            }
            if ($Process.MainWindowHandle -ne [IntPtr]::Zero -and $Process.Responding) {
                return [pscustomobject]@{
                    ready = $true
                    exited = $false
                    windowHandle = $Process.MainWindowHandle.ToInt64()
                }
            }
        }
        catch [System.InvalidOperationException] {
            return [pscustomobject]@{
                ready = $false
                exited = $true
                windowHandle = 0
            }
        }

        Start-Sleep -Milliseconds $WindowPollIntervalMilliseconds
    }

    return [pscustomobject]@{
        ready = $false
        exited = $false
        windowHandle = 0
    }
}

function Show-BetterGIWindow {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process]$Process
    )

    if (-not ('BetterGILauncher.NativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace BetterGILauncher
{
    public static class NativeMethods
    {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
'@
    }

    $Process.Refresh()
    $handle = $Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
        return $false
    }

    $null = [BetterGILauncher.NativeMethods]::ShowWindowAsync($handle, 9)
    $null = [BetterGILauncher.NativeMethods]::BringWindowToTop($handle)
    $activated = [BetterGILauncher.NativeMethods]::SetForegroundWindow($handle)
    if (-not $activated) {
        try {
            [Microsoft.VisualBasic.Interaction]::AppActivate($Process.Id)
            $activated = $true
        }
        catch {
            $activated = $false
        }
    }
    return $activated
}

try {
    Assert-LauncherPrerequisites

    if ($Check) {
        $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $config.maskWindowConfig) {
            throw "BetterGI maskWindowConfig not found in: $ConfigPath"
        }
        if (-not $config.autoPickConfig) {
            throw "BetterGI autoPickConfig not found in: $ConfigPath"
        }
        if (-not $config.hardwareAccelerationConfig) {
            throw "BetterGI hardwareAccelerationConfig not found in: $ConfigPath"
        }

        Write-LauncherLog (
            'CHECK OK: exe={0}; config={1}; currentCaptureMode={2}; requiredCaptureMode={3}; no configuration changes were applied.' -f
            $BetterGIExe,
            $ConfigPath,
            $config.captureMode,
            $RequiredCaptureMode)

        [pscustomobject]@{
            mode = 'check'
            executable = $BetterGIExe
            configPath = $ConfigPath
            currentCaptureMode = $config.captureMode
            requiredCaptureMode = $RequiredCaptureMode
            windowReadyTimeoutSeconds = $WindowReadyTimeoutSeconds
            waitsForResponsiveWindow = $true
            reusesExistingProcess = $true
            wouldLaunch = $false
            changesApplied = $false
        } | ConvertTo-Json -Depth 3
        return
    }

    Write-LauncherLog (
        'Applying normal HDR profile: captureMode={0}; showLogBox={1}; showStatus={2}; autoPickKey={3}; cpuOcr={4}.' -f
        $RequiredCaptureMode,
        $RequiredShowLogBox,
        $RequiredShowStatus,
        $RequiredAutoPickKey,
        $RequiredCpuOcr)

    $changes = & (Get-Command pwsh.exe -ErrorAction Stop).Source `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $CaptureModeScript `
        -BetterGIRoot $BetterGIRoot `
        -CaptureMode $RequiredCaptureMode `
        -ShowLogBox $RequiredShowLogBox `
        -ShowStatus $RequiredShowStatus `
        -AutoPickKey $RequiredAutoPickKey `
        -CpuOcr $RequiredCpuOcr
    if ($LASTEXITCODE -ne 0) {
        throw "Capture mode setup failed with exit code $LASTEXITCODE."
    }
    foreach ($change in $changes) {
        Write-LauncherLog "PROFILE: $change"
    }

    if ($NoLaunch) {
        Write-LauncherLog 'NO-LAUNCH OK: normal HDR profile applied; BetterGI was not started.'
        [pscustomobject]@{
            mode = 'no-launch'
            executable = $BetterGIExe
            requiredCaptureMode = $RequiredCaptureMode
            wouldLaunch = $false
            changesApplied = $true
        } | ConvertTo-Json -Depth 3
        return
    }

    $process = Get-BetterGIProcessForCurrentSession
    $reusedExistingProcess = $null -ne $process
    if ($reusedExistingProcess) {
        Write-LauncherLog ("REUSING: pid={0}; waiting for its responsive main window." -f $process.Id)
    }
    else {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $BetterGIExe
        $startInfo.WorkingDirectory = $BetterGIRoot
        $startInfo.UseShellExecute = $true
        foreach ($argument in @($BetterGIArguments)) {
            $startInfo.ArgumentList.Add([string]$argument)
        }

        $process = [System.Diagnostics.Process]::Start($startInfo)
        if (-not $process) {
            throw "BetterGI process could not be created: $BetterGIExe"
        }
        Write-LauncherLog (
            'STARTED: pid={0}; arguments={1}; waiting up to {2}s for a responsive main window.' -f
            $process.Id,
            $(if ($BetterGIArguments.Count -gt 0) { $BetterGIArguments -join ' ' } else { '<none>' }),
            $WindowReadyTimeoutSeconds)
    }

    $windowState = Wait-BetterGIResponsiveWindow -Process $process
    if ($windowState.exited) {
        $forwardedProcess = Get-BetterGIProcessForCurrentSession
        if ($forwardedProcess -and $forwardedProcess.Id -ne $process.Id) {
            $process = $forwardedProcess
            $reusedExistingProcess = $true
            Write-LauncherLog ("FORWARDED: using existing BetterGI pid={0}." -f $process.Id)
            $windowState = Wait-BetterGIResponsiveWindow -Process $process
        }
    }
    if (-not $windowState.ready) {
        throw (
            "BetterGI PID {0} did not expose a responsive main window within {1} seconds. " +
            "The process was left running; inspect $LogPath and the BetterGI application log.") -f
            $process.Id,
            $WindowReadyTimeoutSeconds
    }

    $activationSucceeded = Show-BetterGIWindow -Process $process
    Write-LauncherLog (
        'READY: pid={0}; reusedExistingProcess={1}; windowHandle={2}; activationSucceeded={3}.' -f
        $process.Id,
        $reusedExistingProcess,
        $windowState.windowHandle,
        $activationSucceeded)

    [pscustomobject]@{
        mode = 'launch'
        processId = $process.Id
        reusedExistingProcess = $reusedExistingProcess
        responsiveWindow = $true
        activationSucceeded = $activationSucceeded
        windowReadyTimeoutSeconds = $WindowReadyTimeoutSeconds
    } | ConvertTo-Json -Depth 3
}
catch {
    try {
        Write-LauncherLog ("FAILED: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
    }
    catch {
        # Preserve the original launcher failure if diagnostic logging also fails.
    }
    Write-Error $_
    exit 1
}
