/* _dbg-2x-perframe.js — 精确复刻生产"逐帧滑窗"，打印每次计数的事件时刻与 d 的形态 */
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

const fps = 60, freq = 1.2, win = 30, smoothK = 4, minGap = 0.3;
const N = Math.round(30 * fps);

function run(useDC) {
  const x = new Array(N);
  for (let i = 0; i < N; i++) x[i] = useDC ? 0.5 + 0.5 * Math.sin(2 * Math.PI * freq * (i / fps)) : 0.05 * Math.sin(2 * Math.PI * freq * (i / fps));
  let armed = false, lastAt = -1, reps = 0;
  const ev = [];
  const tails = Math.max(2, Math.round(fps * 0.35));
  const win3 = Math.round(3.5 * fps);
  let minTailK = Infinity, maxTailK = -Infinity;
  for (let t = 9; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const now = (t + 1) / fps;
    const tail = Math.min(d.length, tails);
    for (let i = d.length - tail; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps++; ev.push(+now.toFixed(3)); lastAt = now; } armed = false; }
    }
  }
  const gaps = []; for (let i = 1; i < ev.length; i++) gaps.push(+(ev[i] - ev[i - 1]).toFixed(3));
  return { reps, ev, gaps, rate: reps / (N / fps) };
}

for (const useDC of [false, true]) {
  const r = run(useDC);
  console.log(`\n=== ${useDC ? "x = 0.5 + 0.5·sin (含DC偏置，合成重演用)" : "x = 0.05·sin (纯AC正弦)"} f=${freq}Hz ===`);
  console.log(`reps=${r.reps}  平均 ${(r.rate * 60).toFixed(1)} 次/分  输入周期=${(1 / freq).toFixed(3)}s(${(1 / freq * fps).toFixed(0)}帧)  半周期=${(0.5 / freq).toFixed(3)}s`);
  console.log(`事件时刻(前16): ${r.ev.slice(0, 16).join(", ")}`);
  console.log(`事件间隔(前16): ${r.gaps.slice(0, 16).join(", ")}`);
  const hist = {}; for (const g of r.gaps) { const b = (Math.round(g * 20) / 20).toFixed(2); hist[b] = (hist[b] || 0) + 1; }
  console.log(`间隔直方: ${Object.entries(hist).sort().map(([a, b]) => a + "s×" + b).join("  ")}`);
}
