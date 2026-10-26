/* _dbg-2x-shape.js — 精确打印 d 序列与 armed/count 事件，弄清每周期为何计两次 */
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
const x = new Array(N); for (let i = 0; i < N; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * freq * (i / fps));
/* 取一段稳态：用最后 3.5s */
const win3 = Math.round(3.5 * fps);
const raw = x.slice(N - win3);
const d = smooth(detrend(raw, win), smoothK);
const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
const k = clamp(rms * 0.85, 0.45, 2.2);
console.log(`f=${freq}Hz win=${win} smoothK=${smoothK} → rms=${rms.toFixed(3)} k=${k.toFixed(3)}  周期=${(fps/freq).toFixed(1)}帧`);
/* 打印中段（跳过边界）1.5 个周期，每 3 帧一个点 */
const from = Math.round(win3 * 0.5), to = from + Math.round(fps / freq * 1.5);
let armed = false, lastAt = -1, reps = 0;
const marks = [];
for (let i = 0; i < d.length; i++) {
  const v = d[i];
  if (v < -k) armed = true;
  else if (v > k && armed) { reps++; lastAt = i; armed = false; }
}
console.log(`\n整段(3.5s) rms/k/逻辑过零: rms=${rms.toFixed(3)} k=${k.toFixed(3)} reps(整段单次)=${reps}`);
let sc = 0; for (let i = 1; i < d.length; i++) if (d[i - 1] * d[i] < 0) sc++;
console.log(`逻辑过零次数=${sc} 折算Hz=${(sc / 2 / (win3 / fps)).toFixed(2)}`);
console.log("\n逐点（中段 1.5 周期，每 3 帧）：值 | 相对k | 符号");
for (let i = from; i < to; i += 3) {
  const v = d[i];
  const rel = v > k ? ">+k ★" : (v < -k ? "<-k" : (v > 0 ? "0..+k" : "-k..0"));
  console.log(`  i=${String(i - from).padStart(3)}  d=${v.toFixed(3).padStart(7)}  ${rel.padEnd(7)}  sign=${v >= 0 ? "+" : "-"}`);
}
/* 事件间隔 */
function events(d, k, minGap, fps) {
  let armed = false, lastAt = -1; const ev = [];
  for (let i = 0; i < d.length; i++) { const v = d[i];
    if (v < -k) armed = true;
    else if (v > k && armed) { const t = i / fps; if (lastAt < 0 || t - lastAt >= minGap) { ev.push(+t.toFixed(3)); lastAt = t; } armed = false; } }
  return ev;
}
const ev = events(d, k, minGap, fps);
console.log(`\n事件时刻(中段): ${ev.slice(0, 12).join(", ")}`);
const gaps = []; for (let i = 1; i < ev.length; i++) gaps.push(+(ev[i] - ev[i - 1]).toFixed(3));
console.log(`事件间隔: ${gaps.slice(0, 12).join(", ")}  (输入周期=${(1/freq).toFixed(3)}s, 半周期=${(0.5/freq).toFixed(3)}s)`);
