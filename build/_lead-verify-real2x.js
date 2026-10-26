/* 决定性判定：把**真实 MediaPipe 关键点**（build/_tmp/_lm.json）按引擎真时序
 * （rAF 60fps 读、关键点 24Hz 更新 → 帧重复）喂进**严格复刻的 detectReps 计次器**，
 * 对比"物理周期数 vs 引擎计次"，在【原始拍速】与【放慢到真实儿童拍速】两种情况下。
 *
 * 目的：回答"真实孩子会不会被判 2×"。
 * 只读产品文件 + 只读 _lm.json。 */
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
if (!detrendSrc.includes("gstd") || !detrendSrc.includes("out[i] = (raw[i] - m) / gstd")) throw new Error("detrend 源码不符");

const ENG_FPS = 60, SRC_FPS = 24, WIN_SECS = 3.5, TAIL_SECS = 0.35;

function makeCounter(win, minGap) {
  const env = `
    ${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${minGap};
      let reps = 0, lastAt = -1, armed = false;
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = [];
        for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        for (let i = Math.max(0, d.length - tailN); i < d.length; i++) {
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

// 真实关键点 → 逐帧信号（按各动作真实计次信号）
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const ACT = {
  jumpRope: { cn: "跳绳", sig: "height", win: 30, gap: 0.3 },
  jumpingJacks: { cn: "开合跳", sig: "width", win: 40, gap: 0.45 },
  squat: { cn: "徒手深蹲", sig: "height", win: 80, gap: 0.9 },
  burpee: { cn: "波比跳", sig: "height", win: 90, gap: 1.4 },
  highKnees: { cn: "原地高抬腿", sig: "width", win: 40, gap: 0.45 },
};
function rawSignal(name) {
  const cfg = ACT[name];
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const pts = f.filter(p => p && p.length > 2 && p[2] > 0.5);
    if (pts.length < 3) { out.push(NaN); continue; }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    out.push(cfg.sig === "width" ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys));
  }
  return out;
}
// 物理周期数：对真实信号数"过均值上升沿"
function physCycles(v) {
  const a = v.filter(Number.isFinite);
  if (a.length < 10) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  let c = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] <= m && a[i] > m) c++;
  return c;
}
// 按引擎真时序构造 60fps 序列：关键点 24Hz 更新，帧间沿用上一帧（真实降级行为）
function to60(v, timeScale) {
  const out = [];
  const step = 1 / ENG_FPS;                 // 60fps 步进
  const totalT = (v.length / SRC_FPS) * timeScale;
  for (let t = 0; t < totalT; t += step) {
    const srcIdx = Math.min(v.length - 1, Math.floor((t / timeScale) * SRC_FPS));
    out.push({ t, v: v[srcIdx] });
  }
  return out;
}

console.log("=== 真实关键点 → 严格复刻计次器（含 60fps/24Hz 帧重复）===");
console.log("动作        物理周期  |  原始拍速 reps/比值  |  放慢到~70-110/min reps/比值");
for (const name of Object.keys(ACT)) {
  const v = rawSignal(name);
  const cyc = physCycles(v);
  const c = makeCounter(ACT[name].win, ACT[name].gap);
  const r1 = c(to60(v, 1.0), ENG_FPS);
  // 放慢：目标 1.2Hz(72/min) 左右。原始频率 ≈ cyc/(len/24)
  const f0 = cyc / (v.length / SRC_FPS);
  const scale = f0 > 0 ? f0 / 1.2 : 1;
  const r2 = c(to60(v, scale), ENG_FPS);
  console.log(`${ACT[name].cn.padEnd(10)} ${String(cyc).padStart(6)}    |  ${String(r1).padStart(4)} / ${(r1/cyc).toFixed(2)}${r1/cyc>1.6?" ★":""}          |  ${String(r2).padStart(4)} / ${(r2/cyc).toFixed(2)}${r2/cyc>1.6?" ★2×":""}  (原频${f0.toFixed(2)}Hz→1.2Hz, 放慢${scale.toFixed(2)}x)`);
}

// 自检：纯正弦在非 2× 区应给出 ~1.0，在 2× 区给 ~2.0
console.log("\n=== 自检（纯正弦，验证复刻器可信）===");
const cc = makeCounter(30, 0.3);
for (const f of [0.6, 1.2, 2.0]) {
  const s = []; for (let i = 0; i < 20 * ENG_FPS; i++) s.push({ t: i / ENG_FPS, v: 0.1 * Math.sin(2 * Math.PI * f * i / ENG_FPS) });
  const r = cc(s, ENG_FPS);
  console.log(`  ${f}Hz → ${r} 次（期望 ${(f*20).toFixed(0)}，比值 ${(r/(f*20)).toFixed(2)}）`);
}
