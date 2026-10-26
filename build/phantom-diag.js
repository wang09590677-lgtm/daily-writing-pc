// 定位"真实空房间被判成有人"的成因：把引擎的内部分带/连通域选择过程 dump 出来。
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const FILE = process.env.FILE || "real-depth-person.json";
const real = JSON.parse(fs.readFileSync(path.join(ORBBEC, FILE), "utf8"));

const flatten = cells => {
  const flat = [];
  for (let y = 0; y < cells.length; y++)
    for (let x = 0; x < cells[y].length; x++) flat.push(cells[y][x] || 0);
  return flat;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-phantom-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(async () => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => { c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480); c.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion");
    await motionCamRefresh();
    await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    motionEngine.attachDepth({
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  async function probe(cells, label) {
    const flat = flatten(cells);
    for (let i = 0; i < 6; i++) {
      await page.evaluate((f) => {
        const g = window.__grid;
        for (let k = 0; k < g.length; k++) g[k] = f[k] || 0;
      }, flat);
      await sleep(200);
    }
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const dbg = motionEngine.depthDebug();
      return { has: sk.has, bbox: sk.bbox, area: sk.area, dbg: dbg };
    });
    console.log("\n===== " + label + " =====");
    console.log("  has=" + r.has + "  area=" + (r.area * 100).toFixed(1) + "%" +
      (r.bbox ? "  bbox=" + r.bbox.x.toFixed(3) + "," + r.bbox.y.toFixed(3) +
        " " + r.bbox.w.toFixed(3) + "x" + r.bbox.h.toFixed(3) : ""));
    console.log("  depthDebug keys: " + Object.keys(r.dbg || {}).join(", "));
    console.log("  " + JSON.stringify(r.dbg, null, 1).split("\n").slice(0, 40).join("\n  "));
    return r;
  }

  // 控制组：全 0 网格（相机啥也没看到）必须"没人"
  const zeros = [];
  for (let y = 0; y < 72; y++) { const row = []; for (let x = 0; x < 96; x++) row.push(0); zeros.push(row); }
  await probe(zeros, "控制组：全 0 网格（应没人）");
  await probe(real.bg, "真实空房间基准 bg（应没人）");
  await probe(real.poses[1].frames[0].grid, "真人 T-pose（应有人）");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
