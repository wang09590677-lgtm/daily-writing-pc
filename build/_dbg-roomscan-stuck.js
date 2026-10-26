/* 决定性实验：空房扫描到底卡在哪一步？（真实页面 + 真实深度桥）
 *
 * 用户报：「开启体感摄像头后，总是要先弹出一个对话框显示"我先记一下房间的样子"，
 *          但都是等好久也不结束只能跳过」
 *
 * 已知代码路径：
 *   app.js motionRoomScanMaybeStart()
 *     前提 hasDepth = (motionDepth.stats().status === "open")   ← 只判 WebSocket 连上
 *     → 进 scanning，显示对话框
 *   app.js motionRoomScanTick()  每帧读 motionEngine.roomScanInfo()
 *     → info.ready 才收工；**这里没有任何超时处理**
 *   motion-engine.js structureWarm()
 *     每帧：g = depthLink.grid()；if (!g || g.length !== PIX) return;
 *           若该帧有效格 < PIX*0.05 → 直接 return（不计样本）
 *           只有 stSamples ≥ 12 且 elapsedMs ≥ 2500 才 finalize
 *   ⇒ 只要"拿不到 grid" 或 "有效格一直 <5%"，stSamples 永远 0 → 永久卡住
 *
 * 本脚本同时打三件事，定位卡在哪一层：
 *   ① motionDepth.stats()      —— 深度桥连上了吗
 *   ② depthLink 的 grid 有效格 —— 真有数据吗
 *   ③ roomScanInfo 的 samples/elapsedMs/ready —— 引擎在推进吗
 *
 * 用法：NODE_PATH=... node build/_dbg-roomscan-stuck.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-roomscan-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    defaultViewport: { width: 1100, height: 780 },
    // 用假摄像头占住彩色流（深度桥是独立进程，不受影响）；
    // 这样不必占用真机 Astra 的彩色通道，也能走到"开摄像头 → 校准"这条路上。
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
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 160)); });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => { try { localStorage.removeItem("dailyWritingPcStateV3"); } catch (e) { } });
  await page.reload({ waitUntil: "load" });
  await sleep(1000);

  // 进体感页 + 开摄像头（这会触发校准 + 空房扫描）
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(500);

  // 等深度桥连上（app 会在这一步之后决定弹不弹空房扫描）
  console.log("等深度桥连接…");
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate(() => {
      try { return window.motionDepth && motionDepth.stats ? motionDepth.stats() : null; } catch (e) { return null; }
    });
    if (s && s.status === "open") { console.log("深度桥已连上:", JSON.stringify(s)); break; }
    await sleep(400);
  }

  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(2500);

  console.log("\n=== 每 500ms 采一次，共 24 秒 ===");
  console.log("t(s)".padStart(5) + "  深度桥            grid有效格   扫描阶段   samples/need  elapsedMs  ready  对话框");
  for (let i = 0; i < 48; i++) {
    const s = await page.evaluate(() => {
      const out = {};
      try { out.depth = motionDepth && motionDepth.stats ? motionDepth.stats() : null; } catch (e) { out.depth = null; }
      try {
        // 深度网格的有效格数（引擎内部同一个 grid）
        const g = window.depthLink && depthLink.grid ? depthLink.grid() : null;
        out.gridLen = g ? g.length : 0;
        out.gridValid = g ? g.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) : 0;
      } catch (e) { out.gridLen = -1; out.gridValid = -1; }
      try { out.info = motionEngine && motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null; } catch (e) { out.info = null; }
      try { out.phase = roomScan ? roomScan.phase : null; } catch (e) { out.phase = null; }
      // 诊断：超时闸到底卡在哪一步
      try {
        out.now = Date.now(); out.perf = Math.round(performance.now()); out.waited = roomScan.startedAt ? (Date.now() - roomScan.startedAt) : null;
        out.timer = roomScan.timer;
        out.depthDead = !!roomScan.depthDead;
        out.noFrames = !!(out.depth && out.depth.status === "open" && !(out.depth.frameIndex > 0));
        out.TIMEOUT = (typeof ROOM_SCAN_NOFRAME_MS !== "undefined") ? ROOM_SCAN_NOFRAME_MS : "未定义";
      } catch (e) { out.waited = "ERR:" + e.message; }
      const box = document.getElementById("roomScan");
      out.boxShown = box ? !box.classList.contains("hidden") : false;
      const cnt = document.getElementById("roomScanCount");
      out.countText = cnt ? cnt.textContent : null;
      return out;
    });
    const t = ((i * 500) / 1000).toFixed(1);
    const ds = s.depth ? (s.depth.status + (s.depth.info && s.depth.info.device ? "/" + s.depth.info.device : "")) : "null";
    const info = s.info || {};
    console.log(
      String(t).padStart(5) + "  " + String(ds).padEnd(16) +
      String(s.gridValid + "/" + s.gridLen).padEnd(12) +
      String(s.phase).padEnd(10) +
      String((info.samples || 0) + "/" + (info.need || "?")).padEnd(13) +
      String(info.elapsedMs == null ? "-" : info.elapsedMs).padEnd(10) +
      String(info.ready == null ? "-" : info.ready).padEnd(7) +
      (s.boxShown ? "显示中 " : "已收起") + "「" + (s.countText || "") + "」" +
      "  waited=" + s.waited + " now=" + s.now + " perf=" + s.perf + " timer=" + s.timer + " dead=" + s.depthDead
    );
    if (i === 30) break;   // 15 秒够判断了
  }

  console.log("\n=== 补充信息 ===");
  const extra = await page.evaluate(() => {
    const out = {};
    try { out.depthFull = JSON.stringify(motionDepth.stats()); } catch (e) { out.depthFull = null; }
    try { out.roomScan = JSON.stringify(roomScan); } catch (e) { out.roomScan = null; }
    return out;
  });
  console.log("motionDepth.stats() =", extra.depthFull);
  console.log("roomScan 状态 =", extra.roomScan);

  checkVerdict();

  function checkVerdict() { }
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
