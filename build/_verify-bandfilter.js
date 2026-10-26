/* 【verifier-oneshot 可恢复性确认：DFT 频带滤波】纯离线。
 * 用可靠的 DFT/IDFT（自检过，误差 1e-15）把信号限制在动作声明 tempoBand 内，
 * 再喂现行引擎。若计数恢复到 ~8-10，则"5"是**探测器分辨力**问题（可修），
 * 而非"信号里没有这些拍"。
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

function dft(x) { const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let i = 0; i < n; i++) { const ph = -2 * Math.PI * k * i / n; sr += x[i] * Math.cos(ph); si += x[i] * Math.sin(ph); } re[k] = sr; im[k] = si; } return { re, im }; }
function idft(re, im) { const n = re.length, y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < n; k++) { const ph = 2 * Math.PI * k * i / n; s += re[k] * Math.cos(ph) - im[k] * Math.sin(ph); } y[i] = s / n; } return y; }

function bandFilter(series, sig, loHz, hiHz) {
  const n = series.length, durSec = n / 60;
  const v = series.map(s => s[sig]);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const x = v.map(a => a - mean);
  const { re, im } = dft(x);
  const klo = Math.ceil(loHz * durSec), khi = Math.floor(hiHz * durSec);
  const R = new Float64Array(n), I = new Float64Array(n);
  for (let k = klo; k <= khi && k < n / 2; k++) { R[k] = re[k]; I[k] = im[k]; R[n - k] = re[n - k]; I[n - k] = im[n - k]; }
  const y = idft(R, I);
  return series.map((s, i) => Object.assign({}, s, { [sig]: 0.5 + y[i] }));
}

console.log("把信号限制到动作声明 tempoBand 的频带内（Hz = band/60），再喂现行引擎");
console.log("=".repeat(96));
const HIST = { jumpRope: "8~10", jumpingJacks: "6~7", squat: 5, halfSquatWarm: "5~6", burpee: 2 };
for (const key of Object.keys(D.acts)) {
  const a = D.acts[key], sig = a.signal, band = a.profile.tempoBand;
  const raw = a.series.map(s => Object.assign({ t: s.t }, s));
  const rawR = NOW(a.profile, 60, { height: 0.6 }).run(raw).reps;
  const out = [];
  for (const [lo, hi] of [[band[0] / 60, band[1] / 60], [band[0] / 60 * 0.8, band[1] / 60 * 1.2]]) {
    const bf = bandFilter(raw, sig, lo, hi);
    let zc = 0; const vv = bf.map(o => o[sig] - 0.5);
    for (let i = 1; i < vv.length; i++) if (vv[i - 1] < 0 && vv[i] >= 0) zc++;
    out.push(`带通[${(lo * 60).toFixed(0)}~${(hi * 60).toFixed(0)}/分]→引擎${NOW(a.profile, 60, { height: 0.6 }).run(bf).reps}(过零${zc})`);
  }
  console.log(`  ${a.cn.padEnd(8)} 原始→引擎=${rawR}   ${out.join("   ")}   真值≈${HIST[key]}`);
}
