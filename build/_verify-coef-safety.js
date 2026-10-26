/* 【verifier-oneshot 安全对照：降阈值系数会不会引入超计】纯离线。
 * 上一步发现跳绳在系数 0.7 时从 5 恢复到 8（团队三法真值）。
 * 但 0.85 是经过标定的。若降系数会让"静止/噪声"开始计数，则这条建议有害。
 * 本测试在系数扫描下，同时跑：
 *   · 静止/噪声序列（build/_exp-series.json）→ 必须保持 0
 *   · 干净正弦 → 必须仍准确（不虚高）
 *   · 真机 5 动作 → 看是否更接近三法真值
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return SRC.slice(i, j); };
const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
function make(coef) {
  let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
  det = det.replace("clamp(rms * 0.85, 0.45, 2.2)", `clamp(rms * ${coef}, 0.45, 2.2)`);
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
const COEFS = [0.85, 0.8, 0.75, 0.7, 0.65, 0.6];
const ENG = COEFS.map(c => ({ c, e: make(c) }));
const run = (e, p, seq) => e(p, 60, { height: 0.6 }).run(seq).reps;

console.log("【安全性】静止/噪声序列在不同阈值系数下的计数（必须为 0）");
console.log("=".repeat(96));
console.log("场景".padEnd(18) + "sig".padEnd(12) + COEFS.map(c => ("×" + c).padStart(7)).join(""));
let anyNoise = false;
for (const k of Object.keys(EXP)) {
  const e = EXP[k], p = e.profile;
  const row = ENG.map(({ e: en }) => run(en, p, e.series.map(s => Object.assign({ t: s.t }, s))));
  if (row.some(v => v > 0)) anyNoise = true;
  console.log(k.padEnd(18) + String(p.signal).padEnd(12) + row.map(v => String(v).padStart(7)).join(""));
}
console.log(anyNoise ? "  ⚠ 有噪声场景在某个系数下 >0" : "  ✓ 所有系数下噪声场景均为 0");

console.log("\n【准确性】干净正弦（真值 40/60 次 60 秒）");
console.log("=".repeat(96));
{
  const p = { mode: "rep", signal: "centroidY", tempoBand: [20, 120], minRepGap: 0.3, expectedAmplitude: 0.1 };
  for (const amp of [0.05, 0.1, 0.2]) {
    const row = ENG.map(({ e }) => {
      const seq = [];
      for (let i = 0; i < 60 * 60; i++) seq.push({ t: i / 60, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5 + amp * Math.sin(2 * Math.PI * 1.0 * i / 60), width: 0.3, height: 0.6 });
      return run(e, p, seq);
    });
    console.log(`  amp=${amp} (真值60)   ` + row.map(v => String(v).padStart(7)).join(""));
  }
}

console.log("\n【真机】5 动作在不同系数下的计数");
console.log("=".repeat(96));
const TRUTH = { jumpingJacks: "6~7", squat: "5", halfSquatWarm: "5~6", jumpRope: "8~9", burpee: "2" };
for (const k of Object.keys(D.acts)) {
  const a = D.acts[k];
  const row = ENG.map(({ e }) => run(e, a.profile, a.series.map(s => Object.assign({ t: s.t }, s))));
  console.log(`  ${a.cn.padEnd(8)} ` + row.map(v => String(v).padStart(7)).join("") + `   三法真值≈${TRUTH[k]}`);
}
console.log("\n列头：" + COEFS.map(c => "×" + c).join(" / "));
