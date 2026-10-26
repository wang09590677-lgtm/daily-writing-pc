// 逐步探查：是在哪一步之后结构基线被清掉的。
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
      "--user-data-dir=" + path.join(__dirname, "probe-trace-" + process.pid),
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
    const info = async (tag) => {
      const r = await page.evaluate(() => {
        let me = null;
        try { me = motionEngine; } catch (e) { me = null; }
        if (!me) return { none: true };
        const s = me.structureInfo();
        return s;
      });
      if (r.none) { console.log("  " + tag.padEnd(28) + "(motionEngine 还没创建)"); return r; }
      console.log("  " + tag.padEnd(28) + "ready=" + r.ready + " samples=" + r.samples +
        " gen=" + r.gen + " linkAvail=" + r.linkAvail + " cov=" + (r.coverage * 100).toFixed(1));
      return r;
    };

    await info("goto+refresh 之后");
    await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
    await sleep(1500);
    await info("点开摄像头之后");

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
    await info("attach 之后");

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
    await info("空房喂 20 帧后");
    await feed(real.poses[0].frames.slice(0, 4).map(f => f.grid), 4);
    await info("人出现喂 4 帧后");
    await feed(real.poses[1].frames.slice(0, 4).map(f => f.grid), 4);
    await info("再喂张臂 4 帧后");
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
