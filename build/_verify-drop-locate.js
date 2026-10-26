/* 【verifier-oneshot 跳绳丢拍定位】纯离线。
 * 疑点：跳绳 height 信号 DFT/自相关都显示 ~10.3 个周期（≈历史真值 10），
 *       但引擎只数 5。必须查清引擎在哪一步丢掉。
 * 手法：在**内存里**给 detectReps 副本插桩（不改产品文件），记录
 *   · 每次计数的时刻（看是不是"隔一个周期"）
 *   · 门开/门关的交替（看闸门是否间歇性关掉）
 *   · 迟滞状态机事件（arm / fire）
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };

// 抠出 detectReps 后插桩（仅本脚本内存中）
let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");
det = det.replace("if (keyIndex === 0) { repGate = gate; repSpread = spread; }",
  "if (keyIndex === 0) { repGate = gate; repSpread = spread; __ev.push({t:now,k:'frame',spread:spread,gate:gate,pass:spread>=gate}); }");
det = det.replace("reps += 1;", "reps += 1; __ev.push({t:now,k:'FIRE'});");
det = det.replace("if (v < -k) st.armed = true;", "if (v < -k) { if(!st.armed) __ev.push({t:now,k:'ARM',v:v,k}); st.armed = true; }");

const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
const FACT = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps = fpsInit||60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0, __ev = [];
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
    return { reps, repTimes:repTimes.slice(), __ev: __ev.slice() }; } };
};`;
const eng = new Function(FACT)();

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
for (const key of ["jumpRope", "jumpingJacks", "squat"]) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const r = eng(a.profile, 60, { height: 0.6 }).run(seq);
  const fires = r.__ev.filter(e => e.k === "FIRE").map(e => +e.t.toFixed(3));
  const arms = r.__ev.filter(e => e.k === "ARM").map(e => +e.t.toFixed(3));
  const frames = r.__ev.filter(e => e.k === "frame");
  const passN = frames.filter(f => f.pass).length;
  const intervals = fires.slice(1).map((t, i) => +(t - fires[i]).toFixed(3));
  console.log("=".repeat(96));
  console.log(`${a.cn}  信号=${a.signal}  时长=${(a.series[a.series.length-1].t).toFixed(2)}s`);
  console.log(`  引擎计数=${r.reps}   计数时刻=${JSON.stringify(fires)}`);
  console.log(`  计数间隔=${JSON.stringify(intervals)}`);
  console.log(`  ARM(下穿-k)时刻=${JSON.stringify(arms)}`);
  console.log(`  门开帧=${passN} / 总判帧=${frames.length}  （门关百分比=${(100*(frames.length-passN)/frames.length).toFixed(1)}%）`);
  // spread/gate 分布
  const sp = frames.map(f => f.spread), ga = frames.map(f => f.gate);
  console.log(`  spread 范围=[${Math.min(...sp).toFixed(5)}, ${Math.max(...sp).toFixed(5)}]  gate 范围=[${Math.min(...ga).toFixed(5)}, ${Math.max(...ga).toFixed(5)}]`);
  // 门交替段
  let segs = [], cur = frames.length ? frames[0].pass : null, st = 0;
  frames.forEach((f, i) => { if (f.pass !== cur) { segs.push((cur ? "开" : "关") + (frames[i-1].t - frames[st].t).toFixed(2) + "s"); cur = f.pass; st = i; } });
  segs.push((cur ? "开" : "关") + (frames[frames.length-1].t - frames[st].t).toFixed(2) + "s");
  console.log(`  门状态时间线: ${segs.slice(0, 14).join(" | ")}${segs.length>14?" ...("+segs.length+"段)":""}`);
}
