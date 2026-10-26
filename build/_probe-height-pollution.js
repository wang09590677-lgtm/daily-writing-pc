"use strict";
/* 探针 5：用真机波比跳数据，分离"腿的真实弹动"与"手臂接管边界造成的假波动"。
 *
 * 判据：
 *   · height_legOnly  —— 只用腰以下关键点（髋/膝/踝/跟/趾）算的竖直跨度。
 *                        这是"腿真的在动"的纯量，手臂永远碰不到它。
 *   · height_all      —— 现有 SIGNALS.height（全部关键点的 bbox 高）。
 *   · 两者之差       —— 就是手臂污染的份额。
 *
 * 同时用产品 detectReps 原文，分别跑两条信号，看计数差。
 *
 * 用法：node build/_probe-height-pollution.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;

const LEG = new Set([MP.L_HIP, MP.R_HIP, MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE,
  MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT]);
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const toLM = fr => fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }));

/* 只用腿部关键点算竖直跨度（= 腿的真实弹动） */
function legSpan(fr) {
  let mn = Infinity, mx = -Infinity, n = 0;
  for (let i = 0; i < fr.length; i++) {
    if (!LEG.has(i)) continue;
    const p = fr[i]; if (!p || !(vis(p) >= PV.VIS_MIN)) continue;
    n++;
    if (p[1] < mn) mn = p[1];
    if (p[1] > mx) mx = p[1];
  }
  return n >= 2 ? mx - mn : null;
}
/* 只用腿部关键点算"单侧最低点"（= 抬膝的真实峰） */
function legBottom(fr, side) {
  let b = null;
  for (let i = 0; i < fr.length; i++) {
    if (!LEG.has(i)) continue;
    const p = fr[i]; if (!p || !(vis(p) >= PV.VIS_MIN)) continue;
    const isL = p[0] < 0.5;
    if (side === "L" && !isL) continue;
    if (side === "R" && isL) continue;
    if (b === null || p[1] > b) b = p[1];
  }
  return b;
}
/* 只用腿部关键点算"单侧最低点"（= 抬膝的真实峰） */
function armSpan(fr) {
  // 只是为了对照：手臂的竖直跨度
  return null;
}

const pp = a => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) - Math.min(...v) : 0; };

console.log("动作          信号               峰峰值(含臂/全点)  峰峰值(只用腿)   污染占比");
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  const frames = act.frames.filter(Boolean);
  const H_all = [], H_leg = [], bL_all = [], bL_leg = [], bR_all = [], bR_leg = [];
  for (const fr of frames) {
    const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
    H_all.push(m.height);
    H_leg.push(legSpan(fr));
    bL_all.push(m.bottomL); bL_leg.push(legBottom(fr, "L"));
    bR_all.push(m.bottomR); bR_leg.push(legBottom(fr, "R"));
  }
  const row = (label, all, leg) => {
    const a = pp(all), b = pp(leg);
    const pol = b > 0 ? ((a - b) / a * 100) : 0;
    console.log(`  ${label.padEnd(10)} ${a.toFixed(4).padStart(12)} ${b.toFixed(4).padStart(14)}  ${(pol > 0 ? pol.toFixed(0) : 0).toString().padStart(6)}%`);
  };
  console.log(`\n【${act.cn}】`);
  row("height", H_all, H_leg);
  row("bottomL", bL_all, bL_leg);
  row("bottomR", bR_all, bR_leg);
}
