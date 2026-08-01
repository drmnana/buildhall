@echo off
setlocal
REM BuildHall Bridge launcher. Keeps this window open so you can see
REM connection status; closing it stops the bridge.
cd /d "%~dp0.."
title BuildHall Bridge
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required and was not found on PATH.
  echo Install Node 22.5 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run - installing dependencies...
  call npm install --omit=dev
)
node bridge\server.mjs
pause
