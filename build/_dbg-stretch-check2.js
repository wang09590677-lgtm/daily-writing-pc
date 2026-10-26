/* _dbg-stretch-check2.js — 校验 boundary6 的 timeStretch 与 boundary7 的 stretchToFreq 哪个对 */
"use strict";
function domPeriod(v, fps) { const fin = v.filter(Number.isFinite); if (fin.length < 20) return null; const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  let bl = 0, best = -Infinity; const maxLag = Math.min(Math.round(fps * 6), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.1); lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; s /= (x.length - lag); if (s > best) { best = s; bl = lag; } } return bl ? bl / fps : null; }
/* boundary6 版（有疑） */
function timeStretch6(src, p0, pT, targetLen) { const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) { const u = i * pT / p0; const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u); out[i] = src[i0] * (1 - fr) + src[i1] * fr; } return out; }
/* boundary7 版 */
function stretchToFreq(src, srcPeriodSec, f, srcFps, targetLen) { const targetPeriodSamples = (1 / f) * srcFps; const srcPeriodSamples = srcPeriodSec * srcFps; const k = targetPeriodSamples / srcPeriodSamples;
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) { const u = i / k; const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u); out[i] = src[i0] * (1 - fr) + src[i1] * fr; } return out; }
/* 修正版：明确"源周期 p0 秒 → 目标周期 pT 秒" */
function stretchFixed(src, p0, pT, targetLen, fps) { const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) { const u = i * (p0 / pT); const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u); out[i] = src[i0] * (1 - fr) + src[i1] * fr; } return out; }

const SRC = 24, N = Math.round(30 * SRC);
/* 造一个已知周期 0.5s(2Hz) 的源 */
const p0 = 0.5; const src = []; for (let i = 0; i < Math.round(6 * SRC); i++) src.push(Math.sin(2 * Math.PI * (1 / p0) * (i / SRC)));
console.log(`源周期 p0=${p0}s (${1 / p0}Hz)\n`);
console.log("目标Hz | boundary6版实测 | boundary7版实测 | 修正版实测");
console.log("-".repeat(62));
for (const f of [0.5, 0.9, 1.2, 1.71, 2.5]) {
  const a = timeStretch6(src, p0, 1 / f, N);
  const b = stretchToFreq(src, p0, f, SRC, N);
  const c = stretchFixed(src, p0, 1 / f, N, SRC);
  console.log(String(f).padEnd(7) + (1 / domPeriod(a, SRC)).toFixed(3).padEnd(17) + (1 / domPeriod(b, SRC)).toFixed(3).padEnd(17) + (1 / domPeriod(c, SRC)).toFixed(3));
}
