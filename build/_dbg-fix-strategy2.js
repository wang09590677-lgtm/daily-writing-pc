/* _dbg-fix-strategy2.js — 精确定位 2× 的机制并测试更强候选 */
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

const fps = 60, smoothK = 4, N = Math.round(30 * fps);
const win3 = Math.round(3.5 * fps), tails = Math.max(2, Math.round(fps * 0.35));

/* ---- 生产复刻（对照） ---- */
function prod(x, win, minGap, kMul) {
  kMul = kMul || 0.85;
  let armed = false, lastAt = -1, reps = 0; const ev = [];
  for (let t = 9; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * kMul, 0.45, 2.2);
    const now = (t + 1) / fps;
    const tail = Math.min(d.length, tails);
    for (let i = d.length - tail; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps++; ev.push(+(now).toFixed(3)); lastAt = now; } armed = false; }
    }
  }
  return { reps, ev };
}
/* ---- 候选 F：单样本增量更新（每个新样本只处理一次，不重扫历史 tail） ---- */
function incr2(x, win, minGap, kMul) {
  kMul = kMul || 0.85;
  let armed = false, lastAt = -1, reps = 0; const ev = [];
  let processed = 9;
  for (let t = 9; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * kMul, 0.45, 2.2);
    const base = t - d.length + 1;
    const now = (t + 1) / fps;
    const start = Math.max(0, processed + 1 - base);
    for (let i = start; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps++; ev.push(+now.toFixed(3)); lastAt = now; } armed = false; }
    }
    processed = base + d.length - 1;
  }
  return { reps, ev };
}

function build(freq, plat) {
  const x = new Array(N);
  for (let i = 0; i < N; i++) { const p = (1 - Math.cos(2 * Math.PI * freq * (i / fps))) / 2;
    x[i] = plat ? Math.min(1, Math.max(0, (p - 0.2) / 0.6)) : p; }
  return x;
}
const FS = [0.6, 0.8, 0.9, 1.0, 1.2, 1.4, 1.5, 1.8, 2.0, 2.2];
console.log("=== 机制验证：现状 vs 单样本增量更新（jumpRope win=30/minGap=0.3）===\n");
console.log("频率".padEnd(7) + "真值".padEnd(6) + "现状reps".padEnd(9) + "现状比值".padEnd(9) + "增量reps".padEnd(9) + "增量比值");
console.log("-".repeat(60));
for (const f of FS) {
  const x = build(f, false);
  const p = prod(x, 30, 0.3);
  const q = incr2(x, 30, 0.3);
  const truth = Math.round(f * 30);
  console.log(String(f).padEnd(7) + String(truth).padEnd(6) + String(p.reps).padEnd(9) + (p.reps / truth).toFixed(2).padEnd(9) + String(q.reps).padEnd(9) + (q.reps / truth).toFixed(2));
}
console.log("\n对照平台波形：");
for (const f of [1.0, 1.2]) {
  const x = build(f, true);
  const p = prod(x, 30, 0.3), q = incr2(x, 30, 0.3);
  const truth = Math.round(f * 30);
  console.log(`f=${f} 现状=${p.reps}(${(p.reps / truth).toFixed(2)}) 增量=${q.reps}(${(q.reps / truth).toFixed(2)})`);
}
