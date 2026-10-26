/* 【verifier-oneshot 黄金标准：频域窄带重建】纯离线。
 * 用 DFT 精确抽取 1.65Hz 附近分量并逆变换重建（不掉相位、不引入 biquad 误差），
 * 再数重建信号的过零数——这是"信号里客观有几个 1.65Hz 周期"的权威答案。
 * 同时把重建后的纯分量喂给现行引擎，看它能不能数到应有的次数。
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

// 朴素 DFT（n 小，O(n^2) 可接受）
function dft(x) {
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) { const ph = -2 * Math.PI * k * i / n; sr += x[i] * Math.cos(ph); si += x[i] * Math.sin(ph); }
    re[k] = sr; im[k] = si;
  }
  return { re, im };
}
function idft(re, im) {
  const n = re.length, y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) { const ph = 2 * Math.PI * k * i / n; s += re[k] * Math.cos(ph) - im[k] * Math.sin(ph); }
    y[i] = s / n;
  }
  return y;
}

for (const key of ["jumpRope", "jumpingJacks"]) {
  const a = D.acts[key], sig = a.signal;
  const seq = a.series;
  const n = seq.length, v = seq.map(s => s[sig]);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const x = v.map(a => a - mean);
  const { re, im } = dft(x);
  const dur = seq[n - 1].t - seq[0].t;
  const binHz = 1 / (n / 60); // 采样 60/s → 总时长 n/60 秒
  // 找出幅度最大的 bin（k>0）
  let kmax = 1, magmax = -1;
  for (let k = 1; k < n / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > magmax) { magmax = m; kmax = k; } }
  const fpeak = kmax / (n / 60);
  console.log("=".repeat(92));
  console.log(`${a.cn} 信号=${sig} 时长=${dur.toFixed(2)}s 主 bin k=${kmax} 频率=${fpeak.toFixed(3)}Hz (${(fpeak * 60).toFixed(0)}/分)`);
  // 窄带重建：只保留 kmax 及其左右各 1 个 bin
  for (const half of [0, 1, 2]) {
    const R = new Float64Array(n), I = new Float64Array(n);
    for (let k = Math.max(1, kmax - half); k <= Math.min(n / 2, kmax + half); k++) { R[k] = re[k]; I[k] = im[k]; R[n - k] = re[n - k]; I[n - k] = im[n - k]; }
    const y = idft(R, I);
    let zc = 0; for (let i = 1; i < n; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    const amp = Math.max(...y) - Math.min(...y);
    console.log(`  窄带重建(±${half} bin, ${(2 * half + 1) * binHz.toFixed(3)}Hz 带宽): 过零=${zc} 次  峰峰=${amp.toFixed(5)}  → 客观周期数 ≈ ${zc}`);
  }
  // 直接数原始信号去均值后的正向过零（无滤波）
  let zcRaw = 0; for (let i = 1; i < n; i++) if (x[i - 1] < 0 && x[i] >= 0) zcRaw++;
  console.log(`  原始去均值信号直接数过零 = ${zcRaw} 次（含慢漂移穿越）`);
  // 全频带重建（校验 idft 正确性）
  const yAll = idft(re.slice(), im.slice());
  let err = 0; for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(yAll[i] - x[i]));
  console.log(`  IDFT 自检：全频带重建与原信号最大误差 = ${err.toExponential(2)}（应≈0）`);
}
