# Creates a "BuildHall Bridge" shortcut on the Desktop pointing at the launcher.
# Safe to run more than once - it overwrites its own shortcut and nothing else.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repoRoot 'bridge\start-hidden.vbs'
$icon     = Join-Path $repoRoot 'brand\favicon\favicon.ico'

if (-not (Test-Path $launcher)) {
  Write-Error "Launcher not found at $launcher - run this from inside the buildhall repo."
}

# Prefer the real Desktop location: OneDrive redirects it on most Windows setups,
# so hardcoding %USERPROFILE%\Desktop puts the shortcut somewhere invisible.
$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'BuildHall Bridge.lnk'

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
# wscript runs the VBS with no console window; the VBS starts the bridge hidden.
$link.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
$link.Arguments        = '"' + $launcher + '"'
$link.WorkingDirectory = $repoRoot
$link.Description      = 'Connect your local AI agents to BuildHall'
if (Test-Path $icon) { $link.IconLocation = $icon }
$link.Save()

Write-Host ""
Write-Host "Shortcut created:" -ForegroundColor Green
Write-Host "  $linkPath"
Write-Host ""
Write-Host "Double-click it to start the bridge - silently, no window."
Write-Host "The control panel opens automatically only on FIRST run; after that,"
Write-Host "double-click the shortcut again (or visit the address below) to open it:"
Write-Host "  http://127.0.0.1:7391"
Write-Host ""
