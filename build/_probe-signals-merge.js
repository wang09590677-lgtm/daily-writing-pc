"use strict";
/* 探针 3：验证 signals 数组的合并语义（是取 max？取和？还是各自计数相加？）
 * 直接用产品 detectReps 原文跑，而不是读代码猜。
 *
 * 做法：给一个只动 bottomL、bottomR 完全不动 的序列，
 * 看 reps 是「一次动作一次」还是「一次动作两次」。
 *
 * 用法：node build/_probe-signals-merge.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 30));
  return SRC.slice(i, j);
}
const parts = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
  signalWindowTimes: grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)"),
  signalWindow: grab("function signalWindow(key, seconds)", "// 去趋势："),
  detrend: grab("function detrend(raw, win)", "function smooth(raw, k)"),
  smooth: grab("function smooth(raw, k)", "// 峰值计次"),
  detectReps: grab("function detectReps(now)", "/* ---------- 保持类 ---------- */"),
};
const FACTORY = `
return function makeEngine(profileIn, fpsInit) {
  let fps = fpsInit || 60;
  let profile = profileIn;
  let live = { height: 0.6 };
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${parts.SIGNALS}
${parts.clamp}
${parts.mean}
${parts.std}
${parts.signalWindowTimes}
${parts.signalWindow}
${parts.detrend}
${parts.smooth}
${parts.detectReps}
  return { run(seq) {
    series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
    for (const s of seq) {
      const dflt = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: .3, height: .6,
        bottomL: .9, bottomR: .9, left: 0, right: 0, upper: 0, lower: 0 };
      live = Object.assign({}, dflt, s);
      series.push(Object.assign({ t: s.t }, live));
      if (series.length > 60 * 30) series.shift();
      fps = 60;
      detectReps(s.t);
    }
    return { reps, counters: Object.keys(repCounters) };
  } };
};`;
const makeEngine = new Function(FACTORY)();

/* 只动 bottomL（模拟"只有一条腿在抬"），bottomR 恒定 */
const seq = [];
const rate = 90, f = rate / 60;
for (let i = 0; i < 60 * 20; i++) {
  const t = i / 60;
  seq.push({ t, bottomL: 0.85 + 0.20 * Math.sin(2 * Math.PI * f * t), bottomR: 0.90 });
}
const profile = { mode: "rep", signal: "bottomL", signals: ["bottomL", "bottomR"],
  tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 };
const r = makeEngine(profile, 60).run(seq);
console.log(`只单腿动（bottomR 恒定）、20 秒、${rate}/分 → 真值 ${rate / 3} 次`);
console.log(`  signals:["bottomL","bottomR"] 计数 = ${r.reps}  ${r.reps > rate / 3 * 1.4 ? "← 超计，说明两条信号各自独立计数后相加" : ""}`);
console.log(`  计数器 keys = ${JSON.stringify(r.counters)}`);

const r2 = makeEngine({ mode: "rep", signal: "bottomL", tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 }, 60).run(seq);
console.log(`  只给单信号 signal:"bottomL"         计数 = ${r2.reps}`);
