// 机制验证：手臂是被"哪一步"丢掉的？
//
// 假设：T-pose 的手臂在画面里是一条**横向很宽、纵向很薄**的条（3m 处厚约 1.4 行）。
//   labelComponents 发现整块宽 40% > 0.22 → 调 splitByColumnGap 切开。
//   splitByColumnGap 候选 A 按"空列"分段，判空列的门槛是
//     minCol = max(round(块高×0.08), round(最高列×0.18))
//   手臂所在列每列只有 1~3 个像素 < minCol → 被当成"空列" → 手腕到手之间被切断，
//   只剩躯干那段（10 格宽）胜出。所以手臂像素在**分带之前**就没了。
//
// 验证法：把手臂加粗（armT 从 55mm 逐渐加到 400mm），让手臂所在列的像素数跨过 minCol。
//   若假设成立 → 手臂会在某个厚度处"突然"被保住，bbox 宽度从 10 格跳到 30+ 格。
//
// 环境变量：D=3000  PH=1350  ARMT=55,110,165,220,300,400
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
  const armY = s.armY === undefined ? ph * 0.78 : s.armY;
  const armT = s.armT === undefined ? 55 : s.armT;
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
      "--user-data-dir=" + path.join(__dirname, "probe-profile-armt-" + process.pid),
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
  const armCols = 675 * 2 / viewW * 96;
  console.log(`距离 ${D}mm，人高 ${PH}mm，画面宽 ${viewW.toFixed(0)}mm`);
  console.log(`手臂从躯干(±170mm)伸到 ±675mm → 画面里横跨 ${armCols.toFixed(0)} 格，人的总宽应约 ${(1350 / viewW * 96).toFixed(0)} 格`);
  console.log("");
  console.log(" armT(mm) | 手臂在画面里几行 | 骨架 | bbox 宽(格) | bbox 高(格) | bh/bw | 分数 | 手臂 | 引导语");

  for (const armT of (process.env.ARMT || "55,110,165,220,300,400").split(",").map(Number)) {
    const s = { camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH, arm: 675, armT: armT };
    await page.evaluate((d, sc) => { sc.dist = d; window.__buildScene(window.__grid, sc); }, D, s);
    await sleep(950);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      const dbg = motionEngine.depthDebug();
      return {
        has: sk.has, bbox: sk.bbox || null,
        arms: { wristL: sk.joints.wristL || null, handL: sk.joints.handL || null, elbowL: sk.joints.elbowL || null },
        pose: pose ? { score: pose.score, arms: pose.checks.arms, guideText: pose.guideText } : null,
        split: (dbg.diag || []).filter(d => d.pick === "合格").map(d => d.split).join(",")
      };
    });
    // 手臂在画面里占几行
    const armRows = (armT / viewW) * 96 * (72 / 96) * (96 / 72); // 近似：行数 = 厚度/画面高*72
    const viewH = 2 * D * Math.tan(45.5 * Math.PI / 360);
    const rows = armT / viewH * 72;
    const bwCols = r.bbox ? (r.bbox.w * 96) : 0;
    console.log(`  ${String(armT).padStart(5)} |        ${rows.toFixed(1)}        |  ${r.has ? "有" : "无"} |     ${bwCols.toFixed(0).padStart(3)}     |     ${r.bbox ? (r.bbox.h * 72).toFixed(0) : "-"}     | ${r.bbox ? (r.bbox.h / r.bbox.w).toFixed(2) : "-"} | ${r.pose ? String(r.pose.score).padStart(3) : "--"} | ${r.pose ? r.pose.arms.toFixed(2) : "--"} | ${r.pose ? r.pose.guideText : ""}   [split=${r.split}]`);
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
