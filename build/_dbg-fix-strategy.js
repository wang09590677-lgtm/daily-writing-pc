/* _dbg-fix-strategy.js — 在纯数学上快速验证各候选方向是否真能消 2× */
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

const fps = 60, smoothK = 4;
const N = Math.round(30 * fps);
const win3 = Math.round(3.5 * fps), tails = Math.max(2, Math.round(fps * 0.35));

/* 通用逐帧计次器，可选候选开关 */
function count(x, opt) {
  const win = opt.win, minGap = opt.minGap, kMul = opt.kMul || 0.85, useEdge = !!opt.useEdge, absFloor = opt.absFloor || 0.45;
  let armed = false, lastAt = -1, reps = 0, lastCountAbs = -1;
  for (let t = 9; t < N; t++) {
    const raw = x.slice(Math.max(0, t + 1 - win3), t + 1);
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * kMul, absFloor, 2.2);
    const now = (t + 1) / fps;
    const tail = Math.min(d.length, tails);
    const base = d.length - tail;
    for (let i = base; i < d.length; i++) {
      const absFrame = (t - d.length + 1) + i;
      if (useEdge && absFrame <= lastCountAbs) continue;   // 候选B：不吃"陈旧样本"重新 arm
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) {
        if (lastAt < 0 || now - lastAt >= minGap) { reps++; lastAt = now; }
        armed = false; lastCountAbs = absFrame;            // 记下计数发生的绝对帧
      }
    }
  }
  return reps;
}

function buildSignal(freq, kind) {
  const x = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = (1 - Math.cos(2 * Math.PI * freq * (i / fps))) / 2;
    x[i] = kind === "plat" ? Math.min(1, Math.max(0, (p - 0.2) / 0.6)) : p;
  }
  return x;
}
const WJR = 30;  // win（jumpRope band[1]=120 → 30帧）
const minGapJR = 0.3;

console.log("=== 候选方向快速验证（纯数学，jumpRope win=30/minGap=0.3，30s）===\n");
const CONFIGS = [
  { name: "现状 k=0.85rms", o: { win: WJR, minGap: minGapJR } },
  { name: "A1 k=1.2rms", o: { win: WJR, minGap: minGapJR, kMul: 1.2 } },
  { name: "A2 k=1.8rms", o: { win: WJR, minGap: minGapJR, kMul: 1.8 } },
  { name: "A3 绝对下限=0.8", o: { win: WJR, minGap: minGapJR, absFloor: 0.8 } },
  { name: "B 边沿触发(不吃陈旧)", o: { win: WJR, minGap: minGapJR, useEdge: true } },
  { name: "B+A2 边沿+1.8rms", o: { win: WJR, minGap: minGapJR, useEdge: true, kMul: 1.8 } },
];
console.log("配置".padEnd(22) + [0.6, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0].map(f => ("f=" + f).padEnd(12)).join(""));
console.log("-".repeat(22 + 7 * 12));
for (const c of CONFIGS) {
  const cells = [];
  for (const f of [0.6, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0]) {
    const x = buildSignal(f, "sine");
    const reps = count(x, c.o);
    const truth = Math.round(f * 30);
    const ratio = reps / truth;
    cells.push((ratio.toFixed(2) + (ratio >= 1.5 ? "★" : "")).padEnd(12));
  }
  console.log(c.name.padEnd(22) + cells.join(""));
}
