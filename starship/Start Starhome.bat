@echo off
title Starhome VR
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8080/
  node serve.mjs
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
)
pause
