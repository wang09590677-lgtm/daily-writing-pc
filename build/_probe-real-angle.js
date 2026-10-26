/* 探针：**真实照片**上量"引擎自己的关节内角"，用来定 IK 伸直死区。
 *
 * 背景（本轮真机反馈）：孩子伸直手臂/腿时模型是弯的。修法是让 IK 复现
 * **引擎自己的关节内角**而不是"目标到模型根的距离"（见 solveTwoBoneIK 长注释）。
 * 但引擎的内角本身在"真人伸直"时**并不等于 180°**，因为：
 *   · MediaPipe 的 shoulder 关键点落在**肩峰**（肩关节外侧约 2~3cm），
 *     而模型的 `RightArm` 骨骼起点是**肩关节** —— 于是"肩峰→肘→腕"天生是折的；
 *   · hip 关键点同理有偏差。
 * 死区取多少，取决于这个偏差有多大。**必须用真实照片量，不能拍脑袋。**
 *
 * 用法：node build/_probe-real-angle.js
 */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
/* ⚠️ MediaPipe 对同一张图**每次跑出来的关键点不完全一样**（平滑器的内部状态），
 * 于是"改前/改后"根本没法比。所以把第一次跑到的 33 点**落盘缓存**，之后都用它 ——
 * 这样这个探针是**确定性**的，可以拿来做 A/B。 */
const CACHE = path.join(__dirname, "fixtures", "pose-human-landmarks.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(FIXTURE)) { console.error("缺少样本：" + FIXTURE); process.exit(1); }
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  const cached = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : null;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"),
    { waitUntil: "load", timeout: 40000 });
  await sleep(900);

  const r = await page.evaluate(async (b64, cached) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    let lm = cached;
    if (!lm) {
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      pose.onResults(x => { if (x && x.poseLandmarks && x.poseLandmarks.length) lm = x.poseLandmarks; });
      for (let i = 0; i < 5; i++) { await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 120)); }
    }
    if (!lm) return { err: "无关键点" };
    const m = window.PoseVision.mapLandmarks(lm);
    if (!m.ok) return { err: "映射失败 " + m.reason };
    return { imgW: cv.width, imgH: cv.height, joints: m.joints, bbox: m.bbox, lm: lm.length, rawLm: lm };
  }, b64, cached).catch(e => ({ err: String(e && e.message) }));

  if (r.err) { console.log("失败：" + r.err); await browser.close(); process.exit(2); }
  if (!cached && r.rawLm) {
    fs.writeFileSync(CACHE, JSON.stringify(r.rawLm));
    console.log("（已把 33 点缓存到 " + path.relative(ROOT, CACHE) + "，之后每次跑都用它，保证可比）");
  }

  const j = r.joints;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const len = v => Math.hypot(v.x, v.y);
  const interior = (a, b, c) => {
    const u = sub(a, b), v = sub(c, b);
    const d = (u.x * v.x + u.y * v.y) / (len(u) * len(v));
    return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
  };

  console.log("\n真实照片 " + r.imgW + "x" + r.imgH + "，关键点 " + r.lm + " 个");
  console.log("包围盒 x=" + r.bbox.x.toFixed(3) + " y=" + (r.bbox.y || 0).toFixed(3) +
    " w=" + r.bbox.w.toFixed(3) + " h=" + r.bbox.h.toFixed(3));

  const rows = [];
  const add = (name, a, b, c) => {
    if (!j[a] || !j[b] || !j[c]) { console.log("  " + name + "：关节缺失"); return; }
    const e1 = len(sub(j[b], j[a])), e2 = len(sub(j[c], j[b])), eD = len(sub(j[c], j[a]));
    const ang = interior(j[a], j[b], j[c]);
    rows.push({ name, bend: 180 - ang, e1, e2, eD, ratio: eD / (e1 + e2) });
    console.log("  " + name.padEnd(10) + " 内角 " + ang.toFixed(1).padStart(5) + "°" +
      "  ⇒ **弯曲 " + (180 - ang).toFixed(1).padStart(5) + "°**" +
      "   e₁=" + e1.toFixed(4) + " e₂=" + e2.toFixed(4) + " eD=" + eD.toFixed(4) +
      "   eD/(e₁+e₂)=" + (eD / (e1 + e2)).toFixed(4));
  };

  console.log("\n== 手臂（真人垂手站立，应当基本伸直）==");
  add("左臂", "shoulderL", "elbowL", "wristL");
  add("右臂", "shoulderR", "elbowR", "wristR");
  console.log("\n== 腿（真人站立，应当基本伸直）==");
  add("左腿", "hipL", "kneeL", "ankleL");
  add("右腿", "hipR", "kneeR", "ankleR");

  const mx = rows.reduce((a, b) => Math.max(a, b.bend), 0);
  console.log("\n★ 引擎报出的最大弯曲角 = " + mx.toFixed(1) + "°  ⇒ 系统偏差上限");
  console.log("  （当前 BEND_BIAS = 12°）");

  /* ---------- 端到端：把真实照片的关节**直接喂给跟练角色**，量模型自己的弯曲角 ----------
   * 这是本轮唯一能"离机"证明修好了的证据：真人站直 ⇒ 模型四肢也应当是直的。 */
  const model = await page.evaluate(async (joints) => {
    const M = window.MotionAvatar;
    M.show();
    for (let i = 0; i < 40; i++) {
      const sk = M.__skeleton();
      if (sk && (sk.ready || sk.failed)) break;
      await new Promise(r => setTimeout(r, 400));
    }
    for (let i = 0; i < 60; i++) M.updateFromSkeleton(joints);   // 让低通收敛
    M.__renderNow();
    const s = M.__poseSnapshot();
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const len = v => Math.hypot(v[0], v[1], v[2]);
    const interior = (a, b, c) => {
      const u = sub(a, b), v = sub(c, b);
      const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v));
      return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const out = {};
    if (s.RightArm && s.RightForeArm && s.RightHand) out.左臂 = 180 - interior(s.RightArm, s.RightForeArm, s.RightHand);
    if (s.LeftArm && s.LeftForeArm && s.LeftHand) out.右臂 = 180 - interior(s.LeftArm, s.LeftForeArm, s.LeftHand);
    if (s.RightUpLeg && s.RightLeg && s.RightFoot) out.左腿 = 180 - interior(s.RightUpLeg, s.RightLeg, s.RightFoot);
    if (s.LeftUpLeg && s.LeftLeg && s.LeftFoot) out.右腿 = 180 - interior(s.LeftUpLeg, s.LeftLeg, s.LeftFoot);
    return out;
  }, r.joints);

  console.log("\n== 端到端：真实照片关节 → 跟练角色，模型自己的弯曲角 ==");
  Object.keys(model).forEach(k => {
    console.log("  " + k + "  模型弯曲 " + model[k].toFixed(1).padStart(5) + "°" +
      (model[k] < 6 ? "   ✓ 基本伸直" : "   ✗ 仍然弯着"));
  });
  const mMax = Math.max.apply(null, Object.keys(model).map(k => model[k]));
  console.log("\n★ 模型最大弯曲角 = " + mMax.toFixed(1) + "°" + (mMax < 6 ? "  ⇒ 真人站直 ⇒ 模型也站直 ✓" : "  ⇒ 还没修好"));

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
