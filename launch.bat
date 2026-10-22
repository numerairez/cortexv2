@echo off
rem Flowbook launcher. Double-click to start the app in your browser.
setlocal
cd /d "%~dp0"
title Flowbook

set "PY="
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY (
    where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo.
    echo Python was not found on this PC.
    echo Ask IT for a supported Python 3.10+ installation, then run setup.bat.
    echo.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo No private environment found. Run setup.bat once before launching.
    echo Trying to start with the system Python anyway...
)

if not exist "frontend\dist\index.html" (
    echo.
    echo The user interface has not been built. This copy of the app is incomplete;
    echo please use a release folder that contains frontend\dist.
    echo.
    pause
    exit /b 1
)

set "PYTHONPATH=%~dp0backend"
set "PYTHONUTF8=1"
%PY% -m app.launcher %*
if errorlevel 1 (
    echo.
    pause
)
endlocal
