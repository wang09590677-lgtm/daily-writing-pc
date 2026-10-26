"use strict";
/* 探针 6：候选新信号 legY 的分辨力 + 退化为 0 的帧占比。
 *
 * 候选：legY = 腿（髋/膝/踝/跟/趾）在**画面坐标**里的中位 y。
 *   理由：这是腿部相对相机的位置，不含任何手臂/头关键点，
 *   而且不是"区间宽度"——不会像 bottomL 那样被头顶/面部混进来。
 *   腿整体抬升（抬膝、收膝、跳起）→ legY 变小；腿落地 → legY 变大。
 *
 * 用法：node build/_probe-legy.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;

const LEG = [MP.L_HIP, MP.R_HIP, MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE, MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT];
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];

function legY(fr) {
  const ys = [];
  for (const i of LEG) { const p = fr[i]; if (p && vis(p) >= PV.VIS_MIN) ys.push(p[1]); }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  const m = ys.length >> 1;
  return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2;
}
/* 变体：只用膝+踝（最纯的"腿"），不含髋（髋在躯干交界） */
const LEG_CORE = [MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE];
function legCoreY(fr) {
  const ys = [];
  for (const i of LEG_CORE) { const p = fr[i]; if (p && vis(p) >= PV.VIS_MIN) ys.push(p[1]); }
  if (!ys.length) return null;
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}
const pp = a => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) - Math.min(...v) : 0; };

console.log("动作          legY峰峰值   有效帧占比   legCoreY峰峰值 有效帧占比");
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  const frames = act.frames.filter(Boolean);
  const A = [], B = [];
  let nA = 0, nB = 0;
  for (const fr of frames) {
    const a = legY(fr), b = legCoreY(fr);
    A.push(a); B.push(b);
    if (a != null) nA++;
    if (b != null) nB++;
  }
  console.log(`【${act.cn}】`.padEnd(14) +
    `${pp(A).toFixed(4).padStart(11)} ${(100 * nA / frames.length).toFixed(0).padStart(9)}% ` +
    `${pp(B).toFixed(4).padStart(14)} ${(100 * nB / frames.length).toFixed(0).padStart(9)}%`);
}

/* 关键：腿完全不可见的帧有多少？这些帧上 legY 必须"保持上一值"而不能变 0 */
console.log("\n=== 腿部关键点完全不可用的帧（legY 必须沿用上一值，否则会造出假峰）===");
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  const frames = act.frames.filter(Boolean);
  let miss = 0, tot = 0;
  for (const fr of frames) { tot++; if (legY(fr) == null) miss++; }
  console.log(`【${act.cn}】${miss}/${tot} 帧腿不可用 (${(100 * miss / tot).toFixed(0)}%)`);
}
