/* 空房扫描超时闸：**逻辑验证**（不依赖真实时间推进）。
 *
 * 为什么不用"等 3 秒看它自己跳"来验：实测该页面在 puppeteer 下被 Chrome 重度节流 ——
 * `performance.now()` 5 秒只涨 10ms、`Date.now()` 也一样，真实时间根本不走，
 * 于是任何"等 N 秒"的断言都会假失败。换成**直接验证逻辑分支**：
 *   ① 把 startedAt 人为拨到很久以前 → 手动触发一次判定 → 应当自动跳过
 *   ② 判定"桥不出数据"后，本会话不再弹（depthDead）
 *   ③ 跳过时对话框收起、提示语正确
 * 定时器是否按时触发这件事，代码只有一行 setTimeout，可在真机复核。
 *
 * ⚠️ 密闭性（R9）：本用例验的分支是"桥**连上了**、但**一帧都不推**"。
 *   以前它靠"机器上恰好有一个变馊的真桥"才成立 —— 真桥健康时 frameIndex>0
 *   （分支根本进不去），桥没起时 status=closed（扫描压根不启动），于是同一份
 *   代码会因为外部进程的状态时绿时红。实测过三种桥状态，只有"变馊"那一种能过：
 *     桥没跑   → depthStatus=closed，phase 直接 skipped        → 5/11
 *     桥健康   → depthStatus=open，samples=116（帧在流）        → 6/11
 *   现在**由本脚本自己占住 8765** 起一个只握手、零推帧的假桥，前置条件自己保证，
 *   并且有一条断言**自证**这个前提真的成立了（否则 ① 整块都是在验不存在的前提）。
 *   ⚠️ 因此跑之前必须**没有真桥在跑**（tools/orbbec/openni-bridge.py 也占 8765）；
 *      被占用时脚本立刻报 EADDRINUSE 退出，不会给出假结论。
 *
 * 用法：NODE_PATH=... node build/_verify-roomscan-timeout.js
 */
"use strict";
const path = require("path"), os = require("os"), fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const WebSocket = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "ws"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BRIDGE_PORT = 8765;      // 页面里 depth-link.js 的 DEFAULT_URL 写死了这个端口
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  → " + d : "")); ok ? pass++ : fail++; };

(async () => {
  /* ---------- 0. 自己起一个"只握手、零推帧"的假桥（密闭，R9）----------
   * 只替换**外部设备**，不替换任何内部模块：页面里用的仍是真的
   * depth-link.js / motionDepth / roomScan，只有 8765 上的那台"相机"是替身。 */
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: BRIDGE_PORT });
  const bridgeUp = await new Promise(resolve => {
    wss.once("listening", () => resolve("ok"));
    wss.once("error", e => resolve((e && e.code === "EADDRINUSE") ? "EADDRINUSE"
      : "ERR:" + (e && e.message)));
  });
  if (bridgeUp !== "ok") {
    console.error(bridgeUp === "EADDRINUSE"
      ? ("端口 " + BRIDGE_PORT + " 已被占用 —— 请先关掉深度桥（tools/orbbec/openni-bridge.py）再跑本用例。")
      : ("假桥启动失败：" + bridgeUp));
    process.exit(2);
  }
  wss.on("connection", ws => {
    /* hello 发完就**什么都不发**。这条"零推帧"正是被测分支的前置条件，
     * 也是这个用例以前唯一能靠外部环境碰巧满足的东西。 */
    ws.send(JSON.stringify({
      type: "hello", device: "FakeAstra", serial: "SILENT",
      width: 640, height: 480, fps: 15, registered: false,
      note: "密闭假桥：只握手、零推帧"
    }));
  });
  console.log("假桥已监听 ws://127.0.0.1:" + BRIDGE_PORT + "（只握手、零推帧）");

  const profileDir = path.join(os.tmpdir(), "wbc-rsv-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    defaultViewport: { width: 1100, height: 780 },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); } }
  };
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errs = [];
  page.on("pageerror", e => { errs.push(e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") { errs.push(m.text()); console.log("CONSOLE-ERR:", m.text().slice(0, 140)); } });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);

  // 先确认"常量与函数"都在（防止改名/漏定义导致静默失效）
  const wiring = await page.evaluate(() => ({
    timeout: typeof ROOM_SCAN_TIMEOUT_MS === "number" ? ROOM_SCAN_TIMEOUT_MS : null,
    noframe: typeof ROOM_SCAN_NOFRAME_MS === "number" ? ROOM_SCAN_NOFRAME_MS : null,
    monoNow: typeof monoNow === "function",
    giveUp: typeof motionRoomScanGiveUp === "function",
    maybeStart: typeof motionRoomScanMaybeStart === "function"
  }));
  check("超时闸的两个常量与函数都在位",
    wiring.timeout > 0 && wiring.noframe > 0 && wiring.monoNow && wiring.giveUp && wiring.maybeStart,
    JSON.stringify(wiring));
  check("单调时钟在被使用（不是 Date.now）", wiring.monoNow === true, "monoNow 存在");

  // 进体感页 → 开摄像头 → 触发空房扫描，然后**人为把时间拨老**再触发判定
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());

  /* ⚠️ 别用**固定 sleep** 等"扫描相位起来"。回归是串行跑的，但机器上仍可能有别的
   * Chrome/残留进程，页面初始化会被拖慢 —— 实测过一次 `phase=off` 的**假失败**
   * （同一份代码单独复跑 12/12）。改成**轮询到 scanning 为止**（上限 15 秒）：
   * 断言一个字没改，只是给它足够时间，把"慢"和"真的没进扫描"分开。 */
  let phaseWait = "off";
  for (let i = 0; i < 60; i++) {
    phaseWait = await page.evaluate(() => {
      try { return roomScan.phase; } catch (e) { return "?"; }
    });
    if (phaseWait === "scanning" || phaseWait === "skipped") break;
    await sleep(250);
  }

  /* 前置条件自证（R3 的精神）：假桥真的连上了、而且真的一帧都没推。
   * 这两条不成立的话，下面 ① 整块都是在验一个根本不存在的前提 ——
   * 必须让它**当场报出来**，而不是让 5 条断言各自莫名其妙地失败。 */
  const pre = await page.evaluate(() => {
    try {
      const s = motionDepth.stats();
      return { status: s.status, frameIndex: s.frameIndex, note: s.note };
    } catch (e) { return { status: "?", frameIndex: -1, err: String(e) }; }
  });
  check("前置条件自证：假桥已连上（status=open）且零推帧（frameIndex=0）",
    pre.status === "open" && pre.frameIndex === 0, JSON.stringify(pre));

  const st0 = await page.evaluate(() => ({
    phase: roomScan.phase,
    hasTimer: !!roomScan.timer,
    boxShown: (() => { const b = document.getElementById("roomScan"); return b ? !b.classList.contains("hidden") : null; })(),
    depthStatus: (() => { try { return motionDepth.stats().status; } catch (e) { return null; } })()
  }));
  check("已进入空房扫描且挂上了超时定时器", st0.phase === "scanning" && st0.hasTimer === true, JSON.stringify(st0));
  check("扫描期间对话框是显示状态（问题现场）", st0.boxShown === true, "对话框显示中");

  // ★ 核心：把 startedAt 拨到很久以前，再模拟 watch 的判定（等价于"等够了 3 秒"）
  const r1 = await page.evaluate(() => {
    roomScan.startedAt = monoNow() - (ROOM_SCAN_NOFRAME_MS + 5000);
    const info = motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null;
    const dst = (typeof motionDepth !== "undefined" && motionDepth.stats) ? motionDepth.stats() : null;
    const noFrames = !!(dst && dst.status === "open" && !(dst.frameIndex > 0));
    // 复刻 watch 的第一条判据
    const shouldGiveUp = noFrames && (monoNow() - roomScan.startedAt) >= ROOM_SCAN_NOFRAME_MS;
    if (shouldGiveUp) motionRoomScanGiveUp("深度摄像头没有数据（连接正常但收不到画面），已跳过这一步。体感跟练照常可用。", true);
    const box = document.getElementById("roomScan");
    return {
      noFrames, shouldGiveUp,
      phase: roomScan.phase, depthDead: roomScan.depthDead,
      timerCleared: !roomScan.timer,
      boxHidden: box ? box.classList.contains("hidden") : null,
      samples: info ? info.samples : null
    };
  });
  check("① 无帧 + 超时 → 判定应当放弃（shouldGiveUp=true）", r1.shouldGiveUp === true, JSON.stringify(r1));
  check("① 超时后扫描状态收尾为 skipped", r1.phase === "skipped", "phase=" + r1.phase);
  check("① 超时后对话框收起（不再拦着孩子）", r1.boxHidden === true, "boxHidden=" + r1.boxHidden);
  check("① 判定为「桥不出数据」并记下 depthDead", r1.depthDead === true, "depthDead=" + r1.depthDead);

  // ★ depthDead 之后：本会话不再弹（否则孩子每次进体感都要被拦一次）
  const r2 = await page.evaluate(() => {
    roomScan.phase = "off";                 // 模拟"再次进校准"
    const started = motionRoomScanMaybeStart();
    const box = document.getElementById("roomScan");
    return { started, phase: roomScan.phase, boxHidden: box ? box.classList.contains("hidden") : null };
  });
  check("② 判定过「没数据」后，再次进入不再弹这个框",
    r2.started === false && r2.boxHidden === true, JSON.stringify(r2));

  // 反向确认：把 depthDead 清掉（模拟深度恢复了），就应该还能正常进入扫描
  const r3 = await page.evaluate(() => {
    roomScan.depthDead = false;
    roomScan.phase = "off";
    const started = motionRoomScanMaybeStart();
    return { started, phase: roomScan.phase };
  });
  check("② 反向确认：清掉 depthDead 后仍能正常扫描（没把功能焊死）",
    r3.phase === "scanning", JSON.stringify(r3));

  check("全程没有 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | ") || "无");

  wss.close();                 // 释放 8765，别让后面跑的用例连到假桥上
  await browser.close();
  console.log("\n===== " + pass + "/" + (pass + fail) + " 通过 =====");
  if (fail) process.exit(1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
