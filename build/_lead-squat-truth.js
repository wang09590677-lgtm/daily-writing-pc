/* 【深蹲真值核查】我的"踝y极小值=15"是否可靠？深蹲视频 361帧/15.04s，
 * band=[15,45]/分 → 期望周期 1.33~4s。若真值 15 则周期 1.0s=60/分，**超出 band 上限**，
 * 说明很可能是噪声过计。用多关节 + 多参数交叉，并打印波形供人工核对。
 * 只读 _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const FPS = 24;
function col(name, idxs, axis) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite);
    out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN);
  }
  return out;
}
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function ext(a, gapF, promFrac) {
  const s = smooth(a, 5); const rng = Math.max(...s) - Math.min(...s); const prom = rng * promFrac;
  const idx = [];
  for (let i = 1; i < s.length - 1; i++) if (s[i] <= s[i - 1] && s[i] < s[i + 1]) {
    if (idx.length && i - idx[idx.length - 1] < gapF) { if (s[i] < s[idx[idx.length - 1]]) idx[idx.length - 1] = i; } else idx.push(i);
  }
  return idx.filter(i => { const lo = Math.max(0, i - 25), hi = Math.min(s.length, i + 25); return Math.max(...s.slice(lo, hi)) - s[i] >= prom; });
}
function medGap(idx) { if (idx.length < 2) return NaN; const g = []; for (let i = 1; i < idx.length; i++) g.push(idx[i] - idx[i - 1]); g.sort((a, b) => a - b); return g[Math.floor(g.length / 2)]; }

console.log("=== 徒手深蹲（361帧/15.04s）真值核查 ===");
console.log("band=[15,45]/分 → 期望周期 1.33~4.0s（=32~96帧）\n");
console.log("关节          幅度门限  极小值  中位周期(帧)  → /分   是否落在band内");
const JOINT = { "踝y(27,28)": [27, 28, 1], "髋y(23,24)": [23, 24, 1], "膝y(25,26)": [25, 26, 1], "鼻y(0)": [0, 1], "合并y跨度": null };
for (const [lb, spec] of Object.entries(JOINT)) {
  for (const pf of [0.02, 0.08, 0.15, 0.25]) {
    let a;
    if (spec === null) {
      a = fill(LM.acts.squat.frames.map(f => { if (!f) return NaN; const ys = f.filter(p => p && p.length > 2 && p[2] > 0.4).map(p => p[1]); return ys.length ? Math.max(...ys) - Math.min(...ys) : NaN; }));
    } else a = fill(col("squat", [spec[0]], spec[1]));
    const e = ext(a, 6, pf); const g = medGap(e);
    const rate = Number.isFinite(g) ? 60 / (g / FPS) : NaN;
    const inBand = rate >= 15 && rate <= 45;
    console.log(`${lb.padEnd(12)} ${pf.toFixed(2).padStart(8)} ${String(e.length).padStart(6)} ${String(g).padStart(11)}帧  ${Number.isFinite(rate) ? rate.toFixed(0).padStart(5) : "  ---"}   ${Number.isFinite(rate) ? (inBand ? "✅在带内" : "❌超带") : ""}`);
  }
}
// 波形
console.log("\n=== 踝y 波形（每5帧1字符，↓=极小值）===");
const a = smooth(fill(col("squat", [27], 1)), 5);
const ml = Math.min(...a), M = Math.max(...a);
let line = "";
for (let i = 0; i < a.length; i += 5) {
  const isMin = i > 0 && i < a.length - 1 && a[i] <= a[i - 1] && a[i] < a[i + 1];
  line += isMin ? "↓" : (a[i] > ml + (M - ml) * 0.7 ? "-" : (a[i] < ml + (M - ml) * 0.3 ? "v" : " "));
  if (line.length % 60 === 0) { console.log("  " + line); line = ""; }
}
if (line) console.log("  " + line);
console.log(`  (范围 ${ml.toFixed(3)}~${M.toFixed(3)}; - = 高位置, v = 低位置)`);

console.log("\n=== 半蹲热身（复用 squat 视频）真值核查 ===");
console.log("band=[15,40]/分 → 期望周期 1.5~4.0s（=36~96帧）");
for (const pf of [0.08, 0.15, 0.25]) {
  const h = fill(col("squat", [23, 24], 1));
  const s = smooth(h, 5); const rng = Math.max(...s) - Math.min(...s);
  // 半蹲用 centroidY：髋部上下
  const e = ext(h, 6, pf); const g = medGap(e);
  const rate = Number.isFinite(g) ? 60 / (g / FPS) : NaN;
  console.log(`  髋y 门限${pf}  极小值=${e.length}  中位周期=${g}帧  → ${Number.isFinite(rate) ? rate.toFixed(0) : "---"}/分`);
}
