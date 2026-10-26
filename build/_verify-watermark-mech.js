/* 【verifier-oneshot 水位线机制定位】纯离线。
 * 2×2 显示：只改水位线（B）让跳绳 12→6；只改因果均值（A）反而 12→11（≈真值）。
 * 说明**水位线**才是跳绳欠计的主因。本脚本在现行 detectReps 上逐样本插桩，
 * 记录每个"新判定"样本的 (t, v/k, armed前, 事件)，找出为什么每周期只 fire 一半。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return SRC.slice(i, j); };
let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
const B0 = det;
det = det.replace("        for (let i = 0; i < d.length; i++) {\n          const tS = wT[i];\n          if (tS !== undefined && tS <= st.scannedT) continue;\n          const v = d[i];",
  "        for (let i = 0; i < d.length; i++) {\n          const tS = wT[i];\n          __all.push({t:tS,v:d[i],k:k,skip:(tS!==undefined&&tS<=st.scannedT)});\n          if (tS !== undefined && tS <= st.scannedT) continue;\n          const v = d[i];\n          __judged.push({t:tS,r:v/k,armed:st.armed,ev:'judge'});");
if (det === B0) throw new Error("插桩1未命中");
const B1 = det;
det = det.replace("if (v < -k) st.armed = true;", "if (v < -k) { st.armed = true; __judged[__judged.length-1].ev='ARM'; }");
det = det.replace("reps += 1;", "reps += 1; __judged[__judged.length-1] && (__judged[__judged.length-1].ev='FIRE');");
if (det === B1) throw new Error("插桩2未命中");
const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
const FACT = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps=fpsInit||60, profile=profileIn, live=liveInit;
  let series=[], repCounters={}, reps=0, repTimes=[], repGate=0, repSpread=0, repHeightBase=0, __all=[], __judged=[];
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
  return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];__all=[];__judged=[];
    for(const s of seq){ const d={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
      live=Object.assign({},d,liveInit,s); series.push(Object.assign({t:s.t},d,s));
      if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
    return { reps, __all:__all.slice(), __judged:__judged.slice(), __arm:__judged.filter(x=>x.ev==='ARM').length }; } };
};`;
const eng = new Function(FACT)();
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

for (const key of ["jumpRope", "jumpingJacks"]) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const r = eng(a.profile, 60, { height: 0.6 }).run(seq);
  // __all 里每个样本在多帧被判（窗口滑动），按 t 取"最后一次"的 k，并统计每样本是否被 SKIP 过
  const byT = new Map();
  for (const e of r.__all) { const c = byT.get(e.t) || { t: e.t, v: e.v, k: e.k, judged: 0, skipped: 0 }; c.v = e.v; c.k = e.k; if (e.skip) c.skipped++; else c.judged++; byT.set(e.t, c); }
  const pts = [...byT.values()].sort((x, y) => x.t - y.t);
  console.log("=".repeat(96));
  console.log(`${a.cn}  引擎计数=${r.reps}`);
  console.log(`  唯一时刻数=${pts.length}，其中"曾被当新样本判定"的时刻=${pts.filter(p => p.judged > 0).length}，"始终被跳过"的=${pts.filter(p => p.judged === 0).length}`);
  console.log(`  判定事件数(judged)=${r.__judged.length}，其中 ARM=${r.__arm}，FIRE=${r.__judged.filter(x => x.ev === 'FIRE').length}`);
  // 逐周期：看每个"正峰"是否在判定到的那一刻 v>k 且 armed
  // 打印所有 FIRE 和 ARM 时刻
  const fires = r.__judged.filter(x => x.ev === 'FIRE').map(x => `${x.t.toFixed(2)}(r=${x.r.toFixed(2)})`);
  const arms = r.__judged.filter(x => x.ev === 'ARM').map(x => `${x.t.toFixed(2)}(r=${x.r.toFixed(2)})`);
  console.log(`  ARM 时刻: ${arms.join(" ")}`);
  console.log(`  FIRE 时刻: ${fires.join(" ")}`);
  // 信号在每个时刻的 r=v/k，看正峰处 r 最大多少
  const rmax = Math.max(...pts.map(p => p.v / p.k));
  console.log(`  全程 max(v/k)=${rmax.toFixed(2)}（>1 才能 FIRE）`);
}
