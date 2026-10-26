"use strict";
/* 探针 8：以"膝"为唯一数据源的候选信号，逐个测分辨力。
 *
 * 已知（探针 6/7 实测）：
 *   · legY（腿部 y 中位数）被多个部位稀释，与抬膝相关只有 -0.15 → 不能用。
 *   · kneeL_y / kneeR_y 交替变化非常干净（0.51~0.73）。
 *   · bottomL 在高抬腿里峰峰值 0.66，但其中 63% 是头顶/面部贡献 → 太脏。
 *
 * 候选（每个都只用膝/踝，绝不碰手臂和头）：
 *   kneeUp  = max(kneeL_y, kneeR_y)   两条腿里"最下（最大 y）"的那条 = 着地腿
 *   kneeDn  = min(kneeL_y, kneeR_y)   两条腿里"最上"的那条 = 抬起腿
 *   kneeAsym= kneeR_y - kneeL_y       左右膝的高度差（交替抬膝 → 正负摆动）
 *   footY   = max(ankleL_y, ankleR_y)  着地脚的高度（跳起时会整体上移）
 *   legYMax = 腿关键点里最大的 y（= 着地最低点，但只取腿，不含头/手）
 *
 * 用法：node build/_probe-knee-signals.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;

const LEG = [MP.L_HIP, MP.R_HIP, MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE, MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT];
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const gy = (fr, i) => { const p = fr[i]; return (p && vis(p) >= PV.VIS_MIN) ? p[1] : null; };

function feats(fr) {
  const kl = gy(fr, MP.L_KNEE), kr = gy(fr, MP.R_KNEE);
  const al = gy(fr, MP.L_ANKLE), ar = gy(fr, MP.R_ANKLE);
  const knees = [kl, kr].filter(v => v != null);
  const feet = [al, ar].filter(v => v != null);
  const legAll = [];
  for (const i of LEG) { const v = gy(fr, i); if (v != null) legAll.push(v); }
  return {
    kneeUp: knees.length ? Math.max(...knees) : null,
    kneeDn: knees.length ? Math.min(...knees) : null,
    kneeAsym: (kl != null && kr != null) ? kr - kl : null,
    footY: feet.length ? Math.max(...feet) : null,
    legYMax: legAll.length ? Math.max(...legAll) : null
  };
}
const pp = a => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
function corr(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter(p => p[0] != null && p[1] != null);
  const n = pairs.length; if (n < 3) return 0;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n, mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (const [x, y] of pairs) { const da = x - ma, db = y - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sab / Math.sqrt(sa * sb) || 0;
}

const NAMES = ["kneeUp", "kneeDn", "kneeAsym", "footY", "legYMax"];
console.log("动作          " + NAMES.map(n => n.padStart(10)).join("") + "   （峰峰值）");
const store = {};
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  const frames = act.frames.filter(Boolean);
  const F = frames.map(fr => { const m = PV.mapLandmarks(fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }))); return m.ok ? feats(fr) : null; }).filter(Boolean);
  store[key] = F;
  console.log(`【${act.cn}】`.padEnd(14) + NAMES.map(n => pp(F.map(f => f[n])).toFixed(4).padStart(10)).join(""));
}

console.log("\n=== 关键验证：kneeAsym 与 kneeUp 对「抬膝」的跟踪质量（高抬腿）===");
{
  const F = store.highKnees;
  console.log(`  kneeUp   峰峰值=${pp(F.map(f => f.kneeUp)).toFixed(4)} （着地腿，交替抬膝时几乎不动 = 好事，说明它只反映"整体弹跳"）`);
  console.log(`  kneeDn   峰峰值=${pp(F.map(f => f.kneeDn)).toFixed(4)} （抬起腿，交替抬膝时大幅变化 = 反映抬膝）`);
  console.log(`  kneeAsym 峰峰值=${pp(F.map(f => f.kneeAsym)).toFixed(4)} （左右差，交替 → 正负摆，最适合"计次"）`);
}

console.log("\n=== 分辨力矩阵：各候选对「跳绳的弹跳」vs「高抬腿的抬膝」谁更敏感 ===");
for (const n of NAMES) {
  const jr = pp(store.jumpRope.map(f => f[n])), hk = pp(store.highKnees.map(f => f[n]));
  console.log(`  ${n.padEnd(9)} 跳绳=${jr.toFixed(4)}  高抬腿=${hk.toFixed(4)}`);
}
