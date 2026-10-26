/* 【verifier-oneshot 跳绳信号真值裁定】纯离线。
 * 前序发现：跳绳 height 的 DFT/自相关都指向 ~1.7Hz(102/分)，6.03s ≈ 10.3 周期
 * （与历史真值 10 吻合）；但引擎只数 5。两者必须有一方错。本脚本用三把独立尺子
 * 定"信号里到底有几个周期"，并把同频同幅的**干净正弦**喂给引擎做能力对照。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

function spectrum(series, sig) {
  const t = series.map(s => s.t), v = series.map(s => s[sig]);
  const n = v.length, dt = (t[n - 1] - t[0]) / (n - 1);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const x = v.map(a => a - mean);
  const out = [];
  for (let kf = 1; kf <= 300; kf++) {
    const f = kf / (n * dt);
    if (f > 8) break;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * f * t[i]; re += x[i] * Math.cos(ph); im -= x[i] * Math.sin(ph); }
    out.push({ f, mag: Math.hypot(re, im) * 2 / n });
  }
  return { out, dt, mean, rms: Math.sqrt(x.reduce((a, b) => a + b * b, 0) / n) };
}
// 带通（Goertzel 式窄带 IQ 解调）后取包络相位的展开 → 周期数
function bandCycles(series, sig, f0) {
  const t = series.map(s => s.t), v = series.map(s => s[sig]);
  const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * f0 * t[i]; re += (v[i] - mean) * Math.cos(ph); im -= (v[i] - mean) * Math.sin(ph); }
  const amp = 2 * Math.hypot(re, im) / n;
  // 逐点解调相位，累计相位变化 → 周期数
  let prev = null, cum = 0;
  for (let i = 0; i < n; i++) {
    const ph = 2 * Math.PI * f0 * t[i];
    const I = (v[i] - mean) * Math.cos(ph), Q = -(v[i] - mean) * Math.sin(ph);
    const a = Math.atan2(Q, I);
    if (prev !== null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; cum += d; }
    prev = a;
  }
  return { amp, cyclesFromPhase: Math.abs(cum) / (2 * Math.PI) };
}
// 干净正弦喂引擎（用与 A/B 脚本同款抠函数）
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

for (const key of ["jumpRope", "jumpingJacks", "squat", "halfSquatWarm", "burpee"]) {
  const a = D.acts[key], sig = a.signal;
  const sp = spectrum(a.series, sig);
  // top 4 谱峰（局部极大）
  const peaks = [];
  for (let i = 1; i < sp.out.length - 1; i++)
    if (sp.out[i].mag > sp.out[i - 1].mag && sp.out[i].mag >= sp.out[i + 1].mag) peaks.push(sp.out[i]);
  peaks.sort((x, y) => y.mag - x.mag);
  const top = peaks.slice(0, 4);
  const dur = a.series[a.series.length - 1].t - a.series[0].t;
  const f0 = top[0].f;
  const bc = bandCycles(a.series, sig, f0);
  const runs = { now: NOW(a.profile, 60, { height: 0.6 }).run(a.series.map(s => Object.assign({ t: s.t }, s))).reps, base: BASE(a.profile, 60, { height: 0.6 }).run(a.series.map(s => Object.assign({ t: s.t }, s))).reps };

  // 干净正弦（同 f0、同 RMS 幅值）喂引擎
  const A = Math.SQRT2 * sp.rms;
  const clean = [];
  for (let i = 0; i < Math.round(dur * 60); i++) {
    const o = { t: i / 60, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5, width: 0.3, height: 0.6 };
    o[sig] = 0.5 + A * Math.sin(2 * Math.PI * f0 * i / 60); clean.push(o);
  }
  const cleanRun = NOW(a.profile, 60, { height: 0.6 }).run(clean).reps;

  console.log("=".repeat(96));
  console.log(`${a.cn}  信号=${sig}  时长=${dur.toFixed(2)}s  信号RMS=${sp.rms.toFixed(5)}`);
  console.log(`  谱峰 top4: ` + top.map(p => `${p.f.toFixed(3)}Hz(${(p.f * 60).toFixed(0)}/分, mag=${p.mag.toFixed(5)})`).join("  "));
  console.log(`  主频 ${f0.toFixed(3)}Hz → 理论周期数 = ${(f0 * dur).toFixed(2)}   |   解调相位累计周期数 = ${bc.cyclesFromPhase.toFixed(2)}`);
  console.log(`  引擎计数: 现行=${runs.now}   基线=${runs.base}`);
  console.log(`  同频(${f0.toFixed(2)}Hz)同幅(${A.toFixed(4)}) 干净正弦喂现行引擎 → ${cleanRun} 次  ${Math.abs(cleanRun - f0 * dur) <= 1.5 ? "（≈理论周期数，引擎在干净信号上不丢拍）" : "（引擎在干净信号上也偏！）"}`);
}
