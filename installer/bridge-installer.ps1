# BuildHall AI Bridge installer.
# Copies the bridge to %LOCALAPPDATA%\BuildHall, makes a Desktop shortcut with
# the BuildHall logo, and starts it. Re-running updates the files in place.
param([string]$Base = "https://buildhall.ai")
$ErrorActionPreference = 'Stop'
Write-Host ""
Write-Host "  BuildHall AI Bridge setup" -ForegroundColor Cyan
Write-Host "  -------------------------"

$dir = Join-Path $env:LOCALAPPDATA 'BuildHall'
New-Item -ItemType Directory -Force -Path $dir, (Join-Path $dir 'public') | Out-Null

# --- Node.js (the only requirement) ---------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  Node.js is not installed - trying to install it with winget..."
  try {
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
  } catch { }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  Could not install Node automatically." -ForegroundColor Yellow
    Write-Host "  Install it from the page that just opened, then run this setup again."
    Start-Process 'https://nodejs.org'
    exit 1
  }
}
Write-Host "  Node found: $(node --version)"

# --- download the bridge ---------------------------------------------------
Write-Host "  Downloading the bridge from $Base ..."
$manifest = Invoke-RestMethod "$Base/download/manifest.json" -UseBasicParsing
foreach ($f in $manifest.files) {
  $target = Join-Path $dir ($f -replace '/', '\')
  Invoke-WebRequest "$Base/bridge-src/$f" -OutFile $target -UseBasicParsing
}
Invoke-WebRequest "$Base/favicon.ico" -OutFile (Join-Path $dir 'buildhall.ico') -UseBasicParsing

# --- launcher (hidden window) ----------------------------------------------
@"
@echo off
cd /d "%~dp0"
if not exist "%USERPROFILE%\.buildhall" mkdir "%USERPROFILE%\.buildhall"
node server.mjs >> "%USERPROFILE%\.buildhall\bridge.log" 2>&1
"@ | Set-Content (Join-Path $dir 'bridge-run.cmd') -Encoding ASCII
@"
' Starts BuildHall Bridge with no console window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & here & "\bridge-run.cmd""", 0, False
"@ | Set-Content (Join-Path $dir 'BuildHall Bridge.vbs') -Encoding ASCII

# --- Desktop shortcut with the logo ----------------------------------------
# GetFolderPath resolves the REAL Desktop - OneDrive redirects it on most
# machines and %USERPROFILE%\Desktop would miss.
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'BuildHall Bridge.lnk'))
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $dir 'BuildHall Bridge.vbs') + '"'
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = (Join-Path $dir 'buildhall.ico')
$lnk.Description = 'Connect the AIs on this computer to BuildHall'
$lnk.Save()

Write-Host ""
Write-Host "  Installed. A 'BuildHall Bridge' shortcut is on your Desktop." -ForegroundColor Green
Write-Host "  Starting it now - your browser will open so you can sign in."
Start-Process wscript.exe ('"' + (Join-Path $dir 'BuildHall Bridge.vbs') + '"')
Start-Sleep 2
Start-Process 'http://127.0.0.1:7391'
