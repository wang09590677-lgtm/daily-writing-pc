/* 【verifier-oneshot 决定性判决：窄带纯净分量喂现行引擎】纯离线。
 * 若"信号里客观有 10 周期"成立，则把该单一分量（窄带重建）喂引擎应数出 ≈10；
 * 若仍只数 5，说明现行引擎在这种波形上确有分辨缺陷（假设 A）。
 * 注意：_realseries.json 是 24fps→60fps 重复上采样（段长 2/3），
 * 会带来平台谐波——两份结果都报，让证据自己说话。
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

// 用 Goertzel 精确抽取单频分量（对 24Hz 源序列，先用其真实采样率）
// 这里对 60fps（上采样后）序列做逐 bin DFT 窄带重建
function narrowband(series, sig, fHz, bandwidthBins) {
  const n = series.length;
  const v = series.map(s => s[sig]);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const x = v.map(a => a - mean);
  const N = n; // 用序列长度做 DFT 基
  const dur = series[n - 1].t - series[0].t + (series[1].t - series[0].t);
  const k0 = Math.round(fHz * dur);
  // 直接构造单频分量
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * k0 * i / N; re += x[i] * Math.cos(ph); im -= x[i] * Math.sin(ph); }
  const out = series.map((s, i) => {
    let val = 0;
    for (let k = Math.max(1, k0 - bandwidthBins); k <= k0 + bandwidthBins; k++) {
      let r = 0, im2 = 0;
      for (let j = 0; j < n; j++) { const ph = -2 * Math.PI * k * j / N; r += x[j] * Math.cos(ph); im2 += x[j] * Math.sin(ph); }
      const ph2 = 2 * Math.PI * k * i / N;
      val += (r * Math.cos(ph2) - im2 * Math.sin(ph2)) / N;
    }
    return Object.assign({}, s, { [sig]: 0.5 + val * 2 });
  });
  // 数过零
  let zc = 0; const vals = out.map(o => o[sig] - 0.5);
  for (let i = 1; i < n; i++) if (vals[i - 1] < 0 && vals[i] >= 0) zc++;
  return { seq: out, zc };
}

for (const key of ["jumpRope", "jumpingJacks"]) {
  const a = D.acts[key], sig = a.signal;
  const raw = a.series.map(s => Object.assign({ t: s.t }, s));
  const fpeak = key === "jumpRope" ? 1.653 : 2.149;
  console.log("=".repeat(92));
  console.log(`${a.cn} 信号=${sig}  主频=${fpeak}Hz  现行(原始)=${NOW(a.profile, 60, { height: 0.6 }).run(raw).reps}`);
  for (const bw of [0, 1]) {
    const nb = narrowband(raw, sig, fpeak, bw);
    const r = NOW(a.profile, 60, { height: 0.6 }).run(nb.seq).reps;
    console.log(`  窄带重建(±${bw} bin) 过零=${nb.zc} → 现行引擎=${r}  ${Math.abs(r - nb.zc) <= 2 ? "（引擎能数出来 → 5 不是引擎缺陷）" : "（引擎数不出 → 需进一步查）"}`);
  }
}
