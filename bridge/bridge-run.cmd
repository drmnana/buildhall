@echo off
REM Headless worker for BuildHall Bridge - started hidden by start-hidden.vbs.
REM Output goes to %USERPROFILE%\.buildhall\bridge.log
cd /d "%~dp0.."
if not exist "%USERPROFILE%\.buildhall" mkdir "%USERPROFILE%\.buildhall"
where node >nul 2>nul || exit /b 1
if not exist node_modules call npm install --omit=dev >> "%USERPROFILE%\.buildhall\bridge.log" 2>&1
node bridge\server.mjs >> "%USERPROFILE%\.buildhall\bridge.log" 2>&1
