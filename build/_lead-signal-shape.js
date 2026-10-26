/* 【信号形态鉴定】为什么 F 在跳绳上只有 6 次（真值 10）？
 * 直接打印引擎在真机序列里**实际消费的 signal**（_realseries.json 的 width/height/centroidY），
 * 统计其自身的极值/周期，判断：是"引擎信号本身周期数就是10"，还是"信号形态导致 F 欠计"。
 *
 * 同时对比：把同一序列用现状/F 两种扫描，打印每次计数发生在哪一帧 → 看 F 漏掉了哪些拍。
 * 只读 _realseries.json + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function detrend(raw, win) {
  const out = new Array(raw.length), half = Math.max(1, Math.floor(win / 2)), gstd = std(raw) || 1;
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) { s += raw[j]; n++; } out[i] = (raw[i] - s / n) / gstd; }
  return out;
}
function counterTrace(series, win, gap, mode, fps) {
  const smoothK = Math.max(1, Math.round(fps * 0.06));
  const tailN = Math.max(2, Math.round(fps * 0.35));
  let reps = 0, lastAt = -1, armed = false; const hits = [];
  for (let f = 0; f < series.length; f++) {
    const now = series[f].t, from = now - 3.5;
    const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const start = mode === "prod" ? Math.max(0, d.length - tailN) : Math.max(0, d.length - 1);
    for (let i = start; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= gap) { reps += 1; hits.push(+now.toFixed(2)); lastAt = now; } armed = false; }
    }
  }
  return { reps, hits };
}
function extremaCount(a, gapF, prom, wantMin) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) {
    const is = wantMin ? (a[i] <= a[i - 1] && a[i] < a[i + 1]) : (a[i] >= a[i - 1] && a[i] > a[i + 1]);
    if (!is) continue;
    if (idx.length && i - idx[idx.length - 1] < gapF) { const b = wantMin ? a[i] < a[idx[idx.length - 1]] : a[i] > a[idx[idx.length - 1]]; if (b) idx[idx.length - 1] = i; } else idx.push(i);
  }
  return idx.filter(i => { const lo = Math.max(0, i - 30), hi = Math.min(a.length, i + 30); const sl = a.slice(lo, hi); const ref = wantMin ? Math.max(...sl) : Math.min(...sl); return Math.abs(ref - a[i]) >= prom; });
}
function fftMain(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n);
  const m = mean(a); for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let s = 0; s < n; s += len) for (let k2 = 0; k2 < len / 2; k2++) { const wr = Math.cos(ang * k2), wi = Math.sin(ang * k2); const ur = re[s + k2], ui = im[s + k2]; const vr = re[s + k2 + len / 2] * wr - im[s + k2 + len / 2] * wi; const vi = re[s + k2 + len / 2] * wi + im[s + k2 + len / 2] * wr; re[s + k2] = ur + vr; im[s + k2] = ui + vi; re[s + k2 + len / 2] = ur - vr; im[s + k2 + len / 2] = ui - vi; } }
  let best = 1, bv = -1; for (let i = 2; i < n / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > bv) { bv = p; best = i; } }
  return best * fps / n;
}
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } let o = out.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n2 = i + 1; while (n2 < o.length && !Number.isFinite(o[n2])) n2++; o[i] = (p >= 0 && n2 < o.length) ? (out[p] + out[n2]) / 2 : (p >= 0 ? out[p] : 0); } return o; };

const engWin = band => Math.max(3, Math.min(Math.round(60 * 60 / Math.max(15, band[1])), Math.round(60 * 1.5)));

console.log("=== 引擎实际消费的信号：自身周期数 vs 引擎计数 ===");
console.log("动作     信号       引擎信号周期(极值/FFT)   现状reps  F reps  | 物理真值(关节)");
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap;
  const win = engWin(band);
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const rawV = series.map(s => s.v);
  const s3 = smooth(rawV, 5);
  const nMin = extremaCount(s3, 8, (Math.max(...rawV) - Math.min(...rawV)) * 0.12, true).length;
  const nMax = extremaCount(s3, 8, (Math.max(...rawV) - Math.min(...rawV)) * 0.12, false).length;
  const ff = fftMain(rawV, 60) * a.secs;
  const tp = counterTrace(series, win, gap, "prod", 60);
  const tf = counterTrace(series, win, gap, "F", 60);
  const truthMap = { jumpingJacks: ["jumpingJacks", [15, 16], 1], jumpRope: ["jumpRope", [27, 28], 1], squat: ["squat", [27, 28], 1], halfSquatWarm: ["squat", [23, 24], 1], burpee: ["burpee", [27, 28], 1] };
  const [lmName, idxs, axis] = truthMap[name];
  const tv = smooth(lmCol(lmName, idxs, axis), 3);
  const tMin = extremaCount(tv, 6, 0.02, true).length;
  console.log(`${a.cn.padEnd(6)} ${sig.padEnd(10)} 极值 小${String(nMin).padStart(3)}/大${String(nMax).padStart(3)}  FFT=${ff.toFixed(1).padStart(5)}   ${String(tp.reps).padStart(4)}    ${String(tf.reps).padStart(4)}  |   ${tMin}`);
}

// 详细追踪跳绳
console.log("\n=== 跳绳（height 信号）逐次计数帧号 ===");
{
  const a = R.acts.jumpRope, band = a.profile.tempoBand, gap = a.profile.minRepGap, win = engWin(band);
  const series = a.series.map(s => ({ t: s.t, v: s.height }));
  const tp = counterTrace(series, win, gap, "prod", 60), tf = counterTrace(series, win, gap, "F", 60);
  console.log("现状计数帧(秒):", tp.hits.map(h => h.toFixed(2)).join(", "));
  console.log("F   计数帧(秒):", tf.hits.map(h => h.toFixed(2)).join(", "));
  console.log(`跳绳物理真值 = 10 次，平均间隔应≈${(a.secs / 10).toFixed(2)}s`);
  // 打印 height 数值柱状（每 3 帧）
  const v = series.map(s => s.v), lo = Math.min(...v), hi = Math.max(...v);
  console.log("\nheight 信号波形（每帧 1 字符宽，满宽 100，标 ★现状 / ☆F）：");
  const nrm = x => Math.round((x - lo) / (hi - lo + 1e-9) * 8);
  const rows = Array.from({ length: 9 }, () => new Array(v.length).fill(" "));
  for (let i = 0; i < v.length; i++) rows[8 - nrm(v[i])][i] = "·";
  const mark = (hits, ch) => { for (const h of hits) { const idx = Math.round(h * 60) - 1; if (idx >= 0 && idx < v.length) rows[8 - nrm(v[idx])][idx] = ch; } };
  mark(tp.hits, "★"); mark(tf.hits, "☆");
  for (const r of rows) console.log("  |" + r.join(""));
  console.log("  +" + "-".repeat(v.length));
}
