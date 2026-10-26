/* 【波形鉴定】开合跳"计数偏高"的根因到底是 (a) 2× 重扫，还是 (b) width 信号本身
 * 一个动作周期含两个峰（双峰），导致迟滞过零每周期数两次？
 *
 * 这个区分是**决定性的**：
 *   · 若是 (a) → F 修法（单样本增量）能修，采纳 F。
 *   · 若是 (b) → F 修不掉（F 也数两个峰），必须另想办法（换信号 / 特殊相位判据）。
 *
 * 手段：把真实序列逐帧打印成字符波形（上下对称），并标出"引擎迟滞过零"在哪些帧
 * 触发了计数，一眼就能看出计数是不是落在真实的动作相位上。
 * 只读 _lm.json。 */
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
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function detrend(raw, win) {
  const out = new Array(raw.length), half = Math.max(1, Math.floor(win / 2));
  const gstd = std(raw) || 1;
  for (let i = 0; i < raw.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) { s += raw[j]; n++; }
    out[i] = (raw[i] - s / n) / gstd;
  }
  return out;
}
// 带迟滞的过零计数，返回每次计数的帧号
function countFrames(raw, win, gapF, skipFrames) {
  const smoothK = 4;                      // 60fps * 0.06 ≈ 4（此处按 24fps 近似）
  const d = smooth(detrend(raw, win), smoothK);
  const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
  const k = clamp(rms * 0.85, 0.45, 2.2);
  let armed = false, last = -1e9; const hits = [];
  for (let i = skipFrames; i < d.length; i++) {
    const v = d[i];
    if (v < -k) armed = true;
    else if (v > k && armed) {
      if (i - last >= gapF) { hits.push(i); last = i; }
      armed = false;
    }
  }
  return { hits, k, d };
}

function draw(label, raw, win, gapF, minGapSec) {
  const gapF_ = Math.round(minGapSec * FPS);
  const { hits, k, d } = countFrames(raw, win, gapF_, 0);
  console.log(`\n========== ${label}  win=${win}帧 minGap=${minGapSec}s(${gapF_}帧)  k=${k.toFixed(2)} ==========`);
  console.log(`计数=${hits.length}  触发帧: ${hits.join(",")}`);
  // 字符波形
  const lo = Math.min(...d), hi = Math.max(...d);
  const nrm = x => Math.round((x - lo) / (hi - lo + 1e-9) * 20);
  const rows = 21;
  const grid = Array.from({ length: rows }, () => new Array(d.length).fill(" "));
  for (let i = 0; i < d.length; i++) grid[20 - nrm(d[i])][i] = "·";
  // 标出阈值线
  for (let i = 0; i < d.length; i++) {
    const rp = 20 - nrm(k), rn = 20 - nrm(-k);
    if (grid[rp] && grid[rp][i] === " ") grid[rp][i] = "+";
    if (grid[rn] && grid[rn][i] === " ") grid[rn][i] = "-";
  }
  // 标出计数的帧
  for (const h of hits) if (grid[20] && d[h] !== undefined) grid[20 - nrm(d[h])][h] = "★";
  for (let r = 0; r < rows; r++) console.log("  |" + grid[r].join(""));
  // 每 12 帧一个刻度
  let axis = "", t = "";
  for (let i = 0; i < d.length; i += 12) { const s = `${i}`.padEnd(12, " ").slice(0, 12); axis += s; }
  console.log("  +" + "-".repeat(d.length));
  console.log("   " + axis);
  return { hits, k };
}

// 开合跳：宽度信号（引擎所用）
const jjW = fill(span("jumpingJacks", [11, 12, 23, 24], 0));   // 双肩双髋 x 跨度
const jjW2 = fill(span("jumpingJacks", [27, 28], 0));          // 双踝 x 跨度
const jjWrist = fill(col("jumpingJacks", [15, 16], 1));        // 腕 y
const jjHandFoot = (() => { const a = col("jumpingJacks", [27, 28], 1), w = col("jumpingJacks", [15, 16], 1); return a.map((v, i) => v - w); })();

draw("开合跳 · width(肩髋x跨度)  [引擎当前用这个]", jjW, 40, 0, 0.45);
draw("开合跳 · 踝x跨度(27,28)", jjW2, 40, 0, 0.45);
draw("开合跳 · 腕y均值(15,16)  [手举起放下]", jjWrist, 40, 0, 0.45);
draw("开合跳 · 腕-踝垂直距离  [复合单峰量]", jjHandFoot, 40, 0, 0.45);

// 数值表：一个周期的样本，人工核对
console.log("\n=== 开合跳 width 逐帧数值（前 60 帧，每帧一行），★ = 引擎计数点 ===");
const { hits: h1 } = countFrames(jjW, 40, 11, 0);
for (let i = 0; i < Math.min(60, jjW.length); i++) {
  const mark = h1.includes(i) ? " ★计数" : "";
  const bar = "█".repeat(Math.round((jjW[i] - Math.min(...jjW)) / (Math.max(...jjW) - Math.min(...jjW) + 1e-9) * 40));
  console.log(`  ${String(i).padStart(3)}  ${jjW[i].toFixed(4)}  ${bar}${mark}`);
}
