/* ==================================================================
 * _exp-fix-variants.js — 根因修法 F 的形态扫描（只读产品，纯 Node）
 *
 * 背景：
 *   现状根因 = 每帧重扫 d 尾部 0.35s 陈旧样本 → 同一 +k 平台反复计数(2×)。
 *   F  = 每样本只处理一次（消除重扫）—— 但只在"样本刚出现在窗口最右端"时求值，
 *        该端 detrend 均值窗被右裁剪 → 真实带噪信号上系统性少计。
 *   F′ = 每样本只处理一次，且延迟 D 帧、待其获得更居中的窗口后再求值。
 *
 * 本脚本扫描两个形态参数：
 *   delay：D 帧延迟（0=右端即 F；half=完整居中；smoothK=极小延迟）
 *   kFloor：迟滞绝对下限（现状 0.45；居中后慢速动作 |d| 会跌破 → 需略降）
 * 指标：① 12 动作 × 5 拍速 >1.5 星数（越小越好）
 *       ② band 地板最低比值（越接近 1 越好，0 = 完全漏计）
 *       ③ 真实视频 5 样本 |偏差| 最大值（≤2 达标）
 *       ④ 抗误计必须全 0
 * 输出 build/_exp-fix-variants.json
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const FPS = 60;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function detrend(raw, win) {
  const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gs = 0; for (let i = 0; i < raw.length; i++) gs += raw[i]; const gm = gs / raw.length;
  let gv = 0; for (let i = 0; i < raw.length; i++) gv += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gv / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1); let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; }
  return out;
}
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length); for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }
const WIN3 = Math.round(3.5 * FPS), TAIL = Math.max(2, Math.round(FPS * 0.35)), SMOOTH_K = Math.max(1, Math.round(FPS * 0.06));
function winOf(bm) { return clamp(Math.round(FPS * 60 / Math.max(15, bm)), 3, Math.round(FPS * 1.5)); }

function runCounter(sig, height, profile, cfg) {
  cfg = cfg || {};
  const win = winOf(cfg.winMode === "bandMin" ? profile.tempoBand[0] : profile.tempoBand[1]);
  const kMul = cfg.kMul || 0.85, kAbsFloor = cfg.kAbsFloor || 0.45;
  const ea = profile.expectedAmplitude;
  const hMean = height && height.length ? mean(height.filter(Number.isFinite)) : 0.6;
  const gate = ea * 0.5 * clamp((hMean || 0.6) / 0.6, 1.0, 1.5);
  const half = Math.floor(win / 2);
  const mode = cfg.mode || "status";
  const delay = mode === "incrC" ? (cfg.delay != null ? cfg.delay : half) : 0;
  let armed = false, lastAt = -1, reps = 0, processedAbs = -1;
  for (let t = 0; t < sig.length; t++) {
    const from = Math.max(0, t + 1 - WIN3); const raw = sig.slice(from, t + 1);
    if (raw.length < 10) continue;
    if (Math.max(...raw) - Math.min(...raw) < gate) { armed = false; continue; }
    const d = smooth(detrend(raw, win), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * kMul, kAbsFloor, 2.2);
    const base = t + 1 - raw.length, now = (t + 1) / FPS;
    let lo, hi;
    if (mode === "incrC") { const target = t - delay; if (target < 0) continue; hi = target - base; lo = Math.max(0, processedAbs + 1 - base); if (hi < lo) continue; }
    else if (mode === "incr") { lo = Math.max(0, processedAbs + 1 - base); hi = d.length - 1; }
    else { lo = d.length - Math.min(d.length, TAIL); hi = d.length - 1; }
    for (let i = lo; i <= hi; i++) {
      if (i < 0 || i >= d.length) continue; const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= profile.minRepGap) { reps++; lastAt = now; } armed = false; }
    }
    processedAbs = base + hi;
  }
  return reps;
}

const ACTIONS = [
  { id: "halfSquatWarm", cn: "半蹲热身", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 },
  { id: "jumpingJacks", cn: "开合跳", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 },
  { id: "jumpRope", cn: "跳绳", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 },
  { id: "squat", cn: "徒手深蹲", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 },
  { id: "lunge", cn: "弓步蹲", signal: "height", tempoBand: [12, 36], minRepGap: 1.1, expectedAmplitude: 0.12 },
  { id: "calfRaise", cn: "提踵", signal: "height", tempoBand: [20, 55], minRepGap: 0.7, expectedAmplitude: 0.045 },
  { id: "gluteBridge", cn: "臀桥", signal: "height", tempoBand: [15, 40], minRepGap: 1.0, expectedAmplitude: 0.08 },
  { id: "stepUp", cn: "台阶踏步", signal: "centroidY", tempoBand: [15, 40], minRepGap: 1.1, expectedAmplitude: 0.09 },
  { id: "abWheel", cn: "跪姿健腹轮", signal: "centroidY", tempoBand: [8, 25], minRepGap: 1.2, expectedAmplitude: 0.10 },
  { id: "deadBug", cn: "死虫式", signal: "height", tempoBand: [10, 30], minRepGap: 1.2, expectedAmplitude: 0.06 },
  { id: "burpee", cn: "波比跳", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 0.16 },
  { id: "lateralHop", cn: "侧向跳", signal: "width", tempoBand: [40, 100], minRepGap: 0.45, expectedAmplitude: 0.18 }
];
const SECS = 20, N = Math.round(SECS * FPS);
function synth(f, ea) { const x = new Array(N); for (let i = 0; i < N; i++) x[i] = ea * 0.5 * (1 - Math.cos(2 * Math.PI * f * (i / FPS))); return x; }

const serData = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const FALSE_CASES = [["A_static_2m", "完全静止"], ["B_noise06_2m", "噪0.6px@2m"], ["C_noise12_2m", "噪1.2px@2m"], ["C2_noise20_2m", "噪2.0px@2m"], ["G_noise12_4m", "噪1.2px@4m"]];
const RS = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

const VARIANTS = [
  { key: "现状", cfg: { mode: "status" } },
  { key: "F  延迟0 k0.45", cfg: { mode: "incr", kAbsFloor: 0.45 } },
  { key: "F  延迟0 k0.35", cfg: { mode: "incr", kAbsFloor: 0.35 } },
  { key: "F′ 延迟half k0.45", cfg: { mode: "incrC", delay: null, kAbsFloor: 0.45 } },
  { key: "F′ 延迟half k0.30", cfg: { mode: "incrC", delay: null, kAbsFloor: 0.30 } },
  { key: "F′ 延迟half k0.20", cfg: { mode: "incrC", delay: null, kAbsFloor: 0.20 } },
  { key: "F+win由band0", cfg: { mode: "incr", winMode: "bandMin", kAbsFloor: 0.45 } },
  { key: "F′+win由band0 k0.45", cfg: { mode: "incrC", delay: null, winMode: "bandMin", kAbsFloor: 0.45 } },
  { key: "F′+win由band0 k0.20", cfg: { mode: "incrC", delay: null, winMode: "bandMin", kAbsFloor: 0.20 } }
];

const rows = [];
for (const V of VARIANTS) {
  const cfgBase = Object.assign({}, V.cfg);
  let stars = 0, floorMin = 99, floorMinInfo = "";
  for (const A of ACTIONS) {
    const b0 = A.tempoBand[0] / 60, b1 = A.tempoBand[1] / 60;
    const win = winOf(A.tempoBand[1]);
    const cfg = Object.assign({}, cfgBase);
    if (cfg.delayFrac != null) cfg.delay = cfg.delayFrac < 0 ? SMOOTH_K : Math.floor(win * cfg.delayFrac);
    if (cfg.delay === null) cfg.delay = Math.floor(win / 2);
    for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
      const f = b0 + (b1 - b0) * t; const reps = runCounter(synth(f, A.expectedAmplitude), null, A, cfg);
      const truth = Math.round(f * SECS); const ratio = truth ? reps / truth : 0;
      if (ratio > 1.5) stars++;
      if (t === 0 && ratio < floorMin) { floorMin = ratio; floorMinInfo = A.cn; }
    }
  }
  // false count
  let fcBad = 0;
  for (const [id, label] of FALSE_CASES) {
    const c = serData[id]; if (!c || !c.series) continue;
    const ser = c.series.filter(r => isFinite(r.width));
    const cfg = Object.assign({}, cfgBase);
    if (cfg.delayFrac != null) cfg.delay = cfg.delayFrac < 0 ? SMOOTH_K : Math.floor(winOf(c.profile.tempoBand[1]) * (cfg.delayFrac < 0 ? 0 : cfg.delayFrac));
    if (cfg.delay === null) cfg.delay = Math.floor(winOf(c.profile.tempoBand[1]) / 2);
    if (runCounter(ser.map(r => r.width), ser.map(r => r.height), c.profile, cfg) !== 0) fcBad++;
  }
  // real video
  let realMax = 0, realStr = [];
  for (const id of Object.keys(RS.acts)) {
    const a = RS.acts[id];
    const cfg = Object.assign({}, cfgBase);
    if (cfg.delayFrac != null) cfg.delay = cfg.delayFrac < 0 ? SMOOTH_K : Math.floor(winOf(a.profile.tempoBand[1]) * (cfg.delayFrac < 0 ? 0 : cfg.delayFrac));
    if (cfg.delay === null) cfg.delay = Math.floor(winOf(a.profile.tempoBand[1]) / 2);
    const reps = runCounter(a.series.map(r => r[a.signal]), a.series.map(r => r.height), a.profile, cfg);
    const dev = Math.abs(reps - a.repsGateOn); if (dev > realMax) realMax = dev;
    realStr.push(a.cn.slice(0, 2) + reps);
  }
  rows.push({ key: V.key, stars, floorMin: +floorMin.toFixed(2), floorMinInfo, fcBad, realMax, real: realStr.join("/") });
}

const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
const padL = (s, n) => { s = String(s); while (s.length < n) s = " " + s; return s; };
console.log("=== 根因修法 F 形态扫描：三组回归指标 ===");
console.log("（① 星数=12动作×5拍速里>1.5的格子数，0最好 ② band地板最低比值，越接近1越好 ③ 抗误计坏例数，0最好 ④ 真实视频|偏差|最大，≤2达标）\n");
console.log(pad("变体", 26) + padL("①星数/60", 10) + padL("②地板最低", 10) + padL("地板动作", 16) + padL("③误计坏", 9) + padL("④真实偏差", 10) + "  真实5样本reps");
console.log("-".repeat(110));
for (const r of rows) console.log(pad(r.key, 26) + padL(r.stars, 10) + padL(r.floorMin.toFixed(2), 10) + padL(r.floorMinInfo, 16) + padL(r.fcBad, 9) + padL(r.realMax, 10) + "  " + r.real);
fs.writeFileSync(path.join(__dirname, "_exp-fix-variants.json"), JSON.stringify({ rows, ref: "现状真实: " + Object.keys(RS.acts).map(id => RS.acts[id].cn + RS.acts[id].repsGateOn).join("/") }, null, 2));
console.log("\n结果已写入 build/_exp-fix-variants.json");
