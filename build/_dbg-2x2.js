/* 【2×2 归因】欠计到底是「因果均值」造成，还是「水位线 oneshot」造成？
 *
 * 修复动了两个地方：
 *   改动① detrend：居中均值 → 因果（后向）均值
 *   改动② detectReps：删尾部重扫 → 水位线 scannedT「每样本只判一次」
 * 已有 D = 两者都不改（基线），C = 两者都改（现行）。
 * 本脚本补出 A、B，凑成 2×2，把责任定位到具体那一处：
 *   A = 只改①（因果均值 + 尾部重扫）
 *   B = 只改②（居中均值 + 水位线）
 * 用法：node build/_dbg-2x2.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

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
const SWT = src => src.includes("function signalWindowTimes(")
  ? g(src, "function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)")
  : "function signalWindowTimes(){ return []; }";

const cur = Object.assign(COMMON(SRC_CUR), {
  signalWindowTimes: SWT(SRC_CUR),
  detrend: g(SRC_CUR, "function detrend(raw, win)", "function smooth(raw, k)"),
  detectReps: g(SRC_CUR, "function detectReps(now)", "/* ---------- 保持类 ---------- */"),
});
const base = Object.assign(COMMON(SRC_BASE), {
  signalWindowTimes: "function signalWindowTimes(){ return []; }",
  detrend: g(SRC_BASE, "function detrend(raw, win)", "function smooth(raw, k)"),
  detectReps: g(SRC_BASE, "function detectReps(now)", "/* ---------- 保持类 ---------- */"),
});

function mkEngine(p) {
  const F = `
return function mk(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${p.SIGNALS}${p.clamp}${p.mean}${p.std}${p.signalWindowTimes}${p.signalWindow}${p.detrend}${p.smooth}${p.detectReps}
  return {
    run(seq) {
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
    }
  };
};`;
  return new Function(F)();
}

// 四组合
const V = {
  "D 都不改(基线)": mkEngine(base),
  "A 只改①因果均值": mkEngine(Object.assign({}, base, { detrend: cur.detrend })),
  "B 只改②水位线": mkEngine(Object.assign({}, cur, { detrend: base.detrend })),
  "C 都改(现行)": mkEngine(cur),
};

const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const TRUTH = { jumpingJacks: "6~7", squat: 5, halfSquatWarm: "?", jumpRope: 10, burpee: 2 };

console.log("动作".padEnd(22) + "真值".padStart(6) + Object.keys(V).map(k => k.padStart(14)).join(""));
for (const [k, e] of Object.entries(R.acts)) {
  const seq = e.series.map(s => Object.assign({}, s));
  const out = Object.keys(V).map(nm => {
    try { return String(V[nm](e.profile, 60, { height: 0.6 }).run(seq).reps).padStart(14); } catch (err) { return "ERR".padStart(14); }
  });
  console.log((e.cn + "(" + k + ")").padEnd(22) + String(TRUTH[k]).padStart(6) + out.join(""));
}

/* 跳绳单独看计数时刻，判断"漏的是哪几拍" */
console.log("\n--- 跳绳 计数时刻明细 ---");
const jr = R.acts.jumpRope, jseq = jr.series.map(s => Object.assign({}, s));
for (const nm of Object.keys(V)) {
  const r = V[nm](jr.profile, 60, { height: 0.6 }).run(jseq);
  console.log(nm.padEnd(16) + "n=" + String(r.reps).padStart(3) + "  t=" + r.trace.join(", "));
}

/* 原始 height 序列的客观峰数（人工核对用） */
console.log("\n--- 跳绳原始 height 序列（每 5 帧取一个，看客观振荡次数）---");
const hv = jr.series.map(o => o.height);
let s = "";
for (let i = 0; i < hv.length; i += 3) {
  const d = hv[i] - Math.min(...hv);
  s += d > (Math.max(...hv) - Math.min(...hv)) * 0.6 ? "#" : (d > (Math.max(...hv) - Math.min(...hv)) * 0.3 ? "+" : ".");
}
console.log("min=" + Math.min(...hv).toFixed(4) + " max=" + Math.max(...hv).toFixed(4) + " 峰峰=" + (Math.max(...hv) - Math.min(...hv)).toFixed(4));
console.log(s);
