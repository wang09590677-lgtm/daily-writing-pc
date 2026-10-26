// 用「带状宽度比」判「双手是否张开」——定阈值用的实测扫描。
//
// 背景：原来用 bandAt(0.42).split（该带内左右是否被空隙分开）判双手张开。
// 但 T-pose 时左臂-肩-躯干-肩-右臂是**连续**的，没有间隙 → split 永远 false
// → checks.arms 永远是 0.6 → 引导语"请把双手张开一点"永远挂着（97 分也挂着）。
//
// 正确判据应该是"某条带明显比躯干宽"。本脚本打印每个姿态下逐带的
// 宽度（R-L，单位：画面宽百分比），用来定"臂带宽 / 躯带宽"的阈值。
//
// 环境变量：D=3000  PH=1350
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCENE_FN = `
function buildScene(grid, s) {
  const W = 96, H = 72;
  const tv2 = Math.tan(45.5 * Math.PI / 360), th2 = Math.tan(58.4 * Math.PI / 360);
  function ray(x, y) {
    const u = (x + 0.5) / W - 0.5, v = (y + 0.5) / H - 0.5;
    return { dx: u * 2 * th2, dy: -v * 2 * tv2, dz: 1 };
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    let z = s.wall / d.dz;
    if (d.dy < -1e-6) { const zf = (-s.camH / d.dy) * d.dz; if (zf > 0 && zf < z) z = zf; }
    grid[y * W + x] = z > 0 ? z : 0;
  }
  const ph = s.ph || 1350, shoulder = 340, legHalf = 55, legGap = 75, D = s.dist;
  const armHalf = s.arm || 0;
  // uFromTop：手臂中心线在"从头顶往下"的归一化高度
  const armY = s.uFromTop === undefined ? ph * 0.58 : ph * (1 - s.uFromTop);
  const armT = s.armT === undefined ? 120 : s.armT;   // 真实儿童上臂直径约 80~120mm
  const headT = Math.min(200, ph * 0.15);
  const legTop = ph * 0.42;
  const cxW = (s.cx - 0.5) * 2 * D * th2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    const t = D / d.dz;
    if (!(t > 0)) continue;
    const wx = t * d.dx, wy = s.camH + t * d.dy;
    if (wy < 0 || wy > ph) continue;
    const ax = Math.abs(wx - cxW);
    let inside = false;
    if (wy > ph - headT) inside = ax <= 75;
    else if (wy < legTop) inside = !(Math.abs(ax - legGap) > legHalf && Math.abs(ax + legGap) > legHalf);
    else if (ax <= shoulder / 2) inside = true;
    if (!inside && armHalf > 0 && ax <= armHalf && Math.abs(wy - armY) <= armT / 2) inside = true;
    if (inside) grid[y * W + x] = D;
  }
  return grid;
}
window.__buildScene = buildScene;
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-bandw-" + process.pid),
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
  const cases = [
    { name: "双臂自然下垂(对照)", arm: 0 },
    { name: "双臂斜下举 45°(伸400mm)", arm: 400, uFromTop: 0.50 },
    { name: "双臂斜下举(伸550mm)", arm: 550, uFromTop: 0.44 },
    { name: "双臂侧平举 T-pose(伸675mm)", arm: 675, uFromTop: 0.20 },
    { name: "双臂上举 V 形(伸300mm)", arm: 300, uFromTop: 0.08 }
  ];

  for (const cs of cases) {
    const s = { camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH, arm: cs.arm, uFromTop: cs.uFromTop };
    await page.evaluate((d, sc) => { sc.dist = d; window.__buildScene(window.__grid, sc); }, D, s);
    await sleep(950);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      return {
        has: sk.has, bbox: sk.bbox || null,
        bands: (sk.bands || []).map(b => b.ok ? { w: b.R - b.L, sp: b.split, e: b.energy } : null),
        arms: pose ? pose.checks.arms : null,
        wrists: pose ? { wl: !!sk.joints.wristL, wr: !!sk.joints.wristR, hl: !!sk.joints.handL, hr: !!sk.joints.handR } : null
      };
    });
    console.log(`\n== ${cs.name} ==`);
    if (!r.has) { console.log("   丢人"); continue; }
    console.log(`   bbox宽 ${(r.bbox.w * 100).toFixed(1)}%  手臂分 ${r.arms}  腕/手关节: ${JSON.stringify(r.wrists)}`);
    const w = r.bands.filter(Boolean).map(b => b.w * 100);
    const maxW = Math.max(...w);
    const medW = w[w.length - 1]; // 末带≈脚
    console.log(`   逐带宽度(%) u=0.00→1.00: ${w.map((x, i) => i + ":" + x.toFixed(0)).join(" ")}`);
    console.log(`   最大带 ${maxW.toFixed(1)}%  最宽/窄带比 ≈ ${(maxW / Math.max(1, medW)).toFixed(2)}`);
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
