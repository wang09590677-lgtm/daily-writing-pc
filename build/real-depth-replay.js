// 把**真实相机**录下来的深度网格喂给引擎，看它怎么判。
//
// 为什么要这个：之前所有体感调试都喂"合成人形"——几何精确、边缘锐利一步跳变、
// 零深度空洞、零量化噪声。用户质疑：没有真人参照物调出来的东西必然不对。
// 本脚本是第一份**真实数据**回归：用 openni 抓的真实 96x72 网格（实拍空房间），
// 看引擎会不会报"幻影人"（画面里没人却说有人）。
//
// 用法：
//   node build/real-depth-replay.js                       # 默认读 real-depth-empty.json
//   FILE=real-depth-person.json node build/real-depth-replay.js
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const FILE = process.env.FILE || "real-depth-empty.json";
const dataPath = path.join(ORBBEC, FILE);
if (!fs.existsSync(dataPath)) {
  console.error("找不到真实数据：" + dataPath);
  console.error("先在 tools/orbbec 下跑：python capture-real-depth.py --tag empty");
  process.exit(1);
}
const real = JSON.parse(fs.readFileSync(dataPath, "utf8"));
console.log("真实数据：" + FILE);
console.log("  设备 " + real.device + "  源分辨率 " + real.srcW + "x" + real.srcH);
console.log("  采集时间 " + real.capturedAt + "  帧数 " + real.frames.length);
console.log("  统计 " + JSON.stringify(real.stats));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-realdepth-" + process.pid),
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

  let phantom = 0, frames = 0;
  const rows = [];
  for (const fr of real.frames) {
    // ⚠️ grid 是二维数组（72 行 × 96 列），必须 flatten 成一维再写进
    //    Float32Array。直接 g[i]=cells[i] 会把数组塞进去变成 NaN，
    //    整张网格全 0 → 引擎必然报"没人"，于是"0 幻影人"是假阳性。
    //    本脚本第一版就踩了这个坑，加了 gridNonZero 自证数据真的喂进去了。
    await page.evaluate((cells) => {
      const g = window.__grid;
      const flat = [];
      for (let y = 0; y < cells.length; y++) {
        const row = cells[y];
        for (let x = 0; x < row.length; x++) flat.push(row[x] || 0);
      }
      for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
    }, fr.grid);
    await sleep(750);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      const dbg = motionEngine.depthDebug();
      const g = window.__grid;
      let nz = 0;
      for (let k = 0; k < g.length; k++) if (g[k] > 0) nz++;
      return {
        has: sk.has, bbox: sk.bbox || null,
        area: sk.area || 0, joints: sk.visibleJointCount || 0,
        near: dbg && dbg.chosen ? dbg.chosen : null,
        score: pose ? pose.score : null,
        guide: pose ? pose.guideText : "",
        gridNonZero: nz,
      };
    });
    frames++;
    if (r.has) phantom++;
    rows.push(r);
    console.log(`  帧 ${String(frames).padStart(2)}  有人=${r.has ? "【是】" : "否 "}  ` +
      (r.bbox ? `bbox ${r.bbox.w.toFixed(3)}×${r.bbox.h.toFixed(3)} ` : "bbox —  ") +
      `关节 ${r.joints}  面积 ${(r.area * 100).toFixed(1)}%  ` +
      `选定距离 ${r.near}  分 ${r.score}  网格非零 ${r.gridNonZero}`);
  }

  const allEmpty = rows.every(r => r.gridNonZero === 0);
  console.log(`\n===== 结论 =====`);
  if (allEmpty) {
    console.log("  ❌ 数据根本没喂进去（网格非零=0）—— 结论无效，先修 flatten");
  } else {
    console.log(`  真实空房间场景：${frames} 帧里 ${phantom} 帧报"有人"`);
    if (phantom === 0) {
      console.log("  ✅ 没有幻影人 —— 引擎在真实数据上不误报");
    } else {
      console.log(`  ❌ 幻影人率 ${(phantom / frames * 100).toFixed(0)}% —— 合成数据测不出这个问题`);
    }
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
