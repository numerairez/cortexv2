@echo off
rem One-time setup: creates a private Python environment (.venv) and installs dependencies.
setlocal
cd /d "%~dp0"
title Context Workbench setup

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo Python was not found. Ask IT for Python 3.10 or newer, then run this again.
    pause
    exit /b 1
)

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
    echo This Python is too old. Python 3.10 or newer is required.
    %PY% --version
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating private environment in .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo Could not create the environment. Your PC may block venv; contact IT.
        pause
        exit /b 1
    )
)

set "REQ=backend\requirements.lock"
.venv\Scripts\python.exe -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 set "REQ=backend\requirements.txt"

rem Offline installs: if a "wheels" folder was shipped with the app, install from it only.
if exist "wheels" (
    .venv\Scripts\python.exe -m pip install --no-index --find-links wheels -r %REQ%
) else (
    .venv\Scripts\python.exe -m pip install -r %REQ%
)
if errorlevel 1 (
    echo.
    echo Installing packages failed. If your PC has no internet access or uses a
    echo company package mirror, ask IT, or obtain a release that includes a "wheels" folder.
    pause
    exit /b 1
)

echo.
echo Setup complete. Start the app by double-clicking launch.bat.
pause
endlocal
