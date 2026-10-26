// 「张臂的手臂被引擎整块丢掉」精确定位诊断。
//
// 起因：pose-armspan-test.js 实测发现 —— T-pose（双臂侧平举）与「双臂自然下垂」
// 两种人形，引擎算出的 bbox 宽度**一模一样**（0.19/0.15/0.13/0.10/0.08），
// 也就是手臂像素被整块丢弃了。而且 evaluatePose 的 checks.arms 永远是 0.6，
// 引导语永远停在「请把双手张开一点，站直站直」。
//
// 本脚本要回答：
//   Q1 手臂是**在哪一步**被丢掉的？（stripBackgroundRows 背景行剔除 / labelComponents 闸门 / splitByColumnGap 滑窗裁剪）
//   Q2 丢掉手臂后，bandAt(0.42) 的 split 还能不能为真？checks.arms 有没有可能到 1？
//   Q3 每个距离上，引擎眼里 "张臂" 与 "不张臂" 的输入是否等价（bbox 逐字段比对）。
//
// 环境变量：D=3000  ARM=675(张臂单侧mm，0=不张臂)  PH=1350
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
  const armY = s.armY === undefined ? ph * 0.78 : s.armY;   // 手臂中心线高度（从脚算起）
  const armT = s.armT === undefined ? 55 : s.armT;          // 手臂有多粗
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
      "--user-data-dir=" + path.join(__dirname, "probe-profile-armcut-" + process.pid),
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

  async function run(armHalf, label) {
    const s = { camH: 1000, wall: 4000, cx: 0.5, dist: D, ph: PH, arm: armHalf };
    await page.evaluate((d, sc) => { sc.dist = d; window.__buildScene(window.__grid, sc); }, D, s);
    await sleep(1000);
    const r = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      const dbg = motionEngine.depthDebug();
      const raw = sk.bands || [];
      const bands = raw.map((b, i) => b && b.ok
        ? `${i}:L${(b.L * 96).toFixed(0)}-R${(b.R * 96).toFixed(0)}${b.split ? " SPLIT" : ""}`
        : `${i}:空`);
      const i042 = Math.round(0.42 * 23);
      return {
        has: sk.has, bbox: sk.bbox || null, area: sk.area || 0,
        joints: sk.visibleJointCount || 0, bandCount: raw.length,
        arms: {
          wristL: sk.joints.wristL || null, wristR: sk.joints.wristR || null,
          handL: sk.joints.handL || null, handR: sk.joints.handR || null,
          shoulderL: sk.joints.shoulderL || null, elbowL: sk.joints.elbowL || null
        },
        pose: pose ? { score: pose.score, arms: pose.checks.arms, legs: pose.checks.legs, whole: pose.checks.whole, center: pose.checks.center, size: pose.checks.size, guide: pose.guide, guideText: pose.guideText, locked: pose.locked } : null,
        band042: bands[i042] || "(越界)",
        allBands: bands.join(" | "),
        diag: (dbg && dbg.diag ? dbg.diag.filter(d => d.pick === "合格") : []).map(d =>
          `q${d.q} t=${d.t} bw=${d.bw} bh=${d.bh} 分${d.score} ${d.path || ""}/${d.split || ""}`)
      };
    });
    // 算出"画面宽度能容纳的臂展"
    const th2 = Math.tan(58.4 * Math.PI / 360);
    const viewW = 2 * D * th2;
    console.log(`\n----- ${label}（单侧伸 ${armHalf}mm，人的画面宽 ${((armHalf * 2 + 340) / viewW * 100).toFixed(0)}%）-----`);
    console.log(`  骨架:${r.has ? "有" : "无"}  bbox: ${r.bbox ? r.bbox.w.toFixed(3) + "×" + r.bbox.h.toFixed(3) : "—"}  (${r.bbox ? (r.bbox.w * 96).toFixed(0) : "-"}格宽)  面积:${(r.area * 100).toFixed(1)}%  可见关节:${r.joints}`);
    if (r.pose) console.log(`  分数:${r.pose.score}  全身:${r.pose.whole.toFixed(2)} 大小:${r.pose.size.toFixed(2)} 居中:${r.pose.center.toFixed(2)} 腿:${r.pose.legs.toFixed(2)} 手臂:${r.pose.arms.toFixed(2)}  引导:「${r.pose.guideText}」 locked=${r.pose.locked}`);
    console.log(`  带数:${r.bandCount}  0.42处(${Math.round(0.42 * 23)}号): ${r.band042}`);
    const aj = r.arms;
    const f = p => p ? `(${p.x.toFixed(3)},${p.y.toFixed(3)})` : "无";
    console.log(`  手臂关节: 肩L${f(aj.shoulderL)} 肘L${f(aj.elbowL)} 腕L${f(aj.wristL)} 腕R${f(aj.wristR)} 手L${f(aj.handL)} 手R${f(aj.handR)}`);
    if (process.env.ALL) console.log(`  全部带: ${r.allBands}`);
    console.log(`  合格候选: ${r.diag.length ? r.diag.join(" | ") : "(无)"}`);
    console.log(`  画面宽 ${viewW.toFixed(0)}mm （人 1350mm 臂展占 ${(1350 / viewW * 100).toFixed(0)}%）`);
    return r;
  }

  console.log(`=== 距离 ${D}mm，人高 ${PH}mm ===`);
  const a = await run(0, "双臂自然下垂");
  const b = await run(675, "双臂侧平举 T-pose（1.35m 臂展）");
  const c = await run(400, "双臂斜下举（模拟「张开一点」）");

  console.log("\n===== 逐字段比对：张臂 vs 不张臂 =====");
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  console.log(`  bbox 相同? ${eq(a.bbox, b.bbox)}   （${JSON.stringify(a.bbox)}  vs  ${JSON.stringify(b.bbox)}）`);
  console.log(`  关节数相同? ${a.joints === b.joints}  （${a.joints} vs ${b.joints}）`);
  console.log(`  checks.arms 相同? ${a.pose.arms === b.pose.arms} （${a.pose.arms} vs ${b.pose.arms}）`);

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
