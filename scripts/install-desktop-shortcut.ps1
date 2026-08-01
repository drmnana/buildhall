# Creates a "BuildHall Bridge" shortcut on the Desktop pointing at the launcher.
# Safe to run more than once - it overwrites its own shortcut and nothing else.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repoRoot 'bridge\BuildHall Bridge.cmd'
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
$link.TargetPath       = $launcher
$link.WorkingDirectory = $repoRoot
$link.Description      = 'Connect your local AI agents to BuildHall'
if (Test-Path $icon) { $link.IconLocation = $icon }
$link.Save()

Write-Host ""
Write-Host "Shortcut created:" -ForegroundColor Green
Write-Host "  $linkPath"
Write-Host ""
Write-Host "Double-click it to start the bridge. It opens a control panel at"
Write-Host "  http://127.0.0.1:7391"
Write-Host ""
