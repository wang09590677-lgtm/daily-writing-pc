// 临时诊断：横板场景切回干净场景后，引擎需要多久收敛？
// 目的：判断 arm-furniture-test 的 E 组 FAIL 是"测试时序假象"还是真引擎问题。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROJ = "D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc";
const INDEX = "file:///" + path.join(PROJ, "index.html").replace(/\\/g, "/");
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
  const armY = s.uFromTop === undefined ? ph * 0.58 : ph * (1 - s.uFromTop);
  const armT = s.armT === undefined ? 120 : s.armT;
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
  if (s.bar) {
    const b = s.bar;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = ray(x, y);
      if (d.dz < 1e-6) continue;
      const t = D / d.dz;
      const wx = t * d.dx, wy = s.camH + t * d.dy;
      if (wx < b.x0 || wx > b.x1) continue;
      if (wy < b.yBot || wy > b.yTop) continue;
      grid[y * W + x] = D;
    }
  }
  return grid;
}
window.__buildScene = buildScene;
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(PROJ, "build", "probe-profile-timing-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => { c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480); c.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(`(function(){ ${SCENE_FN} })();`);
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv); motionEngine.preview();
  });

  const shelf = { x0: -1100, x1: -171, yBot: 980, yTop: 1070 };
  async function shoot(sc, wait) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5 }, sc);
    await page.evaluate((d, sc2) => { sc2.dist = d; window.__buildScene(window.__grid, sc2); }, s.dist, s);
    await sleep(wait);
    return await page.evaluate(() => {
      const sk = motionEngine.getSkeleton(); const pose = motionEngine.getPose();
      return {
        w: sk.bbox ? sk.bbox.w : 0, arms: pose ? pose.checks.arms : null,
        cx: sk.bbox ? sk.bbox.x + sk.bbox.w / 2 : null,
        near: motionEngine.getLive().depthNear
      };
    });
  }

  console.log("序列 A：干净T-pose 直接首帧（无前置）");
  let r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 900);
  console.log(`  A1 干净 T-pose  首帧      w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 1500);
  console.log(`  A2 干净 T-pose  再等1.5s  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);

  console.log("\n序列 B：先一帧「双臂下垂」做前置，再切 T-pose（复刻 arm-furniture-test 组 A 的顺序）");
  r = await shoot({ dist: 3000, arm: 0 }, 900);
  console.log(`  B1 双臂下垂              w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 900);
  console.log(`  B2 紧接 T-pose           w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);

  console.log("\n序列 C：横板 T-pose → 切回干净 T-pose（复刻 arm-furniture-test 组 E 的顺序）");
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20, bar: shelf }, 900);
  console.log(`  C1 横板 T-pose           w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);
  for (const w of [900, 2500]) {
    r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, w);
    console.log(`  C2 切回干净 T-pose 等${String(w).padStart(4)}ms  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);
  }
  console.log("\n序列 D：横板旁「先下垂一帧」再 T-pose");
  r = await shoot({ dist: 3000, arm: 0, bar: shelf }, 900);
  console.log(`  D1 横板+双臂下垂         w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20, bar: shelf }, 900);
  console.log(`  D2 横板+紧接 T-pose      w=${(r.w * 96).toFixed(0)}格 arms=${r.arms} near=${r.near}`);

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
