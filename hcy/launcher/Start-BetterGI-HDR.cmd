@echo off
setlocal

set "BETTERGI_ROOT=%~dp0"
if "%BETTERGI_ROOT:~-1%"=="\" set "BETTERGI_ROOT=%BETTERGI_ROOT:~0,-1%"
set "LAUNCHER_SCRIPT=%BETTERGI_ROOT%\Start-BetterGI-HDR.ps1"

set "POWERSHELL_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if exist "%POWERSHELL_EXE%" goto pwsh_ready
set "POWERSHELL_EXE="
for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%~fI"
if not defined POWERSHELL_EXE (
  echo PowerShell 7 pwsh.exe is required to start BetterGI.
  exit /b 1
)
:pwsh_ready

if not exist "%LAUNCHER_SCRIPT%" (
  echo BetterGI HDR launcher not found: "%LAUNCHER_SCRIPT%"
  exit /b 1
)

if /I "%~1"=="--check" goto check
if /I "%~1"=="-Check" goto check
if /I "%~1"=="--no-launch" goto no_launch
if /I "%~1"=="-NoLaunch" goto no_launch

"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER_SCRIPT%" %*
exit /b %errorlevel%

:check
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER_SCRIPT%" -Check
exit /b %errorlevel%

:no_launch
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER_SCRIPT%" -NoLaunch
exit /b %errorlevel%
