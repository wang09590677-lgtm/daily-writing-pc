/* 根因诊断：合成跳绳（height 信号，纯 1.5Hz 正弦）在姿态链路里为什么 ~2×(60/30)。
 *
 * 做法：
 *   1) 跑真实引擎，记录引擎每一帧的 live.height（引擎真正看到的原始信号）。
 *   2) 把 motion-engine.js 的 detrend()/smooth()/迟滞过零**逐字复刻**在本脚本里，
 *      在记录到的同一串信号上重算，数出过零次数。
 *   3) 若复刻出的过零数 ≈ 周期数（30），说明 2× 不是算法本身，而是引擎管线里
 *      别的东西（如 signalWindow 的取样/时间戳）；若复刻也给出 60，
 *      则是 detrend/迟滞组合在"周期接近窗口"时的固有行为。
 */
"use strict";
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;
globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fc(w, h) { return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
  const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
  for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return { data: d };
} }) }; }
globalThis.window = {}; globalThis.document = { createElement: () => fc(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; } catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* ---- 从 motion-engine.js 逐字复刻 ---- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }
function detrend(raw, win) { const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length; let gvar = 0;
  for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; } return out; }
function mean(a) { if (!a.length) return 0; let s = 0; for (const x of a) s += x; return s / a.length; }

/* ---- 合成 1.5Hz 跳绳 height 信号（引擎逐帧会看到的原始值） ---- */
function makeBodyY(bh, fy, c) {
  const Y = y => fy - (fy - y) * (1 - c);
  const ht = Y(fy - bh), hr = .055 * bh;
  const sy = Y(ht + .20 * bh), hy = Y(ht + .52 * bh), ky = Y(ht + .75 * bh), ay = Y(fy);
  const so = .085 * bh, ho = .045 * bh;
  const lm = new Array(33); for (let i = 0; i < 33; i++) lm[i] = { x: .5, y: .5, visibility: .95 };
  lm[0] = { x: .5, y: ht + hr, visibility: .95 }; lm[7] = { x: .5 - .028, y: ht + hr, visibility: .95 }; lm[8] = { x: .5 + .028, y: ht + hr, visibility: .95 };
  lm[11] = { x: .5 - so, y: sy, visibility: .95 }; lm[12] = { x: .5 + so, y: sy, visibility: .95 };
  lm[13] = { x: .5 - so, y: sy + .18 * bh, visibility: .95 }; lm[14] = { x: .5 + so, y: sy + .18 * bh, visibility: .95 };
  lm[15] = { x: .5 - so, y: sy + .36 * bh, visibility: .95 }; lm[16] = { x: .5 + so, y: sy + .36 * bh, visibility: .95 };
  lm[23] = { x: .5 - ho, y: hy, visibility: .95 }; lm[24] = { x: .5 + ho, y: hy, visibility: .95 };
  lm[25] = { x: .5 - ho, y: ky, visibility: .95 }; lm[26] = { x: .5 + ho, y: ky, visibility: .95 };
  lm[27] = { x: .5 - ho, y: ay, visibility: .95 }; lm[28] = { x: .5 + ho, y: ay, visibility: .95 };
  return lm.map(p => ({ x: p.x, y: p.y, visibility: .95 }));
}
const BH = .65, FY = .88, F = 1.0, FREQ = 1.5, ENG = 60, SRC = 24, RATIO = ENG / SRC;
const PROFILE = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 };

function run(fps) {
  const ratio = fps / SRC;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(PROFILE);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  eng.preview(); let prev = -1;
  const seen = []; // 引擎每帧 live.height
  const total = fps + Math.round(20 * fps);
  for (let i = 0; i < total; i++) {
    if (i === fps) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prev) { prev = slot; const t = slot / SRC; const p = .5 - .5 * Math.cos(2 * Math.PI * FREQ * t); pv.pushLandmarks(makeBodyY(BH, FY, F * .09 * p)); }
    globalThis.__clock = (i + 1) * (1000 / fps);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= fps) seen.push(eng.getState().live.height);
  }
  eng.stop();
  return { reps: eng.getState().reps, seen };
}

const r = run(ENG);
/* 引擎的窗口参数（fps=60，band=[60,120]） */
const fps = 60;
const win = clamp(Math.round(fps * 60 / Math.max(15, 120)), 3, Math.round(fps * 1.5));
const smoothK = Math.max(1, Math.round(fps * .06));
const wf = Math.round(3.5 * fps);
console.log(`引擎 reps = ${r.reps}   （物理周期数 = 1.5Hz × 20s = 30）\n`);
console.log(`窗口参数：detrend win=${win}  smoothK=${smoothK}  3.5s窗=${wf} 帧\n`);

/* 逐帧复刻 detectReps 的前半段（只用 height 一个信号） */
let armed = false, lastAt = -1, calcReps = 0;
const gate = 0.05 * 0.5 * clamp(0.65 / 0.6, 1.0, 1.5);
const dAll = [];
for (let i = 0; i < r.seen.length; i++) {
  const t = (i + 1) / fps;
  const from = t - 3.5;
  const raw = [];
  for (let k = Math.max(0, Math.floor(from * fps)); k <= i; k++) raw.push(r.seen[k]);
  if (raw.length < 10) continue;
  const spread = Math.max(...raw) - Math.min(...raw);
  if (spread < gate) { armed = false; continue; }
  const d = smooth(detrend(raw, win), smoothK);
  const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
  const kk = clamp(rms * .85, .45, 2.2);
  const tail = Math.min(d.length, Math.max(2, Math.round(fps * .35)));
  for (let z = d.length - tail; z < d.length; z++) {
    const v = d[z];
    if (v < -kk) armed = true;
    else if (v > kk && armed) { if (lastAt < 0 || t - lastAt >= .3) { calcReps++; lastAt = t; } armed = false; }
  }
  dAll.push({ t, rms, kk, spread });
}
console.log(`复刻 detrend+迟滞过零：calcReps = ${calcReps}`);
console.log(`（若 calcReps ≈ 60 而非 30，说明 2× 来自 detrend+迟滞在"周期≈窗口"下的固有行为，不是管线）\n`);

/* 直接看原始信号本身有几个周期 */
const s = r.seen;
let mn = Infinity, mx = -Infinity; for (const v of s) { if (v < mn) mn = v; if (v > mx) mx = v; }
const m = mean(s);
let up = 0, below = false;
for (const v of s) { if (v < m) below = true; else if (v > m && below) { up++; below = false; } }
console.log(`引擎看到的 live.height：范围 [${mn.toFixed(4)}, ${mx.toFixed(4)}] 均值 ${m.toFixed(4)}`);
console.log(`以均值为阈值的上升沿次数 = ${up}  （≈物理周期数）`);
console.log(`detrend 的 win=${win} 帧 = ${(win / fps).toFixed(3)}s；信号周期 ${(1 / FREQ).toFixed(3)}s`);
console.log(`→ win(${(win / fps).toFixed(3)}s) 与周期(${(1 / FREQ).toFixed(3)}s) 的比值 = ${((win / fps) / (1 / FREQ)).toFixed(2)}`);

/* ---- 逐次计数事件的时间点：看是不是"每 1/minGap 就计一次" ---- */
const events = [];
{
  let armed2 = false, lastAt2 = -1;
  for (let i = 0; i < r.seen.length; i++) {
    const t = (i + 1) / fps;
    const raw = [];
    for (let k = Math.max(0, Math.floor((t - 3.5) * fps)); k <= i; k++) raw.push(r.seen[k]);
    if (raw.length < 10) continue;
    const spread = Math.max(...raw) - Math.min(...raw);
    if (spread < gate) { armed2 = false; continue; }
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const kk = clamp(rms * .85, .45, 2.2);
    const tail = Math.min(d.length, Math.max(2, Math.round(fps * .35)));
    for (let z = d.length - tail; z < d.length; z++) {
      const v = d[z];
      if (v < -kk) armed2 = true;
      else if (v > kk && armed2) { if (lastAt2 < 0 || t - lastAt2 >= .3) { events.push({ t: +t.toFixed(3), rms: +rms.toFixed(3), k: +kk.toFixed(3) }); lastAt2 = t; } armed2 = false; }
    }
  }
}
console.log(`\n计数事件（复刻）共 ${events.length} 次，前 24 次：`);
console.log(events.slice(0, 24).map(e => `${e.t}(k=${e.k})`).join("  "));
const gaps = [];
for (let i = 1; i < events.length; i++) gaps.push(+(events[i].t - events[i - 1].t).toFixed(3));
console.log(`相邻间隔：min=${Math.min(...gaps)} 中位=${gaps.slice().sort((a, b) => a - b)[gaps.length >> 1]} max=${Math.max(...gaps)}`);
console.log(`物理周期 = ${(1 / FREQ).toFixed(3)}s；若中位间隔 ≈ ${((1 / FREQ) / 2).toFixed(3)}s，说明每半周期就计一次（2×）`);

/* ---- 直接把一段窗口的 detrended 波形画出来 ---- */
{
  const i = 400;
  const t = (i + 1) / fps;
  const raw = [];
  for (let k = Math.max(0, Math.floor((t - 3.5) * fps)); k <= i; k++) raw.push(r.seen[k]);
  const d = smooth(detrend(raw, win), smoothK);
  const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
  const kk = clamp(rms * .85, .45, 2.2);
  console.log(`\n窗口终点 i=${i}（t=${t.toFixed(2)}s）的 detrended 波形（每 3 帧抽 1，k=${kk.toFixed(3)}）：`);
  let line = "";
  for (let z = 0; z < d.length; z += 3) {
    const v = d[z];
    line += (v > kk ? "↑" : (v < -kk ? "↓" : (Math.abs(v) < .15 ? "·" : (v > 0 ? "+" : "-"))));
  }
  console.log("  " + line);
  console.log(`  ↑=${d.length} 帧里 >k 的抽样数；↓=<-k。若 ↑/↓ 成对出现多于 5 次，即为多计。`);
}

