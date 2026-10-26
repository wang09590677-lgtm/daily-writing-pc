/* 独立复核两件事（lead 自查，不复用队友脚本）：
 * 1) 真实跳绳视频的**真值周期数**到底是多少？用 4 种互相独立的方法交叉：
 *    a. 过均值上升沿（我上轮用的，可能被噪声抬高）
 *    b. 平滑后过均值上升沿
 *    c. 自相关主周期
 *    d. 谱峰主频 × 时长
 * 2) 队友的 "F 修法"（每帧只处理新样本）是否真能消掉 2×。
 * 只读产品文件 + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");

const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const ACT = {
  jumpRope: { cn: "跳绳", sig: "height", win: 30, gap: 0.3 },
  jumpingJacks: { cn: "开合跳", sig: "width", win: 40, gap: 0.45 },
  squat: { cn: "徒手深蹲", sig: "height", win: 80, gap: 0.9 },
  burpee: { cn: "波比跳", sig: "height", win: 90, gap: 1.4 },
};
function rawSignal(name) {
  const cfg = ACT[name]; const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const pts = f.filter(p => p && p.length > 2 && p[2] > 0.5);
    if (pts.length < 3) { out.push(NaN); continue; }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    out.push(cfg.sig === "width" ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys));
  }
  return out;
}
function smoothArr(a, k) { const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function crossUp(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; let c = 0; for (let i = 1; i < a.length; i++) if (a[i - 1] <= m && a[i] > m) c++; return c; }
function autocorrPeriod(a) {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const x = a.map(v => v - m);
  const n = x.length, maxLag = Math.floor(n / 2.5);
  let best = 1, bestV = -Infinity;
  for (let lag = 4; lag < maxLag; lag++) {
    let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    s /= (n - lag);
    if (s > bestV) { bestV = s; best = lag; }
  }
  return best;
}
function fftMain(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n);
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  // 迭代 FFT
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
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
  return best * fps / n;   // Hz
}

console.log("=== 1) 真实跳绳/各动作的【真值周期数】四种方法交叉（24fps）===");
console.log("动作        帧数 时长s | 过均值沿 | 平滑后沿 | 自相关周期 →周期数 | 谱峰Hz →周期数");
for (const name of Object.keys(ACT)) {
  const v = rawSignal(name);
  const a = v.filter(Number.isFinite);
  const secs = v.length / 24;
  const c1 = crossUp(a);
  const c2 = crossUp(smoothArr(a, 5));
  const lag = autocorrPeriod(a);
  const c3 = secs / (lag / 24);
  const f = fftMain(a, 24);
  const c4 = f * secs;
  console.log(`${ACT[name].cn.padEnd(9)} ${String(v.length).padStart(4)} ${secs.toFixed(2).padStart(5)} | ${String(c1).padStart(8)} | ${String(c2).padStart(8)} | ${String(lag).padStart(4)}帧 → ${c3.toFixed(1).padStart(5)} | ${f.toFixed(2)}Hz → ${c4.toFixed(1).padStart(5)}`);
}

/* ==== 2) F 修法验证 ==== */
const ENG_FPS = 60, WIN_SECS = 3.5, TAIL_SECS = 0.35;
// mode="prod" 复刻现状（每帧重扫尾部）；mode="F" 每帧只处理新样本
function counter(win, gap, mode) {
  const env = `${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${gap}, MODE = "${mode}";
      let reps = 0, lastAt = -1, armed = false, seen = 0;
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) { continue; }
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        let start;
        if (MODE === "prod") start = Math.max(0, d.length - tailN);
        else { start = Math.max(0, d.length - 1); }   // F: 只处理最新 1 个样本
        for (let i = start; i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) {
            if (lastAt < 0 || now - lastAt >= gapN) { reps += 1; lastAt = now; }
            armed = false;
          }
        }
      }
      return reps;
    };`;
  return new Function(env)();
}
const sineSeries = (f, secs) => { const a = []; for (let i = 0; i < secs * ENG_FPS; i++) a.push({ t: i / ENG_FPS, v: 0.1 * Math.sin(2 * Math.PI * f * i / ENG_FPS) }); return a; };
function to60(v, scale) { const o = []; const step = 1 / ENG_FPS, T = (v.length / 24) * scale; for (let t = 0; t < T; t += step) o.push({ t, v: v[Math.min(v.length - 1, Math.floor((t / scale) * 24))] }); return o; }

console.log("\n=== 2a) 纯正弦：现状 vs F（win=30/minGap=0.3 跳绳档）===");
console.log("Hz    期望  现状(prod)  比值     F  比值");
for (const f of [0.9, 1.0, 1.2, 1.5, 1.667, 2.0]) {
  const s = sineSeries(f, 20);
  const rp = counter(30, 0.3, "prod")(s, ENG_FPS);
  const rf = counter(30, 0.3, "F")(s, ENG_FPS);
  const e = f * 20;
  console.log(`${f.toFixed(3).padStart(5)} ${String(e.toFixed(0)).padStart(5)} ${String(rp).padStart(9)} ${(rp/e).toFixed(2).padStart(6)}${rp/e>1.5?"★":""} ${String(rf).padStart(6)} ${(rf/e).toFixed(2)}`);
}

console.log("\n=== 2b) 真实关键点：现状 vs F（原始拍速）===");
console.log("动作        真值周期(自相关)  现状reps  比值    F reps  比值");
for (const name of Object.keys(ACT)) {
  const v = rawSignal(name), a = v.filter(Number.isFinite);
  const secs = v.length / 24, lag = autocorrPeriod(a), cTrue = secs / (lag / 24);
  const rp = counter(ACT[name].win, ACT[name].gap, "prod")(to60(v, 1), ENG_FPS);
  const rf = counter(ACT[name].win, ACT[name].gap, "F")(to60(v, 1), ENG_FPS);
  console.log(`${ACT[name].cn.padEnd(9)} ${cTrue.toFixed(1).padStart(11)} ${String(rp).padStart(10)} ${(rp/cTrue).toFixed(2).padStart(6)} ${String(rf).padStart(8)} ${(rf/cTrue).toFixed(2)}`);
}
