// 决定性验证：引擎的「张臂检查」在**任何**姿态下都不可能通过吗？
//
// 已确认的事实：
//   · motion-engine.js 的 JOINTS 表里 wristL/wristR 定义在 u=0.42（从头顶往下 42%）
//   · evaluatePose() 的手臂检查 = bandAt(0.42).split
//   · u=0.42 是**手臂自然下垂**时手腕所在的高度
//
// 待验证的假设：
//   H1 手臂自然下垂时，手腕确实在 u=0.42，但垂下的手臂与躯干相连 → split=false → 提示"张开一点"
//   H2 手臂侧平举（T-pose）时，手腕跑到 u≈0.20（肩膀高度）→ 引擎还在 u=0.42 看 → 那里是躯干 → split=false → **依然提示"张开一点"**
//   H3 只有当手臂恰好**斜下举到 u=0.42 且横向离开躯干**时，split 才可能为真
//
// 验证法：让手臂始终处于水平伸出状态（保证远离躯干是分开的），只**上下平移手臂高度**，
//   扫 u（从头顶往下） = 0.14 → 0.62，看 checks.arms 在哪个高度区间能变成 1。
//   如果只有很窄的一段能通过 → H3 成立，说明"张开双手"的引导语是个陷阱。
//
// 环境变量：D=3000  U=0.14,0.20,0.26,...,0.62
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
  // uFromTop：手臂中心线在"从头顶往下"的归一化高度（0=头顶，1=脚底）
  const armY = s.uFromTop === undefined ? ph * 0.58 : ph * (1 - s.uFromTop);
  const armT = s.armT === undefined ? 220 : s.armT;   // 用粗手臂保证不被"空列"判据切掉
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
      "--user-data-dir=" + path.join(__dirname, "probe-profile-armu-" + process.pid),
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
  const th2 = Math.tan(58.4 * Math.PI / 360);
  const viewW = 2 * D * th2;
  console.log(`距离 ${D}mm，人高 ${PH}mm，画面宽 ${viewW.toFixed(0)}mm`);
  console.log(`手臂恒定侧平举（伸到 ±675mm，粗 220mm），只上下平移高度；`);
  console.log(`引擎读的手臂高度固定在 u=0.42（从头顶往下 42%），band 序号 = round(0.42×23) = 10`);
  console.log("");
  console.log("  手臂u | 引擎读的band | 骨架 | bbox宽(格) | 手臂像素到保住了吗 | 手臂分 | 引导语");

  for (const u of (process.env.U || "0.14,0.20,0.26,0.32,0.38,0.42,0.46,0.52,0.58,0.62").split(",").map(Number)) {
    const s = { camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH, arm: 675, armT: 220, uFromTop: u };
    await page.evaluate((d, sc) => { sc.dist = d; window.__buildScene(window.__grid, sc); }, D, s);
    await sleep(950);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      return {
        has: sk.has, bbox: sk.bbox || null,
        wristL: sk.joints.wristL || null, wristR: sk.joints.wristR || null,
        pose: pose ? { arms: pose.checks.arms, guideText: pose.guideText, score: pose.score } : null
      };
    });
    const bwCols = r.bbox ? r.bbox.w * 96 : 0;
    const kept = bwCols > 25 ? "保住(38格)" : `丢了(${bwCols.toFixed(0)}格)`;
    const armBand = Math.round(u * 23);
    const inBand10 = (armBand === 10) ? "  ← 命中!" : "";
    console.log(`  ${u.toFixed(2)}  |   band ${String(armBand).padStart(2)}${inBand10.padEnd(9)} |  ${r.has ? "有" : "无"} |    ${bwCols.toFixed(0).padStart(3)}     | ${kept.padEnd(14)} |  ${r.pose ? r.pose.arms.toFixed(2) : "--"}  | ${r.pose ? r.pose.guideText : ""}`);
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
