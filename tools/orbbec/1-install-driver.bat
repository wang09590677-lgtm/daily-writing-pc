@echo off
chcp 437 >nul
setlocal enabledelayedexpansion
title Astra Pro Depth Camera - Driver Install

set "ROOT=%~dp0"
set "DRV=%ROOT%driver-extracted\obdrv4.inf"
set "LOG=%ROOT%install-log.txt"

rem ---- self elevation: relaunch as administrator via UAC ----
net session >nul 2>&1
if "%errorLevel%"=="0" goto :ADMIN

echo.
echo   [!] Requesting administrator privilege.
echo       Please click YES on the UAC dialog...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%ROOT%'"
exit /b 0

:ADMIN
echo ============================================================
echo   ORBBEC Astra Pro - depth sensor driver install
echo   Target : USB\VID_2BC5^&PID_0403^&MI_00   (Astra Pro depth)
echo   Driver : obdrv4.inf  v4.3.0.22  (WHQL signed)
echo   Log    : %LOG%
echo ============================================================
echo.

echo === ORBBEC ASTRA DRIVER INSTALL === > "%LOG%"
echo Date: %date% %time% >> "%LOG%"
echo INF : %DRV% >> "%LOG%"
echo. >> "%LOG%"

if not exist "%DRV%" (
  echo   [X] obdrv4.inf NOT FOUND: %DRV%
  echo.
  pause
  exit /b 1
)

echo [1/4] Adding driver package to the Windows driver store ...
echo --- pnputil /add-driver --- >> "%LOG%"
pnputil /add-driver "%DRV%" /install >> "%LOG%" 2>&1
set "RC=%errorLevel%"
echo       pnputil exit code = %RC%
echo       pnputil exit code = %RC% >> "%LOG%"

if not "%RC%"=="0" (
  echo.
  echo   [!] pnputil returned %RC%.
  echo       Full output:
  echo.
  type "%LOG%"
  echo.
  echo   Common causes: not elevated / signature rejected / inf path wrong.
  echo.
  pause
  exit /b %RC%
)

echo [2/4] Rescanning for hardware changes ...
echo --- pnputil /scan-devices --- >> "%LOG%"
pnputil /scan-devices >> "%LOG%" 2>&1

echo [3/4] Enumerating Orbbec devices ...
echo --- device state --- >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_2BC5' } | ForEach-Object { $p = ($_ | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data; '{0} | PC={1} | {2} | {3}' -f $_.Status, $p, $_.FriendlyName, $_.InstanceId }" >> "%LOG%" 2>&1

echo [4/4] ---- RESULT ----
echo.
type "%LOG%"
echo.
echo ============================================================
echo   What to look for:
echo     USB\VID_2BC5^&PID_0403^&MI_00   Status=OK   PC=0
echo   If it still says Error / PC=10:
echo     1. Unplug the camera and plug it back in
echo        (prefer a USB 3.0 port on the REAR of the PC)
echo     2. Run  2-verify.bat
echo ============================================================
echo.
pause
