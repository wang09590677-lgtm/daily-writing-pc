/* 【verifier-oneshot 跳绳丢拍定位 v2】纯离线。
 * v1 的 ARM 日志为空但 FIRE 有 5 条 → 插桩没生效，结论不可信。v2 改为
 * **在每个样本上直接记录 (t, v, k, armed)**，用 assert 确认插桩命中，
 * 从而确定性地回答："跳绳的平滑去趋势信号到底有没有下穿 -k（有没有被 ARM）"。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0) throw new Error("缺:" + a.slice(0, 30)); return src.slice(i, j); };

let det = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */").replace(/\r\n/g, "\n");
const BEFORE = det;
// 在每个样本判定处插桩（放在 for 循环体第一行）
det = det.replace(
  "for (let i = 0; i < d.length; i++) {\n          const tS = wT[i];",
  "for (let i = 0; i < d.length; i++) {\n          __ev.push({ t: wT[i], v: d[i], k: k });\n          const tS = wT[i];");
if (det === BEFORE) throw new Error("插桩1未命中");
// 记录 ARM 与 FIRE
det = det.replace("reps += 1;", "reps += 1; __fire++;");
det = det.replace("if (v < -k) st.armed = true;", "if (v < -k) { st.armed = true; __arm++; }");
if (!/__fire/.test(det) || !/__arm/.test(det)) throw new Error("插桩2未命中");

const swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
const FACT = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps = fpsInit||60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  let __ev = [], __arm = 0, __fire = 0;
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
  return { run(seq){ series=[];repCounters={};reps=0;repTimes=[];__ev=[];__arm=0;__fire=0;
    for(const s of seq){ const dflt={motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
      live=Object.assign({},dflt,liveInit,s); series.push(Object.assign({t:s.t},dflt,s));
      if(series.length>60*30) series.shift(); fps=s.__fps||fpsInit||60; detectReps(s.t); }
    return { reps, repTimes:repTimes.slice(), __ev:__ev.slice(), __arm, __fire }; } };
};`;
const eng = new Function(FACT)();

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
for (const key of ["jumpRope", "jumpingJacks"]) {
  const a = D.acts[key];
  const seq = a.series.map(s => Object.assign({ t: s.t }, s));
  const r = eng(a.profile, 60, { height: 0.6 }).run(seq);
  // __ev 里每个样本记录一次（采样窗内每帧会被重记，按 t 去重保留最后一次）
  const byT = new Map();
  for (const e of r.__ev) byT.set(e.t, e);
  const pts = [...byT.values()].sort((x, y) => x.t - y.t);
  const vmin = Math.min(...pts.map(p => p.v)), vmax = Math.max(...pts.map(p => p.v));
  const kavg = pts.reduce((s, p) => s + p.k, 0) / pts.length;
  const belowK = pts.filter(p => p.v < -p.k).length;
  const aboveK = pts.filter(p => p.v > p.k).length;
  console.log("=".repeat(92));
  console.log(`${a.cn}  信号=${a.signal}  引擎计数=${r.reps}  __arm=${r.__arm}  __fire=${r.__fire}`);
  console.log(`  平滑去趋势信号 v: min=${vmin.toFixed(4)}  max=${vmax.toFixed(4)}  平均阈值 k≈${kavg.toFixed(4)}`);
  console.log(`  样本 v < -k 的个数=${belowK}   v > k 的个数=${aboveK}`);
  console.log(`  → 信号${belowK > 0 ? "**有**下穿 -k（能被 ARM）" : "**从未**下穿 -k（迟滞永远武装不起来，无法 FIRE）"}`);
  const fires = r.repTimes.map(t => +t.toFixed(3));
  console.log(`  计数时刻=${JSON.stringify(fires)}  间隔=${JSON.stringify(fires.slice(1).map((t, i) => +(t - fires[i]).toFixed(3)))}`);
  // 打印每 0.1s 的 v/k 比值（看波形在阈值尺度下的样子）
  const step = Math.max(1, Math.round(0.1 / ((a.series[1].t - a.series[0].t))));
  let line = "";
  for (let i = 0; i < pts.length; i += step) {
    const ratio = pts[i].v / (pts[i].k || 1);
    line += ratio > 1 ? "+" : ratio < -1 ? "-" : ratio > .5 ? "·" : ratio < -.5 ? "." : " ";
  }
  console.log(`  波形(每格≈0.1s; '+'=过+k '-'=过-k '·'/'.'=近阈 ' '=平):  ${line}`);
}
