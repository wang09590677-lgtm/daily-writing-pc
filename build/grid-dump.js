// 原始深度网格 dump —— 一锤定音地区分两件事：
//   (1) 造景脚本没把手臂像素写进 grid（测试脚手架问题）
//   (2) 手臂像素在网格里，但被 stripBackgroundRows / depthPersonMask / labelComponents
//       这些**引擎前段**剔除了（引擎问题）
//
// 起因：pose-armspan-test 里 T-pose 与「双臂下垂」的 bbox 逐字段完全相同（都 10 格），
//       说明手臂没进 shapeMask。arm-cut-diag 显示三种姿态逐带宽度也完全一样。
//       要判断责任在谁，必须看**引擎读的原始网格**长什么样。
//
// 做法：SCENE_FN 直接从 pose-armspan-test.js 抠（保证同源，避免手抄造景出错），
//       造景后直接扫 __grid，按"深度 == dist 的像素"统计逐行占宽。
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从正式验收测试里抠 SCENE_FN，保证和被测环境**完全同源**
const src = fs.readFileSync(path.join(__dirname, "pose-armspan-test.js"), "utf8");
const m = src.match(/const SCENE_FN = `([\s\S]*?)`;/);
if (!m) { console.error("抠不到 SCENE_FN"); process.exit(1); }
const SCENE_FN = m[1];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-griddump-" + process.pid),
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
  await page.evaluate(`(function(){ ${SCENE_FN} })();`);
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

  const D = Number(process.env.D || 3000);
  const PH = Number(process.env.PH || 1350);

  async function run(sc, label) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH }, sc);
    await page.evaluate((d, sc2) => { sc2.dist = d; window.__buildScene(window.__grid, sc2); }, D, s);
    await sleep(900);
    // 直接扫原始网格：统计"深度≈D（人）"的像素，逐行给左右边界
    const r = await page.evaluate((d) => {
      const W = 96, H = 72, g = window.__grid;
      const rows = [];
      let near = 0, minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) {
        let mn = W, mx = -1, c = 0;
        for (let x = 0; x < W; x++) {
          const z = g[y * W + x];
          if (z > d - 60 && z < d + 60) { c++; if (x < mn) mn = x; if (x > mx) mx = x; }
        }
        if (c) {
          rows.push({ y, mn, mx, c });
          if (mn < minX) minX = mn; if (mx > maxX) maxX = mx;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          near += c;
        }
      }
      return { near, minX, maxX, minY, maxY, rows };
    }, D);
    const bw = r.maxX >= 0 ? (r.maxX - r.minX + 1) : 0;
    console.log(`\n----- ${label} -----`);
    console.log(`  网格中 人深度(${D}±60mm) 像素数: ${r.near}`);
    console.log(`  人像素 bbox（原始网格）: 列 ${r.minX}~${r.maxX}（宽 ${bw} 格，${(bw / 96 * 100).toFixed(0)}% 画面）行 ${r.minY}~${r.maxY}`);
    // 逐行宽度分布，方便看"手臂那几行有没有变宽"
    const line = r.rows.map(x => `${x.y}:${x.mn}-${x.mx}`).join(" ");
    console.log(`  逐行(行:左-右): ${line}`);
    return bw;
  }

  console.log(`=== 原始网格 dump，距离 ${D}mm，人高 ${PH}mm ===`);
  const a = await run({ arm: 0 }, "双臂自然下垂");
  const b = await run({ arm: 675, uFromTop: 0.20 }, "T-pose（单侧 675mm，臂展 1.35m）");
  const c = await run({ arm: 400, uFromTop: 0.50 }, "斜下举（单侧 400mm）");
  console.log(`\n===== 结论 =====`);
  console.log(`  网格里 bbox 宽：下垂 ${a} 格 / T-pose ${b} 格 / 斜下举 ${c} 格`);
  if (b > a * 1.5) console.log("  → 造景 OK，手臂像素**在网格里**；问题在引擎把它们剔除了");
  else console.log("  → 造景异常，手臂像素**没进网格**；先修测试脚手架，引擎结论待重测");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
