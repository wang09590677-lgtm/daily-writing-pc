# -*- coding: utf-8 -*-
"""把「写作 + 体能训练」打包成一个可整目录拷贝、双击即用的发行版。

用法：
    python build/make-release.py                # 输出到 <项目>/../release/AI学习训练助手/
    python build/make-release.py --out D:/xx    # 指定输出目录

设计要点（为什么这么做）：

1) **白名单，不是黑名单**。只拷贝"运行时真正需要"的东西。
   黑名单模式（拷全部再删）在源目录长出新东西时会静默漏删 —— 这是本项目
   反复踩过的坑（"只跑本次 diff 相关"必然漏，见 R8）。

2) **拷贝前对每个文件做"引用可达性"校验**（见 verify_* 一系列函数）。
   `index.html` 引用的每个脚本/样式，以及代码里动态拼出来的资源
   （`assets/pictures/picXXX.jpg`、`assets/coach/*.mp3`、`体能训练动作演示/*.mp4`），
   都必须在包里真的存在 —— 否则新电脑上会表现为"某张图点不动 / 某个动作没视频"，
   而源码这边完全看不出来。**少文件要当场报错，不能等用户发现。**

3) **不拷任何本机状态**：Chrome 专用配置档（`%LOCALAPPDATA%/WritingCoachChrome`）
   里的草稿 / 作文 / 积分 / 家长密码**不进包**。新电脑全新开始。

4) **包内不放 .md / 不放生成器 / 不放回归脚本**。发行包里只有：
   程序 + 素材 + 两个 .bat + 一份纯 ASCII 的 README.txt。
"""

import os
import re
import shutil
import sys
import io
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(os.path.dirname(ROOT), "release")


# ============================================================
#  一、包内容清单（白名单）
# ============================================================

# 根目录的脚本与页面
ROOT_FILES = [
    "index.html",
    "styles.css",
    "app.js",
    "ai-grader.js",
    "coach-timer.js",
    "depth-link.js",
    "motion-avatar.js",
    "motion-engine.js",
    "pose-vision.js",
    "video-store.js",
    "voice-guide.js",
]

# data/ 全量（都是运行时素材库：题库 / 范文库 / 听音场景 / 动作库）
DATA_DIR = "data"

# vendor/ 全量（MediaPipe 的 wasm / tflite 必须整套在一起）
VENDOR_DIR = "vendor"

# assets/ 全量（音频 / 配图 / 语音 / 三件套库 / 图标）
ASSETS_DIR = "assets"

# 体能训练视频：只拷**代码真的会引用**的那些 + 中场休息
VIDEO_DIR = "体能训练动作演示"
VIDEO_KEEP_FILES = [
    "中场休息.mp4",
    "开合跳.mp4",
    "原地高抬腿跑.mp4",
    "原地小步跑.mp4",
    "原地小跑.mp4",
    "跳绳.mp4",
    "平板支撑.mp4",
    "健腹轮.mp4",
    "动态踢腿.mp4",
    "波比跳.mp4",
    "深蹲.mp4",
    "臀桥.mp4",
    "死虫式.mp4",
    "登山跑.mp4",
    "全身拉伸.mp4",
    "大腿后侧拉伸.mp4",
    "小腿拉伸.mp4",
    # ★ 3D 跟练角色模型（不是视频，但就放在这个目录里）
    "体感跟练模型.glb",
]

# 深度（可选增强项）：tools/orbbec 里的**运行时**文件 + OpenNI2 SDK + 7z。
# KEEP 为空字符串表示"整个目录都要"。
TOOLS_KEEP = {
    # 运行时：桥本体 + ctypes 绑定 + OpenNI2 运行库
    "orbbec/openni-bridge.py": 0,
    "orbbec/openni2bind.py": 0,
    "orbbec/start-depth-bridge.bat": 0,
    "orbbec/OpenNI_inner.zip": 0,
    "orbbec/Orbbec_OpenNI_v2.3.0.86-beta6_windows_release.zip": 0,
    # 驱动安装包：换新电脑要能重装驱动，必须带
    "orbbec/astra-win32-driver-4.3.0.22": "",
    "orbbec/astra-win32-driver-4.3.0.22.zip": 0,
    "orbbec/1-install-driver.bat": 0,
    "orbbec/2-verify.bat": 0,
    "orbbec/3-reset-device.bat": 0,
    "orbbec/4-capture-real.bat": 0,
    "orbbec/4-抓取真人数据.bat": 0,
    # OpenNI2 SDK
    "openni": "",
    # 7z（解压 SDK 用）
    "7z": "",
}


# ============================================================
#  二、引用可达性校验
# ============================================================

def html_refs(index_path):
    """从 index.html 抓出所有 href/src（去掉 ?v= 查询串）。"""
    src = io.open(index_path, encoding="utf-8").read()
    refs = re.findall(r'(?:href|src)="([^"]+)"', src)
    out = []
    for r in refs:
        if r.startswith(("http://", "https://", "data:", "#", "mailto:")):
            continue
        out.append(r.split("?")[0])
    return out


def js_string_refs(*js_paths):
    """从 js 里抓"以目录开头"的字符串字面量，用于校验动态拼接的资源。

    ⚠️ 只抓**双引号**字面量，且**排除含 `${...}` 的模板串**：
       `assets/pictures/${imageId}.jpg` 是运行时拼出来的，静态校验看不见，
       硬报"缺文件"就是假阳性。这类动态路径由 verify() 里专门的
       数量对账（(c) 配图、(d) 视频对照表）来覆盖。
    """
    out = set()
    pat = re.compile(r'"((?:assets|data|vendor)/[^"$]*)"')
    for p in js_paths:
        if not os.path.isfile(p):
            continue
        src = io.open(p, encoding="utf-8", errors="replace").read()
        out.update(pat.findall(src))
    return out


def _read_task_lib(path):
    """读 data/tasks.js 里的 window.DAILY_TASK_LIBRARY（文件头有注释，先剥掉）。"""
    src = io.open(path, encoding="utf-8", errors="replace").read()
    i = src.find("=")
    body = src[i + 1:].strip()
    if body.endswith(";"):
        body = body[:-1].strip()
    import json
    return json.loads(body)


def verify(rel_root, problems):
    """出厂自检：引用到的文件必须在包里真的存在。"""
    idx = os.path.join(rel_root, "index.html")

    # (a) index.html 直接引用的每个文件
    for r in html_refs(idx):
        if not os.path.isfile(os.path.join(rel_root, r.replace("/", os.sep))):
            problems.append("index.html 引用了但包里没有：%s" % r)

    # (b) 代码里以 assets/ data/ vendor/ 开头的字面量（逐个文件；目录跳过）
    for r in sorted(js_string_refs(
            os.path.join(rel_root, "app.js"),
            os.path.join(rel_root, "coach-timer.js"),
            os.path.join(rel_root, "voice-guide.js"),
            os.path.join(rel_root, "video-store.js"))):
        fp = os.path.join(rel_root, r.replace("/", os.sep))
        if os.path.isdir(fp):
            continue
        if not os.path.isfile(fp):
            problems.append("代码里引用了但包里没有：%s" % r)

    # (c) 看图编故事的配图：picture 条目数 == picXXX.jpg 数量
    n_pic = -1
    tasks_js = os.path.join(rel_root, "data", "tasks.js")
    if os.path.isfile(tasks_js):
        try:
            n_pic = len(_read_task_lib(tasks_js).get("picture", []))
        except Exception as e:
            problems.append("tasks.js 解析失败：%s" % e)
    pic_dir = os.path.join(rel_root, "assets", "pictures")
    n_img = len([f for f in os.listdir(pic_dir) if f.lower().endswith(".jpg")]) \
        if os.path.isdir(pic_dir) else 0
    if n_pic >= 0 and n_pic != n_img:
        problems.append("看图编故事配图对不上：题目 %d 条，图片 %d 张" % (n_pic, n_img))

    # (d) 体感视频：video-store.js 对照表里的文件必须在
    vs = os.path.join(rel_root, "video-store.js")
    if os.path.isfile(vs):
        src = io.open(vs, encoding="utf-8", errors="replace").read()
        block = re.search(r"BUILTIN_FILES\s*=\s*\{(.*?)\};", src, re.S)
        if not block:
            problems.append("video-store.js 里找不到 BUILTIN_FILES 对照表")
        else:
            for name in re.findall(r':\s*"([^"]+\.mp4)"', block.group(1)):
                fp = os.path.join(rel_root, VIDEO_DIR, name)
                if not os.path.isfile(fp):
                    problems.append("体感视频对照表里有、包里没有：%s" % name)

    # (e) 3D 跟练模型
    glb = os.path.join(rel_root, VIDEO_DIR, "体感跟练模型.glb")
    if not os.path.isfile(glb):
        problems.append("缺 3D 跟练模型：%s/体感跟练模型.glb" % VIDEO_DIR)

    # (f) 启动脚本必须在
    for b in ("启动.bat",):
        if not os.path.isfile(os.path.join(rel_root, b)):
            problems.append("缺启动脚本：%s" % b)

    return n_pic, n_img


# ============================================================
#  三、拷贝
# ============================================================

def copytree(src, dst, skip_names=None):
    """拷贝目录；skip_names 里的名字（文件或目录）整棵跳过。"""
    skip_names = set(skip_names or [])
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in skip_names and d != "__pycache__"]
        rel = os.path.relpath(root, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for f in files:
            if f in skip_names:
                continue
            shutil.copy2(os.path.join(root, f), os.path.join(target, f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="输出根目录，实际会在其下建「AI学习训练助手」")
    ap.add_argument("--name", default="AI学习训练助手")
    args = ap.parse_args()

    rel_root = os.path.join(os.path.abspath(args.out), args.name)
    print("源目录 : %s" % ROOT)
    print("输出   : %s" % rel_root)
    print()

    if os.path.isdir(rel_root):
        shutil.rmtree(rel_root)
    os.makedirs(rel_root)

    # ---- 根文件 ----
    for f in ROOT_FILES:
        s = os.path.join(ROOT, f)
        if not os.path.isfile(s):
            print("[!] 缺根文件：%s" % f)
            return 2
        shutil.copy2(s, os.path.join(rel_root, f))

    # ---- data / vendor / assets ----
    for d in (DATA_DIR, VENDOR_DIR, ASSETS_DIR):
        copytree(os.path.join(ROOT, d), os.path.join(rel_root, d))
        print("  + %-10s (%s)" % (d, "全量"))

    # ---- 视频：白名单 ----
    vdst = os.path.join(rel_root, VIDEO_DIR)
    os.makedirs(vdst, exist_ok=True)
    v_src = os.path.join(ROOT, VIDEO_DIR)
    kept = 0
    for f in VIDEO_KEEP_FILES:
        s = os.path.join(v_src, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(vdst, f))
            kept += 1
        else:
            print("[!] 视频白名单里的文件不存在：%s" % f)
    all_mp4 = len([f for f in os.listdir(v_src) if f.lower().endswith(".mp4")])
    print("  + %-10s (%d/%d 个视频 + 1 个模型)" % (VIDEO_DIR, kept - 1, all_mp4))

    # ---- tools（深度，可选）----
    for rel, mode in TOOLS_KEEP.items():
        s = os.path.join(ROOT, "tools", rel.replace("/", os.sep))
        d = os.path.join(rel_root, "tools", rel.replace("/", os.sep))
        if mode == 0:
            if os.path.isfile(s):
                os.makedirs(os.path.dirname(d), exist_ok=True)
                shutil.copy2(s, d)
            else:
                print("[!] tools 白名单里的文件不存在：%s" % rel)
        else:
            if os.path.isdir(s):
                copytree(s, d)
            else:
                print("[!] tools 白名单里的目录不存在：%s" % rel)
    print("  + %-10s (运行时 + 驱动 + SDK，可选增强)" % "tools")

    # ---- 启动脚本 ----
    shutil.copy2(os.path.join(ROOT, "build", "release-tpl", "启动.bat"),
                 os.path.join(rel_root, "启动.bat"))
    _write_readme(rel_root)

    # ---- 出厂自检 ----
    print()
    problems = []
    n_pic, n_img = verify(rel_root, problems)
    print("自检：")
    print("  index.html 引用 / 代码动态资源 / 配图 %d 张 / 视频对照表 / 模型 / 启动脚本" % n_img)
    if problems:
        print()
        for p in problems:
            print("  [X] %s" % p)
        print()
        print("!! 自检未通过，包不可用 !!")
        return 1
    print("  [OK] 全部可达")

    total = sum(os.path.getsize(os.path.join(r, f))
                for r, _, fs in os.walk(rel_root) for f in fs)
    nfiles = sum(len(fs) for _, _, fs in os.walk(rel_root))
    print()
    print("完成：%s" % rel_root)
    print("      %d 个文件，%.1f MB" % (nfiles, total / 1024.0 / 1024.0))
    return 0


def _write_readme(rel_root):
    """纯 ASCII 的 README，避开 bat 的 GBK / 记事本编码坑（见 PITFALLS）。"""
    txt = """AI Learning & Fitness Trainer  (offline, single PC)
=====================================================

HOW TO START
------------
Double-click  启动.bat   (it is the only entry point you need)

The script will:
  1. find Chrome (or Edge) on this computer
  2. open index.html in a dedicated window, with a private profile
     so your drafts / essays / points stay on this machine
  3. try to start the (optional) Astra depth service on port 8765

REQUIREMENTS
------------
* Windows
* Google Chrome, or Microsoft Edge, installed normally
  (no internet needed; everything is in this folder)

FIRST RUN CAUTIONS (these are normal, not bugs)
-----------------------------------------------
* If Windows shows "Windows protected your PC":
      click "More info" -> "Run anyway"
      (the .bat is a plain text script, but it was not
       downloaded from the internet so Windows cannot verify it)

* If the camera prompt appears: click "Allow".
  The training module needs the camera; the writing module does not.

* If the camera is not detected: close other programs that may be
  using it (video calls, another browser window) and retry.

OPTIONAL: depth / distance measurement
--------------------------------------
Only if you plug in an ORBBEC Astra Pro camera:
  * Install the driver once:
        tools\\orbbec\\1-install-driver.bat
  * Then double-click  tools\\orbbec\\start-depth-bridge.bat
  * Requires Python 3 with the "websockets" package
        pip install websockets
  Everything else keeps working with no depth service running.
  The fitness trainer does NOT need depth at all.

WHAT IS / IS NOT IN THIS FOLDER
-------------------------------
IN : the app, all its artwork / audio / videos, the 3D trainer model,
     the OpenNI2 runtime + Astra driver, and this README.
OUT: development scripts, regression tests, build logs, and
     intermediate artifacts. They are not needed to run the app.

PORTABLE
--------
You may copy this whole folder to a USB stick or another PC.
Nothing is installed into the system (except the optional Astra
driver). The app stores your data inside a Chrome profile in
   %LOCALAPPDATA%\\WritingCoachChrome
so deleting this folder does NOT delete your drafts.

TROUBLESHOOTING
---------------
* Nothing happens after double-click:
      right-click  启动.bat  ->  "Run as administrator"
* Page opens but looks unstyled / broken:
      make sure the whole folder was copied (all subfolders included)
* You want a clean slate:
      delete the folder  %LOCALAPPDATA%\\WritingCoachChrome

--------------------------------------------------
This folder is self-contained. No internet required.
"""
    # 写成 ASCII：编不出来就退化替换，避免 GBK 控制台炸掉（本项目踩过）
    data = txt.encode("ascii", errors="replace")
    with open(os.path.join(rel_root, "README.txt"), "wb") as f:
        f.write(data)


if __name__ == "__main__":
    sys.exit(main())
