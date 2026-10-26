// 特征分离实验：把"空房基准"(负) 与 "三组真人姿势"(正) 喂进引擎，
// dump 每个候选深度带的连通域特征（bw/bh/cx/topY/botY/fill/score），
// 找出能真正把"墙"和"人"分开的特征。**不靠猜，靠数据。**
//
// 用法: node build/band-feature-probe.js
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
      "--user-data-dir=" + path.join(__dirname, "probe-feat-" + process.pid),
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
        const cells = gridArr[Math.min(i, gridArr.length - 1)];
        await page.evaluate((cs) => {
          const g = window.__grid;
          const flat = [];
          for (let y = 0; y < cs.length; y++) {
            const row = cs[y];
            for (let x = 0; x < row.length; x++) flat.push(row[x] || 0);
          }
          for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
        }, cells);
        await sleep(170);
      }
    }

    async function grab() {
      return page.evaluate(() => {
        const dbg = motionEngine.depthDebug();
        const sk = motionEngine.getSkeleton();
        return { dbg, has: sk.has, bbox: sk.bbox || null };
      });
    }

    const rows = [];
    async function probe(label, isPerson, grids) {
      await feed(grids, 6);
      const r = await grab();
      console.log("\n===== " + label + "  (期望" + (isPerson ? "有人" : "没人") + ") =====");
      console.log("  引擎结论: has=" + r.has + "  bbox=" +
        (r.bbox ? r.bbox.w.toFixed(3) + "x" + r.bbox.h.toFixed(3) : "--"));
      if (!r.dbg) { console.log("  (无候选表)"); return; }
      console.log("  选中 t=" + r.dbg.chosen + "   候选数=" + r.dbg.cand);
      console.log("  " + "cand".padEnd(9) + "t".padStart(5) + "hi".padStart(6) +
        "bw".padStart(6) + "bh".padStart(6) + "cx".padStart(6) +
        "topY".padStart(6) + "botY".padStart(6) + "fill".padStart(6) + "score".padStart(7) + "  pick");
      for (const d of r.dbg.diag) {
        if (d.pick !== "合格") {
          console.log("  " + String(d.q).padEnd(9) + String(d.t).padStart(5) + String(d.hi).padStart(6) +
            "  --    --    --    --    --    --     --    " + d.pick +
            (d.bigBw != null ? "  bigBw=" + d.bigBw + " ratio=" + d.bigRatio : ""));
          continue;
        }
        console.log("  " + String(d.q).padEnd(9) + String(d.t).padStart(5) + String(d.hi).padStart(6) +
          String(d.bw).padStart(6) + String(d.bh).padStart(6) +
          String((d.cx != null ? d.cx : 0)).padStart(6) +
          String(d.topY).padStart(6) + String(d.botY).padStart(6) +
          String(d.fill).padStart(6) + String(d.score).padStart(7) +
          "  " + (Math.abs(d.t - r.dbg.chosen) < 1 ? "★选中" : ""));
        rows.push({ label, isPerson, t: d.t, bw: d.bw, bh: d.bh, topY: d.topY, botY: d.botY, fill: d.fill, score: d.score, chosen: Math.abs(d.t - r.dbg.chosen) < 1 });
      }
    }

    await probe("空房间基准", false, [real.bg]);
    for (const p of real.poses) {
      await probe(p.name + " " + (p.label || ""), true, p.frames.slice(0, 6).map(f => f.grid));
    }

    // 汇总：按 topY 分档看能否分离
    console.log("\n\n########## 特征分离汇总 ##########");
    console.log("（真人：头应在画面中部，topY 应明显 > 0；墙/地板带会顶到 topY=0）");
    const buckets = [
      ["负/空房", rows.filter(r => !r.isPerson)],
      ["正/真人", rows.filter(r => r.isPerson)],
    ];
    for (const [name, rs] of buckets) {
      const tops = rs.map(r => r.topY).sort((a, b) => a - b);
      const fills = rs.map(r => r.fill).sort((a, b) => a - b);
      const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
      console.log("  " + name.padEnd(8) + " n=" + String(rs.length).padStart(3) +
        "  topY: min=" + pct(tops, 0).toFixed(2) + " p25=" + pct(tops, .25).toFixed(2) +
        " 中位=" + pct(tops, .5).toFixed(2) + " p75=" + pct(tops, .75).toFixed(2) + " max=" + pct(tops, 1).toFixed(2) +
        "   fill中位=" + pct(fills, .5).toFixed(2));
    }
    // 阈值扫描：用 topY 卡"顶到画面顶"的候选
    console.log("\n  topY 阈值扫描（把 topY < 阈值的候选判为背景→否掉）：");
    for (const th of [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15]) {
      let negKilled = 0, negTot = 0, posKept = 0, posTot = 0;
      for (const r of rows) {
        if (r.isPerson) { posTot++; if (r.topY >= th) posKept++; }
        else { negTot++; if (r.topY < th) negKilled++; }
      }
      console.log("    topY<" + th.toFixed(2) + " → 杀掉背景候选 " + negKilled + "/" + negTot +
        "，保留真人候选 " + posKept + "/" + posTot);
    }
    // 哪些"负"候选是引擎选中的？
    console.log("\n  空房里被引擎『选中』的候选（必须被否掉的那些）：");
    for (const r of rows.filter(x => !x.isPerson && x.chosen)) {
      console.log("    t=" + r.t + " bw=" + r.bw + " bh=" + r.bh + " topY=" + r.topY +
        " botY=" + r.botY + " fill=" + r.fill + " score=" + r.score);
    }
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
