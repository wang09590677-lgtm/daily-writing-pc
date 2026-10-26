/* 决定性扫描：用**真实关键点**，把拍速从 60 扫到 160/分，
 * 对比 现状引擎 / F 修法 / 物理真值。回答"真实孩子慢跳会不会多计"。
 *
 * 物理真值口径（不依赖引擎信号）：
 *   · 跳绳/波比/深蹲 = 踝 y 的局部极小值个数（起跳最高点）
 *   · 开合跳 = 四肢张开量的局部极小值个数（四肢并拢）
 * 无 `scale` 参数直接放慢（零阶保持，模拟孩子跳得慢）。
 * 真值周期数与放慢倍率**无关**（周期个数不变）。
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

const ENG_FPS = 60, SRC_FPS = 24, WIN_SECS = 3.5, TAIL_SECS = 0.35;
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
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function minima(a, gapF, prom) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) if (a[i] <= a[i - 1] && a[i] < a[i + 1]) {
    if (idx.length && i - idx[idx.length - 1] < gapF) { if (a[i] < a[idx[idx.length - 1]]) idx[idx.length - 1] = i; }
    else idx.push(i);
  }
  return idx.filter(i => { const lo = Math.max(0, i - 15), hi = Math.min(a.length, i + 15); return Math.max(...a.slice(lo, hi)) - a[i] >= prom; });
}
function jointSig(name, idxs) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const ys = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][1] : NaN).filter(Number.isFinite);
    out.push(ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN);
  }
  return fill(out);
}
function widthSig(name) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const pts = f.filter(p => p && p.length > 2 && p[2] > 0.4);
    out.push(pts.length < 3 ? NaN : (Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))));
  }
  return fill(out);
}
const ACT = {
  jumpRope: { cn: "跳绳", win: 30, gap: 0.3, truth: () => jointSig("jumpRope", [27, 28]) },
  jumpingJacks: { cn: "开合跳", win: 40, gap: 0.45, truth: () => widthSig("jumpingJacks") },
  squat: { cn: "徒手深蹲", win: 80, gap: 0.9, truth: () => jointSig("squat", [27, 28]) },
  burpee: { cn: "波比跳", win: 90, gap: 1.4, truth: () => jointSig("burpee", [27, 28]) },
};
// 引擎看到的信号
function engSig(name) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const pts = f.filter(p => p && p.length > 2 && p[2] > 0.4);
    if (pts.length < 3) { out.push(NaN); continue; }
    const ys = pts.map(p => p[1]), xs = pts.map(p => p[0]);
    const h = Math.max(...ys) - Math.min(...ys), w = Math.max(...xs) - Math.min(...xs);
    out.push((name === "jumpingJacks") ? w : h);
  }
  return fill(out);
}
function to60(v, scale) { const o = []; const step = 1 / ENG_FPS, T = (v.length / SRC_FPS) * scale; for (let t = 0; t < T; t += step) o.push({ t, v: v[Math.min(v.length - 1, Math.floor((t / scale) * SRC_FPS))] }); return o; }

console.log("真值（物理周期数，与拍速无关）：");
for (const k of Object.keys(ACT)) {
  const t = ACT[k].truth();
  const m = minima(smoothArr(t, 3), 3, 0.01);
  console.log(`  ${ACT[k].cn.padEnd(9)} 周期数=${m.length}`);
}
console.log("\n=== 拍速扫描：现状 vs F（用真实关键点放慢/加快）===");
console.log("动作      原拍速  物理真值 | 目标/min | 现状reps(比值) | F reps(比值)");
for (const name of Object.keys(ACT)) {
  const t = ACT[name].truth();
  const cyc = minima(smoothArr(t, 3), 3, 0.01).length;
  const baseRate = cyc / (t.length / SRC_FPS) * 60;   // 原拍速 /分
  const sig = engSig(name);
  const cp = counter(ACT[name].win, ACT[name].gap, "prod");
  const cf = counter(ACT[name].win, ACT[name].gap, "F");
  for (const target of [60, 80, 100, 120, 140, 160]) {
    const scale = baseRate / target;
    const s60 = to60(sig, scale);
    const rp = cp(s60, ENG_FPS), rf = cf(s60, ENG_FPS);
    console.log(`${ACT[name].cn.padEnd(9)} ${baseRate.toFixed(0).padStart(5)}  ${String(cyc).padStart(6)}   | ${String(target).padStart(6)}   | ${String(rp).padStart(4)} (${(rp/cyc).toFixed(2)})${rp/cyc>1.5?"★":""}      | ${String(rf).padStart(4)} (${(rf/cyc).toFixed(2)})`);
  }
  console.log("");
}
