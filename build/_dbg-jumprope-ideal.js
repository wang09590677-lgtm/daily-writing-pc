/* 【决定性实验】跳绳的欠计，责任在「信号选错」还是「计数算法丢拍」？
 *
 * 已有事实：
 *   · 跳绳独立真值 = 10（7 个互相独立的物理量一致：腕y/踝y/髋y/鼻y/肩踝距…，中位周期 0.583s=103/分）
 *   · 引擎的 signal:"height" 用峰值法只能数出 7 次
 *   · 现行引擎（因果均值+水位线）数出 5 次；基线（居中均值+尾部重扫）数出 12 次
 *
 * 本实验：从**原始 MediaPipe 关键点**重建几个"物理上必然周期"的信号，喂给引擎。
 *   · hipY  髋部竖向位置   → 最接近引擎语义里的 centroidY（人跳起 → 变小）
 *   · ankleY 踝部竖向位置  → 脚离地，跳绳最干净的量
 *   · noseY 头部竖向位置
 * 判定标准：
 *   · 若某个重建信号能让现行引擎数出 ≈10 → **责任在"信号选错"**，修法是换 signal
 *   · 若所有重建信号都只数出 5~7 → **责任在"计数算法丢拍"**，修法是改 detectReps
 * 用法：node build/_dbg-jumprope-ideal.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const L = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

/* ---- 引擎组装（与 2×2 脚本同一手法：抠真函数原文）---- */
const SRC_CUR = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
const SRC_BASE = fs.readFileSync(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"), "utf8");
const g = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 34));
  return src.slice(i, j);
};
const COMMON = src => ({
  SIGNALS: g(src, "const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: g(src, "function clamp(v, a, b)", "function mean(arr)"),
  mean: g(src, "function mean(arr)", "function std(arr)"),
  std: g(src, "function std(arr)", "// 动作参数默认值"),
  signalWindow: g(src, "function signalWindow(key, seconds)", "// 去趋势："),
  smooth: g(src, "function smooth(raw, k)", "// 峰值计次"),
});
function mkEngine(src, causal, base) {
  const c = COMMON(src);
  const swt = src.includes("function signalWindowTimes(")
    ? g(src, "function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)")
    : "function signalWindowTimes(){ return []; }";
  const detrend = causal ? g(SRC_CUR, "function detrend(raw, win)", "function smooth(raw, k)")
    : g(SRC_BASE, "function detrend(raw, win)", "function smooth(raw, k)");
  const reps = base ? g(SRC_BASE, "function detectReps(now)", "/* ---------- 保持类 ---------- */")
    : g(SRC_CUR, "function detectReps(now)", "/* ---------- 保持类 ---------- */");
  const F = `
return function mk(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${c.SIGNALS}${c.clamp}${c.mean}${c.std}${swt}${c.signalWindow}${detrend}${c.smooth}${reps}
  return { run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      const trace = [];
      for (const s of seq) {
        const d = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: 0, height: 0, bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        series.push(Object.assign({ t: s.t }, d, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        const r0 = reps; detectReps(s.t); if (reps > r0) trace.push(+s.t.toFixed(2));
      }
      return { reps, gate: repGate, spread: repSpread, trace };
  } };
};`;
  return new Function(F)();
}
const V = {
  "现行(因果+水位线)": mkEngine(SRC_CUR, true, false),
  "基线(居中+尾部重扫)": mkEngine(SRC_BASE, false, true),
};

/* ---- 从关键点重建信号 ---- */
const IDX = { hip: [23, 24], ankle: [27, 28], knee: [25, 26], wrist: [15, 16], shoulder: [11, 12], nose: [0] };
const avgY = ids => f => { let s = 0, n = 0; for (const id of (Array.isArray(ids) ? ids : [ids])) { if (f[id]) { s += f[id][1]; n++; } } return n ? s / n : NaN; };

function resample(ds, fps) {
  if (ds.length < 3) return [];
  const t0 = ds[0].t, t1 = ds[ds.length - 1].t, n = Math.floor((t1 - t0) * fps) + 1, out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps;
    while (j < ds.length - 1 && ds[j + 1].t < t) j++;
    const a = ds[j], b = ds[Math.min(ds.length - 1, j + 1)];
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    out.push({ t, v: a.v + (b.v - a.v) * u });
  }
  return out;
}
function buildSeries(frames, pick) {
  const ds = [];
  for (let i = 0; i < frames.length; i++) { const f = frames[i]; if (!f || !f.length) continue; const v = pick(f); if (Number.isFinite(v)) ds.push({ t: i / 24, v }); }
  return resample(ds, 60);
}

const jr = R.acts.jumpRope;
const jrProfile = jr.profile;
console.log("跳绳 profile:", JSON.stringify(jrProfile));
const lmA = L.acts.jumpRope;
const frames = lmA.frames || lmA;

const BUILDS = [
  ["hip 髋y", avgY(IDX.hip)],
  ["ankle 踝y", avgY(IDX.ankle)],
  ["knee 膝y", avgY(IDX.knee)],
  ["nose 鼻y", avgY(IDX.nose)],
  ["wrist 腕y", avgY(IDX.wrist)],
  ["shoulder 肩y", avgY(IDX.shoulder)],
];

console.log("\n把重建信号喂给两个引擎（映射成引擎的 centroidY；height 同时给 0.6 常量以隔离 bodyScale）");
console.log("信号".padEnd(14) + "样本".padStart(5) + "峰峰".padStart(9) + "真值峰值".padStart(9) +
  Object.keys(V).map(k => k.padStart(20)).join(""));
for (const [name, pick] of BUILDS) {
  const ds = buildSeries(frames, pick);
  if (ds.length < 10) { console.log(name + "  样本不足"); continue; }
  const vs = ds.map(o => o.v);
  const pp = Math.max(...vs) - Math.min(...vs);
  // 独立峰值数（简单局部极大 + 最小间隔）
  let pk = 0, lastT = -9;
  for (let i = 2; i < ds.length - 2; i++) {
    const v = ds[i].v;
    if (v > ds[i - 1].v && v >= ds[i + 1].v && v > ds[i - 2].v && v >= ds[i + 2].v) {
      if (ds[i].t - lastT > 0.3) { pk++; lastT = ds[i].t; }
    }
  }
  // ★ 关键：profile 声明的信号是 "height"，所以要写进 height 字段才读得到。
  //   但 live.height 保持 0.6（run() 里 live 从不更新），把 bodyScale 隔离成 1.0，
  //   这样门限恒为 expectedAmplitude×0.5，不会随重建信号的绝对量级漂移。
  const seq = ds.map(o => ({ t: o.t, height: o.v, centroidY: o.v, width: 0.3, motion: 0, area: 0.1 }));
  const cells = Object.keys(V).map(nm => {
    try { const r = V[nm](jrProfile, 60, { height: 0.6 }).run(seq); return `${r.reps} (k=${r.gate.toFixed(3)},s=${r.spread.toFixed(3)})`.padStart(20); }
    catch (e) { return "ERR".padStart(20); }
  });
  console.log(name.padEnd(14) + String(ds.length).padStart(5) + pp.toFixed(4).padStart(9) + String(pk).padStart(9) + cells.join(""));
}

console.log("\n[参照] 引擎实吃的 height 信号（已记录的 363 样本）");
const hseq = jr.series.map(s => Object.assign({}, s));
for (const nm of Object.keys(V)) {
  const r = V[nm](jrProfile, 60, { height: 0.6 }).run(hseq);
  console.log("  " + nm.padEnd(20) + "n=" + String(r.reps).padStart(3) + "  t=" + r.trace.join(", "));
}
console.log("\n真值 = 10（7 个独立物理量一致，中位周期 0.583s）");
