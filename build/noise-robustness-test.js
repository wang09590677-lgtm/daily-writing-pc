// 噪声注入回归：把**真实相机实测的劣化特性**注入合成人形，看张臂识别是否还成立。
//
// 为什么必须做这个：
//   之前所有体感调试都喂"理想合成人形"——整具身体赋同一个精确深度值、
//   零空洞、边缘一步跳变。实测真实 Astra Pro（空房间 30 帧平均）：
//     · 深度空洞率 14~19%
//     · 同一表面相邻格仍有中位 10mm / p90 136mm 的差
//     · 边缘渐变 + 飞点（最大相邻差 5632mm）
//     · 单帧出现 300+ 个不同深度值（合成只用 1~3 个）
//   → 合成测试只能验证「算法逻辑对不对」，验证不了「真实条件下参数够不够」。
//   本脚本按真实统计量注入噪声，把这条鸿沟量出来。
//
// 噪声模型（参数都来自真实实测）：
//   ① 空洞 holeRate：按"局部梯度越大越容易空洞"分布（边缘更易丢数据）
//   ② 抖动 jitterMM：人体表面高斯抖动（σ = jitterMM），真实是几十~上百 mm
//   ③ 飞点 flyRate：少量前景格出现离谱深度（多路径反射）
//   ④ 逐帧重随机：噪声每帧都变（真实深度是时变的），而不是冻结一份噪声
//
// 用法：
//   node build/noise-robustness-test.js
//   HOLE=0.05,0.10,0.15,0.20 JIT=0,15,30,60 node build/noise-robustness-test.js
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// SCENE_FN 与正式验收测试**同源抠取**，避免手抄失真
const src = fs.readFileSync(path.join(__dirname, "pose-armspan-test.js"), "utf8");
const m = src.match(/const SCENE_FN = `([\s\S]*?)`;/);
if (!m) { console.error("抠不到 SCENE_FN"); process.exit(1); }
const SCENE_FN = m[1];

// 与造景同源：把噪声层也写成可注入的字符串
const NOISE_FN = `
window.__mulberry32 = function (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};
// 以 seed 为准生成一份噪声，叠加到 __baseGrid 上写入 __grid
window.__applyNoise = function (opt) {
  var W = 96, H = 72, base = window.__baseGrid, g = window.__grid;
  var rnd = window.__mulberry32(opt.seed | 0);
  var D = opt.dist;
  // 先把基础网格拷过去
  for (var i = 0; i < W * H; i++) g[i] = base[i];

  // 找前景（= D 的那些格）与局部梯度
  var isFg = new Uint8Array(W * H);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    if (base[y * W + x] === D) isFg[y * W + x] = 1;
  }
  var grad = new Float32Array(W * H);
  for (var y2 = 1; y2 < H - 1; y2++) for (var x2 = 1; x2 < W - 1; x2++) {
    var c = base[y2 * W + x2];
    var dx = Math.abs(base[y2 * W + x2 + 1] - c);
    var dy = Math.abs(base[(y2 + 1) * W + x2] - c);
    grad[y2 * W + x2] = Math.min(1, (dx + dy) / 800);
  }

  // ① 抖动 + ④ 逐帧变化：只加在前景（人的身体）上
  var sigma = opt.jitter;
  if (sigma > 0) {
    for (var i2 = 0; i2 < W * H; i2++) {
      if (!isFg[i2]) continue;
      // Box-Muller 近似：两个均匀数求和够用
      var u = rnd() + rnd() + rnd() + rnd() - 2;
      g[i2] = D + u * sigma;
    }
  }

  // ③ 飞点：少量前景格出现离谱深度
  if (opt.fly > 0) {
    for (var i3 = 0; i3 < W * H; i3++) {
      if (!isFg[i3]) continue;
      if (rnd() < opt.fly) g[i3] = D * (0.6 + rnd() * 0.7);
    }
  }

  // ② 空洞：边缘更容易丢。人身上也丢（真实数据人体内部也有空洞）
  if (opt.hole > 0) {
    for (var i4 = 0; i4 < W * H; i4++) {
      // 只让前景和它附近受影响，背景保持（模拟"人挡住的区域丢数据"）
      var inBody = isFg[i4];
      if (!inBody) continue;
      var p = opt.hole * (1 + grad[i4] * 3);
      if (rnd() < p) g[i4] = 0;
    }
  }

  // ⑤ 【可选】空洞填充：把"被空洞咬掉、但邻域有前景"的格用邻域中值填回。
  //    这是用来做 A/B 对照的诊断开关 —— 若开启后张臂识别恢复，
  //    就证明"失效的根因是空洞丢像素"，而不是判据本身错。
  if (opt.fill) {
    var out = new Float32Array(g);
    for (var y3 = 1; y3 < H - 1; y3++) for (var x3 = 1; x3 < W - 1; x3++) {
      var ii = y3 * W + x3;
      if (g[ii] > 0) continue;              // 已有数据不动
      // 3x3 里数有几个"接近 D"的前景邻居
      var nb = [], near = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var v2 = g[(y3 + dy) * W + (x3 + dx)];
        if (v2 > 0 && Math.abs(v2 - D) < 600) { nb.push(v2); near++; }
      }
      if (near >= (opt.fill === "strict" ? 5 : 3)) {
        nb.sort(function (a, b) { return a - b; });
        out[ii] = nb[nb.length >> 1];       // 邻域中值
      }
    }
    for (var i5 = 0; i5 < W * H; i5++) g[i5] = out[i5];
  }
};
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-noise-" + process.pid),
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
  await page.evaluate(`(function(){ ${NOISE_FN} })();`);
  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    window.__baseGrid = new Float32Array(96 * 72);
    window.__grid = new Float32Array(96 * 72);
    motionEngine.attachDepth({
      available: () => true, grid: () => window.__grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  const D = Number(process.env.D || 3000);
  const PH = Number(process.env.PH || 1350);
  const holes = (process.env.HOLE || "0,0.05,0.10,0.15,0.20").split(",").map(Number);
  const jits = (process.env.JIT || "0,15,30,60").split(",").map(Number);
  const FLY = Number(process.env.FLY || 0.005);
  const FILL = process.env.FILL === '1' || process.env.FILL === 'strict' ? (process.env.FILL === 'strict' ? 'strict' : true) : false;

  // 逐帧重随机：用定时器持续把新的噪声写进 __grid（模拟真实时变噪声）
  async function startNoise(opt) {
    await page.evaluate((o) => {
      if (window.__noiseTimer) { clearInterval(window.__noiseTimer); window.__noiseTimer = null; }
      window.__noiseSeed = 1;
      window.__noiseOpt = o;
      window.__noiseTimer = setInterval(() => {
        window.__noiseOpt.seed = (window.__noiseSeed = (window.__noiseSeed * 1103515245 + 12345) & 0x7fffffff);
        window.__applyNoise(window.__noiseOpt);
      }, 66);
    }, opt);
  }
  async function stopNoise() {
    await page.evaluate(() => {
      if (window.__noiseTimer) { clearInterval(window.__noiseTimer); window.__noiseTimer = null; }
    });
  }

  async function shoot(sc, arm) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH }, sc);
    // 先建无噪基础网格，再开噪声
    await stopNoise();
    await page.evaluate((d, sc2) => {
      sc2.dist = d;
      window.__buildScene(window.__baseGrid, sc2);
    }, D, s);
    await startNoise({ hole: sc.hole || 0, jitter: sc.jitter || 0, fly: FLY, dist: D, seed: 1, fill: sc.fill || false });
    await sleep(1100);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      return {
        has: sk.has, bbox: sk.bbox || null,
        arms: pose ? pose.checks.arms : null,
        guide: pose ? pose.guideText : "",
        joints: sk.visibleJointCount || 0,
      };
    });
    await stopNoise();
    return r;
  }

  const th2 = Math.tan(58.4 * Math.PI / 360);
  const viewW = 2 * D * th2;
  const expectW = 1350 / viewW;
  const downW = 340 / viewW;   // 垂臂时躯干宽

  console.log(`距离 ${D}mm，画面宽 ${viewW.toFixed(0)}mm`);
  console.log(`理论：T-pose 宽 ${(expectW * 100).toFixed(1)}%（${(expectW * 96).toFixed(0)} 格）／垂臂宽 ${(downW * 100).toFixed(1)}%（${(downW * 96).toFixed(0)} 格）`);
  console.log(`飞点率 ${FLY}，噪声逐帧变化（66ms 重随机）`);
  console.log("");
  console.log(" 空洞率 | 抖动mm | 姿态   | 有人 | bbox宽(格) | arms | 引导语");
  console.log(" -------|--------|--------|------|------------|------|--------");

  let total = 0, okArms = 0, lostPerson = 0;
  for (const hole of holes) {
    for (const jitter of jits) {
      const down = await shoot({ hole, jitter, arm: 0, fill: FILL });
      const tp = await shoot({ hole, jitter, arm: 675, uFromTop: 0.20, fill: FILL });
      total += 2;
      if (tp.arms === 1) okArms++;
      if (!down.has || !tp.has) lostPerson++;
      const fmt = r => ` ${r.has ? "是" : "否"} |    ${r.bbox ? (r.bbox.w * 96).toFixed(0).padStart(3) : " — "}     |  ${r.arms === null ? "—" : r.arms.toFixed(2)} | ${r.guide}`;
      console.log(`  ${String(hole).padEnd(6)} | ${String(jitter).padStart(5)}  | 下垂   |${fmt(down)}`);
      console.log(`  ${String(hole).padEnd(6)} | ${String(jitter).padStart(5)}  | T-pose |${fmt(tp)}`);
    }
  }

  console.log("");
  console.log("===== 鲁棒性小结 =====");
  console.log(`  无噪声（空洞0/抖动0）时 T-pose arms=1 是基线；共测 ${total} 个组合`);
  console.log(`  T-pose 认出张臂的组合数：${okArms} / ${holes.length * jits.length}`);
  console.log(`  丢人（下垂或 T-pose 认不出人）的组合数：${lostPerson} / ${holes.length * jits.length}`);
  console.log("");
  console.log("  真实相机实测区间：空洞率 14~19%，抖动（同表面）中位 10mm / p90 136mm");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
