/* 【终审实验】在**真机姿态链录制的 60fps 原始序列**上（_realseries.json，引擎实吃的那份数组），
 * 直接对比 现状 / F，并给出该序列上可人工核对的物理真值。不做任何重采样 → 无伪影。
 *
 * 真值口径（对每个动作选其"单峰物理量"）：
 *   开合跳 = 腕 y 均值(15,16) 的极小值个数（手举到最高 = y 最小），6 个独立量交叉
 *   跳绳/深蹲/波比 = 踝 y(27,28) 或髋 y 的极小值个数
 * 此外给出 FFT 主频折算的周期数作为第二口径。
 *
 * 输出：每个动作 [真值区间] vs [现状] vs [F]，并标出 2× 是否被消掉。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const ENG_FPS = 60, WIN_SECS = 3.5, TAIL_SECS = 0.35;
function counter(win, gap, mode) {
  const env = `${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${gap}, MODE = "${mode}";
      let reps = 0, lastAt = -1, armed = false;
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        const start = MODE === "prod" ? Math.max(0, d.length - tailN) : Math.max(0, d.length - 1);
        for (let i = start; i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= gapN) { reps += 1; lastAt = now; } armed = false; }
        }
      }
      return reps;
    };`;
  return new Function(env)();
}
// 引擎侧 win（复刻 motion-engine.js:2576）
const engWin = (fps, band) => Math.max(3, Math.min(Math.round(fps * 60 / Math.max(15, band[1])), Math.round(fps * 1.5)));
const engWinSec = (band) => engWin(60, band) / 60;

function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function extremaCount(a, gapF, prom, wantMin) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) {
    const is = wantMin ? (a[i] <= a[i - 1] && a[i] < a[i + 1]) : (a[i] >= a[i - 1] && a[i] > a[i + 1]);
    if (!is) continue;
    if (idx.length && i - idx[idx.length - 1] < gapF) { const b = wantMin ? a[i] < a[idx[idx.length - 1]] : a[i] > a[idx[idx.length - 1]]; if (b) idx[idx.length - 1] = i; }
    else idx.push(i);
  }
  return idx.filter(i => { const lo = Math.max(0, i - 20), hi = Math.min(a.length, i + 20); const sl = a.slice(lo, hi); const ref = wantMin ? Math.max(...sl) : Math.min(...sl); return Math.abs(ref - a[i]) >= prom; });
}
function fftMain(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n);
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
      const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
    }
  }
  let best = 1, bv = -1;
  for (let i = 2; i < n / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > bv) { bv = p; best = i; } }
  return best * fps / n;
}
// 取 _lm.json 中某动作的关节序列（24fps），用于真值
function lmCol(name, idxs, axis) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite);
    out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN);
  }
  return fill(out);
}
const TRUTH = {
  jumpingJacks: { label: "开合跳", cn: "腕y(15,16)", fn: () => lmCol("jumpingJacks", [15, 16], 1), gap: 4, prom: 0.02 },
  squat: { label: "徒手深蹲", cn: "踝y(27,28)", fn: () => lmCol("squat", [27, 28], 1), gap: 6, prom: 0.02 },
  halfSquatWarm: { label: "半蹲热身", cn: "髋y(23,24)", fn: () => lmCol("squat", [23, 24], 1), gap: 6, prom: 0.02 },
  jumpRope: { label: "跳绳", cn: "踝y(27,28)", fn: () => lmCol("jumpRope", [27, 28], 1), gap: 3, prom: 0.01 },
  burpee: { label: "波比跳", cn: "踝y(27,28)", fn: () => lmCol("burpee", [27, 28], 1), gap: 6, prom: 0.02 },
};

console.log("=== 真机姿态链实测（_realseries.json 60fps，引擎实吃数组）===");
console.log("动作      信号      band      win(帧/秒) minGap | 真值(腕/踝极小) 真值(FFT) | 现状  |  F  ");
console.log("-".repeat(112));
const summary = [];
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], p = a.profile;
  const sig = a.signal, band = p.tempoBand, gap = p.minRepGap;
  const win = engWin(60, band), winSec = engWinSec(band);
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const rp = counter(win, gap, "prod")(series, 60);
  const rf = counter(win, gap, "F")(series, 60);
  const T = TRUTH[name];
  const tv = T.fn();
  const s3 = smoothArr(tv, 3);
  const tMin = extremaCount(s3, T.gap, T.prom, true).length;
  const dur = tv.length / 24;
  const tFft = fftMain(tv, 24) * dur;
  const bar = v => String(v).padStart(4);
  console.log(
    `${T.label.padEnd(7)} ${sig.padEnd(8)} [${String(band[0]).padStart(2)},${String(band[1]).padStart(2)}]  ${String(win).padStart(2)}帧/${winSec.toFixed(2)}s  ${String(gap).padStart(4)} | ${String(tMin).padStart(8)}(${T.cn}) ${tFft.toFixed(1).padStart(7)} | ${bar(rp)}  | ${bar(rf)}`
  );
  summary.push({ name, label: T.label, tMin, tFft, rp, rf, band, gap, winSec });
}
console.log("\n=== 判定表（比值）===");
console.log("动作      真值区间      现状/真值      F/真值     现状是否2×     F 是否落在真值区间内");
for (const s of summary) {
  const tlo = Math.min(s.tMin, Math.round(s.tFft)), thi = Math.max(s.tMin, Math.round(s.tFft));
  const tm = (s.tMin + s.tFft) / 2;
  const inF = s.rf >= tlo * 0.75 && s.rf <= thi * 1.25 ? "✅" : "⚠️";
  const inP = s.rp >= tlo * 0.75 && s.rp <= thi * 1.25 ? "✅" : "❌超";
  console.log(`${s.label.padEnd(7)} [${tlo}~${thi}] (中${tm.toFixed(1)})   ${s.rp}/${tm.toFixed(1)}=${(s.rp / tm).toFixed(2)}      ${s.rf}/${tm.toFixed(1)}=${(s.rf / tm).toFixed(2)}     ${inP}          ${inF} (F=${s.rf})`);
}
