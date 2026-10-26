"use strict";
/* 探针 7：legY 的时间行为 —— 它到底是"跟着抬膝走"还是"跟着全身走"？
 *
 * 高抬腿真机数据（145 帧，约 6 秒）。逐帧打印：
 *   legY      = 腿部关键点 y 的中位数（候选新信号）
 *   kneeL_y   = 图像左侧膝盖的 y
 *   topY      = bbox 顶边（指尖/头）
 *   hipY      = 髋中点 y
 * 看 legY 的波峰是不是跟着 kneeL 的波峰（抬膝）。
 *
 * 用法：node build/_probe-legy-trace.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;

const LEG = [MP.L_HIP, MP.R_HIP, MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE, MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT];
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const toLM = fr => fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }));
function legY(fr) {
  const ys = [];
  for (const i of LEG) { const p = fr[i]; if (p && vis(p) >= PV.VIS_MIN) ys.push(p[1]); }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  const m = ys.length >> 1;
  return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2;
}

const act = LMJ.acts.highKnees;
const frames = act.frames.filter(Boolean);
console.log("帧   legY    R_KNEE_y  L_KNEE_y  hipMidY  bboxTop  说明");
for (let i = 0; i < frames.length; i += 3) {
  const fr = frames[i];
  const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
  const ly = legY(fr);
  const rk = fr[MP.R_KNEE], lk = fr[MP.L_KNEE];
  console.log(
    `${String(i).padStart(3)}  ${ly.toFixed(3)}  ${rk[1].toFixed(3)}    ${lk[1].toFixed(3)}    ` +
    `${m.joints.hipMid.y.toFixed(3)}   ${m.top.toFixed(3)}`);
}

/* 相关性：legY 与各候选量的皮尔逊相关 */
function corr(a, b) {
  const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sab / Math.sqrt(sa * sb);
}
const A = [], K = [], H = [], T = [], B = [], BOT = [];
for (const fr of frames) {
  const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
  A.push(legY(fr)); K.push(m.joints.kneeL ? m.joints.kneeL.y : m.joints.kneeR.y);
  H.push(m.joints.hipMid.y); T.push(m.top); B.push(m.height); BOT.push(m.bottomL);
}
console.log("\n=== 皮尔逊相关（与 legY 比）===");
console.log(`  legY vs kneeL_y : ${corr(A, K).toFixed(3)}`);
console.log(`  legY vs hipMid_y: ${corr(A, H).toFixed(3)}`);
console.log(`  legY vs bboxTop : ${corr(A, T).toFixed(3)}   ← 这就是手臂参与的地方`);
console.log(`  legY vs bottomL : ${corr(A, BOT).toFixed(3)}`);
