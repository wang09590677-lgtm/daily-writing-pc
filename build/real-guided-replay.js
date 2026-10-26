// 用**真人实拍**（语音引导抓的 real-depth-person.json）检验引擎：
//   ① 空房间基准 bg        → 应该"没有人"（幻影人检查）
//   ② arms_down / arms_down2 → 应该"有人"，且窄
//   ③ t_pose                  → 应该"有人"，且明显更宽（张臂被认出来）
//
// 这是本轮的核心验证：之前所有结论都建立在合成人形上，
// 合成数据零空洞、边缘一步跳变，测不出真实条件的问题。
// 用法：
//   node build/real-guided-replay.js
//   FILE=real-depth-person.json node build/real-guided-replay.js
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const FILE = process.env.FILE || "real-depth-person.json";
const dataPath = path.join(ORBBEC, FILE);
if (!fs.existsSync(dataPath)) {
  console.error("找不到：" + dataPath);
  console.error("先双击 tools/orbbec/4-抓取真人数据.bat 抓一份");
  process.exit(1);
}
const real = JSON.parse(fs.readFileSync(dataPath, "utf8"));
if (!real.poses) {
  console.error("这份文件不是引导格式（缺 poses）。请用 real-depth-replay.js");
  process.exit(1);
}
console.log("真人数据：" + FILE);
console.log("  设备 " + real.device + "  采集 " + real.capturedAt);
console.log("  基准 " + JSON.stringify(real.baseline));
console.log("  摘要 " + JSON.stringify(real.summary));

async function run(browser) {
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

  async function feed(gridArr, label, note) {
    // 每组的帧依次喂进去（引擎有时间平滑，要连喂几帧才稳定）
    // ⚠️ grid 是二维数组（72 行 × 96 列），必须 flatten 成一维再写进
    //    Float32Array —— 直接 g[i]=cells[i] 会把数组塞进去变成 NaN，
    //    引擎拿到的全 0 网格就会一直报"没人"（看起来像"没有幻影人"，
    //    其实是数据根本没喂进去，是假阳性）。
    let last = null;
    for (let i = 0; i < gridArr.length; i++) {
      await page.evaluate((cells) => {
        const g = window.__grid;
        const flat = [];
        for (let y = 0; y < cells.length; y++) {
          const row = cells[y];
          for (let x = 0; x < row.length; x++) flat.push(row[x] || 0);
        }
        for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
      }, gridArr[i]);
      await sleep(180);
      last = await page.evaluate(() => {
        const sk = motionEngine.getSkeleton();
        const pose = motionEngine.getPose();
        const dbg = motionEngine.depthDebug();
        const sti = motionEngine.structureInfo ? motionEngine.structureInfo() : null;
        const g = window.__grid;
        let nz = 0;
        for (let k = 0; k < g.length; k++) if (g[k] > 0) nz++;
        return {
          has: sk.has, bbox: sk.bbox || null, area: sk.area || 0,
          joints: sk.visibleJointCount || 0,
          near: dbg && dbg.chosen ? dbg.chosen : null,
          score: pose ? pose.score : null,
          gridNonZero: nz,
          st: sti,
        };
      });
    }
    console.log("  " + label.padEnd(22) +
      (last.has ? "有人" : "没人") +
      (last.bbox ? "  bbox " + last.bbox.w.toFixed(3) + "x" + last.bbox.h.toFixed(3) : "  bbox --") +
      "  关节 " + last.joints +
      "  面积 " + (last.area * 100).toFixed(1) + "%" +
      "  距离 " + last.near + "  分 " + (last.score == null ? "-" : last.score.toFixed(2)) +
      "  网格非零 " + last.gridNonZero + "/6912" +
      (last.st ? "  结构基线 " + (last.st.ready ? "就绪" : "预热中") +
        " " + last.st.samples + "/" + last.st.warm +
        " 覆盖 " + (last.st.coverage * 100).toFixed(1) + "%" : "") +
      (note ? "   " + note : ""));
    return last;
  }

  console.log("\n--- 1) 空房间基准（应该没人）---");
  /* 预热需要先跑满 ST_WARM_FRAMES，且必须在"人不在画面里"时完成。
   * 真实使用中学生是**走进画面**的，所以预热天然是空房间。 */
  /* 必须先显式开始"房间结构扫描"，且此刻画面里没人。 */
  await page.evaluate(() => motionEngine.beginRoomScan && motionEngine.beginRoomScan());
  const bgFrames = new Array(22).fill(real.bg);
  const rbg = await feed(bgFrames, "empty/bg", "幻影人检查");

  const res = {};
  for (const p of real.poses) {
    console.log("\n--- " + p.name + " : " + (p.label || "") + " ---");
    const grids = p.frames.slice(0, 8).map(f => f.grid);
    res[p.name] = await feed(grids, p.name, "");
  }

  console.log("\n===== 结论 =====");
  const emptyOK = !rbg.has;
  console.log("  空房间误报      : " + (rbg.has ? "❌ 报有人（幻影人）" : "✅ 正确报没人"));
  const wDown = res.arms_down && res.arms_down.bbox ? res.arms_down.bbox.w : 0;
  const wT = res.t_pose && res.t_pose.bbox ? res.t_pose.bbox.w : 0;
  console.log("  arms_down 宽度  : " + wDown.toFixed(3) + "  " + (res.arms_down.has ? "有人" : "❌没人"));
  console.log("  t_pose    宽度  : " + wT.toFixed(3) + "  " + (res.t_pose.has ? "有人" : "❌没人"));
  const ratio = wDown > 0 ? wT / wDown : 0;
  console.log("  T字/垂臂 宽度比 : " + ratio.toFixed(2) + "x");
  const armOK = wT > wDown * 1.25;
  console.log("  张臂是否被认出  : " + (armOK ? "✅ 是（真机数据）" : "❌ 否 —— 真实空洞下张臂仍失效"));
  return { emptyOK, armOK, ratio, wDown, wT };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-guided-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
