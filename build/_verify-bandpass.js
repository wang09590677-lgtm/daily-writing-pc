/* 【verifier-oneshot 决定性实验：带通】纯离线。
 * 假设：跳绳 height 信号里客观有 ~10 个 1.65Hz 周期，但被 ~0.5Hz 的大分量
 *       抬高 RMS，使"按 RMS 比例"的判定只能分辨出 ~5 个。
 * 若把信号带通到 1.5~1.8Hz 后再喂引擎能数出 ~9-10 次，则
 *   ① 10 个周期客观存在；② 5 次不是水位线/重扫实现 bug，而是信号适配问题。
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

// 简易 IIR 带通（f0 中心，Q 可调）——直接改样本里的目标信号值
function bandpass(series, sig, f0, q) {
  const n = series.length, dt = (series[n - 1].t - series[0].t) / (n - 1);
  const w0 = 2 * Math.PI * f0, alpha = Math.sin(w0 * dt / 2) / q, cw = Math.cos(w0 * dt / 2);
  const b0 = alpha, b1 = 0, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const x0 = series[i][sig];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out.push(y0);
  }
  return out.map((v, i) => Object.assign({ t: series[i].t }, series[i], { [sig]: 0.5 + v }));
}

for (const key of ["jumpRope", "jumpingJacks", "squat", "halfSquatWarm", "burpee"]) {
  const a = D.acts[key], sig = a.signal, p = a.profile;
  const raw = a.series.map(s => Object.assign({ t: s.t }, s));
  const nowRaw = NOW(p, 60, { height: 0.6 }).run(raw).reps;
  const baseRaw = BASE(p, 60, { height: 0.6 }).run(raw).reps;
  console.log("=".repeat(96));
  console.log(`${a.cn}  信号=${sig}  现行(原始信号)=${nowRaw}  基线(原始信号)=${baseRaw}`);
  for (const f0 of [0.3, 0.5, 0.8, 1.0, 1.65, 2.15].filter(f => f < 5 / ((raw[raw.length - 1].t - raw[0].t) / raw.length) * 1)) {
    // 只在动作主频附近有意义；这里统一扫几个频带看滤波后计数
  }
  // 针对每个动作的主频带
  const centers = { jumpRope: [1.65], jumpingJacks: [2.15], squat: [0.27], halfSquatWarm: [0.27], burpee: [0.335] }[key];
  for (const f0 of centers) {
    for (const q of [1.5, 3, 6]) {
      const bp = bandpass(raw, sig, f0, q);
      const rn = NOW(p, 60, { height: 0.6 }).run(bp).reps;
      const rb = BASE(p, 60, { height: 0.6 }).run(bp).reps;
      console.log(`  带通 ${f0}Hz(Q=${q}) 后：现行=${String(rn).padStart(3)}  基线=${String(rb).padStart(3)}`);
    }
  }
}
