# -*- coding: utf-8 -*-
"""
生成 start-app.bat（必须存成 GBK / ANSI 编码）。

为什么要有这个脚本，而不是直接手写 bat:
  1. bat 里一旦有中文，就必须用 GBK 存。用编辑器另存很容易漏，
     而 UTF-8 + chcp 65001 会让 cmd 因代码页切换把中文注释错切成命令，满屏报错。
  2. 统一由 Python 生成，编码永远正确，改文案只需改这里再跑一次。
"""
import os

CONTENT = r'''@echo off
cd /d "%~dp0"
title AI 儿童每日写作训练 - 体感跟练

rem ============================================================
rem   一键启动：双击本文件打开应用。
rem
rem   它做了两件关键的事：
rem     1) 摄像头权限自动允许，不再弹「是否允许访问摄像头」
rem     2) 自动拉起 Astra Pro 深度桥接服务（已启动则跳过）
rem
rem   技术说明：
rem     页面是 file:// 打开，在 Chrome 里本来属于「不透明来源」，
rem     摄像头授权无法被记住，所以每次都会重新弹框。下面几个参数解决它：
rem       --allow-file-access-from-files    让 file:// 变成可识别来源
rem       --use-fake-ui-for-media-stream    权限询问框自动点「允许」
rem       --user-data-dir=独立目录          开一个专用配置档，这样即使你
rem                                        原来的 Chrome 正在运行，参数也
rem                                        一样生效（否则会被已有进程吞掉）
rem       --autoplay-policy                 让滴答声和语音不用先点一下页面
rem
rem   注意：本文件必须是 GBK(ANSI) 编码，且不能加 chcp 65001。
rem         否则 cmd 会因代码页切换把中文注释错切成命令，满屏报错。
rem         需要改文案时请改 build/gen-start-bat.py 再重新生成。
rem ============================================================

rem ---------- 拼出 index.html 的 file:// 地址 ----------
rem 分两步替换反斜杠：单行写 %CD:\=/% 在部分 cmd 版本上不生效，两步最稳。
set "APPDIR=%CD%"
set "APPDIR=%APPDIR:\=/%"
set "URL=file:///%APPDIR%/index.html"

rem ---------- 找一个浏览器：优先 Chrome，其次 Edge ----------
set "BROWSER="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER (
  echo [!] 没有找到 Chrome 或 Edge。
  echo     请手动用 Chrome 打开本目录下的 index.html。
  echo.
  pause
  exit /b 1
)

rem ---------- 专用配置档目录 ----------
set "PROFILE=%LOCALAPPDATA%\WritingCoachChrome"
if not exist "%PROFILE%" mkdir "%PROFILE%" 2>nul

rem ---------- 定位 Python（必须在括号块外！见下方说明）----------
rem 注意：cmd 的括号块是「整块先解析、后执行」：块内的 %VAR% 在进入块时就展开成
rem    当时的值。若在块内 set 再在块内用 %VAR% 读，读到的永远是旧值（空）。
rem    原版把 set PY 写在 else 块里、紧接着用 "%PY%" 判断 -> 永远为空
rem    -> 永远走「没找到 Python」-> 深度桥从未启动（体感只能退回纯彩色）。
rem    修法：把定位逻辑提到块外，块内只做「用」不做「设」。
set "PY="
if exist "C:\Users\lixue\.workbuddy-ai\binaries\python\envs\default\Scripts\pythonw.exe" set "PY=C:\Users\lixue\.workbuddy-ai\binaries\python\envs\default\Scripts\pythonw.exe"
if not defined PY if exist "C:\Users\lixue\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe" set "PY=C:\Users\lixue\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe"
if not defined PY if exist "C:\Users\lixue\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe" set "PY=C:\Users\lixue\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"

rem ---------- Astra 深度桥接服务（端口 8765）----------
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [OK] 深度桥接服务已经在运行，跳过启动。
) else (
  if defined PY (
    echo 正在启动 Astra Pro 深度桥接服务（会最小化一个窗口，别关它）...
    start "Astra 深度桥接" /min "%PY%" "%~dp0tools\orbbec\openni-bridge.py" --res 640x480 --fps 15
  ) else (
    echo [!] 没找到 Python，跳过深度服务。
    echo     体感会退回纯彩色识别，功能仍可用，只是精度低一些。
  )
)

echo.
echo 正在打开应用，请稍候...
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --allow-file-access-from-files --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --disable-search-engine-choice-screen "%URL%"

echo.
echo ============================================================
echo  已启动。摄像头权限会自动允许，不用再点「允许」。
echo  进入体感跟练后会自动做骨骼识别校准，跟着语音提示站位即可。
echo ============================================================
echo.
echo 本窗口 6 秒后自动关闭。
ping -n 7 127.0.0.1 >nul
exit /b 0
'''

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "start-app.bat")
raw = CONTENT.encode("gbk", errors="strict")          # 编码不了会直接报错，不会静默出错
raw = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")   # 统一 CRLF
with open(OUT, "wb") as f:
    f.write(raw)
print("written:", OUT, os.path.getsize(OUT), "bytes")
