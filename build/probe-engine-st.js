// 直接读引擎里的结构基线数组，核对"为什么某一格被剔"
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const real = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-st2-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  try {
    await page.goto(INDEX, { waitUntil: "domcontentloaded" });
    await sleep(700);
    await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = 640; cv.height = 480;
      const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
      window.__fakeStream = cv.captureStream(30);
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
    async function feed(gridArr, n) {
      for (let i = 0; i < n; i++) {
        const cs = gridArr[Math.min(i, gridArr.length - 1)];
        await page.evaluate((cells) => {
          const g = window.__grid;
          const flat = [];
          for (let y = 0; y < cells.length; y++) {
            const row = cells[y];
            for (let x = 0; x < row.length; x++) flat.push(row[x] || 0);
          }
          for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
        }, cs);
        await sleep(170);
      }
    }
    await feed(new Array(20).fill(real.bg), 20);
    await feed(real.poses[1].frames.slice(0, 6).map(f => f.grid), 6);

    const r = await page.evaluate(() => {
      const sti = motionEngine.structureInfo();
      const probes = {};
      for (const [x, y] of [[35,40],[30,40],[45,40],[45,35],[45,44],[45,55],[12,40],[48,20],[48,30]]) {
        probes[x + "," + y] = motionEngine.structureProbe(x, y);
      }
      return { sti, probes };
    });
    console.log("structureInfo:", JSON.stringify(r.sti));
    console.log("格 (x,y) | stOk | 结构基线bg | min | max | 当前dep | 会被剔?");
    for (const k of Object.keys(r.probes)) {
      const p = r.probes[k];
      console.log("  " + k.padEnd(8) + String(p.ok).padStart(4) + String(p.bg).padStart(11) +
        String(p.min).padStart(7) + String(p.max).padStart(7) + String(p.dep).padStart(9) +
        "   " + (p.stripped ? "剔掉" : "保留"));
    }
    console.log("\n对照 Python（同样数据）：35,40 空房3690 T3062 应保留；12,40 空房2721 应剔掉");
  } finally { await browser.close(); }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
