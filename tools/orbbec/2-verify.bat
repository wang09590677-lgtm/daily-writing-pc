@echo off
chcp 437 >nul
setlocal enabledelayedexpansion
title Astra Pro - Verify

set "ROOT=%~dp0"
set "LOG=%ROOT%verify-log.txt"
rem OpenNI 的官方样例二进制在新版本里不一定随包发布，
rem 深度探测统一用我们自己的 openni-probe.py（走 runtime 目录里的 OpenNI2.dll）。
set "ONI=%ROOT%..\openni"

echo === ASTRA PRO VERIFY === > "%LOG%"
echo Date: %date% %time% >> "%LOG%"

echo ============================================================
echo   Astra Pro - depth verification
echo ============================================================
echo.

echo [1] Orbbec USB devices (Status / ProblemCode):
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_2BC5' } | ForEach-Object { $p = ($_ | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data; '{0,-9} PC={1,-3} {2}' -f $_.Status, $p, $_.InstanceId }"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_2BC5' } | ForEach-Object { $p = ($_ | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data; '{0,-9} PC={1,-3} {2}' -f $_.Status, $p, $_.InstanceId }" >> "%LOG%"
echo.

echo [2] obdrv4 in the driver store:
pnputil /enum-drivers | findstr /i "obdrv4"
pnputil /enum-drivers | findstr /i "obdrv4" >> "%LOG%"
if errorlevel 1 (
  echo     NOT INSTALLED - run 1-install-driver.bat as Administrator
  echo     NOT INSTALLED >> "%LOG%"
)
echo.

echo [3] OpenNI2 depth probe (Python, 10 s max):
set "PY="
if exist "%ROOT%python\python.exe" set "PY=%ROOT%python\python.exe"
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set "PY=%%I"
if not defined PY (
  echo     PYTHON NOT FOUND - skipping the OpenNI2 probe
  echo     PYTHON NOT FOUND >> "%LOG%"
  goto SKIP
)
pushd "%ROOT%"
echo --- openni-probe --- >> "%LOG%"
"%PY%" openni-probe.py
"%PY%" openni-probe.py >> "%LOG%" 2>&1
popd
echo.

:SKIP
echo ============================================================
echo   GOOD  = [1] 里全是 OK PC=0，[3] 里出现非 0 的毫米距离
echo   BAD   = [1] 出现 PC=10 / 缺设备，或 [3] 说找不到设备
echo.
echo   想看相机到底"看到"了什么：openni-shot.py 会存成 PNG
echo   想给页面供深度：      start-depth-bridge.bat
echo.
echo   Full log: %LOG%
echo ============================================================
echo.
pause
