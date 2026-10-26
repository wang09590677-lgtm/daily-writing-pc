/* 【verifier-oneshot 决定性机制实验】纯离线。
 * 假说：现行引擎用"单一相对阈值 k=0.85×RMS"判过零。当**快振荡**（=动作，
 *       如跳绳 1.65Hz）叠加在**更大幅度的慢漂移**上时，RMS 被慢分量抬高，
 *       k 相对快振荡过大 → 只有最大 excursions 能过阈 → 少计。
 * 实验：造 f_fast=1.65Hz、A_fast 固定，慢分量 f_slow=0.5Hz、A_slow 递增，
 *       看现行引擎计数如何随 A_slow/A_fast 变化；对照组喂"只有快分量"。
 * 同时用**过零计数**（不依赖阈值）给出信号里客观的周期数，作为独立真值。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

function buildEngine(file) {
  const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };
  const swt = src.includes("function signalWindowTimes(") ? grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)") : "function signalWindowTimes(){return [];}";
  const FACT = `
  return function makeEngine(profileIn, fpsInit, liveInit) {
    let fps=fpsInit||60, profile=profileIn, live=liveInit;
    let series=[], repCounters={}, reps=0, repTimes=[], repGate=0, repSpread=0, repHeightBase=0;
    function cfg(k){ return profile && profile[k]!==undefined ? profile[k] : undefined; }
    function signalList(){ return [cfg("signal")||"centroidY"]; }
    ${grab("const SIGNALS = {", "function clamp(v, a, b)")}
    ${grab("function clamp(v, a, b)", "function mean(arr)")}
    ${grab("function mean(arr)", "function std(arr)")}
    ${grab("function std(arr)", "// 动作参数默认值")}
    ${swt}
    ${grab("function signalWindow(key, seconds)", "// 去趋势：")}
    ${grab("function detrend(raw, win)", "function smooth(raw, k)")}
    ${grab("function smooth(raw, k)", "// 峰值计次")}
    ${grab("function detectReps(now)", "/* ---------- 保持类 ---------- */")}
    return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];repGate=0;repSpread=0;repHeightBase=0;
      for(const s of seq){ const d={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
        live=Object.assign({},d,liveInit,s); series.push(Object.assign({t:s.t},d,s));
        if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
      return { reps, repTimes:repTimes.slice() }; } };
  };`;
  return new Function(FACT)();
}
const NOW = buildEngine(path.join(ROOT, "motion-engine.js"));
const BASE = buildEngine(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"));

const p = { mode: "rep", signal: "centroidY", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.0187 };
const DUR = 6.03, FPS = 60, F_FAST = 1.65, F_SLOW = 0.5;
const AF = 0.0187; // 与跳绳重建幅值一致

function makeSeq(aSlow) {
  const seq = [];
  for (let i = 0; i < Math.round(DUR * FPS); i++) {
    const t = i / FPS;
    seq.push({ t, motion: 0.01, area: 0.1, centroidX: 0.5, width: 0.3, height: 0.6,
      centroidY: 0.5 + AF * Math.sin(2 * Math.PI * F_FAST * t) + aSlow * Math.sin(2 * Math.PI * F_SLOW * t) });
  }
  return seq;
}
function zeroCrossCycles(seq, sig) {
  // 先减去慢基线（0.5s 因果均值的粗近似：用 1s 移动平均），再数正向过零
  const v = seq.map(s => s[sig]); const n = v.length;
  const w = Math.round(1.0 * FPS); const out = []; let acc = 0;
  for (let i = 0; i < n; i++) { acc += v[i]; if (i >= w) acc -= v[i - w]; out.push(v[i] - acc / Math.min(i + 1, w)); }
  let zc = 0;
  for (let i = 1; i < n; i++) if (out[i - 1] < 0 && out[i] >= 0) zc++;
  return { zc, theory: F_FAST * DUR };
}
const clean = zeroCrossCycles(makeSeq(0), "centroidY");

console.log("=".repeat(92));
console.log(`固定快分量 f=${F_FAST}Hz A=${AF}（理论 ${clean.theory.toFixed(1)} 周期），叠加慢分量 f=${F_SLOW}Hz`);
console.log("-".repeat(92));
console.log("A_slow/A_fast   慢幅值    信号客观周期数(过零)   现行引擎计数   基线引擎计数");
for (const aSlow of [0, 0.002, 0.005, 0.010, 0.0187, 0.030, 0.050]) {
  const seq = makeSeq(aSlow);
  const zc = zeroCrossCycles(seq, "centroidY").zc;
  const now = NOW(p, 60, { height: 0.6 }).run(seq).reps;
  const base = BASE(p, 60, { height: 0.6 }).run(seq).reps;
  console.log("  " + String((aSlow / AF).toFixed(2)).padStart(8) + String(aSlow).padStart(11) +
    String(zc).padStart(18) + String(now).padStart(15) + String(base).padStart(15) +
    (now < zc - 2 ? "   <-- 现行欠计" : ""));
}

console.log("\n" + "=".repeat(92));
console.log("对照：直接拿真实跳绳 height 序列，看过零周期数 vs 引擎计数");
{
  const a = D.acts.jumpRope;
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const zc = zeroCrossCycles(seq, "height");
  console.log(`  真实跳绳 height：过零周期数=${zc.zc}   现行引擎=${NOW(a.profile, 60, { height: 0.6 }).run(seq).reps}   基线=${BASE(a.profile, 60, { height: 0.6 }).run(seq).reps}`);
}
