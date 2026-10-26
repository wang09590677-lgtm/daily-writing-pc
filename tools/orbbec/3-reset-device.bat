@echo off
chcp 437 >nul
setlocal
title Astra Pro - Reset failed USB device node

rem Only needed if 1-install-driver.bat succeeded but VID_2BC5&PID_0403
rem still shows Status=Error / ProblemCode=10.

net session >nul 2>&1
if "%errorLevel%"=="0" goto :ADMIN

echo.
echo   [!] Requesting administrator privilege.
echo       Please click YES on the UAC dialog...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
exit /b 0

:ADMIN
echo ============================================================
echo   Remove the stuck "USB\VID_2BC5&PID_0403" node and rescan.
echo   This does NOT delete any file - it only asks Windows to
echo   forget the failed USB device and enumerate it again.
echo ============================================================
echo.
echo   TIP: unplug the camera first, run this, then plug it back
echo        into a USB port directly on the PC (no hub / dock).
echo.

echo [1/3] Removing device node ...
pnputil /remove-device "USB\VID_2BC5&PID_0403" /subtree

echo [2/3] Removing stale non-present nodes ...
pnputil /scan-devices

echo [3/3] Current Orbbec devices:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_2BC5' } | ForEach-Object { $p = ($_ | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data; '{0,-9} PC={1,-3} {2}' -f $_.Status, $p, $_.InstanceId }"

echo.
echo   Now plug the camera back in and run 2-verify.bat
echo.
pause
