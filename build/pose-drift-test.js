// 回归：孩子往后退时，绿色色块不能漂到画面边上。
//
// 背景（为什么会有这个测试）：
//   孩子在画面里越退越小，而画面侧边同深度的柜子/门框像素数基本不变。
//   老逻辑用 log1p(area) 主导评分，退到两三米时连通域整块跳到侧边家具上，
//   绿块就黏在屏幕边缘。修法是：面积降权 + 竖长/居中/填充率主导 +
//   选中后按列空隙把人从大块里切出来。
//
// 断言：三种场景下，1.6~3.6m 全程都必须认出人，且横向中心保持在画面中央附近。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  → " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  → " + detail : ""}`); }
}

// 针孔投影造景：相机 (0, camH, 0)、光轴 +Z、可俯仰；地板 + 后墙 + 立板人 + 可选侧边柜子
const SCENE_FN = `
function buildScene(grid, s) {
  const W = 96, H = 72;
  const tv2 = Math.tan(45.5 * Math.PI / 360), th2 = Math.tan(58.4 * Math.PI / 360);
  function ray(x, y) {
    const u = (x + 0.5) / W - 0.5, v = (y + 0.5) / H - 0.5;
    const dx = u * 2 * th2, dy0 = -v * 2 * tv2, dz0 = 1;
    return { dx: dx, dy: dy0, dz: dz0 };
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    let z = s.wall / d.dz;
    if (d.dy < -1e-6) {
      const zf = (-s.camH / d.dy) * d.dz;
      if (zf > 0 && zf < z) z = zf;
    }
    grid[y * W + x] = z > 0 ? z : 0;
  }
  const height = 1350, shoulder = 340, legHalf = 55, legGap = 75, D = s.dist;
  const cxW = (s.cx - 0.5) * 2 * D * th2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    const t = D / d.dz;
    if (!(t > 0)) continue;
    const wx = t * d.dx, wy = s.camH + t * d.dy;
    if (wy < 0 || wy > height) continue;
    const ax = Math.abs(wx - cxW);
    let half;
    if (wy > height - 200) half = 75;
    else if (wy < height * 0.42) {
      if (Math.abs(ax - legGap) > legHalf && Math.abs(ax + legGap) > legHalf) continue;
      half = 9999;
    } else half = shoulder / 2;
    if (half < 9999 && ax > half) continue;
    grid[y * W + x] = D;
  }
  if (s.box) {                       // 画面左侧、与人同深度的大柜子
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = ray(x, y);
      const t = s.dist / d.dz;
      const wx = t * d.dx, wy = s.camH + t * d.dy;
      if (wy < 0 || wy > 1900) continue;
      if (wx < -1400 || wx > -450) continue;
      grid[y * W + x] = s.dist;
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
      "--user-data-dir=" + path.join(__dirname, "probe-profile-drift-test-" + process.pid),
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

  const scenarios = [
    { name: "空旷房间·人站正中", s: { camH: 1000, wall: 4000, cx: 0.5, box: 0 }, tol: 0.05 },
    { name: "画面左侧同深度大柜子", s: { camH: 1000, wall: 4000, cx: 0.5, box: 1 }, tol: 0.08 },
    { name: "相机更低(700mm)+侧边柜子", s: { camH: 700, wall: 4000, cx: 0.5, box: 1 }, tol: 0.08 },
    { name: "相机更高(1300mm)+侧边柜子", s: { camH: 1300, wall: 4000, cx: 0.5, box: 1 }, tol: 0.08 },
    { name: "人站偏左 cx=0.35", s: { camH: 1000, wall: 4000, cx: 0.35, box: 0 }, tol: 0.05, expect: 0.35 },
    { name: "人站偏右 cx=0.65", s: { camH: 1000, wall: 4000, cx: 0.65, box: 0 }, tol: 0.05, expect: 0.65 }
  ];
  const dists = [1600, 2000, 2400, 2600, 2800, 3000, 3200, 3600];

  for (const sc of scenarios) {
    console.log(`\n== ${sc.name} ==`);
    const rows = [];
    for (const dist of dists) {
      await page.evaluate((dist, s) => { s.dist = dist; window.__buildScene(window.__grid, s); }, dist, sc.s);
      await sleep(850);
      const snap = await page.evaluate(() => {
        const sk = motionEngine.getSkeleton();
        const live = motionEngine.getLive();
        return { has: sk.has, bbox: sk.bbox || null, near: live.depthNear, cx: live.centroidX };
      });
      const expect = sc.expect !== undefined ? sc.expect : 0.5;
      const cx = snap.bbox ? snap.bbox.x + snap.bbox.w / 2 : null;
      const ok = snap.has && cx !== null && Math.abs(cx - expect) <= sc.tol;
      rows.push(`${dist}:${snap.has ? cx.toFixed(3) : "无"}`);
      check(`${sc.name} / ${dist}mm 认出人且横向居中`, ok,
        snap.has ? `cx=${cx.toFixed(3)}（期望 ${expect}±${sc.tol}）bbox=${snap.bbox.w.toFixed(2)}×${snap.bbox.h.toFixed(2)}` : "没认出人");
    }
    console.log("   " + rows.join("  "));
  }

  await browser.close();
  console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
