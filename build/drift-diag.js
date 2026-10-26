// 「退远了绿块偏到屏幕边上」诊断
//
// 三条待验证的假设：
//   H1 人不在正中（cx≠0.5）时，随着后退，连通域会不会被"推"向画面边缘
//   H2 画面侧边有一个同深度的大物件（柜子/门框/窗帘）时，会不会抢走连通域
//   H3 画布比例 ≠ 容器比例时（canvas 16:9 塞进 4:3 的 object-fit:cover），
//      引擎算出来的 cx 在"孩子实际看到的画面"上会被放大推到边上
//
// 相机按针孔投影建模：位置 (0, camH, 0)，光轴 +Z，可俯仰 pitch。
// 深度值取 z 向距离（与 OpenNI 的 z 深度一致）。
//
// 环境变量：
//   CAMH=1000 PITCH=0 WALL=4000 CANVAS=4:3  D=2500 CX=0.5 BOX=0
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

const env = process.env;
const CAMH = Number(env.CAMH || 1000);
const PITCH = Number(env.PITCH || 0);          // 正 = 镜头向下俯
const WALL = Number(env.WALL || 4000);
const CANVAS = env.CANVAS || "4:3";            // 画布(=彩色摄像头)比例
const CONTAINER = env.CONTAINER || "4:3";      // .motion-screen 的比例
const BOX = Number(env.BOX || 0);              // 1 = 画面左侧放一个同深度的大柜子
const NOPERSON = Number(env.NOPERSON || 0);    // 1 = 不画人（验证"纯家具/空房间"不误报）

const SCENE = {
  camH: CAMH, pitch: PITCH, wall: WALL,
  dist: Number(env.D || 2500),
  cx: Number(env.CX || 0.5),
  box: BOX, noPerson: NOPERSON
};

// 场景生成：直接在页面里跑，和引擎共用 96x72 网格
const SCENE_FN = `
function buildScene(grid, s) {
  const W = 96, H = 72;
  const VFOV = 45.5 * Math.PI / 180, HFOV = 58.4 * Math.PI / 180;
  const tv2 = Math.tan(VFOV / 2), th2 = Math.tan(HFOV / 2);
  const p = s.pitch * Math.PI / 180;
  const cp = Math.cos(p), sp = Math.sin(p);

  // 某像素的射线（世界方向 + 相机位置）
  function ray(x, y) {
    const u = (x + 0.5) / W - 0.5, v = (y + 0.5) / H - 0.5;
    const dx = u * 2 * th2, dy0 = -v * 2 * tv2, dz0 = 1;
    return { dx: dx, dy: dy0 * cp - dz0 * sp, dz: dy0 * sp + dz0 * cp };
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = ray(x, y);
      let z = 0;
      if (d.dz > 1e-6) z = s.wall / d.dz;                  // 后墙
      if (d.dy < -1e-6) {                                  // 地板
        const tf = -s.camH / d.dy;
        const zf = tf * d.dz;
        if (zf > 0 && (z === 0 || zf < z)) z = zf;
      }
      grid[y * W + x] = z > 0 ? z : 0;
    }
  }

  // 人：站在 z = s.dist 的一块立板（NOPERSON=1 时不画，用来验证"画面里没人"不误报）
  const height = 1350, shoulder = 340, legHalf = 55, legGap = 75;
  const D = s.dist;
  const cxW = (s.cx - 0.5) * 2 * D * th2;               // 人的世界横向中心
  if (!s.noPerson)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = ray(x, y);
      if (d.dz < 1e-6) continue;
      const t = D / d.dz;
      if (t <= 0) continue;
      const wx = t * d.dx, wy = s.camH + t * d.dy;
      if (wy < 0 || wy > height) continue;
      const ax = Math.abs(wx - cxW);
      let half;
      if (wy > height - 200) half = 75;
      else if (wy < height * 0.42) {
        const dL = Math.abs(ax - legGap), dR = Math.abs(ax + legGap);
        if (dL > legHalf && dR > legHalf) continue;
        half = 9999;
      } else half = shoulder / 2;
      if (half < 9999 && ax > half) continue;
      grid[y * W + x] = D;
    }
  }

  // 同深度的大柜子：贴在画面左侧
  if (s.box) {
    const D2 = s.dist;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = ray(x, y);
        if (d.dz < 1e-6) continue;
        const t = D2 / d.dz;
        const wx = t * d.dx, wy = s.camH + t * d.dy;
        if (wy < 0 || wy > 1900) continue;                 // 柜子高 1.9m
        if (wx < -1400 || wx > -450) continue;             // 世界横向 [-1.4m, -0.45m]
        grid[y * W + x] = D2;
      }
    }
  }
  return grid;
}
window.__buildScene = buildScene;
`;

// 把引擎算出来的归一化坐标，换算成"孩子实际看到的画面坐标"。
// 注意：CSS 已改成 object-fit: contain —— 画面**完整显示**、周围留黑边，
// 引擎坐标在屏幕上 **1:1 不缩放**（这里原来用 cover 模型换算，会把坐标向外
// 放大，与本轮之后的实现不符，会让证据链失真）。x0/x1/y0/y1 只用来标出画面区，
// 黑边之外是摄像头拍不到的地方。
function toDisplay(nx, ny, ca, ba) {
  let x0 = 0, x1 = 1, y0 = 0, y1 = 1;
  if (ca > ba) { const k = (1 - ba / ca) / 2; x0 = k; x1 = 1 - k; }
  else if (ba > ca) { const k = (1 - ca / ba) / 2; y0 = k; y1 = 1 - k; }
  return { x: nx, y: ny, x0: x0, x1: x1, y0: y0, y1: y1 };
}

function ratio(s) {
  const m = String(s).split(":");
  return Number(m[0]) / Number(m[1]);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-drift-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 600));

  await page.evaluate(async () => {
    const cv0 = document.createElement("canvas");
    cv0.width = 640; cv0.height = 480;
    const c0 = cv0.getContext("2d");
    c0.fillStyle = "#111"; c0.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv0.captureStream(30);
    setInterval(() => { c0.fillStyle = "#111"; c0.fillRect(0, 0, 640, 480); c0.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion");
    await motionCamRefresh();
    await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await new Promise(r => setTimeout(r, 1500));

  await page.evaluate(`(function(){ ${SCENE_FN} })();`);

  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    const fake = {
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    };
    motionEngine.attachDepth(fake);
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  const ca = ratio(CANVAS), ba = ratio(CONTAINER);
  console.log(`相机高 ${CAMH}mm 俯仰 ${PITCH}° 后墙 ${WALL}mm | 画布比例 ${CANVAS} 容器比例 ${CONTAINER}` +
    ` → ${ca > ba ? "左右被裁" : ba > ca ? "上下被裁" : "不裁"}`);
  if (BOX) console.log(`场景：画面左侧 z=${SCENE.dist} 处放了一个同深度大柜子`);
  console.log("");
  console.log("  D(mm) |  cx请求 | 骨架 |  bbox(w×h)   | cx(引擎) | cx(孩子看到) | 面积 | 备注");

  const dists = env.DISTANCES ? env.DISTANCES.split(",").map(Number)
    : [1600, 2000, 2400, 2600, 2800, 3000, 3200, 3600];

  for (const dist of dists) {
    await page.evaluate((dist, s) => {
      s.dist = dist;
      window.__buildScene(window.__grid, s);
    }, dist, SCENE);

    await new Promise(r => setTimeout(r, 900));
    const snap = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const live = motionEngine.getLive();
      return {
        has: sk.has,
        bbox: sk.bbox || null,
        area: sk.area || 0,
        joints: sk.visibleJointCount || 0,
        cx: live.centroidX, cy: live.centroidY,
        near: live.depthNear,
        dbg: motionEngine.depthDebug()
      };
    });

    let bboxStr = "      —      ", cxEng = "  —  ", cxDisp = "   —   ";
    if (snap.bbox) {
      bboxStr = `${snap.bbox.w.toFixed(2)}×${snap.bbox.h.toFixed(2)}`;
      const nx = snap.bbox.x + snap.bbox.w / 2;
      const ny = snap.bbox.y + snap.bbox.h / 2;
      const d = toDisplay(nx, ny, ca, ba);
      cxEng = nx.toFixed(3);
      cxDisp = d.x.toFixed(3) + (d.x < 0 || d.x > 1 ? " ←出画" : d.x < 0.15 || d.x > 0.85 ? " ←贴边" : "");
    }
    console.log(`${String(dist).padStart(6)} | ${String(SCENE.cx).padStart(6)} |  ${snap.has ? "有" : "无"} | ${bboxStr} |  ${cxEng}  | ${cxDisp} | ${(snap.area * 100).toFixed(1)}% |`);

    if (env.VERBOSE && snap.dbg) {
      console.log("        " + snap.dbg.diag.map(d =>
        `q${d.q}:t=${d.t},r=${d.r}${d.pick !== "合格" ? "→" + d.pick : `→合格(${d.bw}×${d.bh} 分${d.score} ${d.path || ""}/${d.split || ""})`}`
      ).join(" | "));
    }
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
