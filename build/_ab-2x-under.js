/* 【关键 A/B】2× 修复到底有没有引入 "欠计"？
 *
 * 背景：真机反馈"修复后跳绳只数 5 次（真值 10）"。历史上把这归为"信号分辨不出"。
 * 但 10-06 发现一个更硬的线索：**同一个合成夹具**，
 *   · 修复前基线（motion-engine.before-2xfix.js）→ 探针能数到 20 次（链路完整跑通）
 *   · 修复后（现行 motion-engine.js）      → 只数到 1 次（pct 卡在 5）
 * 需求只有一条："正确完成一次才计数一次" —— 欠计和超额一样是违约。
 *
 * 本脚本：把**两个版本的引擎**分别用【同一份数据】跑，直接对比。
 * 抠的是各自文件里的真函数原文（不是脚本复刻）。
 *
 * 用法：node build/_ab-2x-under.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

const FILES = {
  "修复后(现行)": path.join(ROOT, "motion-engine.js"),
  "修复前(基线)": path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"),
};

/* 把一个 motion-engine.js 原文组装成可跑的真 detectReps。
 * 基线版可能没有 signalWindowTimes（它是本次修复新增的），所以做成可选。 */
function buildEngine(src, label) {
  const grab = (a, b) => {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`[${label}] 抠取失败：${a.slice(0, 34)}`);
    return src.slice(i, j);
  };
  const parts = {
    SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
    clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
    mean: grab("function mean(arr)", "function std(arr)"),
    std: grab("function std(arr)", "// 动作参数默认值"),
  };
  // signalWindowTimes 是修复新增的；基线没有 → 用一个等价桩（由 signalWindow 反推不行，
  // 因为基线根本不用它）。直接给个返回 [] 的桩，基线代码路径不会用到。
  let swt;
  if (src.includes("function signalWindowTimes(")) swt = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
  else swt = "function signalWindowTimes(){ return []; }";
  parts.signalWindowTimes = swt;
  parts.signalWindow = grab("function signalWindow(key, seconds)", "// 去趋势：");
  parts.detrend = grab("function detrend(raw, win)", "function smooth(raw, k)");
  parts.smooth = grab("function smooth(raw, k)", "// 峰值计次");
  parts.detectReps = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");

  const FACTORY = `
  return function makeEngine(profileIn, fpsInit, liveInit) {
    let fps = fpsInit || 60;
    let profile = profileIn;
    let live = liveInit;
    let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
    function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
    function signalList() {
      if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
      return [cfg("signal") || "centroidY"];
    }
  ${parts.SIGNALS}
  ${parts.clamp}
  ${parts.mean}
  ${parts.std}
  ${parts.signalWindowTimes}
  ${parts.signalWindow}
  ${parts.detrend}
  ${parts.smooth}
  ${parts.detectReps}
    return {
      run(seq) {
        series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
        for (const s of seq) {
          const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0,
            bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
          const row = Object.assign(dflt, liveInit, s);
          live = row;
          series.push(Object.assign({ t: s.t }, dflt, s));
          if (series.length > 60 * 30) series.shift();
          fps = s.__fps || fpsInit || 60;
          detectReps(s.t);
        }
        return { reps, repTimes: repTimes.slice(), repGate, repSpread };
      }
    };
  };
  `;
  return { makeEngine: new Function(FACTORY)(), hasWatermark: /scannedT/.test(parts.detectReps), hasTail: /\btail\b/.test(parts.detectReps), hasCausal: /acc -= raw\[i - w\]/.test(parts.detrend) };
}

const ENG = {};
for (const [label, f] of Object.entries(FILES)) {
  if (!fs.existsSync(f)) { console.log(`跳过（文件不存在）：${label} → ${f}`); continue; }
  ENG[label] = buildEngine(fs.readFileSync(f, "utf8"), label);
}
console.log("引擎构建：");
for (const [k, v] of Object.entries(ENG)) console.log(`  ${k.padEnd(14)} 水位线=${v.hasWatermark ? "有" : "无"}  尾部重扫tail=${v.hasTail ? "有" : "无"}  因果均值=${v.hasCausal ? "有" : "无"}`);

/* ---------- 数据源 ---------- */
const files = {
  "真机5动作": path.join(__dirname, "_tmp", "_realseries.json"),
  "静止/噪声": path.join(__dirname, "_exp-series.json"),
};
console.log("\n" + "=".repeat(96));
console.log("【A/B】同一份数据、两个引擎版本（只跑 rep 类动作）");
console.log("=".repeat(96));

for (const [tag, f] of Object.entries(files)) {
  if (!fs.existsSync(f)) { console.log(`\n[${tag}] 数据缺失，跳过（${f}）`); continue; }
  const D = JSON.parse(fs.readFileSync(f, "utf8"));
  console.log(`\n── ${tag} ──`);
  console.log("  场景".padEnd(20) + "信号".padEnd(12) + Object.keys(ENG).map(k => k.padStart(13)).join("") + "   比值");
  const acts = D.acts ? Object.entries(D.acts) : Object.entries(D);
  for (const [k, e] of acts) {
    const p = e.profile || {};
    if (p.mode !== "rep") continue;
    const seq = (e.series || []).map(s => { const o = Object.assign({}, s); delete o.t; return Object.assign({ t: s.t }, o); });
    const out = {};
    for (const [label, E] of Object.entries(ENG)) {
      try { out[label] = E.makeEngine(p, 60, { height: 0.6 }).run(seq).reps; } catch (err) { out[label] = "ERR:" + err.message.slice(0, 18); }
    }
    const ks = Object.keys(ENG);
    const a = out[ks[0]], b = out[ks[1]];
    const ratio = (typeof a === "number" && typeof b === "number" && b > 0) ? (a / b).toFixed(3) : "—";
    const cn = (e.cn || k);
    console.log("  " + cn.padEnd(18) + String(e.signal || p.signal || "?").padEnd(12) +
      ks.map(x => String(out[x]).padStart(13)).join("") + "   " + ratio);
  }
}
