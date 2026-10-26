/* 【verifier-oneshot 逐周期诊断】纯离线。
 * 已知：跳绳平滑去趋势信号有 32 个样本 v<-k、36 个 v>k，arm=64，却只 fire=5。
 * 本脚本按"真周期"切分信号，逐周期报告 [min v/k, max v/k]，
 * 看每个周期是否真的两个方向都过了阈 —— 从而定位丢拍到底发生在哪。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };

let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
det = det.replace("for (let i = 0; i < d.length; i++) {\n          const tS = wT[i];",
  "for (let i = 0; i < d.length; i++) {\n          __ev.push({ t: wT[i], v: d[i], k: k });\n          const tS = wT[i];");
det = det.replace("reps += 1;", "reps += 1;");
const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
const FACT = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps=fpsInit||60, profile=profileIn, live=liveInit;
  let series=[], repCounters={}, reps=0, repTimes=[], repGate=0, repSpread=0, repHeightBase=0, __ev=[];
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
  return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];__ev=[];
    for(const s of seq){ const dflt={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
      live=Object.assign({},dflt,liveInit,s); series.push(Object.assign({t:s.t},dflt,s));
      if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
    return { reps, repTimes:repTimes.slice(), __ev:__ev.slice() }; } };
};`;
const eng = new Function(FACT)();

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
for (const key of ["jumpRope", "jumpingJacks"]) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const r = eng(a.profile, 60, { height: 0.6 }).run(seq);
  const byT = new Map(); for (const e of r.__ev) byT.set(e.t, e);
  const pts = [...byT.values()].sort((x, y) => x.t - y.t);
  // 用 DFT 主周期找极值段：按"v 的局部极小"切周期
  const mins = [], maxs = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i].v < pts[i - 1].v && pts[i].v <= pts[i + 1].v) mins.push(i);
    if (pts[i].v > pts[i - 1].v && pts[i].v >= pts[i + 1].v) maxs.push(i);
  }
  // 相邻极值配对（min→max）作为"半个周期"
  console.log("=".repeat(96));
  console.log(`${a.cn}  信号=${a.signal}  引擎计数=${r.reps}  样本数=${pts.length}`);
  console.log("  —— 用引擎完全相同的迟滞语义在每样本唯一值上复算：");
  {
    let armed = false, cnt = 0; const times = [];
    for (const p of pts) {
      if (p.v < -p.k) armed = true;
      else if (p.v > p.k && armed) { cnt++; times.push(+p.t.toFixed(3)); armed = false; }
    }
    console.log(`    复算 FIRE 次数 = ${cnt}   时刻=${JSON.stringify(times)}`);
    console.log(`    引擎实际 FIRE  = ${r.reps}`);
    console.log(`    → ${cnt === r.reps ? "复算与引擎一致：丢拍发生在**信号层面**（信号里客观只有这么多可分辨峰），不是水位线/重扫的实现 bug" : "复算与引擎不一致：可能存在实现层丢拍"}`);
  }
  // minRepGap 影响
  console.log(`  minRepGap=${a.profile.minRepGap}s；理论最少间隔下最多能计 ${(6.05 / a.profile.minRepGap).toFixed(1)} 次（不是瓶颈）`);
}
