// 追踪空房扫描为什么 armed 变回 false：beginRoomScan() 之后逐 100ms 采样 roomScanInfo，
// 找出 armed 从 true 翻成 false 的时刻；同时给 attachDepth / roomScanReset 打桩记录调用栈。
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-probe2-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--no-proxy-server", "--user-data-dir=" + profileDir,
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => { const t = m.text(); if (/PROBE/.test(t)) console.log("  [page] " + t); });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);

  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);

  // 打桩：记录 roomScanReset 与 attachDepth 的调用时机 + 调用栈
  const marks = await page.evaluate(() => {
    window.__marks = [];
    const log = (what) => window.__marks.push({ what, t: Math.round(performance.now()), stack: (new Error().stack || "").split("\n").slice(2, 6).join(" | ") });
    const origReset = motionEngine.roomScanReset;
    motionEngine.roomScanReset = function () { log("roomScanReset"); return origReset.apply(this, arguments); };
    const origBegin = motionEngine.beginRoomScan;
    motionEngine.beginRoomScan = function () { const r = origBegin.apply(this, arguments); log("beginRoomScan -> " + r); return r; };
    const origAttachDepth = motionEngine.attachDepth;
    motionEngine.attachDepth = function () { log("attachDepth"); return origAttachDepth.apply(this, arguments); };
    return true;
  });

  // 与验收脚本一致：attachDepth → attach → preview
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({ available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {} });
    motionEngine.attach(cv); motionEngine.preview();
  });

  // beginRoomScan 之后立刻读一次，再逐 100ms 采样 2 秒
  const trace = await page.evaluate(async () => {
    const out = [];
    motionEngine.beginRoomScan();
    out.push({ t: 0, info: motionEngine.roomScanInfo() });
    for (let i = 1; i <= 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      out.push({ t: i * 100, info: motionEngine.roomScanInfo() });
    }
    return out;
  });

  console.log("\n=== beginRoomScan 之后的 armed/samples 轨迹 ===");
  let prev = null;
  for (const s of trace) {
    const key = s.info.armed + "/" + s.info.samples;
    if (key !== prev) {
      console.log("  t=" + String(s.t).padStart(4) + "ms  armed=" + s.info.armed +
        " samples=" + s.info.samples + " ready=" + s.info.ready +
        " elapsedMs=" + s.info.elapsedMs + "  ← 变化");
      prev = key;
    }
  }

  const m = await page.evaluate(() => window.__marks);
  console.log("\n=== 关键调用时序 ===");
  for (const x of m) console.log("  t=" + String(x.t).padStart(5) + "ms  " + x.what + "\n        " + x.stack);

  await browser.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
