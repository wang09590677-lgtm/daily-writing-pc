/* 【跳绳/深蹲 剩余偏差归因 — 用真 detectReps】
 * 修复后 2× 已消除，但真机序列上"跳绳 5（真值 10）""徒手深蹲 4（真值 5）"仍偏低。
 * 要分清两笔账：
 *   (a) 信号品质：引擎信号本身能分辨出几拍（用独立峰值法量）
 *   (b) 计数器损失：计数器在同一个信号上又少了几拍
 * 另外 _realseries.json 是 24fps 视频零阶保持(ZOH)升到 60fps 的，阶梯可能干扰。
 * 用线性插值还原成连续信号再测一次，看偏差是否收敛。
 * 跑的是已落地的真 detectReps（与 _lead-harness.js 同一套抠取逻辑）。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 30)); return SRC.slice(i, j); }
const P = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
  swt: grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)"),
  sw: grab("function signalWindow(key, seconds)", "// 去趋势："),
  detrend: grab("function detrend(raw, win)", "function smooth(raw, k)"),
  smooth: grab("function smooth(raw, k)", "// 峰值计次"),
  detectReps: grab("function detectReps(now)", "/* ---------- 保持类 ---------- */")
};
const makeEngine = new Function(`
return function (profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() { if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals; return [cfg("signal") || "centroidY"]; }
${P.SIGNALS}${P.clamp}${P.mean}${P.std}${P.swt}${P.sw}${P.detrend}${P.smooth}${P.detectReps}
  return { run(seq) {
    series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
    for (const s of seq) { const d = { motion:0,area:0,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0 };
      live = Object.assign(d, liveInit, s); series.push(Object.assign({ t: s.t }, d, s));
      if (series.length > 1800) series.shift(); fps = 60; detectReps(s.t); }
    return reps; } };
};`)();

const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

/* 独立峰值法：数同一个信号里有几个峰 */
function peakRef(vals, h, k) {
  const sm = vals.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - h); j <= Math.min(vals.length - 1, i + h); j++) { a += vals[j]; n++; } return a / n; });
  const m = sm.reduce((a, b) => a + b, 0) / sm.length;
  const sd = Math.sqrt(sm.reduce((a, b) => a + (b - m) ** 2, 0) / sm.length) || 1e-6;
  const T = [];
  for (let i = h; i < sm.length - h; i++) { if (sm[i] - m < k * sd) continue; let mx = true; for (let j = i - h; j <= i + h; j++) if (j !== i && sm[j] > sm[i]) { mx = false; break; } if (mx) T.push(i); }
  const dd = []; for (const t of T) if (!dd.length || t - dd[dd.length - 1] > h) dd.push(t);
  const g = []; for (let i = 1; i < dd.length; i++) g.push((dd[i] - dd[i - 1]) / 60); g.sort((a, b) => a - b);
  return { n: dd.length, med: g.length ? g[Math.floor(g.length / 2)] : 0 };
}
/* ZOH → 线性插值 */
function deZoh(series, sig) {
  const uniq = [];
  for (const s of series) if (!uniq.length || Math.abs(s[sig] - uniq[uniq.length - 1].v) > 1e-12) uniq.push({ t: s.t, v: s[sig] });
  const src = uniq.length >= 3 ? uniq : series.map(s => ({ t: s.t, v: s[sig] }));
  const t0 = src[0].t, t1 = src[src.length - 1].t, n = Math.round((t1 - t0) * 60) + 1, out = [];
  let j = 0;
  for (let i = 0; i < n; i++) { const t = t0 + i / 60; while (j < src.length - 2 && src[j + 1].t < t) j++; const a = src[j], b = src[Math.min(j + 1, src.length - 1)]; const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; out.push({ t, v: a.v + (b.v - a.v) * u }); }
  return out;
}

const TRUTH = { jumpingJacks: "6~7", squat: "5(鼻y)", halfSquatWarm: "?", jumpRope: "10", burpee: "2" };
console.log("=".repeat(112));
console.log("【剩余偏差拆账】修复后的真 detectReps vs 独立峰值法 vs 真值");
console.log("-".repeat(112));
console.log("动作        信号       ZOH重放                        线性插值(去阶梯)              真值");
console.log("                     计数  峰值法  中位间隔           计数  峰值法  中位间隔");
for (const k of ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"]) {
  const a = R.acts[k], p = a.profile;
  const sig = a.signal;
  const zoh = a.series.map(s => { const o = Object.assign({}, s); return o; });
  const lin = deZoh(a.series, sig).map(o => ({ t: o.t, [sig]: o.v }));
  const cz = makeEngine(p, 60, { height: 0.6 }).run(zoh);
  const cl = makeEngine(p, 60, { height: 0.6 }).run(lin);
  const pz = peakRef(a.series.map(s => s[sig]), 10, 0.4);
  const pl = peakRef(lin.map(s => s[sig]), 10, 0.4);
  console.log(`${a.cn.padEnd(10)} ${sig.padEnd(9)} ${String(cz).padStart(4)}  ${String(pz.n).padStart(5)}  ${pz.med.toFixed(3)}s            ${String(cl).padStart(4)}  ${String(pl.n).padStart(5)}  ${pl.med.toFixed(3)}s      ${TRUTH[k]}`);
}
console.log("\n读数：① 计数 < 峰值法 → 计数器在丢拍；② 峰值法 < 真值 → 信号本身分辨不出那么多拍");
console.log("      ③ 线性插值后变化明显 → 说明有一部分是 24fps 重放的阶梯伪影（真机 30fps 不会有）");

console.log("\n" + "=".repeat(112));
console.log("【换信号有没有救】同一动作，逐个引擎信号过修复后的真计数器（真机 ZOH 序列）");
console.log("-".repeat(112));
const SIGS = ["motion", "area", "centroidX", "centroidY", "width", "height", "bottomL", "bottomR", "left", "right", "upper", "lower"];
for (const k of ["jumpRope", "squat", "jumpingJacks"]) {
  const a = R.acts[k], p = a.profile;
  const rows = [];
  for (const sig of SIGS) {
    if (!(sig in a.series[0])) continue;
    const seq = a.series.map(s => { const o = { t: s.t }; o[sig] = s[sig]; return o; });
    const c = makeEngine(p, 60, { height: 0.6 }).run(seq);
    const pk = peakRef(a.series.map(s => s[sig]), 10, 0.4);
    rows.push({ sig, c, pk: pk.n, med: pk.med, declared: sig === a.signal });
  }
  rows.sort((x, y) => y.c - x.c);
  console.log(`\n■ ${a.cn}（声明 ${a.signal}，真值 ${TRUTH[k]}）`);
  for (const r of rows.slice(0, 5)) console.log(`   ${r.declared ? "★" : " "}${r.sig.padEnd(11)} 计数 ${String(r.c).padStart(3)}   峰值法 ${String(r.pk).padStart(3)}   中位间隔 ${r.med.toFixed(3)}s`);
}
