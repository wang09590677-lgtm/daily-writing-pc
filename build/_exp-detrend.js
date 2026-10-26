// 实验：把 motion-engine.js 里的 detrend / smooth / detectReps 纯逻辑抠出来，
// 用数值实验验证「幅度信息是否被归一化抹掉 → 静止噪声也计数」。
// 只读引擎源码，不改任何生产文件。
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "motion-engine.js");
const src = fs.readFileSync(SRC, "utf8");

/* ---- 从源码里原样截取纯函数，保证与生产代码逐字一致 ---- */
function grab(startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error("截取失败: " + label);
  return src.slice(a, b);
}
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)", "clamp");
const meanSrc = grab("function mean(arr)", "function std(arr)", "mean");
const stdSrc = grab("function std(arr)", "// 动作参数默认值", "std");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)", "detrend");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次", "smooth");

const fns = new Function(`
  ${clampSrc}
  ${meanSrc}
  ${stdSrc}
  ${detrendSrc}
  ${smoothSrc}
  return { clamp, mean, std, detrend, smooth };
`)();
const { clamp, mean, std, detrend, smooth } = fns;

/* ---- 逐字复刻 detectReps 的判定核心（不含 signalList/repCounters 外壳）---- */
function makeDetector(fps, band, minGap) {
  const win = clamp(Math.round((fps * 60) / Math.max(15, band[1])), 3, Math.round(fps * 1.5));
  const smoothK = Math.max(1, Math.round(fps * 0.06));
  let armed = false, lastAt = -1, reps = 0;
  const repTimes = [];
  function step(raw, now) {
    if (raw.length < 10) return;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const tail = Math.min(d.length, Math.max(2, Math.round(fps * 0.35)));
    for (let i = d.length - tail; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) {
        if (lastAt < 0 || now - lastAt >= minGap) {
          reps += 1;
          repTimes.push(now);
          if (repTimes.length > 40) repTimes.shift();
          lastAt = now;
        }
        armed = false;
      }
    }
    return { reps, k, rms };
  }
  return { step, win, smoothK, get reps() { return reps; }, repTimes };
}

/* ---- 场景模拟 ----
 * 引擎里 fps 实测被夹在 [5,60]，series 每帧 push 一条，signalWindow 取最近 3.5 秒。
 * 这里完全按帧驱动：每帧把当前信号值推进 3.5s 滑动窗，再跑一次 detectReps。
 */
function simulate(name, opts) {
  const { fps, seconds, gen, band, minGap } = opts;
  const dt = 1 / fps;
  const det = makeDetector(fps, band, minGap);
  const buf = [];
  const winSec = 3.5;
  let lastK = 0, lastRms = 0;
  for (let f = 0; f < Math.round(fps * seconds); f++) {
    const t = f * dt;
    buf.push(gen(t));
    while (buf.length && buf[0] !== undefined && buf.length > Math.round(fps * winSec)) buf.shift();
    const r = det.step(buf.slice(), t);
    if (r) { lastK = r.k; lastRms = r.rms; }
  }
  return { name, fps, seconds, reps: det.reps, win: det.win, smoothK: det.smoothK, k: lastK, rms: lastRms, tail: Math.round(fps * 0.35) };
}

/* ---- 确定性伪随机（可复现）---- */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

const results = [];
const rows = [];

function push(label, r) {
  results.push(r);
  rows.push(`${pad(label, 34)} | fps=${pad2(r.fps)} | 计次 ${pad2(r.reps)} | ${r.seconds}s → ${(r.reps / r.seconds).toFixed(2)} 次/秒 | k=${r.k.toFixed(3)} rms=${r.rms.toFixed(3)}`);
}

function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }
function pad2(v) { return String(v).padStart(3, " "); }

/* ===== 场景 1：站住不动（只有摄像头/掩码抖动噪声）=====
 * width = 人形包围盒宽度（0..1，按画面宽度归一）。静止在 2~3m 处约 0.3。
 * 噪声取几档：0.004（很低）/ 0.01（典型）/ 0.02（抖动大）*/
const BAND_JJ = [40, 90];   // 开合跳 tempoBand
const GAP_JJ = 0.45;        // 开合跳 minRepGap

for (const sigma of [0.004, 0.01, 0.02, 0.04]) {
  for (const fps of [25, 60]) {
    const r = rng(12345);
    push(`静止 width σ=${sigma}`, simulate(`静止 σ=${sigma}`, {
      fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
      gen: () => 0.30 + gauss(r) * sigma
    }));
  }
}

/* ===== 场景 2：完全恒定（零噪声）——验证"理论上不该计数"的基线 ===== */
for (const fps of [25, 60]) {
  push(`恒定 width（零噪声）`, simulate("恒定", {
    fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
    gen: () => 0.30
  }));
}

/* ===== 场景 3：真实开合跳 —— 0.4 / 0.8 / 1.2 Hz，幅值 ±0.16 ===== */
for (const hz of [0.4, 0.8, 1.2]) {
  for (const fps of [25, 60]) {
    push(`真实开合跳 ${hz}Hz 幅±0.16`, simulate("真实", {
      fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
      gen: t => 0.38 + 0.16 * Math.sin(2 * Math.PI * hz * t)
    }));
  }
}

/* ===== 场景 4：真实开合跳 + 静止级噪声（真实世界必有） ===== */
{
  const r = rng(777);
  for (const fps of [25, 60]) {
    push(`真实 1.2Hz + σ0.01 噪声`, simulate("真实+噪声", {
      fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
      gen: t => 0.38 + 0.16 * Math.sin(2 * Math.PI * 1.2 * t) + gauss(r) * 0.01
    }));
  }
}

/* ===== 场景 5：极小幅度"假动作"——胳膊只抖 0.01（远低于 expectedAmplitude 0.18）=====
 * 期望：修复后应数 0 次；修复前大概率照数不误。 */
for (const fps of [25, 60]) {
  push(`微动 1.0Hz 幅±0.01（门限应挡住）`, simulate("微动", {
    fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
    gen: t => 0.30 + 0.01 * Math.sin(2 * Math.PI * 1.0 * t)
  }));
}

/* ===== 场景 6：缓慢漂移（人左右挪一步）——期望不该被当成一次动作 ===== */
{
  const r = rng(999);
  for (const fps of [25, 60]) {
    push(`缓慢漂移 0→0.1 / 8s + σ0.01`, simulate("漂移", {
      fps, seconds: 10, band: BAND_JJ, minGap: GAP_JJ,
      gen: t => 0.30 + 0.10 * (t / 8) + gauss(r) * 0.01
    }));
  }
}

/* ===== 场景 7：半蹲热身（真实回归测试用的动作）centroidY 0.6Hz 幅 0.09 =====
 * 回归测试 __motion-browser-test.y4m：人形上下往复 12px / 画面高 96 → 0.125，
 * 但质心只动一部分；实测回归计数 8~10 次 / 15s。这里模拟 0.6Hz 幅 0.08。 */
const BAND_SQ = [15, 40];
const GAP_SQ = 0.9;
for (const fps of [25, 60]) {
  push(`回归：半蹲 0.6Hz 幅±0.08`, simulate("回归", {
    fps, seconds: 15, band: BAND_SQ, minGap: GAP_SQ,
    gen: t => 0.5 + 0.08 * Math.sin(2 * Math.PI * 0.6 * t)
  }));
}

/* ===== 场景 8：minRepGap 上限验证——纯白噪声能顶到多快 ===== */
for (const gap of [0.45, 0.9, 1.4]) {
  const r = rng(4242);
  push(`白噪声上限 gap=${gap}`, simulate("白噪声", {
    fps: 60, seconds: 10, band: BAND_JJ, minGap: gap,
    gen: () => 0.30 + gauss(r) * 0.01
  }));
}

console.log("=== detectReps 数值实验（复刻 motion-engine.js:2504-2570 纯逻辑）===");
console.log("像素坐标系：width 已按画面宽度归一（0..1）；fps 取引擎实测档位 25 / 60\n");
console.log(rows.join("\n"));

console.log("\n=== 关键对比 ===");
const get = n => results.find(r => r.name === n);
const c1 = results.filter(r => /静止 width σ=0.01$/.test(r.name));
const c3 = results.filter(r => /真实开合跳 0.8Hz/.test(r.name));
console.log("静止噪声(σ=0.01) 10 秒计数：", c1.map(r => `fps${r.fps}→${r.reps}次`).join("  "));
console.log("真实 0.8Hz 10 秒计数：   ", c3.map(r => `fps${r.fps}→${r.reps}次`).join("  "));

/* ===== 直接验证「归一化抹掉幅度」这个论断本身 ===== */
console.log("\n=== 归一化前后标准差对比（证明幅度信息被抹掉）===");
function ampProbe(label, gen, n, fps) {
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(gen(i / fps));
  const d = detrend(raw, Math.round(fps * 60 / 90));
  const rangeRaw = Math.max(...raw) - Math.min(...raw);
  const rangeD = Math.max(...d) - Math.min(...d);
  console.log(`${pad(label, 30)} raw 峰峰值=${rangeRaw.toFixed(4)}  →  detrend 后峰峰值=${rangeD.toFixed(4)}  (std=${std(d).toFixed(4)})`);
}
{
  const r1 = rng(1);
  ampProbe("静止噪声 σ=0.004", () => 0.30 + gauss(r1) * 0.004, 600, 60);
  const r2 = rng(2);
  ampProbe("静止噪声 σ=0.04 (10倍)", () => 0.30 + gauss(r2) * 0.04, 600, 60);
  ampProbe("真实开合跳 幅±0.16", t => 0.38 + 0.16 * Math.sin(2 * Math.PI * 1.2 * t), 600, 60);
}
