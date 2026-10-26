/* 【verifier-oneshot 欠计归因分析】纯离线，不启动 Chrome。
 *
 *  1. 对真机 5 动作的**目标信号**独立数"峰"（局部极大值，带最小间隔过滤），
 *     得到"信号里客观有几个可分辨的峰"——与引擎计数对比。
 *  2. 用同一份序列，把引擎换到其它信号（height/centroidY/width/bottomL/bottomR）
 *     跑一遍，看哪个信号能数出接近历史真值的次数。
 *  3. 在**完美正弦**上扫幅度/频率，检验修复后引擎是否在理想信号上也丢拍。
 *  4. 量化 detrend 因果均值在**序列开头**的暖机损失。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

/* ---- 抠真函数（与 _ab-2x-under.js 同手法，但独立实现） ---- */
function buildEngine(file) {
  const src = fs.readFileSync(file, "utf8");
  const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败:" + a.slice(0, 30)); return src.slice(i, j); };
  const swt = src.includes("function signalWindowTimes(")
    ? grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)")
    : "function signalWindowTimes(){ return []; }";
  const FACT = `
  return function makeEngine(profileIn, fpsInit, liveInit) {
    let fps = fpsInit || 60, profile = profileIn, live = liveInit;
    let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
    function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
    function signalList() { if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals; return [cfg("signal") || "centroidY"]; }
    ${grab("const SIGNALS = {", "function clamp(v, a, b)")}
    ${grab("function clamp(v, a, b)", "function mean(arr)")}
    ${grab("function mean(arr)", "function std(arr)")}
    ${grab("function std(arr)", "// 动作参数默认值")}
    ${swt}
    ${grab("function signalWindow(key, seconds)", "// 去趋势：")}
    ${grab("function detrend(raw, win)", "function smooth(raw, k)")}
    ${grab("function smooth(raw, k)", "// 峰值计次")}
    ${grab("function detectReps(now)", "/* ---------- 保持类 ---------- */")}
    return { run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0, bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        live = Object.assign({}, dflt, liveInit, s);
        series.push(Object.assign({ t: s.t }, dflt, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        detectReps(s.t);
      }
      return { reps, repTimes: repTimes.slice() };
    } };
  };`;
  return new Function(FACT)();
}
const NOW = buildEngine(path.join(ROOT, "motion-engine.js"));
const BASE = buildEngine(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"));

const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const mk = (factory, profile) => factory(profile, 60, { height: 0.6 });
const runSig = (factory, profile, series, sig) => mk(factory, Object.assign({}, profile, { signal: sig }))
  .run(series.map(s => Object.assign({ t: s.t }, s, { [sig]: s[sig] }))).reps;

/* ---- 独立数峰：去趋势（线性，避免因果暖机影响）后数"下-上"完整过零对 ----
 * 这里故意用**对称**的简单去均值，因为目的是客观描述信号，而不是复刻引擎。 */
function countPeaks(series, sig, minGapSec) {
  const v = series.map(s => s[sig]);
  const n = v.length;
  let gsum = 0; for (const x of v) gsum += x;
  const mean = gsum / n;
  // 平滑（3 点）
  const sm = v.map((_, i) => (v[Math.max(0, i - 1)] + v[i] + v[Math.min(n - 1, i + 1)]) / 3);
  const dev = sm.map(x => x - mean);
  // 阈值 = 0.3 × 半峰距（p90-p10 的一半），过滤噪声抖动
  const sorted = [...dev].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(n * 0.1)], p90 = sorted[Math.floor(n * 0.9)];
  const thr = (p90 - p10) * 0.3;
  let armed = false, count = 0, lastT = -1;
  for (let i = 0; i < n; i++) {
    const t = series[i].t, x = dev[i];
    if (x < -thr) armed = true;
    else if (x > thr && armed) { if (lastT < 0 || t - lastT >= minGapSec) { count++; lastT = t; } armed = false; }
  }
  return count;
}
// 另外数"局部极大值"（更朴素）
function countLocalMax(series, sig) {
  const v = series.map(s => s[sig]);
  let c = 0;
  for (let i = 1; i < v.length - 1; i++) if (v[i] > v[i - 1] && v[i] >= v[i + 1]) c++;
  return c;
}

console.log("=".repeat(100));
console.log("【1】真机 5 动作：引擎计数 vs 信号客观可分辨峰数");
console.log("-".repeat(100));
console.log("动作        信号       现引擎  基线   信号峰数(客观)  局部极大   历史真值  序列时长");
const HIST = { jumpingJacks: "6~7", squat: "5", halfSquatWarm: "?", jumpRope: "10", burpee: "2" };
for (const [k, a] of Object.entries(D.acts)) {
  const sig = a.signal, p = a.profile;
  const now = runSig(NOW, p, a.series, sig);
  const base = runSig(BASE, p, a.series, sig);
  const pk = countPeaks(a.series, sig, p.minRepGap || 0.5);
  const lm = countLocalMax(a.series, sig);
  const dur = (a.series[a.series.length - 1].t - a.series[0].t).toFixed(1);
  console.log("  " + a.cn.padEnd(9) + sig.padEnd(11) + String(now).padStart(5) + String(base).padStart(6) +
    String(pk).padStart(14) + String(lm).padStart(9) + String(HIST[k]).padStart(10) + (dur + "s").padStart(10));
}

console.log("\n" + "=".repeat(100));
console.log("【2】跳跃类动作：换不同信号，现引擎能数出几次（看是否换了信号就更接近真值）");
console.log("-".repeat(100));
const CAND = ["height", "centroidY", "width", "bottomL", "bottomR", "centroidX"];
for (const k of ["jumpRope", "squat", "halfSquatWarm", "burpee", "jumpingJacks"]) {
  const a = D.acts[k];
  const row = CAND.map(sig => {
    const r = runSig(NOW, a.profile, a.series, sig);
    return sig + "=" + r;
  });
  console.log("  " + a.cn.padEnd(9) + " 历史真值 " + String(HIST[k]).padEnd(4) + " (本条声明信号=" + a.signal + ")  " + row.join("  "));
}

console.log("\n" + "=".repeat(100));
console.log("【3】完美正弦：修复后引擎有没有丢拍？（60 秒，幅值 0.15，centroidY）");
console.log("-".repeat(100));
{
  const p = { mode: "rep", signal: "centroidY", tempoBand: [20, 120], minRepGap: 0.3, expectedAmplitude: 0.1 };
  for (const rpm of [20, 30, 40, 60, 90, 120]) {
    const seq = []; const f = rpm / 60;
    for (let i = 0; i < 60 * 60; i++) seq.push({ t: i / 60, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5 + 0.15 * Math.sin(2 * Math.PI * f * i / 60), width: 0.3, height: 0.6 });
    const now = mk(NOW, p).run(seq).reps, base = mk(BASE, p).run(seq).reps;
    console.log(`  ${String(rpm).padStart(3)}/分  真值=${String(rpm).padStart(3)}  现引擎=${String(now).padStart(3)} (${(now / rpm).toFixed(3)})  基线=${String(base).padStart(3)} (${(base / rpm).toFixed(3)})`);
  }
}

console.log("\n" + "=".repeat(100));
console.log("【4】幅度扫描（60/分 正弦，看现引擎的幅度下限在哪）");
console.log("-".repeat(100));
{
  const p = { mode: "rep", signal: "centroidY", tempoBand: [20, 120], minRepGap: 0.3, expectedAmplitude: 0.1 };
  const ampLine = [];
  for (const amp of [0.02, 0.05, 0.08, 0.1, 0.15, 0.3]) {
    const seq = [];
    for (let i = 0; i < 60 * 60; i++) seq.push({ t: i / 60, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5 + amp * Math.sin(2 * Math.PI * 1.0 * i / 60), width: 0.3, height: 0.6 });
    ampLine.push(`amp=${amp}: now=${mk(NOW, p).run(seq).reps}`);
  }
  console.log("  " + ampLine.join("   "));
}

console.log("\n" + "=".repeat(100));
console.log("【5】因果均值开头暖机损失：正弦 60/分，逐帧看累计计数何时追上真值");
console.log("-".repeat(100));
{
  const p = { mode: "rep", signal: "centroidY", tempoBand: [20, 120], minRepGap: 0.3, expectedAmplitude: 0.1 };
  const seq = [];
  for (let i = 0; i < 30 * 60; i++) seq.push({ t: i / 60, motion: 0.01, area: 0.1, centroidX: 0.5, centroidY: 0.5 + 0.15 * Math.sin(2 * Math.PI * 1.0 * i / 60), width: 0.3, height: 0.6 });
  // 截断到不同时长跑
  for (const sec of [1, 2, 3, 4, 5, 8, 15, 30]) {
    const sub = seq.slice(0, sec * 60);
    const now = mk(NOW, p).run(sub).reps;
    console.log(`  前 ${String(sec).padStart(2)}s: 现引擎=${String(now).padStart(3)}  真值≈${sec}  ${now >= sec - 1 ? "" : "  <-- 落后"}`);
  }
}
