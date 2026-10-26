/* 扫描「近端腿骨 scale.y」的取值（1.15~1.25），为 motion-avatar.js 定最终拉伸值。
 *
 * 为什么用沙盒副本（_diag-cat-lab.html → _diag-cat-lab-mod.js）：
 *   产品文件 motion-avatar.js 没有 __setBoneScaleY / __rescaleRest 钩子，改不了运行时缩放。
 *   沙盒副本是产品文件的忠实拷贝 + 诊断钩子，能在**一次浏览器会话**里反复改缩放并重算
 *   rest.len，省掉每换一个值就重开一次 Chrome（本项目 Chrome 串行铁律）。
 *
 * 每组值量四件事：
 *   ① 站姿 IK 误差（踝/膝/腕/肘）—— 直接判据
 *   ② 腿幅度（并腿→分开，脚的世界位移）与膝幅度 —— 用户"动得不明显"的核心
 *   ③ 模型渲染出来的"最低点/最高点"世界 y —— 用来算「腿拉长后脚会掉出安全区多少」，
 *      进而定 layout 的重排量（不能只靠 IK 数字，脚出界是肉眼可见的坏）
 *   ④ 每组存一张截图，供人眼复核"网格有没有被拉变形"
 *
 * 用法：NODE_PATH=... node build/_dbg-cat-legsweep.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LAB = "file:///" + path.join(__dirname, "_diag-cat-lab.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

const SCALES = [1.00, 1.15, 1.18, 1.20, 1.22, 1.25];

/* 与 _diag-cat-lab.js 同一套姿势，保证数字可与诊断报告对照。 */
const ARM_DOWN = {
  head: { x: 0.5, y: 0.10 }, neck: { x: 0.5, y: 0.22 },
  shoulderL: { x: 0.43, y: 0.27 }, shoulderR: { x: 0.57, y: 0.27 },
  midL: { x: 0.425, y: 0.32 }, midR: { x: 0.575, y: 0.32 },
  elbowL: { x: 0.42, y: 0.37 }, elbowR: { x: 0.58, y: 0.37 },
  foreL: { x: 0.416, y: 0.42 }, foreR: { x: 0.584, y: 0.42 },
  wristL: { x: 0.414, y: 0.465 }, wristR: { x: 0.586, y: 0.465 },
  handL: { x: 0.413, y: 0.49 }, handR: { x: 0.587, y: 0.49 },
  hipMid: { x: 0.5, y: 0.56 }, hipL: { x: 0.462, y: 0.563 }, hipR: { x: 0.538, y: 0.563 },
  kneeL: { x: 0.46, y: 0.712 }, kneeR: { x: 0.54, y: 0.712 },
  shinL: { x: 0.459, y: 0.80 }, shinR: { x: 0.541, y: 0.80 },
  ankleL: { x: 0.458, y: 0.888 }, ankleR: { x: 0.542, y: 0.888 },
  toeL: { x: 0.458, y: 0.93 }, toeR: { x: 0.542, y: 0.93 }
};
const LEGS_APART = JSON.parse(JSON.stringify(ARM_DOWN));
Object.assign(LEGS_APART, {
  kneeL: { x: 0.40, y: 0.712 }, kneeR: { x: 0.60, y: 0.712 },
  shinL: { x: 0.36, y: 0.80 }, shinR: { x: 0.64, y: 0.80 },
  ankleL: { x: 0.32, y: 0.888 }, ankleR: { x: 0.68, y: 0.888 },
  toeL: { x: 0.31, y: 0.93 }, toeR: { x: 0.69, y: 0.93 }
});

const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-legsweep-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    defaultViewport: { width: 1000, height: 720 },
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
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(LAB, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("lab ready=" + sk.ready + " bones=" + sk.boneCount + " skinned=" + sk.skinnedCount);
  if (!sk.ready) { await browser.close(); process.exit(2); }

  const N = 40;
  const pose = (j) => page.evaluate(({ j, n }) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < n; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    const g = k => { const w = M.__boneWorld(k); return w ? [w.x, w.y, w.z] : null; };
    // 从渲染结果里找"猫"（亮度>70）的最低/最高像素行 → 换算世界 y
    const gl = document.querySelector("#motionAvatar canvas");
    let lowest = null, highest = null;
    if (gl) {
      const W = 200, H = 200;
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g2 = cv.getContext("2d"); g2.drawImage(gl, 0, 0, W, H);
      const d = g2.getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 70) { if (lowest === null) lowest = y; highest = y; break; }
        }
      }
      // 正交视口世界高 = 1.8（y∈[-0.9,0.9]）→ 屏幕行 → 世界 y
      const toWorld = py => 0.9 - 1.8 * py / H;
      if (lowest !== null) { lowest = +toWorld(highest).toFixed(4); highest = +toWorld(lowest).toFixed(4); }
    }
    return {
      ik: M.__ikError(), hand: g("RightHand"), foot: g("RightFoot"), footL: g("LeftFoot"),
      knee: g("RightLowerLeg"), layout: M.__layout(),
      topWorld: highest, botWorld: lowest,
      restThigh: M.__restLen("RightUpperLeg"), restShin: M.__restLen("RightLowerLeg")
    };
  }, { j, n: N });

  /* 记录腿根骨骼的模型局部 y（用于解析地算"拉长后最低点下移多少"）。 */
  const geom = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const w = M.__boneWorld("RightUpperLeg");
    const L = M.__layout();
    return { upperLegWorldY: w.y, footY: L.footY, H: L.H, winH: innerHeight };
  });

  const rows = [];
  for (const S of SCALES) {
    await page.evaluate(({ s }) => {
      const M = window.MotionAvatar;
      ["RightUpperLeg", "LeftUpperLeg"].forEach(n => M.__setBoneScaleY(n, s));
      M.__rescaleRest();
    }, { s: S });
    const stand = await pose(ARM_DOWN);
    const apart = await pose(LEGS_APART);
    await pose(ARM_DOWN);
    const shot = path.join(SHOTS, "_sweep-cat-leg-" + String(S).replace(".", "") + ".png");
    await page.screenshot({ path: shot });
    const row = {
      S,
      ankleErr: stand.ik.ankleL, kneeErr: stand.ik.kneeL, wristErr: stand.ik.wristL, elbowErr: stand.ik.elbowL,
      footAmp: d3(stand.foot, apart.foot), kneeAmp: d3(stand.knee, apart.knee),
      legAmpAvg: (d3(stand.foot, apart.foot) + d3(stand.footL, apart.footL)) / 2,
      restThigh: stand.restThigh, restShin: stand.restShin,
      topWorld: stand.topWorld, botWorld: stand.botWorld,
      handAmp: d3(stand.hand, apart.hand)
    };
    rows.push(row);
    console.log(`S=${S.toFixed(2)}  踝误差=${row.ankleErr}  膝误差=${row.kneeErr}  腕误差=${row.wristErr}` +
      `  脚幅度=${row.footAmp.toFixed(4)}  膝幅度=${row.kneeAmp.toFixed(4)}  骨长(大腿/小腿)=${row.restThigh}/${row.restShin}` +
      `  渲染最低y=${row.botWorld} 最高y=${row.topWorld}`);
  }

  console.log("\n腿根骨骼模型局部 y = " + geom.upperLegWorldY + "（世界）; layout.H=" + geom.H + " footY=" + geom.footY);
  fs.writeFileSync(path.join(__dirname, "_dbg-cat-legsweep.json"),
    JSON.stringify({ geom, rows }, null, 2), "utf8");
  console.log("JSON → build/_dbg-cat-legsweep.json；截图 → build/shots/_sweep-cat-leg-*.png");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
