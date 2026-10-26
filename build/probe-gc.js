// 读引擎 depthDebug().gc —— 看"张臂抢救"候选的形态与对称性判定
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const real = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));
(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-gc-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
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
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({ available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {} });
    motionEngine.attach(cv); motionEngine.preview();
  });
  await page.evaluate(() => motionEngine.beginRoomScan());
  async function feed(arr, n) {
    for (let i = 0; i < n; i++) {
      const cs = arr[Math.min(i, arr.length - 1)];
      await page.evaluate((cells) => {
        const g = window.__grid; const flat = [];
        for (let y = 0; y < cells.length; y++) { const row = cells[y];
          for (let x = 0; x < row.length; x++) flat.push(row[x] || 0); }
        for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
      }, cs);
      await sleep(170);
    }
  }
  await feed(new Array(20).fill(real.bg), 20);
  for (const p of real.poses) {
    await feed(p.frames.slice(0, 6).map(f => f.grid), 6);
    const r = await page.evaluate(() => {
      const d = motionEngine.depthDebug(), sk = motionEngine.getSkeleton();
      return { gc: d && d.gc, chosen: d && d.chosen, path: d && d.keepPath, split: d && d.keepSplit,
        has: sk.has, bbox: sk.bbox || null };
    });
    console.log(p.name.padEnd(12) + " bbox=" + (r.bbox ? r.bbox.w.toFixed(3) : "--") +
      "  chosen=" + r.chosen + " path=" + r.path + " split=" + r.split);
    console.log("   gc: " + JSON.stringify(r.gc));
  }
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
