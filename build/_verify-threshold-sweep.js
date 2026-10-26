/* 【verifier-oneshot 机制钉死：阈值系数扫描】纯离线。
 * 现行判定阈值 k = clamp(rms * 0.85, 0.45, 2.2)，rms 来自**整段**平滑去趋势信号。
 * 跳绳 height 里混着 ~0.5Hz 慢漂移 + 24fps 上采样平台谐波，会把 rms 抬高，
 * 使 k 相对"每拍振幅"过大 → 少计。
 * 本测试**只改这个 0.85 系数**（源字符串替换，内存内），看计数是否回到真值 8~10。
 * 若回到真值 → 欠计的直接机制是"相对阈值尺度"，属可调的实现参数（支持需修）。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return SRC.slice(i, j); };
const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");

function make(coef) {
  let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
  const before = det;
  det = det.replace("clamp(rms * 0.85, 0.45, 2.2)", `clamp(rms * ${coef}, 0.45, 2.2)`);
  if (det === before && coef !== 0.85) throw new Error("系数替换未命中");
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

const HIST = { jumpRope: "8~10", jumpingJacks: "6~7", squat: 5, halfSquatWarm: "5~6", burpee: 2 };
console.log("只改阈值系数 (k = clamp(rms*COEF, 0.45, 2.2))，其余全不动");
console.log("=".repeat(100));
for (const key of Object.keys(D.acts)) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const row = [];
  for (const c of [0.85, 0.7, 0.5, 0.35, 0.2]) {
    row.push(`×${c}→${make(c)(a.profile, 60, { height: 0.6 }).run(seq).reps}`);
  }
  console.log(`  ${a.cn.padEnd(8)} ${row.join("  ")}   真值≈${HIST[key]}`);
}
console.log("\n（若 ×0.85 附近少、系数减小后升到真值 → 欠计主因是相对阈值尺度过大；反之则信号确实分辨不出）");
