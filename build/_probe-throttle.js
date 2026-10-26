// 定性 accept-real-room 的 3/9 失败：到底是"代码回归"还是"页面被 Chrome 节流"。
//
// 背景：空房扫描的就绪闸门是
//   if (stSamples >= ST_WARM_FRAMES && elapsedMs >= ST_MIN_SCAN_MS) structureFinalize();
//   其中 elapsedMs = performance.now() - stStartedAtMs
// 本项目已知（踩坑 #24）：puppeteer 下这个页面被 Chrome 重度节流，
// performance.now() 5 秒只涨 10ms → elapsedMs 永远到不了阈值 → ready=false、coverage=0。
//
// 启动序列**照抄** accept-real-room.js 的 boot()（少一步 motionEngine 就是 null）。
// 本探针不改任何产品代码，只量三个事实：
//   1) 页面里 performance.now() 在整段喂帧期间涨了多少（真实经过约 3400ms）
//   2) 这段时间 rAF 回调触发了几次
//   3) 喂完帧之后 roomScanInfo() 的实际读数
// 判据：若 (1) 的涨幅远小于真实经过时间，即坐实是节流，与产品代码无关。

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const empty = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-empty.json"), "utf8"));
const emptyGrids = empty.frames.map(f => f.grid);
const FEED_FRAMES = 20;
const FEED_GAP = 170;

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-probe-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--no-proxy-server",
      "--user-data-dir=" + profileDir,
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);

  // ↓↓↓ 与 accept-real-room.js 的 boot() 完全一致
  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({ available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {} });
    motionEngine.attach(cv); motionEngine.preview();
  });
  // ↑↑↑

  // rAF 计数器 + 页面内时钟起点
  await page.evaluate(() => {
    window.__raf = 0; window.__t0 = performance.now();
    const tick = () => { window.__raf++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => motionEngine.beginRoomScan());

  for (let i = 0; i < FEED_FRAMES; i++) {
    const cells = emptyGrids[Math.min(i, emptyGrids.length - 1)];
    await page.evaluate((g2) => {
      const g = window.__grid; let k = 0;
      for (let y = 0; y < g2.length; y++) { const row = g2[y];
        for (let x = 0; x < row.length; x++) { g[k++] = row[x] || 0; } }
    }, cells);
    await sleep(FEED_GAP);
  }

  const r = await page.evaluate(() => ({
    rafCount: window.__raf,
    perfAdvanceMs: Math.round(performance.now() - window.__t0),
    info: motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null
  }));

  const realMs = FEED_FRAMES * FEED_GAP;
  console.log("喂帧期间（Node 侧真实经过约 " + realMs + " ms）：");
  console.log("  页面内 performance.now() 涨幅 = " + r.perfAdvanceMs + " ms");
  console.log("  rAF 回调触发次数             = " + r.rafCount);
  console.log("  roomScanInfo                 = " + JSON.stringify(r.info));
  console.log("");

  const throttled = r.perfAdvanceMs < realMs * 0.5;
  if (throttled) {
    console.log("★ 判定：页面被重度节流（performance.now 涨幅 = 真实经过时间的 "
      + (100 * r.perfAdvanceMs / realMs).toFixed(1) + "%）。");
    console.log("  空房扫描的 elapsedMs 闸门必然到不了 → coverage=0 / ready=false 是环境导致，");
    console.log("  与本轮改动无关（本轮一行都没碰 motion-engine.js 的空房扫描路径）。");
  } else {
    console.log("★ 判定：页面时钟正常推进 → coverage=0 另有原因，不是节流，需要继续查。");
  }

  await browser.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
