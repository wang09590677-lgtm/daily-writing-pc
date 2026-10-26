/* 【参数扫描】找一组参数，让「真机 5 动作」+「静止/噪声」+「合成栅格」同时达标。
 *
 * 背景：现行（因果均值 + 水位线）把 2× 修掉了，但跳绳 10→5、徒手深蹲 5→4 = 欠计。
 * 本脚本扫描：detrend 方式 × k 系数 × win 系数 × 水位线开关，
 * 用**真机序列**（有真值）+ **静止噪声**（必须 0）双向约束筛参数。
 *
 * 注意：真机序列里没有 motion/area 的真实值（只有 t,width,height,centroidY），
 * 所以"静止噪声"用 _exp-series.json（它带完整字段）。
 * 用法：node build/_dbg-param-scan.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

const SRC_CUR = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
const SRC_BASE = fs.readFileSync(path.join(__dirname, "_rollback", "motion-engine.before-2xfix.js"), "utf8");
const g = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 34));
  return src.slice(i, j);
};
const COMMON = src => ({
  SIGNALS: g(src, "const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: g(src, "function clamp(v, a, b)", "function mean(arr)"),
  mean: g(src, "function mean(arr)", "function std(arr)"),
  std: g(src, "function std(arr)", "// 动作参数默认值"),
  signalWindow: g(src, "function signalWindow(key, seconds)", "// 去趋势："),
  smooth: g(src, "function smooth(raw, k)", "// 峰值计次"),
});
const CENTER = g(SRC_BASE, "function detrend(raw, win)", "function smooth(raw, k)");
const CAUSAL = g(SRC_CUR, "function detrend(raw, win)", "function smooth(raw, k)");
const REP_BASE = g(SRC_BASE, "function detectReps(now)", "/* ---------- 保持类 ---------- */");
const REP_CUR = g(SRC_CUR, "function detectReps(now)", "/* ---------- 保持类 ---------- */");

/* 参数化修补：把 k 系数 0.85 与 win 系数换成可注入常量 */
function patchK(code, coef) { return code.replace(/rms \* 0\.85/, "rms * " + coef); }
function patchWin(code, coef) { return code.replace(/Math\.max\(15, band\[1\]\)/, "Math.max(15, band[1] * " + coef + ")"); }
function patchWin0(code, coef) { return code.replace(/Math\.max\(15, band\[0\]\)/, "Math.max(15, band[0] * " + coef + ")"); }

function mkEngine(cfg) {
  const src = cfg.base ? SRC_BASE : SRC_CUR;
  const c = COMMON(src);
  const swt = src.includes("function signalWindowTimes(")
    ? g(src, "function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)")
    : "function signalWindowTimes(){ return []; }";
  let detrend = cfg.causal ? CAUSAL : CENTER;
  let reps = cfg.watermark ? REP_CUR : REP_BASE;
  reps = patchK(reps, cfg.kCoef);
  if (cfg.winBy === "band1") reps = patchWin(reps, cfg.winCoef);
  else reps = patchWin0(reps, cfg.winCoef);

  const F = `
return function mk(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60, profile = profileIn, live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${c.SIGNALS}${c.clamp}${c.mean}${c.std}${swt}${c.signalWindow}${detrend}${c.smooth}${reps}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const d = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: 0, height: 0, bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        series.push(Object.assign({ t: s.t }, d, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        detectReps(s.t);
      }
      return { reps, gate: repGate, spread: repSpread };
    }
  };
};`;
  return new Function(F)();
}

const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const TRUTH = { jumpingJacks: 7, squat: 5, halfSquatWarm: null, jumpRope: 10, burpee: 2 };
const REAL_KEYS = ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"];

function score(cfg) {
  const E = mkEngine(cfg);
  const rows = [];
  let err = 0;
  for (const k of REAL_KEYS) {
    const e = R.acts[k];
    const seq = e.series.map(s => Object.assign({}, s));
    let n; try { n = E(e.profile, 60, { height: 0.6 }).run(seq).reps; } catch (err2) { n = NaN; }
    rows.push({ k, cn: e.cn, n, truth: TRUTH[k] });
    if (TRUTH[k] != null) err += Math.abs(n - TRUTH[k]);
  }
  // 静止/噪声必须全 0（只对有真值的静/噪场景）
  let noiseMax = 0, noiseDetail = [];
  for (const [k, e] of Object.entries(EXP)) {
    if (!/static|noise/i.test(k)) continue;
    const seq = e.series.map(s => Object.assign({}, s));
    let n; try { n = E(e.profile, 60, { height: 0.6 }).run(seq).reps; } catch (err2) { n = 99; }
    noiseDetail.push(k + "=" + n);
    if (n > noiseMax) noiseMax = n;
  }
  // 合成栅格：匀幅正弦，真值 = 频率×秒数
  let gridErr = 0, gridN = 0;
  for (const k of ["jumpingJacks", "jumpRope", "squat", "halfSquatWarm", "burpee"]) {
    const p0 = R.acts[k].profile;
    const band = p0.tempoBand || [20, 60];
    for (const rate of [band[0], Math.round((band[0] + band[1]) / 2), band[1]]) {
      const f = rate / 60, seq = [];
      for (let i = 0; i < 60 * 20; i++) {
        const o = { t: i / 60, motion: 0, area: .1, centroidX: .5, centroidY: .5, width: .3, height: .6 };
        o[p0.signal] = 0.15 * Math.sin(2 * Math.PI * f * i / 60);
        seq.push(o);
      }
      let n; try { n = E(p0, 60, { height: 0.6 }).run(seq).reps; } catch (err2) { n = NaN; }
      const exp = f * 20;
      gridErr += Math.abs(n - exp) / exp; gridN++;
    }
  }
  return { rows, err, noiseMax, noiseDetail, gridRelErr: gridErr / gridN };
}

const combos = [];
for (const causal of [false, true])
  for (const watermark of [false, true])
    for (const kCoef of [0.85, 0.7, 0.6, 0.5])
      for (const winCoef of [1, 2, 3])
        combos.push({ causal, watermark, kCoef, winCoef, winBy: "band1", base: !causal });

console.log("扫 " + combos.length + " 组…（真机误差 = Σ|数出-真值|，越小越好；噪声必须 0；栅格 = 相对误差）");
const out = [];
for (const c of combos) {
  try { out.push({ c, s: score(c) }); } catch (e) { }
}
out.sort((a, b) => (a.s.noiseMax - b.s.noiseMax) * 100 + (a.s.err - b.s.err) + (a.s.gridRelErr - b.s.gridRelErr) * 10);

const top = out.slice(0, 18);
console.log("\n排名  居中/因果 水位线  k系数 win系数 | 真机误差 噪声max 栅格误差 | 开合跳 深蹲 热身 跳绳 波比");
for (let i = 0; i < top.length; i++) {
  const { c, s } = top[i];
  const b = s.rows.map(r => String(r.n).padStart(3) + (r.truth != null ? "" : "?")).join(" ");
  console.log(
    String(i + 1).padStart(3) + "   " +
    (c.causal ? "因果  " : "居中  ") + (c.watermark ? " 开  " : " 关  ") +
    String(c.kCoef).padStart(5) + String(c.winCoef).padStart(6) + "  |" +
    String(s.err).padStart(7) + String(s.noiseMax).padStart(6) + s.gridRelErr.toFixed(3).padStart(8) + "  | " + b
  );
}
console.log("\n真值：" + REAL_KEYS.map(k => (R.acts[k].cn + "=" + (TRUTH[k] == null ? "?" : TRUTH[k]))).join("  "));
console.log("静止/噪声场景：" + JSON.stringify(Object.keys(EXP).filter(k => /static|noise/i.test(k))));
