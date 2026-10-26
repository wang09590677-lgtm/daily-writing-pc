/* ==================================================================
 * _dbg-detrend-pure.js — 纯数学隔离：detrend+迟滞对"纯正弦"到底产不产生 2×
 *
 * 不接姿态链路、不接引擎。直接把 x(t)=A*sin(2πft) 喂给与引擎逐字一致的
 * detrend/smooth/迟滞过零，逐帧计数。目的是把 2× 的成因从"姿态映射/抖动"
 * 里彻底剥离，判断它是否是 detrend 归一化+阈值造成的纯数学效应。
 *
 * 同时统计：d 的符号变化次数、d 穿越 ±k 的次数、每次计数的 now。
 * ================================================================== */
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

function run(freq, fps, secs, win, smoothK, minGap, amp, dc, useDetrend) {
  const N = Math.round(fps * secs);
  const x = new Array(N); for (let i = 0; i < N; i++) x[i] = dc + amp * Math.sin(2 * Math.PI * freq * (i / fps));
  let armed = false, lastAt = -1, reps = 0; const events = [];
  const tails = Math.max(2, Math.round(fps * 0.35));
  const win3 = Math.round(3.5 * fps);
  let posCross = 0, negCross = 0, signChanges = 0;
  for (let t = 9; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    if (raw.length < 10) continue;
    let d = useDetrend === false ? raw.slice() : detrend(raw, win);
    if (useDetrend === false) { const m = raw.reduce((a, b) => a + b, 0) / raw.length; d = raw.map(v => v - m); }
    d = smooth(d, smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const now = (t + 1) / fps;
    const tail = Math.min(d.length, tails);
    for (let i = d.length - tail; i < d.length; i++) {
      const v = d[i];
      if (v > k) { posCross++; if (armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps++; events.push(+now.toFixed(3)); lastAt = now; } armed = false; } }
      else if (v < -k) { negCross++; armed = true; }
    }
  }
  return { reps, events, posCross, negCross };
}
/* 逻辑过零（不带迟滞）的净符号变化，作为"d 的基频"证据 */
function signChangesOfD(freq, fps, secs, win, smoothK) {
  const N = Math.round(fps * secs); const x = new Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * freq * (i / fps));
  const win3 = Math.round(3.5 * fps); let sc = 0;
  // 取稳态最后一段，统计 d 的符号变化
  for (let t = N - 1; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    const d = smooth(detrend(raw, win), smoothK);
    const from = Math.round(d.length * 0.25);
    const mean = d.slice(from).reduce((a, b) => a + b, 0) / d.slice(from).length;
    for (let i = from + 1; i < d.length; i++) if ((d[i - 1] - mean) * (d[i] - mean) < 0) sc++;
  }
  return sc;
}

const ENG = 60, smoothK = 4, minGap = 0.3, win = 30;
console.log("=== 纯数学正弦：detrend+迟滞（win=30帧/0.5s，smoothK=4，minGap=0.3，30s，fps=60）===\n");
console.log("频率Hz | 周期数 | reps | 比值 | d的符号变化(稳态2.5s内) | 折算d基频Hz | +k穿越 | -k穿越");
console.log("-".repeat(104));
for (const f of [0.5, 0.75, 0.875, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0]) {
  const r = run(f, ENG, 30, win, smoothK, minGap, 0.05, 0, true);
  const cyc = Math.round(f * 30);
  const sc = signChangesOfD(f, ENG, 30, win, smoothK);
  const dFreq = (sc / 2) / 2.5;
  console.log(String(f).padEnd(7) + String(cyc).padEnd(8) + String(r.reps).padEnd(6) + (r.reps / cyc).toFixed(2).padEnd(7) + String(sc).padEnd(26) + dFreq.toFixed(2).padEnd(14) + String(r.posCross).padEnd(9) + r.negCross);
}

console.log("\n=== 对照：关掉 detrend（仅减整段均值）===\n");
console.log("频率Hz | reps | 比值");
console.log("-".repeat(26));
for (const f of [0.9, 1.2, 1.5, 2.0]) {
  const r = run(f, ENG, 30, win, smoothK, minGap, 0.05, 0, false);
  console.log(String(f).padEnd(7) + String(r.reps).padEnd(6) + (r.reps / Math.round(f * 30)).toFixed(2));
}

console.log("\n=== win 扫描（f=1.2Hz）——纯数学 ===\n");
console.log("win帧 | win/周期 | reps | 比值");
console.log("-".repeat(32));
for (const w of [6, 12, 18, 24, 30, 36, 48, 60, 90]) {
  const r = run(1.2, ENG, 30, w, smoothK, minGap, 0.05, 0, true);
  console.log(String(w).padEnd(7) + ((w / ENG) * 1.2).toFixed(3).padEnd(10) + String(r.reps).padEnd(6) + (r.reps / 36).toFixed(2));
}
