/* 【verifier-oneshot 决定性实验：detrend 窗型 vs 欠计】纯离线。
 * 逻辑：其余一切照现行（水位线 + 幅度闸门 + 迟滞过零），**只换 detrend 窗型**：
 *   · 后向（现行，因果）
 *   · 居中（基线那种：raw[i-half..i+half]）
 * 若居中窗在跳绳上能数出接近真值 10、而后向窗只数 5，则欠计是**窗型选择**造成的
 * 分辨力差异（偏"实现选择"），而不是"信号里根本没有 10 拍"。
 * 若两者都数 5 左右，则支持"信号分辨不出"（假设 B）。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const src = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };

const DET_CAUSAL = grab("function detrend(raw, win)", "function smooth(raw, k)");
// 居中窗版本：完全照抄基线算法
const baseSrc = fs.readFileSync(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"), "utf8").replace(/\r\n/g, "\n");
const i0 = baseSrc.indexOf("function detrend(raw, win)"), i1 = baseSrc.indexOf("function smooth(raw, k)", i0);
const DET_CENTER = baseSrc.slice(i0, i1);

const OTHER = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
  swt: grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)"),
  sw: grab("function signalWindow(key, seconds)", "// 去趋势："),
  smooth: grab("function smooth(raw, k)", "// 峰值计次"),
  // 现行 detectReps，但**去掉幅度闸门**以便只看窗型；保留水位线
  detect: grab("function detectReps(now)", "/* ---------- 保持类 ---------- */"),
};
function make(detSrc, dropGate) {
  let det = OTHER.detect;
  if (dropGate) det = det.replace("if (spread < gate) {", "if (false) {");
  const FACT = `
  return function makeEngine(profileIn, fpsInit, liveInit) {
    let fps=fpsInit||60, profile=profileIn, live=liveInit;
    let series=[], repCounters={}, reps=0, repTimes=[], repGate=0, repSpread=0, repHeightBase=0;
    function cfg(k){ return profile && profile[k]!==undefined ? profile[k] : undefined; }
    function signalList(){ return [cfg("signal")||"centroidY"]; }
    ${OTHER.SIGNALS}
    ${OTHER.clamp}
    ${OTHER.mean}
    ${OTHER.std}
    ${OTHER.swt}
    ${OTHER.sw}
    ${detSrc}
    ${OTHER.smooth}
    ${det}
    return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];repGate=0;repSpread=0;repHeightBase=0;
      for(const s of seq){ const d={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
        live=Object.assign({},d,liveInit,s); series.push(Object.assign({t:s.t},d,s));
        if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
      return { reps, repTimes:repTimes.slice(), repGate, repSpread }; } };
  };`;
  return new Function(FACT)();
}
const E_CAUSAL = make(DET_CAUSAL, false);
const E_CENTER = make(DET_CENTER, false);
const E_CAUSAL_NG = make(DET_CAUSAL, true);
const E_CENTER_NG = make(DET_CENTER, true);

console.log("只换 detrend 窗型，其余全用现行逻辑（水位线 + 迟滞）");
console.log("=".repeat(100));
console.log("动作        信号      现行(后向+闸门)  居中+闸门  后向-无闸门  居中-无闸门   历史真值");
const HIST = { jumpRope: 10, jumpingJacks: "6~7", squat: 5, halfSquatWarm: "?", burpee: 2 };
for (const key of Object.keys(D.acts)) {
  const a = D.acts[key], sig = a.signal;
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const r1 = E_CAUSAL(a.profile, 60, { height: 0.6 }).run(seq).reps;
  const r2 = E_CENTER(a.profile, 60, { height: 0.6 }).run(seq).reps;
  const r3 = E_CAUSAL_NG(a.profile, 60, { height: 0.6 }).run(seq).reps;
  const r4 = E_CENTER_NG(a.profile, 60, { height: 0.6 }).run(seq).reps;
  console.log("  " + a.cn.padEnd(9) + sig.padEnd(9) + String(r1).padStart(14) + String(r2).padStart(11) +
    String(r3).padStart(13) + String(r4).padStart(13) + String(HIST[key]).padStart(11));
}
console.log("\n说明：'无闸门'列用于隔离——若它比'有闸门'高很多，说明欠计来自幅度闸门；若两者接近，欠计来自窗型/判定。");
