# -*- coding: utf-8 -*-
"""生成发行版用的「启动.bat」。

为什么用生成器而不是直接写 .bat：
  这个项目踩过两次 cmd 编码的坑（见 memory/PITFALLS.md）：
    1) .bat 里出现 GBK 编不出的字符（emoji 之类）→ 生成时直接抛
       UnicodeEncodeError，看着像脚本坏了；
    2) .bat 与 chcp 65001 混用 → cmd 逐行回退重读，中文字符串被吃掉。
  所以这里**显式**用 GBK 编码写盘（中文 Windows 的 cmd 默认代码页 936），
  并在写之前把 GBK 编不出的字符挑出来报错 —— 不静默损坏。

生成产物：build/release-tpl/启动.bat
用法：python build/gen-release-bat.py
"""

import os
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "build", "release-tpl")
OUT = os.path.join(OUT_DIR, "启动.bat")

BAT = r"""@echo off
rem ============================================================
rem  AI 学习训练助手 —— 一键启动
rem
rem  这个文件是给「拿到压缩包的人」用的，所以：
rem    * 不依赖本机任何固定路径（浏览器逐条探测，找不到就明确报错）
rem    * 不依赖 Python（深度桥是可选增强项，没装就跳过并说明）
rem    * 全程用自己的相对路径 %%~dp0，整个文件夹搬到哪都能跑
rem
rem  编码：GBK(ANSI)，不要加 chcp 65001。
rem        cmd 加载 .bat 是按当前代码页逐行解析的，混用 65001 会让
rem        中文字符串被吃掉（中文 Windows 默认代码页就是 936，够用）。
rem ============================================================

setlocal
cd /d "%~dp0"
title AI 学习训练助手

echo.
echo ============================================================
echo   AI 学习训练助手（写作 + 体能训练）
echo ============================================================
echo.

rem ---------- 1. 先确认本目录完整 ----------
if not exist "index.html" (
  echo [X] 没找到 index.html，说明这个包不完整。
  echo     请把整个文件夹一起拷贝，不要只拷里面的单个文件。
  echo.
  pause
  exit /b 1
)

rem ---------- 2. 找浏览器（Chrome 优先，退而求其次 Edge） ----------
rem 为什么要自己找：这个应用靠 file:// 打开，但必须带
rem   --allow-file-access-from-files 这个开关，否则 MediaPipe 骨架
rem   和 3D 跟练模型都加载不了（实测）；而直接双击 html 是带不上的。
set "BROWSER="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo [X] 这台电脑上没找到 Chrome 或 Edge 浏览器。
  echo.
  echo     本应用需要用浏览器打开，请先装一个（推荐 Chrome），
  echo     装好之后再双击本文件即可。不需要联网。
  echo.
  pause
  exit /b 1
)

rem ---------- 3. 拼出 file:// 地址 ----------
rem 必须把反斜杠换成正斜杠。直接写 %CD:\=/% 在部分 cmd 版本上不生效，
rem 所以分两步赋值（本项目实测过）。
set "APPDIR=%CD%"
set "APPDIR=%APPDIR:\=/%"
set "URL=file:///%APPDIR%/index.html"

rem ---------- 4. 专用配置档 ----------
rem 用固定目录，好处：草稿/作文/积分/家长密码都留在这台机器上，
rem 且不会被系统清理；换电脑时只要删掉它就能"全新开始"。
set "PROFILE=%LOCALAPPDATA%\WritingCoachChrome"
if not exist "%PROFILE%" mkdir "%PROFILE%" 2>nul

rem ---------- 5. 打开应用 ----------
rem 每个参数都是必须的，别删：
rem   --allow-file-access-from-files     file:// 下能读本地素材（MediaPipe/模型）
rem   --use-fake-ui-for-media-stream     摄像头授权框自动放行，孩子不用点
rem   --autoplay-policy=...              人声口令不需要先点一下页面才响
rem   --user-data-dir=...                存档目录（见上）
rem
rem *** 必须写成一行，不要用 ^ 换行！***
rem   cmd 的续行符 ^ 后面只要跟了**缩进空白**，续行就断了：cmd 在 ^ 处结束本行，
rem   下一行被当成**新命令**去执行 —— 于是报
rem       '--user-data-dir' 不是内部或外部命令
rem   应用看着"点了没反应"。本项目实测复现过（见 memory/PITFALLS.md）。
rem   要换行就只能让后续行**顶格**（行首零空白），但一行更省事、更不会错。
set "FLAGS=--user-data-dir="%PROFILE%" --allow-file-access-from-files --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --disable-search-engine-choice-screen"
echo 正在打开应用，请稍候...
start "" "%BROWSER%" %FLAGS% "%URL%"

echo.
echo ============================================================
echo   已打开。第一次使用请注意：
echo     * 浏览器问「是否允许使用摄像头」时，点「允许」
echo     * 若 Windows 提示「已保护你的电脑」，点「更多信息」再点「仍要运行」
echo     * 体能训练需要摄像头；写作模块不需要
echo ============================================================
echo.

rem ---------- 6. 可选：Astra 深度服务 ----------
rem 深度是**可选增强项**：主链路是彩色画面上的骨架识别，不读深度。
rem 只有插了 ORBBEC Astra Pro 且想用「离摄像头多远」提示才需要。
rem 检查端口要在**块外**先用普通 if 判断，避免 ( ) 块内读 %VAR% 读到旧值
rem —— 这是本项目踩过的经典坑（cmd 整块先解析后执行）。
set "PY="
where pythonw.exe >nul 2>nul
if not errorlevel 1 set "PY=pythonw"
if not defined PY (
  where python.exe >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

set "BRIDGE_RUNNING="
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 set "BRIDGE_RUNNING=1"

if defined BRIDGE_RUNNING (
  echo [OK] 深度服务已在运行。
) else (
  if defined PY (
    if exist "%~dp0tools\orbbec\openni-bridge.py" (
      echo 正在尝试启动深度服务（可选，失败也不影响使用）...
      start "Astra 深度服务" /min pythonw "%~dp0tools\orbbec\openni-bridge.py" --res 640x480 --fps 15
      rem 桥需要 Python 的 websockets 包；缺了会立刻退出且**你没有机会看到原因**
      rem （pythonw 不弹窗）。所以这里主动探测一次，缺了就明确告诉用户怎么装。
      python -c "import websockets" >nul 2>nul
      if errorlevel 1 (
        echo.
        echo [注意] 本机 Python 缺 websockets 包，深度服务起不来。
        echo        想用深度测距的话，按 Win+R 输入 cmd 回车，执行：
        echo            pip install websockets
        echo        不装也完全不影响：体感跟练用的是摄像头画面，不依赖深度。
      )
    ) else (
      echo [提示] 本包不含深度服务，体感功能不受影响。
    )
  ) else (
    echo [提示] 本机没装 Python，跳过深度服务。体感功能不受影响。
  )
)

echo.
echo 本窗口 8 秒后自动关闭。
ping -n 9 127.0.0.1 >nul

endlocal
exit /b 0
"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 提前挑出 GBK 编不出的字符：要在写盘前就报错，不要静默损坏
    bad = sorted({ch for ch in BAT if ch not in "\r\n" and _unencodable(ch)})
    if bad:
        print("[X] 下面这些字符 GBK 编不出来，会损坏 .bat：")
        for ch in bad:
            print("      %r  U+%04X" % (ch, ord(ch)))
        return 1

    with io.open(OUT, "w", encoding="gbk", newline="\r\n") as f:
        f.write(BAT)
    size = os.path.getsize(OUT)
    print("已生成：%s  (%d 字节, GBK/CRLF)" % (OUT, size))

    # 回读自证：确认没有 BOM、没有 UTF-8 残留
    raw = open(OUT, "rb").read()
    if raw[:3] == b"\xef\xbb\xbf":
        print("[X] 生成结果带 BOM，cmd 可能报错")
        return 1
    try:
        raw.decode("gbk")
    except UnicodeDecodeError as e:
        print("[X] 生成结果不是合法 GBK：%s" % e)
        return 1
    print("回读自证：无 BOM、GBK 解码通过")
    return 0


def _unencodable(ch):
    try:
        ch.encode("gbk")
        return False
    except UnicodeEncodeError:
        return True


if __name__ == "__main__":
    raise SystemExit(main())
