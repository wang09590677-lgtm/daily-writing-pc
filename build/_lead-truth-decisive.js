/* 【决定性真值实验】开合跳/跳绳到底做了几次？—— 用互相独立的物理量交叉，并把
 * 周期时长直方图打出来，任何人可复核。这是裁定 F 修法是否可采纳的地基。
 *
 * 为什么要这么小心：
 *   现状引擎开合跳=10~11、F 修法=5~6。若真值=12 → F 是灾难（砍半）；
 *   若真值=6  → F 是修复。两个口径差 2 倍，不能靠单一方法。
 *
 * 独立量（开合跳）：
 *   A. width = 关键点 x 跨度（引擎用的就是它）
 *   B. 腕 y 均值(15,16) —— 一次开合跳手举过头一次
 *   C. 踝 x 跨度(27,28) —— 一次开合跳两脚分开一次
 *   D. 手-脚垂直距离 (腕y - 踝y) —— 复合量，一次开合跳一个峰
 *   E. FFT 主频 × 时长（全局，对局部抖动免疫）
 * 每个量都报「极小值个数 / 极大值个数 / 中位周期(帧) / FFT周期数」。
 * 只读 _tmp/_lm.json。 */
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
function span(name, idxs, axis) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite);
    out.push(vs.length < 2 ? NaN : Math.max(...vs) - Math.min(...vs));
  }
  return out;
}
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : (n < o.length ? a[n] : 0)); } return o; }
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }

// 局部极值：minGapFrames 内只留最极端的那个；prom 为相对幅度门限
function extrema(a, minGapFrames, prom, wantMin) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) {
    const is = wantMin ? (a[i] <= a[i - 1] && a[i] < a[i + 1]) : (a[i] >= a[i - 1] && a[i] > a[i + 1]);
    if (!is) continue;
    if (idx.length && i - idx[idx.length - 1] < minGapFrames) {
      const better = wantMin ? a[i] < a[idx[idx.length - 1]] : a[i] > a[idx[idx.length - 1]];
      if (better) idx[idx.length - 1] = i;
    } else idx.push(i);
  }
  return idx.filter(i => {
    const lo = Math.max(0, i - 20), hi = Math.min(a.length, i + 20);
    const sl = a.slice(lo, hi);
    const ref = wantMin ? Math.max(...sl) : Math.min(...sl);
    return Math.abs(ref - a[i]) >= prom;
  });
}
function medGap(idx) { if (idx.length < 2) return NaN; const g = []; for (let i = 1; i < idx.length; i++) g.push(idx[i] - idx[i - 1]); g.sort((x, y) => x - y); return g[Math.floor(g.length / 2)]; }
function fftMain(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n);
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(ang * k), wi = Math.sin(ang * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi; const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
  let best = 1, bv = -1;
  for (let i = 2; i < n / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > bv) { bv = p; best = i; } }
  return best * fps / n;
}

const SUITE = {
  jumpingJacks: [
    ["A width=x跨度(引擎用)", () => span("jumpingJacks", [11, 12, 23, 24, 27, 28], 0), 3, 0.05],
    ["B 腕y均值(15,16)", () => col("jumpingJacks", [15, 16], 1), 4, 0.02],
    ["C 踝x跨度(27,28)", () => span("jumpingJacks", [27, 28], 0), 4, 0.01],
    ["D 腕y-踝y 距离", () => { const w = col("jumpingJacks", [15, 16], 1), a = col("jumpingJacks", [27, 28], 1); return w.map((v, i) => a[i] - v); }, 4, 0.015],
  ],
  jumpRope: [
    ["A height=y跨度(引擎用)", () => span("jumpRope", [11, 12, 23, 24, 27, 28], 1), 3, 0.05],
    ["B 踝y(27,28)", () => col("jumpRope", [27, 28], 1), 3, 0.01],
    ["C 腕y(15,16)", () => col("jumpRope", [15, 16], 1), 3, 0.008],
  ],
};

for (const name of Object.keys(SUITE)) {
  const dur = LM.acts[name].frames.length / FPS;
  console.log(`\n================= ${LM.acts[name].cn} (${name})  时长 ${dur.toFixed(2)}s @24fps =================`);
  console.log("物理量                     极小值  极大值  中位周期(帧)  中位周期(s)  →频率/分   FFT主频→周期数");
  const votes = [];
  for (const [label, fn, gapF, prom] of SUITE[name]) {
    const v = fill(fn());
    const s3 = smooth(v, 3);
    const mn = extrema(s3, gapF, prom, true), mx = extrema(s3, gapF, prom, false);
    const gMin = medGap(mn), gMax = medGap(mx);
    const f = fftMain(v, FPS), cyc = f * dur;
    const rate = Number.isFinite(gMin) ? (60 / (gMin / FPS)) : NaN;
    console.log(
      `${label.padEnd(26)} ${String(mn.length).padStart(5)} ${String(mx.length).padStart(6)}   ${String(gMin).padStart(8)}帧  ${Number.isFinite(gMin) ? (gMin / FPS).toFixed(3).padStart(7) : "   ----"}s  ${Number.isFinite(rate) ? rate.toFixed(0).padStart(7) : "    ----"}/分   ${f.toFixed(2)}Hz→${cyc.toFixed(1)}`
    );
    votes.push({ label, min: mn.length, max: mx.length, fft: cyc, period: gMin });
  }
  const all = [];
  for (const v of votes) { all.push(v.min, v.max, v.fft); }
  all.sort((a, b) => a - b);
  console.log(`  → 所有量×所有口径的计数集合：{ ${all.map(x => x.toFixed(1)).join(", ")} }  中位≈${all[Math.floor(all.length / 2)].toFixed(1)}`);
}
