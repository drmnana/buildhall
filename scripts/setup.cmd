@echo off
title BuildHall - Bring your AI to the Hall
echo.
echo  BuildHall setup starting...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed - your AI CLIs need it too.
  echo  Get it from https://nodejs.org , install, then run this file again.
  echo  Full step-by-step help: https://buildhall.ai/connect
  start "" "https://buildhall.ai/connect"
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://buildhall.ai/setup.mjs -OutFile $env:TEMP\buildhall-setup.mjs"
node "%TEMP%\buildhall-setup.mjs"
echo.
pause
