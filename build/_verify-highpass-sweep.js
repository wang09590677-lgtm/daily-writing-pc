/* 【verifier-oneshot 最终确认：慢漂移是否是可恢复的信息损失】纯离线。
 * 已知：跳绳信号 DFT 显示 ~10 个 1.65Hz 周期；引擎只数 5；换窗型/去闸门都不行。
 * 本测试：对真实序列做**逐渐增强的高通**（减去 W 秒因果均值），W 从 1.0→0.2s，
 * 保留 1.65Hz(周期0.6s)、压掉 0.5Hz(周期2s)。看现行引擎计数能否逼近 10。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
function buildEngine(file, gateOff) {
  const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };
  const swt = src.includes("function signalWindowTimes(") ? grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)") : "function signalWindowTimes(){return [];}";
  let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
  if (gateOff) det = det.replace("if (spread < gate) {", "if (false) {");
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
    ${det}
    return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];repGate=0;repSpread=0;repHeightBase=0;
      for(const s of seq){ const d={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
        live=Object.assign({},d,liveInit,s); series.push(Object.assign({t:s.t},d,s));
        if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
      return { reps, repTimes:repTimes.slice() }; } };
  };`;
  return new Function(FACT)();
}
const NOW = buildEngine(path.join(ROOT, "motion-engine.js"), false);

function highpass(seq, sig, sec) {
  const n = seq.length, w = Math.max(1, Math.round(sec * 60));
  const v = seq.map(s => s[sig]); let acc = 0; const out = [];
  for (let i = 0; i < n; i++) { acc += v[i]; if (i >= w) acc -= v[i - w]; out.push(v[i] - acc / Math.min(i + 1, w)); }
  const m = out.reduce((a, b) => a + b, 0) / n;
  return seq.map((s, i) => Object.assign({}, s, { [sig]: 0.5 + (out[i] - m) }));
}
for (const key of ["jumpRope", "jumpingJacks", "squat", "halfSquatWarm", "burpee"]) {
  const a = D.acts[key], sig = a.signal;
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const line = [];
  for (const sec of [2.0, 1.0, 0.6, 0.4, 0.3, 0.2]) {
    const r = NOW(a.profile, 60, { height: 0.6 }).run(highpass(seq, sig, sec)).reps;
    line.push(`HP${sec}s→${r}`);
  }
  console.log(`  ${a.cn.padEnd(8)} 原始(现行)=${NOW(a.profile, 60, { height: 0.6 }).run(seq).reps}   ${line.join("  ")}`);
}
console.log("\n（历史真值：开合跳 6~7 / 徒手深蹲 5 / 半蹲热身 ? / 跳绳 10 / 波比跳 2）");
