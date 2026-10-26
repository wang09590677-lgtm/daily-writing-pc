/* _dbg-dump-d.js — 直接打印纯数学 1.2Hz 的 d 序列与计数时刻，肉眼看机制 */
"use strict";
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function detrend(raw, win) {
  const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length; let gvar = 0;
  for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; }
  return out;
}
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }

const fps = 60, freq = 1.2, secs = 30, win = 30, smoothK = 4, minGap = 0.3;
const N = Math.round(fps * secs);
const x = new Array(N); for (let i = 0; i < N; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * freq * (i / fps));
let armed = false, lastAt = -1, reps = 0; const events = [];
const tails = Math.max(2, Math.round(fps * 0.35));
const win3 = Math.round(3.5 * fps);
// 稳态：取最后 3.5s 的 d 与 k
let rawLast = null, dLast = null, kLast = 0;
for (let t = 9; t < N; t++) {
  const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
  if (raw.length < 10) continue;
  const d = smooth(detrend(raw, win), smoothK);
  const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
  const k = clamp(rms * 0.85, 0.45, 2.2);
  const now = (t + 1) / fps, tail = Math.min(d.length, tails);
  for (let i = d.length - tail; i < d.length; i++) {
    const v = d[i];
    if (v < -k) armed = true;
    else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps++; events.push(+(now).toFixed(3)); lastAt = now; } armed = false; }
  }
  if (t === N - 1) { rawLast = raw; dLast = d; kLast = k; }
}
console.log(`纯数学 f=${freq}Hz win=${win} smoothK=${smoothK} → reps=${reps} (预期~36)  k=${kLast.toFixed(3)}`);
console.log(`计数事件时刻(前20)：${events.slice(0, 20).join(", ")}`);
// 事件间隔直方图
const gaps = []; for (let i = 1; i < events.length; i++) gaps.push(+(events[i] - events[i - 1]).toFixed(3));
console.log(`事件间隔(前20)：${gaps.slice(0, 20).join(", ")}`);
// raw 与 d 的波形（各取 200 点，每点=1/60s ≈ 1.67 拍）
const ch = " .:-=+*#%@";
function ln(v, lo, hi, n) { let s = ""; for (let i = 0; i < n; i++) { const idx = Math.round((v[i] - lo) / (hi - lo) * (ch.length - 1)); s += ch[Math.max(0, Math.min(ch.length - 1, idx))]; } return s; }
const M = 200;
const rlo = Math.min(...rawLast.slice(0, M)), rhi = Math.max(...rawLast.slice(0, M));
console.log("\nraw (200点=200/60s=3.33拍, 1.2Hz→4拍):");
console.log("  " + ln(rawLast.slice(0, M), rlo, rhi, M));
const dlo = Math.min(...dLast.slice(0, M)), dhi = Math.max(...dLast.slice(0, M));
console.log("d = smooth(detrend(raw)):");
console.log("  " + ln(dLast.slice(0, M), dlo, dhi, M));
console.log(`  ±k 阈值 k=${kLast.toFixed(3)}（在 d 刻度上）`);
// 统计 d 的逻辑过零（去掉 ±k 迟滞，只看符号变化）
let sc = 0; for (let i = 1; i < dLast.length; i++) if (dLast[i - 1] * dLast[i] < 0) sc++;
console.log(`\n整段 d 的逻辑过零次数=${sc}  对应基频≈${(sc / 2 / (dLast.length / fps)).toFixed(2)}Hz`);
// 统计 d 穿越 ±k 次数（净）
let upK = 0, dnK = 0; for (let i = 1; i < dLast.length; i++) { if (dLast[i - 1] <= kLast && dLast[i] > kLast) upK++; if (dLast[i - 1] >= -kLast && dLast[i] < -kLast) dnK++; }
console.log(`整段 d 向上穿越 +k 次数=${upK}  向下穿越 -k 次数=${dnK}  （长度=${(dLast.length/fps).toFixed(2)}s）`);
