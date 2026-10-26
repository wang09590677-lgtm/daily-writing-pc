// 看引擎最终"选中那一块"的掩码（personMask = keepRoot 像素）。
// 用来定性 D2（张臂被切）。引擎已加诊断字段 depthDebug().maskBeforePick。
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
      "--user-data-dir=" + path.join(__dirname, "probe-mask-" + process.pid),
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

    async function show(label, grids, n) {
      await feed(grids, n || 6);
      const r = await page.evaluate(() => {
        const dbg = motionEngine.depthDebug();
        const sk = motionEngine.getSkeleton();
        return { chosen: dbg && dbg.chosen, ascii: dbg && dbg.midMask, has: sk.has, bbox: sk.bbox || null };
      });
      console.log("\n########## " + label + " ##########");
      console.log("  选中 t=" + r.chosen + "  has=" + r.has + " bbox=" +
        (r.bbox ? r.bbox.w.toFixed(3) + "x" + r.bbox.h.toFixed(3) : "--"));
      if (r.ascii) {
        console.log("  —— 引擎最终选中块（#=人）——");
        r.ascii.forEach((s, i) => { if (s.includes("#")) console.log(String(i).padStart(3) + " " + s); });
      } else {
        console.log("  (无 personMask —— 深度路径未走到选带)");
      }
    }

    await show("空房间基准", new Array(22).fill(real.bg), 22);
    const poses = {};
    for (const p of real.poses) {
      await show(p.name, p.frames.slice(0, 15).map(f => f.grid), 15);
      poses[p.name] = p.frames[0].grid;
    }
    /* 人出现后再看"预热基线"用的帧：确认基线是空房建的。 */
    const sti = await page.evaluate(() => motionEngine.structureInfo());
    console.log("\n结构基线最终状态:", JSON.stringify(sti));
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
