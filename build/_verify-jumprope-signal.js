/* 【verifier-oneshot 跳绳信号细察】纯离线。
 * 目的：判断 jumpRope 的 height 信号里，客观到底有几个**可分辨的完整摆幅**。
 * 手法（三条独立证据）：
 *   a) 打印去趋势后波形 + 峰值/谷值出现时刻
 *   b) 自相关主周期（不看阈值，纯统计）
 *   c) 频域：DFT 主峰频率 → 换算成"信号里有几次/秒"
 * 并与历史真值 10 对比。
 */
"use strict";
const fs = require("fs"), path = require("path");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

function analyze(name, series, sig) {
  const t = series.map(s => s.t), v = series.map(s => s[sig]);
  const n = v.length;
  const dt = (t[n - 1] - t[0]) / (n - 1);
  const dur = t[n - 1] - t[0];
  // 去均值 + 3点平滑
  let mean = v.reduce((a, b) => a + b, 0) / n;
  const sm = v.map((_, i) => (v[Math.max(0, i - 1)] + v[i] + v[Math.min(n - 1, i + 1)]) / 3);
  let smMean = sm.reduce((a, b) => a + b, 0) / n;
  const x = sm.map(a => a - smMean);

  // --- b) 自相关主周期（正滞后里第一个显著峰） ---
  const len = Math.floor(n / 2);
  let acBest = 0, acBestLag = 0;
  const acFirst = [];
  for (let lag = 1; lag < len; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    s /= (n - lag);
    acFirst.push(s);
    if (lag > 2 && s > acBest) { acBest = s; acBestLag = lag; }
  }
  // 更稳：找自相关曲线里第一个"从下降转为上升"后的局部峰
  let firstPeakLag = 0;
  for (let lag = 2; lag < acFirst.length - 1; lag++) {
    if (acFirst[lag] > acFirst[lag - 1] && acFirst[lag] >= acFirst[lag + 1] && acFirst[lag] > 0) { firstPeakLag = lag + 1; break; }
  }

  // --- c) DFT 主峰（低频段） ---
  const N = 4096;
  let bestF = 0, bestMag = -1;
  for (let kf = 1; kf < 200; kf++) {
    const f = kf / (N * dt);
    if (f < 0.2 || f > 5) continue;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const ph = 2 * Math.PI * f * t[i];
      re += x[i] * Math.cos(ph); im -= x[i] * Math.sin(ph);
    }
    const mag = Math.hypot(re, im) / n;
    if (mag > bestMag) { bestMag = mag; bestF = f; }
  }

  // 极值点（带最小间隔 0.1s），只统计"显著"的（超过 0.4×RMS）
  const rms = Math.sqrt(x.reduce((a, b) => a + b * b, 0) / n);
  const peaks = [], troughs = [];
  for (let i = 1; i < n - 1; i++) {
    if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0.5 * rms) {
      if (!peaks.length || t[i] - peaks[peaks.length - 1].t >= 0.1) peaks.push({ i, t: t[i], v: x[i] });
    }
    if (x[i] < x[i - 1] && x[i] <= x[i + 1] && x[i] < -0.5 * rms) {
      if (!troughs.length || t[i] - troughs[troughs.length - 1].t >= 0.1) troughs.push({ i, t: t[i], v: x[i] });
    }
  }

  console.log("=".repeat(96));
  console.log(`${name}  信号=${sig}  时长=${dur.toFixed(2)}s  样本=${n}`);
  console.log(`  直流均值=${mean.toFixed(5)}  交流RMS=${rms.toFixed(5)}  峰峰值=${(Math.max(...x) - Math.min(...x)).toFixed(5)}`);
  console.log(`  自相关主周期 = ${(firstPeakLag * dt).toFixed(3)}s  →  信号主频 ≈ ${(1 / (firstPeakLag * dt)).toFixed(2)} Hz = ${(60 / (firstPeakLag * dt)).toFixed(0)} 次/分`);
  console.log(`  DFT 主峰     = ${bestF.toFixed(3)} Hz = ${(bestF * 60).toFixed(0)} 次/分  →  约 ${(bestF * dur).toFixed(1)} 个周期`);
  console.log(`  显著波峰 ${peaks.length} 个，波谷 ${troughs.length} 个（阈值 0.5×RMS）`);
  console.log(`  波峰时刻: ${peaks.map(p => p.t.toFixed(2)).join(", ")}`);
  console.log(`  历史记载真值: 见任务描述（跳绳 10）`);
  // 打印波形（每 0.1s 一个采样点，便于人眼看清）
  const step = Math.max(1, Math.round(0.1 / dt));
  let line = "";
  for (let i = 0; i < n; i += step) {
    const bar = Math.round(x[i] / rms * 10);
    line += String.fromCharCode(65 + Math.min(25, Math.max(0, bar + 12)));
  }
  console.log("  波形(0.1s/字符, 中=M): " + line.slice(0, 80));
  return { peaks: peaks.length, troughs: troughs.length, acHz: 1 / (firstPeakLag * dt), dftHz: bestF, dur };
}

const r1 = analyze("跳绳", D.acts.jumpRope.series, "height");
const r2 = analyze("跳绳(改看 centroidY)", D.acts.jumpRope.series, "centroidY");
const r3 = analyze("跳绳(改看 width)", D.acts.jumpRope.series, "width");
const r4 = analyze("开合跳(真值6~7, 用于校准本分析器)", D.acts.jumpingJacks.series, "width");
const r5 = analyze("波比跳(真值2)", D.acts.burpee.series, "height");

console.log("\n" + "=".repeat(96));
console.log("结论对照（信号客观峰数 vs 引擎计数 vs 历史真值）");
console.log("-".repeat(96));
console.log(`  跳绳 height      : 客观波峰 ${r1.peaks} / DFT ${(r1.dftHz * r1.dur).toFixed(1)} 周期  引擎数=5   历史真值=10`);
console.log(`  跳绳 centroidY   : 客观波峰 ${r2.peaks} / DFT ${(r2.dftHz * r2.dur).toFixed(1)} 周期  引擎数=7`);
console.log(`  跳绳 width       : 客观波峰 ${r3.peaks} / DFT ${(r3.dftHz * r3.dur).toFixed(1)} 周期  引擎数=6`);
console.log(`  开合跳 width     : 客观波峰 ${r4.peaks} / DFT ${(r4.dftHz * r4.dur).toFixed(1)} 周期  引擎数=6   历史真值=6~7`);
console.log(`  波比跳 height    : 客观波峰 ${r5.peaks} / DFT ${(r5.dftHz * r5.dur).toFixed(1)} 周期  引擎数=2   历史真值=2`);
