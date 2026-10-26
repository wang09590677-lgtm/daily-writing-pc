/* 【verifier-oneshot 确认：去慢漂移后引擎是否恢复】纯离线。 */
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
const FPS = 60;
for (const key of ["jumpRope", "jumpingJacks", "squat", "halfSquatWarm", "burpee"]) {
  const a = D.acts[key], sig = a.signal;
  const raw = a.series.map(s => Object.assign({ t: s.t }, s));
  const n = raw.length, w = Math.round(1.0 * FPS);
  const vals = raw.map(s => s[sig]); let acc = 0; const hp = [];
  for (let i = 0; i < n; i++) { acc += vals[i]; if (i >= w) acc -= vals[i - w]; hp.push(vals[i] - acc / Math.min(i + 1, w)); }
  const hpSeq = raw.map((s, i) => Object.assign({}, s, { [sig]: 0.5 + hp[i] }));
  let zc = 0; for (let i = 1; i < n; i++) if (hp[i - 1] < 0 && hp[i] >= 0) zc++;
  const band = a.profile.tempoBand; const win = Math.max(3, Math.min(Math.round(FPS * 60 / Math.max(15, band[1])), Math.round(FPS * 1.5)));
  console.log(`${a.cn}(信号=${sig}) 时长${(raw[n-1].t).toFixed(1)}s`);
  console.log(`  原始信号: 过零周期≈? 现行=${NOW(a.profile, 60, {height:0.6}).run(raw).reps} 基线=${BASE(a.profile, 60, {height:0.6}).run(raw).reps}`);
  console.log(`  高通(减1s因果均值)后: 过零周期=${zc} 现行=${NOW(a.profile, 60, {height:0.6}).run(hpSeq).reps} 基线=${BASE(a.profile, 60, {height:0.6}).run(hpSeq).reps}`);
  console.log(`  detrend 窗长=${win}帧=${(win/FPS).toFixed(2)}s`);
}
