// dump 引擎 depthPersonMask 的候选表 + 最终骨架，定位两个真实数据下的缺陷：
//   ① 空房间为什么被判成"有人"（选了哪个深度带、连通域多大）
//   ② t_pose 为什么只比 arms_down 宽 1.24x（选带是否把手臂切掉了）
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const FILE = process.env.FILE || "real-depth-person.json";
const real = JSON.parse(fs.readFileSync(path.join(ORBBEC, FILE), "utf8"));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-diag-" + process.pid),
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
      const c = cv.getContext("2d");
      c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
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
        const g = gridArr[Math.min(i, gridArr.length - 1)];
        await page.evaluate((cells) => {
          const g = window.__grid;
          const flat = [];
          for (let y = 0; y < cells.length; y++) {
            const row = cells[y];
            for (let x = 0; x < row.length; x++) flat.push(row[x] || 0);
          }
          for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
        }, g);
        await sleep(180);
      }
    }

    async function report(label) {
      const r = await page.evaluate(() => {
        const sk = motionEngine.getSkeleton();
        const dbg = motionEngine.depthDebug();
        return { has: sk.has, bbox: sk.bbox || null, area: sk.area || 0,
          joints: sk.visibleJointCount || 0, dbg };
      });
      console.log("\n########## " + label + " ##########");
      console.log("  has=" + r.has + "  bbox=" +
        (r.bbox ? r.bbox.w.toFixed(3) + "x" + r.bbox.h.toFixed(3) : "--") +
        "  面积=" + (r.area * 100).toFixed(1) + "%  关节=" + r.joints);
      if (r.dbg) {
        console.log("  候选总数 " + r.dbg.cand + "   选中 t=" + r.dbg.chosen);
        console.log("  " + "cand".padEnd(8) + "t".padStart(6) + "hi".padStart(7) + "占比".padStart(7) +
          "  结果");
        for (const d of r.dbg.diag) {
          let tail = "pick=" + d.pick;
          if (d.bw != null) tail += "  bw=" + d.bw + " bh=" + d.bh + " score=" + d.score;
          if (d.bigBw != null) tail += "  bigBw=" + d.bigBw + " bigBh=" + d.bigBh + " ratio=" + d.bigRatio;
          console.log("  " + String(d.q).padEnd(8) + String(d.t).padStart(6) +
            String(d.hi).padStart(7) + String(d.r).padStart(7) + "  " + tail);
        }
      }
    }

    await feed([real.bg], 5);
    await report("空房间基准（应没人）");
    for (const p of real.poses) {
      await feed(p.frames.slice(0, 8).map(f => f.grid), 8);
      await report(p.name + "  " + p.label);
    }
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
