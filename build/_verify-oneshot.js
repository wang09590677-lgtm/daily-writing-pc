/* 【verifier-oneshot 独立验证脚本】—— 不使用任何 _lead-*.js
 *
 * 方法：从**指定源文件**（默认 motion-engine.js，可传入基线路径做 A/B）
 * 原文抠出真函数，在最小组装里跑真 detectReps()。
 * 信号由本脚本自行合成（正弦 / 噪声 / 静止-动作-静止）。
 *
 * 用法：
 *   node build/_verify-oneshot.js                       # 跑现状 motion-engine.js
 *   node build/_verify-oneshot.js <path-to-other-js>    # 跑指定文件（如基线）
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const SRC_PATH = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "motion-engine.js");
const SRC = fs.readFileSync(SRC_PATH, "utf8");
const MD5 = crypto.createHash("md5").update(Buffer.from(SRC, "utf8")).digest("hex");

console.log("源文件: " + SRC_PATH);
console.log("md5   : " + MD5);
console.log("");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 40));
  return SRC.slice(i, j);
}
function grabOpt(a, b) {                 // 基线（修复前）没有 signalWindowTimes
  const i = SRC.indexOf(a);
  if (i < 0) return "/* (源文件无此函数) */";
  return grab(a, b);
}
const P = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
  signalWindowTimes: grabOpt("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)"),
  signalWindow: grab("function signalWindow(key, seconds)", "// 去趋势："),
  detrend: grab("function detrend(raw, win)", "function smooth(raw, k)"),
  smooth: grab("function smooth(raw, k)", "// 峰值计次"),
  detectReps: grab("function detectReps(now)", "/* ---------- 保持类 ---------- */"),
};

/* --- 结构自检（对任意源文件都成立） --- */
const detrendIsCausal = !/raw\[Math\.min\(n - 1, i \+|i \+ half|i \+ half|\[i \+ half\]/.test(P.detrend)
  && /acc -= raw\[i - w\]/.test(P.detrend);
const hasScannedT = /scannedT/.test(P.detectReps);
const hasTailRescan = /0\.35|tail|scannedT/.test(P.detectReps) && /\bfps \* 0\.35\b|fps\s*\*\s*0\.35/.test(P.detectReps);
console.log("detrend 用后向窗 acc-=raw[i-w] : " + (detrendIsCausal ? "是" : "否"));
console.log("detectReps 含 scannedT 水位线  : " + (hasScannedT ? "是" : "否"));
console.log("detectReps 含 tail(recent rescan): " + (hasTailRescan ? "是（可疑）" : "否"));
console.log("");

const FACTORY = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60;
  let profile = profileIn;
  let live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${P.SIGNALS}
${P.clamp}
${P.mean}
${P.std}
${P.signalWindowTimes}
${P.signalWindow}
${P.detrend}
${P.smooth}
${P.detectReps}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0,
          bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        live = Object.assign({}, dflt, liveInit, s);
        series.push(Object.assign({ t: s.t }, dflt, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        detectReps(s.t);
      }
      return { reps, repTimes: repTimes.slice(), repGate, repSpread };
    }
  };
};
`;
const makeEngine = new Function(FACTORY)();

/* ---------- 本脚本自造的信号发生器 ---------- */
const SIG = "centroidY";
const PROF = { mode: "rep", signal: SIG, tempoBand: [20, 90], minRepGap: 0.5, expectedAmplitude: 0.18 };
const FPS = 60;
function pt(t, v) {
  return { t, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5, width: 0.3, height: 0.6, [SIG]: v };
}
// 纯正弦：rpm 次/分，sec 秒
function sineSeq(rpm, sec, amp, base) {
  const f = rpm / 60, seq = [];
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) seq.push(pt(i / FPS, (base || 0.5) + amp * Math.sin(2 * Math.PI * f * i / FPS)));
  return seq;
}
// 确定性伪随机噪声，幅值上限 amp
function noiseSeq(sec, amp) {
  let s = 12345; const seq = [];
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const u = (s / 0x7fffffff) * 2 - 1;              // [-1,1)
    seq.push(pt(i / FPS, 0.5 + u * amp * 0.5));       // 幅值 ±amp/2，整段峰峰值 ≤ amp
  }
  return seq;
}
// 静止 pre 秒 → N 次动作（rpm）→ 静止 post 秒
function burstSeq(N, rpm, pre, post, amp) {
  const f = rpm / 60, seq = []; let t = 0;
  const step = 1 / FPS;
  let s0 = 98765;
  const rnd = () => { s0 = (s0 * 1103515245 + 12345) & 0x7fffffff; return (s0 / 0x7fffffff) * 2 - 1; };
  for (let k = 0; k < Math.round(pre * FPS); k++, t += step) seq.push(pt(t, 0.5 + rnd() * 0.0003));
  for (let k = 0; k < Math.round(N / f * FPS); k++, t += step) seq.push(pt(t, 0.5 + amp * Math.sin(2 * Math.PI * f * (k / FPS))));
  for (let k = 0; k < Math.round(post * FPS); k++, t += step) seq.push(pt(t, 0.5 + rnd() * 0.0003));
  return seq;
}
const run = (seq) => makeEngine(PROF, FPS, { height: 0.6 }).run(seq).reps;

console.log("=".repeat(78));
console.log("【A】正弦计次：真值 40/60/90 次（60 秒）");
console.log("-".repeat(78));
let aOK = 0, aTot = 0;
for (const rpm of [40, 60, 90]) {
  const r = run(sineSeq(rpm, 60, 0.15));
  const err = r / rpm;
  console.log(`  ${String(rpm).padStart(3)}/分  计数=${String(r).padStart(3)}  比值=${err.toFixed(3)}  ${Math.abs(err - 1) <= 0.1 ? "OK" : "偏差大"}`);
  aTot++; if (Math.abs(err - 1) <= 0.15) aOK++;
}

console.log("\n" + "=".repeat(78));
console.log("【B】站着不动 = 0（幅值 0.0006 摄像头噪声地板，60 秒）");
console.log("-".repeat(78));
const rStill = run(noiseSeq(60, 0.0006));
console.log(`  静止噪声计数 = ${rStill}  ${rStill === 0 ? "OK" : "失败（不该计数）"}`);

console.log("\n" + "=".repeat(78));
console.log("【C】静止 3s → N 次 → 静止 2s（慢速 15/分 单列）");
console.log("-".repeat(78));
for (const N of [3, 5, 10]) {
  const r = run(burstSeq(N, 40, 3, 2, 0.15));
  console.log(`  N=${String(N).padStart(2)} (40/分) 计数=${String(r).padStart(3)}  ${Math.abs(r - N) <= 1 ? "OK(±1)" : "超出±1"}`);
}
const rSlow = run(burstSeq(10, 15, 3, 2, 0.15));
console.log(`  N=10 (慢速 15/分, 周期4s) 计数=${String(rSlow).padStart(3)}  ${Math.abs(rSlow - 10) <= 1 ? "OK(±1)" : "塌陷/超计"}`);
const rSlow60 = run(sineSeq(15, 60, 0.15));
console.log(`  慢速 15/分 连续 60 秒 计数=${String(rSlow60).padStart(3)}  （真值 15）${Math.abs(rSlow60 - 15) <= 2 ? " OK" : " 偏差大"}`);

console.log("\n" + "=".repeat(78));
console.log(`结论汇总（MD5 ${MD5}）：A ${aOK}/${aTot}，静止=${rStill}，慢动作=${rSlow60}/15`);
