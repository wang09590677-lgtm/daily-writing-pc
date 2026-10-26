/* 跳绳为何丢拍？dump 现行 vs 基线的 detrend 输出 d 与迟滞判定符号串。
 * 用法：node build/_dbg-jumprope-wave.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

function build(file) {
  const SRC = fs.readFileSync(file, "utf8");
  const grab = (a, b) => {
    const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 30));
    return SRC.slice(i, j);
  };
  const parts = {
    SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
    clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
    mean: grab("function mean(arr)", "function std(arr)"),
    std: grab("function std(arr)", "// 动作参数默认值"),
  };
  parts.signalWindowTimes = SRC.includes("function signalWindowTimes(")
    ? grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)")
    : "function signalWindowTimes(){ return []; }";
  parts.signalWindow = grab("function signalWindow(key, seconds)", "// 去趋势：");
  parts.detrend = grab("function detrend(raw, win)", "function smooth(raw, k)");
  parts.smooth = grab("function smooth(raw, k)", "// 峰值计次");
  parts.detectReps = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");

  const F = `
return function mk(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${parts.SIGNALS}${parts.clamp}${parts.mean}${parts.std}${parts.signalWindowTimes}${parts.signalWindow}${parts.detrend}${parts.smooth}${parts.detectReps}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      const trace = [];
      for (const s of seq) {
        const d = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: 0, height: 0, bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        const row = Object.assign(d, liveInit, s); live = row;
        series.push(Object.assign({ t: s.t }, d, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        const r0 = reps; detectReps(s.t); if (reps > r0) trace.push({ t: +s.t.toFixed(2), i: series.length - 1, reps });
      }
      return { reps, gate: repGate, spread: repSpread, trace };
    },
    getD(seq, key) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repHeightBase = 0;
      for (const s of seq) {
        const d = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: 0, height: 0, bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        series.push(Object.assign({ t: s.t }, d, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
      }
      const band = cfg("tempoBand") || [20, 60];
      const win = clamp(Math.round(fps * 60 / Math.max(15, band[1])), 3, Math.round(fps * 1.5));
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const raw = signalWindow(key || cfg("signal") || "centroidY", 3.5);
      const dd = smooth(detrend(raw, win), smoothK);
      const rms = Math.sqrt(mean(dd.map(v => v * v))) || 1;
      const k = clamp(rms * 0.85, 0.45, 2.2);
      return { win, smoothK, k, rms, d: Array.from(dd), raw: Array.from(raw) };
    }
  };
};`;
  return new Function(F)();
}

const AFTER = build(path.join(ROOT, "motion-engine.js"));
const BEFORE = build(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"));
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const e = R.acts.jumpRope;
const seq = e.series.map(s => Object.assign({}, s));
console.log("跳绳 profile:", JSON.stringify(e.profile), "| 样本数", seq.length, "| 时长", seq[seq.length - 1].t.toFixed(2), "s");

for (const [nm, mk] of [["现行(oneshot)", AFTER], ["基线(tail重扫)", BEFORE]]) {
  const g = mk(e.profile, 60, { height: 0.6 }).getD(seq, "height");
  console.log("");
  console.log("=== " + nm + " === win=" + g.win + " smoothK=" + g.smoothK + " rms=" + g.rms.toFixed(3) + " k=" + g.k.toFixed(3) + " d长度=" + g.d.length);
  const d = g.d, k = g.k;
  let s = "";
  for (let i = 0; i < d.length; i++) s += d[i] > k ? "+" : (d[i] < -k ? "-" : ".");
  console.log("判定符号串（+ = 上穿阈值, - = 下穿）:");
  console.log(s);
  const r = mk(e.profile, 60, { height: 0.6 }).run(seq);
  console.log("计数=" + r.reps + "  计数时刻=" + r.trace.map(x => x.t).join(","));
}
