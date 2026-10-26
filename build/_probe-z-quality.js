/* 探针：**MediaPipe 的 z（深度）到底能不能用来驱动跟练角色**。
 *
 * 为什么必须有这一步（R2：真实数据是唯一验收标准）：
 *   上一轮我按合成夹具设计并"验证通过"了 `IK_REF`，结果在真实数据上被否决
 *   （`build/_probe-real-jitter.js`：抖动让绝对伸直的真人报出 24.0° 幻影弯曲）。
 *   这次不能再犯 —— z 的几何接通只是**必要条件**，还必须在真实关键点上量：
 *     · 它有没有把"站直的人"推歪（躯干倾角、四肢弯曲）？
 *     · 它给出的骨长和模型差多少？
 *
 * 数据来源：`build/fixtures/pose-human-landmarks.json`
 *   —— MediaPipe 对 `pose-human.png` 的**原始输出**（含 x/y/z/visibility），
 *      由 `_probe-real-angle.js` 首次运行时落盘。是**真实模型的真实输出**。
 * ⚠️ 但那张图是**平面插画**（物理上 z 应当处处为 0），所以它测的是
 *    **z 的伪影下限**，不是"真人有深度时 z 有多准"。结论要按这个口径读。
 *
 * 用法：node build/_probe-z-quality.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const CACHE = path.join(__dirname, "fixtures", "pose-human-landmarks.json");
const VIEW = { width: 1280, height: 800 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MP = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16, L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28 };

(async () => {
  if (!fs.existsSync(CACHE)) { console.error("缺少 " + CACHE + "（先跑一次 build/_probe-real-angle.js 生成）"); process.exit(1); }
  const lm = JSON.parse(fs.readFileSync(CACHE, "utf8"));

  /* ---------- 一、先看 z 本身的形状（不依赖浏览器） ---------- */
  const zs = lm.map(p => p.z);
  console.log("============ 一、真实关键点的 z 分布（平面插画，物理上应处处为 0）============");
  console.log("  z 范围: " + Math.min.apply(null, zs).toFixed(4) + " ~ " + Math.max.apply(null, zs).toFixed(4));
  const named = [["鼻", MP.NOSE], ["左肩", MP.L_SHOULDER], ["右肩", MP.R_SHOULDER], ["左肘", MP.L_ELBOW], ["右肘", MP.R_ELBOW],
  ["左腕", MP.L_WRIST], ["右腕", MP.R_WRIST], ["左髋", MP.L_HIP], ["右髋", MP.R_HIP],
  ["左膝", MP.L_KNEE], ["右膝", MP.R_KNEE], ["左踝", MP.L_ANKLE], ["右踝", MP.R_ANKLE]];
  console.log("  部位    y      z       (y 越大越靠下)");
  named.forEach(([n, i]) => {
    console.log("  " + n.padEnd(6) + " " + lm[i].y.toFixed(3).padStart(6) + " " + lm[i].z.toFixed(4).padStart(8));
  });
  /* 骨段"3D 长度 / 2D 投影长度"——z 伪影的直接体现：真人站直时该比值应 ≈1 */
  const seg3 = (a, b) => Math.hypot(lm[b].x - lm[a].x, lm[b].y - lm[a].y, lm[b].z - lm[a].z);
  const seg2 = (a, b) => Math.hypot(lm[b].x - lm[a].x, lm[b].y - lm[a].y);
  const SEGS = [["左上臂", MP.L_SHOULDER, MP.L_ELBOW], ["左前臂", MP.L_ELBOW, MP.L_WRIST],
  ["右上臂", MP.R_SHOULDER, MP.R_ELBOW], ["右前臂", MP.R_ELBOW, MP.R_WRIST],
  ["左大腿", MP.L_HIP, MP.L_KNEE], ["左小腿", MP.L_KNEE, MP.L_ANKLE],
  ["右大腿", MP.R_HIP, MP.R_KNEE], ["右小腿", MP.R_KNEE, MP.R_ANKLE]];
  console.log("\n  骨段      2D投影   3D(含z)  比值(3D/2D)  Δz");
  let maxRatio = 0;
  SEGS.forEach(([n, a, b]) => {
    const r = seg3(a, b) / seg2(a, b);
    maxRatio = Math.max(maxRatio, r);
    console.log("  " + n.padEnd(8) + " " + seg2(a, b).toFixed(4).padStart(8) + " " + seg3(a, b).toFixed(4).padStart(8) +
      " " + r.toFixed(3).padStart(9) + " " + (lm[b].z - lm[a].z).toFixed(4).padStart(9));
  });
  console.log("\n  ★ 最大 3D/2D 比值 = " + maxRatio.toFixed(3) +
    "（真人站直 ⇒ 真值应当 ≈1.00；显著 >1 说明 z 给出了**不存在的深度**）");

  /* ---------- 二、喂给跟练角色：z 开 / 关 的差别 ---------- */
  const profileDir = path.join(os.tmpdir(), "wbc-zq-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });

  async function run(withDepth) {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport(VIEW);
    await page.goto(INDEX + (withDepth ? "?poseDepth=1" : ""), { waitUntil: "load", timeout: 40000 });
    await sleep(1000);
    await page.evaluate(() => window.MotionAvatar.show());
    for (let i = 0; i < 40; i++) {
      const sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
      if (sk && (sk.ready || sk.failed)) break;
      await sleep(400);
    }
    const r = await page.evaluate((lm) => {
      const M = window.MotionAvatar;
      /* 走**真实链路**：原始关键点 → PoseVision.mapLandmarks → 引擎关节 → 角色。
       * 这样连"z 有没有穿过感知层"一起验了，而不是直接塞关节绕过它。 */
      const m = window.PoseVision.mapLandmarks(lm);
      if (!m.ok) return { err: "mapLandmarks 失败: " + m.reason };
      const zKeys = Object.keys(m.joints).filter(k => typeof m.joints[k].z === "number");
      const zNonZero = zKeys.filter(k => Math.abs(m.joints[k].z) > 1e-9).length;
      for (let i = 0; i < 60; i++) M.updateFromSkeleton(m.joints);
      M.__renderNow();
      const s = M.__poseSnapshot();
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const len = v => Math.hypot(v[0], v[1], v[2]);
      const bend = (a, b, c) => {
        if (!a || !b || !c) return null;
        const u = sub(a, b), v = sub(c, b);
        const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v));
        return 180 - Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
      };
      /* 躯干倾角：颈相对髋的**前后**偏移（度）。真人站直 ⇒ 应 ≈0。 */
      const torsoTilt = (() => {
        const hip = s.Hips, neck = s.Neck;
        if (!hip || !neck) return null;
        const dy = neck[1] - hip[1], dz = neck[2] - hip[2];
        return Math.atan2(dz, Math.abs(dy)) * 180 / Math.PI;
      })();
      /* 头相对髋的前后偏移（世界单位） */
      const headDz = (s.Hips && s.HeadTop_End) ? (s.HeadTop_End[2] - s.Hips[2]) : null;
      return {
        zKeys: zKeys.length, zNonZero: zNonZero,
        torsoTilt: torsoTilt, headDz: headDz,
        elbowL: bend(s.RightArm, s.RightForeArm, s.RightHand),
        elbowR: bend(s.LeftArm, s.LeftForeArm, s.LeftHand),
        kneeL: bend(s.RightUpLeg, s.RightLeg, s.RightFoot),
        kneeR: bend(s.LeftUpLeg, s.LeftLeg, s.LeftFoot),
        /* 末端误差：真实站姿下模型手脚离引擎目标多远 */
        ikErr: M.__ikError()
      };
    }, lm);
    await page.close();
    return r;
  }

  const off = await run(false);
  const on = await run(true);

  console.log("\n============ 二、真实站姿关键点 → 跟练角色（z 关 / 开 对照）============");
  const f = (v, n) => v == null ? "—" : v.toFixed(n == null ? 3 : n);
  const row = (name, a, b) => console.log("  " + name.padEnd(18) + f(a).padStart(10) + f(b).padStart(12));
  if (off.err || on.err) { console.log("  失败: " + (off.err || on.err)); }
  else {
    console.log("  " + "指标".padEnd(16) + "z 关".padStart(10) + "z 开".padStart(12));
    row("关节带 z 的个数", off.zKeys, on.zKeys);
    row("z 非零的关节数", off.zNonZero, on.zNonZero);
    row("躯干前后倾角°", off.torsoTilt, on.torsoTilt);
    row("头相对髋 Δz", off.headDz, on.headDz);
    row("肘弯 L°", off.elbowL, on.elbowL);
    row("肘弯 R°", off.elbowR, on.elbowR);
    row("膝弯 L°", off.kneeL, on.kneeL);
    row("膝弯 R°", off.kneeR, on.kneeR);
    const k = off.ikErr ? Object.keys(off.ikErr) : [];
    console.log("  末端误差（世界单位，越小越好）:");
    k.forEach(kk => console.log("    " + kk.padEnd(10) + f(off.ikErr[kk], 4).padStart(9) + f(on.ikErr[kk], 4).padStart(11)));
  }

  console.log("\n============ 结论 ============");
  const tilt = on.torsoTilt == null ? 0 : Math.abs(on.torsoTilt);
  const limbMax = Math.max(Math.abs(on.elbowL || 0), Math.abs(on.elbowR || 0), Math.abs(on.kneeL || 0), Math.abs(on.kneeR || 0));
  console.log("  躯干前后倾角 " + f(on.torsoTilt, 1) + "°；四肢最大弯曲 " + f(limbMax, 1) + "°");
  if (tilt < 8 && limbMax < 8) {
    console.log("  ⇒ 在这份（平面插画）数据上，z 没有把站直的人推歪。");
    console.log("     ⚠️ 但这**不能**说明真人有深度时 z 够准 —— 必须用真机数据再验（R2）。");
  } else {
    console.log("  ⇒ z 已经把站直的人推歪了（躯干 " + f(on.torsoTilt, 1) + "°、四肢 " + f(limbMax, 1) + "°）");
    console.log("     说明 MediaPipe 的 z 伪影与要检的信号同量级 ⇒ **不能直接拿它驱动角色**。");
  }

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
