/* 【verifier-oneshot 隔离测试：detrend 窗长 vs 欠计】纯离线。
 * 引擎里 detrend 窗长 win = fps*60/max(15, tempoBand[1])。
 * 跳绳 band=[60,120] → win=30帧=0.5s；但信号里有 ~0.5Hz 慢漂移（周期 2s），
 * 0.5s 窗远不足以消掉它 → 漂移残留抬高 RMS，相对阈值 k 过大 → 少计。
 * 本测试**只改 tempoBand[1]**（不动任何文件），看窗长拉长后计数是否恢复。
 * 这是"实现层调参缺陷(假设A)"与"信号分辨不出(假设B)"的判别实验：
 *   若拉长窗长能让计数回到 ~10（DFT/历史真值），则信号里确实有 10 拍 → 不是 B。
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

console.log("只改 tempoBand[1]（决定 detrend 窗长），其余 profile 不变");
console.log("=".repeat(90));
for (const key of ["jumpRope", "jumpingJacks", "squat", "halfSquatWarm", "burpee"]) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const line = [];
  for (const hi of [120, 60, 40, 30, 20]) {
    const win = Math.max(3, Math.min(Math.round(60 * 60 / Math.max(15, hi)), Math.round(60 * 1.5)));
    if (win > seq.length) continue;
    const p = Object.assign({}, a.profile, { tempoBand: [Math.min(a.profile.tempoBand[0], hi), hi] });
    const r = NOW(p, 60, { height: 0.6 }).run(seq).reps;
    line.push(`band_hi=${hi}(win=${(win / 60).toFixed(2)}s)→${r}`);
  }
  console.log(`  ${a.cn.padEnd(8)} 声明band=${JSON.stringify(a.profile.tempoBand)}   ${line.join("  ")}`);
}
console.log("\n（历史真值：开合跳 6~7 / 徒手深蹲 5 / 半蹲热身 ? / 跳绳 10 / 波比跳 2）");
