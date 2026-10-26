/* 量"修复前后"的绝对判据（在产品文件上跑，不依赖沙盒副本）。
 *
 * 为什么要单独一个脚本：accept-cat-glb.js 的视口是 1280×800，而诊断报告/沙盒的数字
 * 是 1000×720 的 —— layout.H 不同 → 世界单位不同，阈值不能直接照搬。这里就在
 * **验收同款视口**上量：站姿 IK 误差、腿/手幅度、以及"猫渲染出来的上下边界"
 * （用来确认腿拉长后脚没掉出 UI 安全区）。
 *
 * 用法：NODE_PATH=... node build/_dbg-cat-ik-measure.js
 * 通过改 motion-avatar.js 里的 LEG_STRETCH 来对比不同拉伸值（1.00 即等价于修复前）。
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = {
  head: { x: 0.500, y: 0.120 }, neck: { x: 0.500, y: 0.235 },
  shoulderL: { x: 0.430, y: 0.280 }, shoulderR: { x: 0.570, y: 0.280 },
  midL: { x: 0.425, y: 0.330 }, midR: { x: 0.575, y: 0.330 },
  elbowL: { x: 0.420, y: 0.380 }, elbowR: { x: 0.580, y: 0.380 },
  foreL: { x: 0.416, y: 0.425 }, foreR: { x: 0.584, y: 0.425 },
  wristL: { x: 0.414, y: 0.468 }, wristR: { x: 0.586, y: 0.468 },
  handL: { x: 0.413, y: 0.492 }, handR: { x: 0.587, y: 0.492 },
  hipMid: { x: 0.500, y: 0.560 }, hipL: { x: 0.462, y: 0.563 }, hipR: { x: 0.538, y: 0.563 },
  kneeL: { x: 0.460, y: 0.712 }, kneeR: { x: 0.540, y: 0.712 },
  shinL: { x: 0.459, y: 0.800 }, shinR: { x: 0.541, y: 0.800 },
  ankleL: { x: 0.458, y: 0.888 }, ankleR: { x: 0.542, y: 0.888 },
  toeL: { x: 0.458, y: 0.930 }, toeR: { x: 0.542, y: 0.930 }
};
const LEGS_APART = JSON.parse(JSON.stringify(BASE));
Object.assign(LEGS_APART, {
  kneeL: { x: 0.400, y: 0.712 }, kneeR: { x: 0.600, y: 0.712 },
  shinL: { x: 0.360, y: 0.800 }, shinR: { x: 0.640, y: 0.800 },
  ankleL: { x: 0.320, y: 0.888 }, ankleR: { x: 0.680, y: 0.888 },
  toeL: { x: 0.310, y: 0.930 }, toeR: { x: 0.690, y: 0.930 }
});
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-ikmeas-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  if (!sk.ready) { console.log("模型未就绪:", sk.reason); await browser.close(); process.exit(2); }

  const pose = (j) => page.evaluate(({ j, n }) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < n; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    const g = k => { const w = M.__boneWorld(k); return w ? [w.x, w.y, w.z] : null; };
    const gl = document.querySelector("#motionAvatar canvas");
    let bot = null, top = null;
    if (gl) {
      const W = 256, H = 160;
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g2 = cv.getContext("2d"); g2.drawImage(gl, 0, 0, W, H);
      const d = g2.getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++) {
        let cnt = 0;
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 110) cnt++;
        }
        if (cnt >= 2) { if (top === null) top = y; bot = y; }
      }
      // 正交视口世界高 = 1.8（y∈[-0.9,0.9]）→ 屏幕行 → 世界 y
      const toWorld = py => 0.9 - 1.8 * py / H;
      if (top !== null) { const a = toWorld(top), b = toWorld(bot); top = +a.toFixed(4); bot = +b.toFixed(4); }
    }
    return { ik: M.__ikError(), hand: g("RightHand"), handL: g("LeftHand"), foot: g("RightFoot"), footL: g("LeftFoot"),
      knee: g("RightLowerLeg"), layout: M.__layout(), topWorld: top, botWorld: bot,
      snap: M.__poseSnapshot() };
  }, { j, n: 40 });

  const idle = await pose(null);            // 站姿（无识别 → IDLE，用于量渲染上下边界）
  const stand = await pose(BASE);           // 显式站姿（__ikError 需要非空 joints，否则返回 null）
  const apart = await pose(LEGS_APART);     // 并腿→分开

  /* 手臂幅度用三档姿势量（肩→腕目标长度依次 0.27 / 0.27 / 0.32 世界单位）：
   *   · side 侧平举（真人臂长内 0.27，不饱和）→ 幅度只由目标决定，拉伸腿不该影响它；
   *   · over 上举（真人臂长内 0.27，不饱和）→ 同上；
   *   · overExt 上举但超出真人臂长（0.32，接近/超过模型臂可达）→ 饱和档，
   *     整猫缩小会削弱它（这是拉伸腿 + 重排 layout 的真实代价）。
   * 判据：若某档的 wristErr ≈ 0，说明不饱和 → 幅度与模型缩放无关。 */
  const armPose = (mode) => page.evaluate(({ b, mode }) => {
    const o = JSON.parse(JSON.stringify(b));
    if (mode === "side") {
      ["L", "R"].forEach(s => {
        const sx = s === "L" ? -1 : 1;
        o["mid" + s] = { x: 0.5 + sx * 0.10, y: 0.280 };
        o["elbow" + s] = { x: 0.5 + sx * 0.14, y: 0.280 };
        o["fore" + s] = { x: 0.5 + sx * 0.17, y: 0.280 };
        o["wrist" + s] = { x: 0.5 + sx * 0.19, y: 0.280 };
        o["hand" + s] = { x: 0.5 + sx * 0.21, y: 0.280 };
      });
    } else if (mode === "over") {
      ["L", "R"].forEach(s => {
        const sx = s === "L" ? -1 : 1;
        o["mid" + s] = { x: 0.5 + sx * 0.06, y: 0.200 };
        o["elbow" + s] = { x: 0.5 + sx * 0.06, y: 0.150 };
        o["fore" + s] = { x: 0.5 + sx * 0.06, y: 0.110 };
        o["wrist" + s] = { x: 0.5 + sx * 0.06, y: 0.080 };
        o["hand" + s] = { x: 0.5 + sx * 0.06, y: 0.055 };
      });
    } else { // overExt：手再往上顶到接近臂展极限
      ["L", "R"].forEach(s => {
        const sx = s === "L" ? -1 : 1;
        o["mid" + s] = { x: 0.5 + sx * 0.05, y: 0.180 };
        o["elbow" + s] = { x: 0.5 + sx * 0.05, y: 0.110 };
        o["fore" + s] = { x: 0.5 + sx * 0.05, y: 0.060 };
        o["wrist" + s] = { x: 0.5 + sx * 0.05, y: 0.020 };
        o["hand" + s] = { x: 0.5 + sx * 0.05, y: -0.010 };
      });
    }
    for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(o);
    window.MotionAvatar.__renderNow();
    const g = k => { const w = window.MotionAvatar.__boneWorld(k); return w ? [w.x, w.y, w.z] : null; };
    return { hand: g("RightHand"), handL: g("LeftHand"), ik: window.MotionAvatar.__ikError() };
  }, { b: BASE, mode });

  const side = await armPose("side");
  const over = await armPose("over");
  const overExt = await armPose("overExt");

  const out = {
    viewport: "1280x800",
    layout: idle.layout,
    ikStand: stand.ik,
    ankleErr: stand.ik.ankleL,
    kneeErr: stand.ik.kneeL,
    wristErr: stand.ik.wristL,
    elbowErr: stand.ik.elbowL,
    legAmp: (d3(stand.foot, apart.foot) + d3(stand.footL, apart.footL)) / 2,
    kneeAmp: d3(stand.knee, apart.knee),
    armSideAmp: (d3(stand.hand, side.hand) + d3(stand.handL, side.handL)) / 2,
    armOverAmp: (d3(stand.hand, over.hand) + d3(stand.handL, over.handL)) / 2,
    armOverExtAmp: (d3(stand.hand, overExt.hand) + d3(stand.handL, overExt.handL)) / 2,
    wristErrSide: side.ik ? side.ik.wristL : null,
    wristErrOver: over.ik ? over.ik.wristL : null,
    wristErrOverExt: overExt.ik ? overExt.ik.wristL : null,
    handStand: stand.hand, handSide: side.hand, handOver: over.hand, handOverExt: overExt.hand,
    snapStand: stand.snap,
    topWorld: idle.topWorld, botWorld: idle.botWorld
  };
  console.log(JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(__dirname, "shots", "_dbg-ik-measure.png") });
  fs.writeFileSync(path.join(__dirname, "_dbg-cat-ik-measure.json"), JSON.stringify(out, null, 2), "utf8");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
