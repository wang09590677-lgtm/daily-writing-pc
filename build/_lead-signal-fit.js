/* 【信号适配性排查】真机序列里每个动作有 width / height / centroidY 三个信号。
 * 用三个"无重扫"参照法（R1逐样本 / R2全段 / R3峰值）分别数每个信号，
 * 找出**哪个信号真正反映该动作的物理周期**。
 *
 * 动机：跳绳的 height 序列范围仅 0.6428~0.7006（几乎是常量），
 * 而"跳起"最直接的量应是踝 y / 重心 y。若 centroidY 明显更准，
 * 那 跳绳 的 signal 声明（height）本身就是缺陷。
 * 只读 _realseries.json + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const std = a => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }

// R1：逐样本，居中窗（在线可及），局部 std
function R1(vals, times, win, gap, fps) {
  let reps = 0, last = -1e9, armed = false; const hits = [];
  const half = Math.floor(win / 2);
  for (let i = 0; i < vals.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(vals.length - 1, i + half);
    const seg = vals.slice(a, b + 1); const m = mean(seg), g = std(seg) || 1;
    const d = (vals[i] - m) / g;
    const k = clamp(Math.sqrt(mean(seg.map(x => ((x - m) / g) ** 2))) * 0.85, 0.45, 2.2);
    if (d < -k) armed = true;
    else if (d > k && armed) { if (times[i] - last >= gap) { reps++; hits.push(+times[i].toFixed(2)); last = times[i]; } armed = false; }
  }
  return reps;
}
// R3：峰值法
function R3(vals, times, gap, fps) {
  const s = smooth(vals, Math.max(1, Math.round(fps * 0.08)));
  const mn = Math.min(...s), mx = Math.max(...s), thr = mn + (mx - mn) * 0.5;
  const md = Math.max(1, Math.round(gap * fps)); let last = -1e9, n = 0;
  for (let i = 1; i < s.length - 1; i++) if (s[i] >= thr && s[i] >= s[i - 1] && s[i] > s[i + 1]) { if (times[i] - last >= gap) { n++; last = times[i]; } }
  return n;
}
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function extremaCount(a, gapF, prom) { const idx = []; for (let i = 1; i < a.length - 1; i++) { if (a[i] <= a[i - 1] && a[i] < a[i + 1]) { if (idx.length && i - idx[idx.length - 1] < gapF) { if (a[i] < a[idx[idx.length - 1]]) idx[idx.length - 1] = i; } else idx.push(i); } } return idx.filter(i => { const lo = Math.max(0, i - 30), hi = Math.min(a.length, i + 30); return Math.max(...a.slice(lo, hi)) - a[i] >= prom; }); }
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } return fill(out); };
const TM = { jumpingJacks: ["jumpingJacks", [15, 16], 1, 4, 0.02, "腕y"], jumpRope: ["jumpRope", [27, 28], 1, 3, 0.01, "踝y"], squat: ["squat", [27, 28], 1, 6, 0.02, "踝y"], halfSquatWarm: ["squat", [23, 24], 1, 6, 0.02, "髋y"], burpee: ["burpee", [27, 28], 1, 6, 0.02, "踝y"] };

console.log("=== 各信号对每个动作的适配性（真值 = 关节法 + FFT 双口径）===\n");
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], band = a.profile.tempoBand, gap = a.profile.minRepGap;
  const win = clamp(Math.round(3600 / Math.max(15, band[1])), 3, 90);
  const times = a.series.map(s => s.t);
  const [lmN, idxs, axis, tg, tp, jointName] = TM[name];
  const tv = smoothArr(lmCol(lmN, idxs, axis), 3);
  const tExt = extremaCount(tv, tg, tp).length;
  console.log(`【${a.cn}】 band=[${band}] gap=${gap}  ${jointName}极小值=${tExt}  引擎声明信号=${a.signal}`);
  for (const sig of ["width", "height", "centroidY"]) {
    const vals = a.series.map(s => s[sig]);
    const rng = Math.max(...vals) - Math.min(...vals);
    const r1 = R1(vals, times, win, gap, 60);
    const r3 = R3(vals, times, gap, 60);
    const mark = sig === a.signal ? "  ← 声明" : "";
    console.log(`   signal=${sig.padEnd(10)} 范围=${rng.toFixed(4)}  R1逐样本=${String(r1).padStart(3)}  R3峰值=${String(r3).padStart(3)}${mark}`);
  }
  console.log("");
}
