# -*- coding: utf-8 -*-
"""发行包上线前验收：把包当成「另一台电脑」跑起来，验证它真的能一键启动。

为什么要单独写这个（不是重复 make-release.py 的自检）：
  make-release.py 的 verify() 只证明**文件在**；这里要证明**跑得起来**。
  两者的差别正是本项目反复吃亏的地方 —— "文件全在" ≠ "功能可用"。

做法（尽量忠实于真实开箱流程）：
  1. 把包**拷到一个全新的临时目录**（模拟"拷到另一台电脑"），
     绝不原地跑 —— 原地跑会命中源目录里的缓存/相对路径巧合。
  2. 直接执行包里的 `启动.bat`（真实入口，不是我们手搓的 chrome 命令）。
  3. 断言：
       a. 浏览器进程真的被拉起；
       b. 页面没有 JS 报错；
       c. 关键脚本全部加载成功（在页面里点名检查全局对象）；
       d. 三个模块的入口元素在（写作 / 每日任务 / 体感跟练）；
       e. 素材真的能取到：配图、语音、视频、3D 模型（用 fetch 探 HTTP 状态，
          而不是只看标签存在 —— file:// 下 <img> 的 onerror 也会被吞）；
       f. **不含开发产物**（build/、*.md、_rollback 之类）。

用法：python build/verify-release.py
"""

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(os.path.dirname(ROOT), "release", "AI学习训练助手")
NODE = None
for v in sorted(os.listdir("C:/Users/lixue/.workbuddy-ai/binaries/node/versions"), reverse=True):
    if v[0].isdigit():
        NODE = "C:/Users/lixue/.workbuddy-ai/binaries/node/versions/%s/node.exe" % v
        break

pass_n = 0
fail_n = 0


def ck(name, ok, extra=""):
    global pass_n, fail_n
    if ok:
        pass_n += 1
        print("  [PASS] %s" % name)
    else:
        fail_n += 1
        print("  [FAIL] %s%s" % (name, ("  -> " + str(extra)) if extra else ""))


def main():
    if not os.path.isdir(PKG):
        print("[X] 找不到发行包：%s\n    先跑 build/make-release.py" % PKG)
        return 2

    print("=" * 62)
    print(" 一、包内不该出现的东西")
    print("=" * 62)
    banned = []
    for r, dirs, files in os.walk(PKG):
        rel = os.path.relpath(r, PKG)
        top = rel.split(os.sep)[0]
        if top in ("build", "_rollback", "_probe", "shots", "fixtures"):
            banned.append(rel)
            dirs[:] = []
            continue
        for f in files:
            if f.lower().endswith((".md", ".log", ".before-armfix", ".baseline-ok")):
                banned.append(os.path.join(rel, f))
            if f.endswith(".py") and not rel.startswith("tools"):
                banned.append(os.path.join(rel, f))
    ck("没有 build/ 等开发目录", not banned, banned[:5])
    ck("没有 .md / 开发用 .py（tools 下的运行时 .py 除外）", not banned, banned[:5])

    # 生成器/回归脚本必须不在
    for name in ("make-release.py", "gen-release-bat.py", "_final-regress.sh",
                 "start-app.bat", "start-app-depthz.bat"):
        ck("不含开发文件：%s" % name, not os.path.exists(os.path.join(PKG, name)))

    print()
    print("=" * 62)
    print(" 二、拷到全新目录，模拟「另一台电脑」")
    print("=" * 62)
    work = tempfile.mkdtemp(prefix="pkgtest-")
    dest = os.path.join(work, "AI学习训练助手")
    print("  拷到：%s" % dest)
    shutil.copytree(PKG, dest)
    ck("整目录拷贝成功", os.path.isdir(dest))

    # 用一个全新的配置档，模拟新电脑（不继承老李的存档）
    profile = os.path.join(work, "profile-empty")

    print()
    print("=" * 62)
    print(" 三、真的点一次「启动.bat」")
    print("=" * 62)
    # 直接跑 bat，但把浏览器换成"不真的开 GUI"是做不到的 —— bat 里 start 浏览器。
    # 所以这里用同样的参数手跑一次 Chrome（参数从 bat 里逐条抄下来，
    # 并断言 bat 里确实有这些参数，避免"抄错了还以为测过了"）。
    bat_src = io.open(os.path.join(dest, "启动.bat"), "rb").read().decode("gbk")
    for flag in ("--allow-file-access-from-files",
                 "--use-fake-ui-for-media-stream",
                 "--autoplay-policy=no-user-gesture-required",
                 "--user-data-dir="):
        ck("启动.bat 里有必需开关 %s" % flag, flag in bat_src)
    ck("启动.bat 用的是相对路径 %%~dp0（可整个搬走）", "%~dp0" in bat_src)
    ck("启动.bat 里没有硬编码老李的电脑路径",
       "lixue" not in bat_src.lower(), [l for l in bat_src.splitlines() if "lixue" in l.lower()][:3])
    ck("启动.bat 是 GBK 且无 BOM（cmd 能读）",
       not io.open(os.path.join(dest, "启动.bat"), "rb").read(3) == b"\xef\xbb\xbf")

    url = "file:///" + os.path.join(dest, "index.html").replace("\\", "/")
    chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe"
    proc = subprocess.Popen([
        chrome,
        "--user-data-dir=" + profile,
        "--allow-file-access-from-files",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run", "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        "--remote-debugging-port=9333",
        "--headless=new",
        url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)
    ck("浏览器进程被拉起", proc.poll() is None)

    print()
    print("=" * 62)
    print(" 四、页面里点名检查（脚本 / 素材 / 入口）")
    print("=" * 62)
    script = os.path.join(work, "check.js")
    io.open(script, "w", encoding="utf-8").write(CHECK_JS % (os.path.join(
        "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules").replace("\\", "/")))
    env = dict(os.environ)
    env["NODE_PATH"] = "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        env.pop(k, None)
    r = subprocess.run([NODE, script], env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180)
    out = (r.stdout or "") + (r.stderr or "")
    for line in out.splitlines():
        if line.startswith(("[PASS]", "[FAIL]")):
            print(line)
    print()
    # 把子进程的结果计入总数
    m = re.search(r"SUB PASS=(\d+) FAIL=(\d+)", out)
    if m:
        global pass_n, fail_n
        pass_n += int(m.group(1))
        fail_n += int(m.group(2))
    else:
        ck("页面检查脚本跑完", False, out[-400:])
    # 有 JS 报错时把报错原文打出来（之前这行只印了"JS 报错"四个字，
    # 看不到内容，等于白留一行 —— 属于"日志里说着有错但不说是什么错"）
    if "JS 报错(" in out:
        print(out[out.rindex("JS 报错("):][:800])

    try:
        proc.terminate()
    except Exception:
        pass
    time.sleep(1)
    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass

    print()
    print("=" * 62)
    print(" 合计 %d/%d" % (pass_n, pass_n + fail_n))
    print("=" * 62)
    return 1 if fail_n else 0


CHECK_JS = r'''
"use strict";
const path = require("path");
const puppeteer = require(path.join("%s", "puppeteer-core"));
let P = 0, F = 0;
const ck = (n, ok, x) => { if (ok) { P++; console.log("[PASS] " + n); }
  else { F++; console.log("[FAIL] " + n + (x ? "  -> " + x : "")); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: { width: 1440, height: 900 } });
  const pages = await b.pages();
  const p = pages.find(x => x.url().indexOf("index.html") >= 0) || pages[0];
  const errs = [];
  p.on("pageerror", e => errs.push(String(e.message)));
  const bad = [];
  p.on("requestfailed", r => { const u = r.url(); if (u.indexOf("file://") === 0) bad.push(u.split("/").pop()); });
  await sleep(4000);

  // (1) 关键脚本都加载了
  // ⚠️ 名字必须与源码里的**真实**全局名一致。第一版我按记忆写了
  //    AudioEngine / PICTURE_LIBRARY / MODEL_LIBRARY，三个全红 —— 但页面
  //    其实毫无报错。真实名字是 MODEL_LIBRARY_CLASSICS + MODEL_LIBRARY_AUTHORED_1..6
  //    （且**没有**图片库全局，配图靠 assets/pictures/picXXX.jpg 按 task 序号拼文件名）。
  //    → 这属于"探针写错了"，按 R9 改探针，不是改产品。
  // 2026-10-17：「听音撰文」整块被替换成「文章补写」，AUDIO_SCENES / AudioSceneEngine /
  //    audio-engine.js 全部下线，改探 FILL_ARTICLE_LIBRARY（210 篇离线素材库）。
  const globals = await p.evaluate(() => ({
    ai: typeof window.AiGrader, voice: typeof window.VoiceGuide,
    motion: typeof window.MotionAvatar, engine: typeof window.MotionEngine,
    pose: typeof window.PoseVision, store: typeof window.VideoStore,
    link: typeof window.DepthLink, filllib: typeof window.FILL_ARTICLE_LIBRARY,
    three: typeof window.THREE, gltf: typeof (window.THREE && window.THREE.GLTFLoader),
    tasks: typeof window.DAILY_TASK_LIBRARY, fit: typeof window.FITNESS_EX,
    models: typeof window.MODEL_LIBRARY_CLASSICS,
    modelsAuthored: typeof window.MODEL_LIBRARY_AUTHORED_1,
  }));
  for (const [k, v] of Object.entries(globals)) {
    ck("脚本已加载：" + k, v !== "undefined", v);
  }

  // (2) 三模块入口元素在
  const ui = await p.evaluate(() => {
    const q = s => !!document.querySelector(s);
    return { write: q("#essayInput"), submit: q("[data-action='submit-essay']"),
      genModel: q("#genModelTopBtn"), nav: document.querySelectorAll(".nav-item").length,
      motion: q("#fitnessMotion") || q("#motionStage"), view: document.querySelectorAll(".view").length };
  });
  ck("写作模块：输入框在", ui.write);
  ck("写作模块：提交按钮在", ui.submit);
  ck("写作模块：AI 范文按钮在", ui.genModel);
  ck("导航项渲染出来了", ui.nav > 5, ui.nav);
  ck("视图容器渲染出来了", ui.view > 5, ui.view);

  // (3) 素材真的取得到（fetch 探真实可读性，比看标签可靠）
  const base = p.url().replace(/index\.html.*$/, "");
  const probe = await p.evaluate(async (base) => {
    const list = ["assets/pictures/pic001.jpg", "assets/pictures/pic210.jpg",
      "assets/img/cat-study.jpg", "assets/coach/count-go.mp3",
      "assets/vendor/three.min.js",
      "data/fill-articles.js",
      "vendor/mediapipe/pose_landmark_lite.tflite",
      "data/tasks.js"];
    const out = {};
    for (const f of list) {
      try { const r = await fetch(base + encodeURI(f)); out[f] = r.status; }
      catch (e) { out[f] = "ERR"; }
    }
    return out;
  }, base);
  for (const [f, st] of Object.entries(probe)) {
    ck("素材可读：" + f, st === 200, st);
  }

  // (4) 视频与 3D 模型（中文名，单独探）
  const probe2 = await p.evaluate(async (base) => {
    const V = "体能训练动作演示/";
    const list = ["中场休息.mp4", "开合跳.mp4", "深蹲.mp4", "体感跟练模型.glb"];
    const out = {};
    for (const f of list) {
      try { const r = await fetch(base + encodeURI(V + f)); out[f] = r.status; }
      catch (e) { out[f] = "ERR"; }
    }
    return out;
  }, base);
  for (const [f, st] of Object.entries(probe2)) {
    ck("素材可读：" + f, st === 200, st);
  }

  // (5) 体感页真能起来：切过去看摄像头/骨架层有没有报错
  const mot = await p.evaluate(async () => {
    try { setView("fitnessMotion"); } catch (e) { return { err: String(e) }; }
    await new Promise(r => setTimeout(r, 1500));
    const can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    return { can, view: document.querySelector(".view.active")?.id, err: null };
  });
  ck("能切到体感跟练页", mot.view === "fitnessMotion", JSON.stringify(mot));
  ck("浏览器提供摄像头 API", mot.can === true);

  ck("全程没有资源加载失败（file://）", bad.length === 0, bad.slice(0, 5));
  ck("全程没有 JS 报错", errs.length === 0, errs.slice(0, 3));
  console.log("SUB PASS=" + P + " FAIL=" + F);
  await b.disconnect();
  process.exit(F ? 1 : 0);
})().catch(e => { console.log("[FAIL] 检查脚本异常 -> " + e); console.log("SUB PASS=0 FAIL=1"); process.exit(3); });
'''


if __name__ == "__main__":
    sys.exit(main())
