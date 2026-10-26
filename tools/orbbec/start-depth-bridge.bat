@echo off
chcp 65001 >nul
title Astra Pro 深度桥接服务
cd /d "%~dp0"

rem Locate Python: bundled venv (if any) -> py launcher -> python on PATH.
rem NOTE: never set-and-read a variable inside the same ( ) block in cmd --
rem it expands before the block runs and always yields the old value.
set PY=
if exist "%~dp0python\python.exe" set PY=%~dp0python\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [!] Python 3 not found. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)

echo ============================================================
echo   Astra Pro 深度桥接服务
echo   启动后保持这个窗口开着，最小化即可，别关。
echo   页面里连的是 ws://127.0.0.1:8765
echo ============================================================
echo.

"%PY%" openni-bridge.py --res 640x480 --fps 15 --verbose

echo.
echo 服务已退出。按任意键关闭窗口。
pause >nul
