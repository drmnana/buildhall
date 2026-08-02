@echo off
title BuildHall AI Bridge setup
echo Downloading the BuildHall AI Bridge installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://buildhall.ai/download/bridge.ps1 -OutFile $env:TEMP\buildhall-setup.ps1; & $env:TEMP\buildhall-setup.ps1"
pause
