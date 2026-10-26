@echo off
chcp 65001 >nul
title Real-depth capture (voice guided)
cd /d "%~dp0"

set PY=
if exist "%~dp0python\python.exe" set PY=%~dp0python\python.exe
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set PY=%%I
if not defined PY (
  echo [!] Python 3 not found. Install from https://www.python.org/downloads/
  pause
  exit /b 1
)
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo ============================================================
echo   Real-depth capture   (VOICE guided, just listen)
echo ============================================================
echo.
echo   A Chinese voice will tell you exactly what to do.
echo   You do NOT need to look at this screen.
echo.
echo   Step 1 : voice says leave the frame   -- walk away
echo   Step 2 : voice says stand 2.5-3 m     -- whole body in view
echo   Step 3 : three poses, one at a time   -- listen every time
echo   Step 4 : voice says leave again       -- walk away
echo.
echo   Voice files are loaded from .\voices\
echo ============================================================
echo.

if not exist "voices\go_stand.wav" goto novoice

"%PY%" capture-guided.py
goto end

:novoice
echo [!] voices\ folder missing or incomplete.
echo     Please run:  python gen-guided-voices.py
echo.
pause >nul
exit /b 1

:end
echo.
echo Finished. Press any key to close.
pause >nul
