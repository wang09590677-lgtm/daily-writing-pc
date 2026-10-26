@echo off
rem ============================================================
rem  DIAGNOSTIC launcher: opens the app with ?depthZ=1
rem  (the depth-z path is OFF by default since 2026-10-11)
rem
rem  ASCII ONLY on purpose: .bat files here are GBK/ANSI and
rem  non-ASCII text would break cmd parsing.
rem
rem  Use this ONLY to A/B test the "front/back (sagittal)" feature.
rem  For normal use, double-click start-app.bat instead.
rem ============================================================
cd /d "%~dp0"

set "APPDIR=%CD%"
set "APPDIR=%APPDIR:\=/%"
set "URL=file:///%APPDIR%/index.html?depthZ=1"

set "BROWSER="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER (
  echo [!] Chrome not found.
  pause
  exit /b 1
)

rem ---------- depth bridge (port 8765), same logic as start-app.bat ----------
set "PY="
if exist "%~dp0tools\orbbec\python\pythonw.exe" set "PY=%~dp0tools\orbbec\python\pythonw.exe"
if not defined PY if exist "%~dp0python\pythonw.exe" set "PY=%~dp0python\pythonw.exe"
if not defined PY for /f "delims=" %%I in ('where pythonw 2^>nul') do if not defined PY set "PY=%%I"
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set "PY=%%I"

netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [OK] depth bridge already listening on 8765
) else (
  if defined PY (
    echo starting depth bridge...
    start "Astra Depth Bridge" /min "%PY%" "%~dp0tools\orbbec\openni-bridge.py" --res 640x480 --fps 15
  ) else (
    echo [!] python not found - bridge not started
  )
)

start "" "%BROWSER%" --user-data-dir="%LOCALAPPDATA%\WritingCoachChrome" --allow-file-access-from-files --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --disable-search-engine-choice-screen "%URL%"

echo.
echo Opened with ?depthZ=1  (diagnostic). Closing in 5s.
ping -n 6 127.0.0.1 >nul
exit /b 0
