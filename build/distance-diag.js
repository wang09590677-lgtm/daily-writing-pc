// 距离诊断：为什么"站超过 2 米骨架就乱"
//
// 之前的 pose-calib-test 用"人形 + 一面 5 米的墙"当背景，**没有地板**，
// 所以地板把连通域撑坏这条路径一直没被测到。这里按真实几何造场景：
//   相机高度 Hc、垂直视场 45.5°、水平视场 58.4°，
//   地面是按针孔投影算出来的深度斜坡，后墙是一个固定距离的平面，
//   人是一个站在 D 米处的立板（头/躯干/两腿/可选张开的手臂）。
// 然后按距离扫一遍，打印骨架结果与"掩码逐行横向占比"，
// 直接看地板是什么时候跟人的腿连成一整行的。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

const W = 96, H = 72;
const VFOV = 45.5, HFOV = 58.4;

// 按针孔投影生成"地板 + 后墙"的背景深度（mm）
function buildScene(camH, wallMM) {
  const bg = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H - 0.5;                 // >0 = 视线向下
    const tv = Math.tan(v * VFOV * Math.PI / 180);
    let d = wallMM;
    if (tv > 1e-4) d = Math.min(wallMM, camH / tv);  // 地板：Hc / tan(俯角)
    for (let x = 0; x < W; x++) bg[y * W + x] = d;
  }
  return bg;
}

// 把一个人画进深度网格（覆盖背景）
function drawPerson(grid, opt) {
  const o = Object.assign({
    dist: 2500, camH: 1000, height: 1350, shoulder: 340,
    armSpan: 0, thickness: 180, cx: 0.5, legs: true
  }, opt || {});
  const D = o.dist;
  const yFeet = 0, yHead = o.height;
  const legHalf = 0.055 * 1000, legGap = 0.075 * 1000;  // mm
  const torsoHalf = o.shoulder / 2;
  const armHalf = o.armSpan / 2;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H - 0.5;
    const tv = Math.tan(v * VFOV * Math.PI / 180);
    const yw = o.camH - D * tv;                 // 这一行射线在 D 处打到的高度（mm）
    if (yw < yFeet || yw > yHead) continue;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W - 0.5;
      const th = Math.tan(u * HFOV * Math.PI / 180);
      const xw = D * th;                        // 这一列射线在 D 处的横向偏移（mm）
      const ax = Math.abs(xw - (o.cx - 0.5) * 2 * D * Math.tan(HFOV / 2 * Math.PI / 180));
      let half;
      if (yw > yHead - 200) half = 75;                                    // 头
      else if (yw < o.height * 0.42) {                                    // 腿
        if (!o.legs) half = legHalf + legGap;
        else {
          const dL = Math.abs(ax - legGap), dR = Math.abs(ax + legGap);
          if (dL > legHalf && dR > legHalf) continue;                     // 两腿之间的缝
          half = 9999;
        }
      } else half = torsoHalf;                                            // 躯干
      if (yw >= o.height * 0.55 && yw <= o.height * 0.80 && armHalf > 0) half = armHalf; // 张开的手臂
      if (half < 9999 && ax > half) continue;
      grid[y * W + x] = D;
    }
  }
  return grid;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-diag"),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 600));

  // 先用假摄像头把引擎建起来（引擎是「开摄像头」时才创建的）
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

  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    const fake = {
      available: () => true,
      grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    };
    motionEngine.attachDepth(fake);
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  const camH = Number(process.env.CAMH || 1000);
  const wall = Number(process.env.WALL || 4000);

  console.log(`相机高度 ${camH}mm，后墙 ${wall}mm`);
  console.log("距离(mm) | 骨架 | 面积 | bbox(h) | depthNear | 关节数 | 掩码满行数(>55%宽) | 备注");

  for (const dist of [1600, 1900, 2100, 2300, 2500, 2800, 3200, 3600, 4000]) {
    const res = await page.evaluate((dist, camH, wall) => {
      const W = 96, H = 72, VFOV = 45.5, HFOV = 58.4;
      const grid = window.__grid;
      // 背景：地板 + 后墙
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H - 0.5;
        const tv = Math.tan(v * VFOV * Math.PI / 180);
        let d = wall;
        if (tv > 1e-4) d = Math.min(wall, camH / tv);
        for (let x = 0; x < W; x++) grid[y * W + x] = d;
      }
      // 人
      const D = dist, height = 1350, shoulder = 340, camHeight = camH;
      const legHalf = 55, legGap = 75, torsoHalf = shoulder / 2;
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H - 0.5;
        const tv = Math.tan(v * VFOV * Math.PI / 180);
        const yw = camHeight - D * tv;
        if (yw < 0 || yw > height) continue;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W - 0.5;
          const th = Math.tan(u * HFOV * Math.PI / 180);
          const ax = Math.abs(D * th);
          let half;
          if (yw > height - 200) half = 75;
          else if (yw < height * 0.42) {
            const dL = Math.abs(ax - legGap), dR = Math.abs(ax + legGap);
            if (dL > legHalf && dR > legHalf) continue;
            half = 9999;
          } else half = torsoHalf;
          if (half < 9999 && ax > half) continue;
          grid[y * W + x] = D;
        }
      }
      return true;
    }, dist, camH, wall);

    await new Promise(r => setTimeout(r, 900));
    const snap = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const live = motionEngine.getLive();
      const p = motionEngine.getPose();
      const grid = window.__grid;
      // 复算一遍"引擎会看到的人形掩码"：按引擎同样的 [d0, d0+thick] 逻辑估计
      const near = live.depthNear || 0;
      let fullRows = 0, maskRows = 0, rowProfile = [];
      if (near) {
        const t = near, thick = Math.min(900, Math.max(450, t * 0.22));
        for (let y = 0; y < 72; y++) {
          let c = 0;
          for (let x = 0; x < 96; x++) {
            const d = grid[y * 96 + x];
            if (d >= t && d <= t + thick) c++;
          }
          rowProfile.push(Math.round(c / 96 * 100));
          if (c / 96 > 0.55) fullRows++;
          if (c) maskRows++;
        }
      }
      return {
        has: sk.has, area: sk.area || 0, bh: sk.bbox ? +sk.bbox.h.toFixed(3) : 0,
        bw: sk.bbox ? +sk.bbox.w.toFixed(3) : 0,
        near: live.depthNear, joints: sk.visibleJointCount || 0,
        score: p ? p.score : -1, guide: p ? p.guide : "",
        fullRows, maskRows, rowProfile,
        dbg: motionEngine.depthDebug()
      };
    });

    console.log(`${String(dist).padStart(5)} | ${snap.has ? "有" : "无"} | ${(snap.area * 100).toFixed(1)}% | ${snap.bh} | ${snap.near} | ${snap.joints} | ${snap.fullRows}/${snap.maskRows} | ${snap.guide}`);
    if (snap.dbg) {
      console.log("       候选: " + snap.dbg.diag.map(d =>
        `q${d.q}:t=${d.t},hi=${d.hi},r=${d.r}${d.pick !== "合格" ? "→" + d.pick : "→合格"}` +
        (d.bigRatio !== undefined ? `(最大块 ${d.bigBw}×${d.bigBh} 比${d.bigRatio})` : "") +
        (d.bh !== undefined ? `(块 ${d.bw}×${d.bh} 分${d.score})` : "")
      ).join("  |  "));
      console.log(`       选中 t=${snap.dbg.chosen}，候选数=${snap.dbg.cand}`);
    }
    if (dist === 2500 || dist === 3200) {
      console.log("       行占比: " + snap.rowProfile.join(","));
    }
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
