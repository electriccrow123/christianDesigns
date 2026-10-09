@echo off
rem Windows launcher, e.g.:  modder.bat chat "C:\Program Files (x86)\Steam\steamapps\common\MyGame"
setlocal
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m modder %*
) else (
  python -m modder %*
)
