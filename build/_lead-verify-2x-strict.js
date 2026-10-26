/* 独立复核 2×（严格版）：忠实复刻 detectReps 的**逐帧滑窗**行为。
 *
 * 上一版 _lead-verify-2x.js 的错误：只对整段 20s 做了一次 detrend。
 * 真实引擎是**每一帧**都对"最近 3.5s 的窗口"重新 detrend，再只看最近 0.35s。
 * 这两者不等价（局部均值窗在段内滑动 vs 逐帧重开），必须严格复刻才能定案。
 *
 * 只读产品文件。 */
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败: " + a.slice(0, 30));
  return SRC.slice(i, j);
}
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");

const FPS = 60;
const WINDOW_SECS = 3.5;   // signalWindow(key, 3.5)  ← 生产真值
const TAIL_SECS = 0.35;

function makeCounter(win, minGap) {
  const env = `
    ${clampSrc}
    ${meanSrc}
    ${detrendSrc}
    ${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = WINSTUB;
      let reps = 0, lastAt = -1, armed = false;
      // 逐帧滑窗：与生产 detectReps 一致（每帧取最近 3.5s 重算）
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t;
        const from = now - ${WINDOW_SECS};
        const raw = [];
        for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        const start = Math.max(0, d.length - tailN);
        for (let i = start; i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) {
            if (lastAt < 0 || now - lastAt >= ${minGap}) { reps += 1; lastAt = now; }
            armed = false;
          }
        }
      }
      return reps;
    };`.replace("WINSTUB", String(win));
  return new Function(env)();
}

function sineSeries(freq, secs, amp) {
  const out = [];
  for (let i = 0; i < Math.round(secs * FPS); i++) {
    out.push({ t: i / FPS, v: amp * Math.sin(2 * Math.PI * freq * (i / FPS)) });
  }
  return out;
}

const SECS = 20;
console.log("=== 忠实逐帧滑窗复刻（win=30 帧=跳绳档, minGap=0.3）===");
console.log("物理Hz  周期s  win/周期   minGap0.3   minGap=0   比值  ");
const c1 = makeCounter(30, 0.3), c2 = makeCounter(30, 0);
for (const f of [0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.875, 0.9, 1.0, 1.2, 1.5, 1.667, 2.0, 2.5, 3.0]) {
  const s = sineSeries(f, SECS, 0.1);
  const r1 = c1(s, FPS), r2 = c2(s, FPS), exp = f * SECS;
  console.log(`${f.toFixed(3).padStart(6)} ${(1/f).toFixed(3).padStart(6)} ${(0.5/(1/f)).toFixed(3).padStart(8)}   ${String(r1).padStart(8)} ${String(r2).padStart(9)}  ${(r1/exp).toFixed(2)}${r1/exp>1.6?" ★2×":""}`);
}

console.log("\n=== 各动作真实 win（用生产公式）下的 2× 扫描 ===");
const ACT = [
  ["跳绳", 60, 120, 0.3], ["开合跳", 40, 90, 0.45], ["半蹲热身", 15, 40, 0.9],
  ["徒手深蹲", 15, 45, 0.9], ["波比跳", 12, 35, 1.4], ["提踵", 20, 55, 0.7],
];
console.log("动作      win帧  物理Hz区间扫描（比值）");
for (const [name, lo, hi, gap] of ACT) {
  const win = Math.max(3, Math.min(90, Math.round(FPS * 60 / Math.max(15, hi))));
  const c = makeCounter(win, gap);
  const parts = [];
  for (const f of [0.5, 0.7, 0.9, 1.2, 1.5, 2.0]) {
    const r = c(sineSeries(f, SECS, 0.1), FPS), exp = f * SECS;
    parts.push(`${f}:${(r/exp).toFixed(2)}`);
  }
  console.log(`${name.padEnd(8)} ${String(win).padStart(5)}  ${parts.join("  ")}`);
}
