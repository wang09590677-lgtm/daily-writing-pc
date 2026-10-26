/* ==================================================================
 * _dbg-2x-mechanism.js — 2× 的机制探针（只读，纯 Node，不开浏览器）
 *
 * 目的：把「为什么是 2×」和「边界由谁决定」讲清楚，而不是只报比值。
 * 做法：
 *  1) 用真实引擎（门限关闭）跑纯正弦 height，逐帧录下 live.height（30s）。
 *  2) 离线**逐帧复刻** detectReps 的核心：signalWindow(3.5s)->detrend(win)->smooth->迟滞过零，
 *     验证复刻的 reps 与引擎真实 reps 一致（证明复刻等价）。
 *  3) 在复刻上做单参数扫描：
 *       · win 变化（12/20/30/45/60 帧）→ 看 2× 与 win/周期 的关系
 *       · minGap 变化（0 / 0.3 / 0.5）→ 看高频端抑制是不是 minGap 干的
 *       · 关掉 detrend（只减整段均值）→ 看 2× 是否消失（定位到 detrend）
 *       · 关掉 smooth → 看平滑有没有责任
 *  4) 打印 d 的 ASCII 波形（f=0.8 与 f=0.9 对比），肉眼确认"2×=每周期多一组过零"。
 *
 * 输出 build/_dbg-2x-mechanism.json + 控制台。
 * ================================================================== */
"use strict";
const fs = require("fs");
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
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;
const MP = PV.MP;

function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: .5, y: .5, visibility: .95 }; return a; }
function makeBody(opt) {
  const lm = blank();
  const bodyH = opt.bodyH, feetY = opt.feetY, cx = .5, c = opt.compress || 0;
  const Y = y => feetY - (feetY - y) * (1 - c);
  const headTop = Y(feetY - bodyH), headR = .055 * bodyH, nose = { x: cx, y: headTop + headR };
  const shoulderY = Y(headTop + .20 * bodyH), hipY = Y(headTop + .52 * bodyH), kneeY = Y(headTop + .75 * bodyH), ankleY = Y(feetY);
  const shOff = .085 * bodyH, hipOff = .045 * bodyH;
  const shL = { x: cx - shOff, y: shoulderY }, shR = { x: cx + shOff, y: shoulderY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY };
  const phi = opt.armPhi || 0, armL = .36 * bodyH * (1 - c * .5);
  const arm = (sh, side) => ({ e: { x: sh.x + side * armL * .5 * Math.sin(phi), y: sh.y + armL * .5 * Math.cos(phi) },
    w: { x: sh.x + side * armL * Math.sin(phi), y: sh.y + armL * Math.cos(phi) } });
  const aL = arm(shL, -1), aR = arm(shR, 1);
  const spread = (opt.legSpread || 0) * bodyH;
  const leg = (hip, side) => ({ k: { x: hip.x + side * spread * .45, y: kneeY }, a: { x: hip.x + side * spread, y: ankleY } });
  const lL = leg(hipL, -1), lR = leg(hipR, 1);
  lm[MP.NOSE] = { ...nose, visibility: .95 }; lm[MP.L_EYE] = { x: cx - .012, y: nose.y - .006, visibility: .95 }; lm[MP.R_EYE] = { x: cx + .012, y: nose.y - .006, visibility: .95 };
  lm[MP.L_EAR] = { x: cx - .028, y: nose.y, visibility: .95 }; lm[MP.R_EAR] = { x: cx + .028, y: nose.y, visibility: .95 };
  lm[MP.L_SHOULDER] = { ...shL, visibility: .95 }; lm[MP.R_SHOULDER] = { ...shR, visibility: .95 };
  lm[MP.L_ELBOW] = { ...aL.e, visibility: .95 }; lm[MP.R_ELBOW] = { ...aR.e, visibility: .95 };
  lm[MP.L_WRIST] = { ...aL.w, visibility: .95 }; lm[MP.R_WRIST] = { ...aR.w, visibility: .95 };
  lm[MP.L_INDEX] = { x: aL.w.x, y: aL.w.y, visibility: .95 }; lm[MP.R_INDEX] = { x: aR.w.x, y: aR.w.y, visibility: .95 };
  lm[MP.L_HIP] = { ...hipL, visibility: .95 }; lm[MP.R_HIP] = { ...hipR, visibility: .95 };
  lm[MP.L_KNEE] = { ...lL.k, visibility: .95 }; lm[MP.R_KNEE] = { ...lR.k, visibility: .95 };
  lm[MP.L_ANKLE] = { ...lL.a, visibility: .95 }; lm[MP.R_ANKLE] = { ...lR.a, visibility: .95 };
  lm[MP.L_HEEL] = { x: lL.a.x, y: ankleY + .01, visibility: .95 }; lm[MP.R_HEEL] = { x: lR.a.x, y: ankleY + .01, visibility: .95 };
  lm[MP.L_FOOT] = { x: lL.a.x + .02, y: ankleY + .015, visibility: .95 }; lm[MP.R_FOOT] = { x: lR.a.x - .02, y: ankleY + .015, visibility: .95 };
  return lm;
}
const BODY_H = .65, FEET_Y = .88;
function makeRnd(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function jitterLM(lm, rnd, j) { return lm.map(p => ({ x: p.x + (rnd() - .5) * 2 * j, y: p.y + (rnd() - .5) * 2 * j, visibility: p.visibility })); }
function framesFromVals(vals, seed) {
  return vals.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * Math.max(0, x) }), makeRnd(seed || 999), .0025));
}
function sineVals(freq, n, fps) { const a = []; for (let i = 0; i < n; i++) a.push((1 - Math.cos(2 * Math.PI * freq * (i / fps))) / 2); return a; }

const ENG = 60, SRC = 24, RATIO = ENG / SRC;
function captureH(frames, profile, opt) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = opt.previewFrames || ENG;
  const total = prev + Math.round(opt.countSecs * ENG);
  const hs = [];
  let prevSlot = -1, srcIdx = -1, lastLm = null;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prev) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) { prevSlot = slot; srcIdx++;
      const fi = opt.loop === false ? srcIdx : (srcIdx % frames.length);
      const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prev) hs.push(eng.getState().live.height);
  }
  eng.stop();
  return { reps: eng.getState().reps, hs };
}

const PROF_OFF = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };

/* ---------- 离线复刻（与 motion-engine.js 逐字对应） ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function signalWindow3_5(hs, fps, seconds) { const k = Math.round(seconds * fps); return hs.slice(Math.max(0, hs.length - k)); }
function detrend(raw, win) {
  const out = new Array(raw.length);
  const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length;
  let gvar = 0; for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j];
    m /= (b - a);
    out[i] = (raw[i] - m) / gstd;
  }
  return out;
}
function smooth(raw, k) {
  if (k <= 1) return raw.slice();
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; }
  return out;
}
function smoothMean(raw) { const m = raw.reduce((a, b) => a + b, 0) / raw.length; return raw.map(v => v - m); }

/* 逐帧复刻 detectReps 的过零/迟滞部分。
 * opts: {win, smoothK, minGap, useDetrend:true/false, useSmooth:true/false} */
function replica(hs, fps, opts) {
  const win = opts.win, smoothK = opts.smoothK, minGap = opts.minGap;
  let armed = false, lastAt = -1, reps = 0;
  const events = [];
  const tails = Math.max(2, Math.round(fps * 0.35));
  // 逐帧：第 t 帧用 hs[0..t] 作为已积累序列
  for (let t = 9; t < hs.length; t++) {
    const rawFull = hs.slice(0, t + 1);
    const raw = signalWindow3_5(rawFull, fps, 3.5);
    if (raw.length < 10) continue;
    let d;
    if (opts.useDetrend === false) d = smoothMean(raw);
    else d = detrend(raw, win);
    if (opts.useSmooth !== false) d = smooth(d, smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const now = (t + 1) / fps;
    const tail = Math.min(d.length, tails);
    for (let i = d.length - tail; i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) {
        if (lastAt < 0 || now - lastAt >= minGap) { reps += 1; events.push(+(now).toFixed(3)); lastAt = now; }
        armed = false;
      }
    }
  }
  return { reps, events };
}
function upCrossings(v) {
  const fin = v.filter(Number.isFinite);
  if (!fin.length) return 0;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  let n = 0, below = false;
  for (const x of fin) { if (x < m) below = true; else if (below) { n++; below = false; } }
  return n;
}
function plot(d, k, from, to) {
  const ch = " .:-=+*#%@";
  const seg = d.slice(from, to);
  const lo = Math.min(...seg, -k), hi = Math.max(...seg, k);
  const span = (hi - lo) || 1;
  let s = "";
  for (const v of seg) { const idx = Math.round((v - lo) / span * (ch.length - 1)); s += ch[Math.max(0, Math.min(ch.length - 1, idx))]; }
  return s;
}

const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC, winJRFrame: 30 }, validate: [], winSweep: [], minGapSweep: [], toggle: [], wave: [] };
const SECS = 30;

/* ============ 1) 验证复刻等价 + win 扫描 ============ */
console.log("=== 1) 复刻校验与 win 扫描（纯正弦 height，门限关闭，30s）===\n");
console.log("频率Hz | 周期数 | 引擎reps | 复刻reps | win帧 | win/周期 | 复刻事件数");
console.log("-".repeat(84));
const FREQS = [0.75, 0.875, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0];
const caps = {};
for (const f of FREQS) {
  const n = Math.round(SECS * SRC);
  const cap = captureH(framesFromVals(sineVals(f, n, SRC), 111), PROF_OFF, { countSecs: SECS });
  const cyc = upCrossings(cap.hs);
  const rep30 = replica(cap.hs, ENG, { win: 30, smoothK: 4, minGap: .3 });
  caps[f] = cap;
  out.validate.push({ freq: f, cycles: cyc, engineReps: cap.reps, replicaReps: rep30.reps, winOverPeriod: +(0.5 * f).toFixed(3) });
  console.log(String(f).padEnd(7) + String(cyc).padEnd(8) + String(cap.reps).padEnd(9) + String(rep30.reps).padEnd(9) + String(30).padEnd(7) + (0.5 * f).toFixed(3).padEnd(10) + rep30.events.length);
}

/* win 扫描（在 1.2Hz 触发频点上） */
console.log("\n=== 2) win 扫描（f=1.2Hz，其余不变）===\n");
console.log("win帧 | win秒 | win/周期 | 复刻reps | 判定");
console.log("-".repeat(56));
const cap12 = caps[1.2];
for (const win of [12, 18, 24, 30, 36, 45, 60, 90]) {
  const r = replica(cap12.hs, ENG, { win, smoothK: 4, minGap: .3 });
  const wp = (win / ENG) * 1.2;
  const tag = r.reps / 36 >= 1.6 ? "2×" : (r.reps / 36 >= 1.25 ? "过渡" : "1×");
  out.winSweep.push({ win, winSec: +(win / ENG).toFixed(3), winOverPeriod: +wp.toFixed(3), reps: r.reps, tag });
  console.log(String(win).padEnd(7) + (win / ENG).toFixed(3).padEnd(7) + wp.toFixed(3).padEnd(10) + String(r.reps).padEnd(9) + tag);
}

/* ============ 3) minGap 扫描（高频端抑制是谁干的） ============ */
console.log("\n=== 3) minGap 扫描（看高频端比值回落是不是 minGap 抑制）===\n");
console.log("频率Hz | minGap=0 | minGap=0.3 | minGap=0.5 | 物理周期数");
console.log("-".repeat(62));
for (const f of [1.5, 1.8, 2.0, 2.5, 3.0]) {
  const cap = caps[f];
  const rows = [0, 0.3, 0.5].map(mg => replica(cap.hs, ENG, { win: 30, smoothK: 4, minGap: mg }).reps);
  const cyc = upCrossings(cap.hs);
  out.minGapSweep.push({ freq: f, minGap0: rows[0], minGap03: rows[1], minGap05: rows[2], cycles: cyc });
  console.log(String(f).padEnd(7) + String(rows[0]).padEnd(10) + String(rows[1]).padEnd(12) + String(rows[2]).padEnd(12) + cyc);
}

/* ============ 4) 开关 detrend / smooth（定位到哪一步） ============ */
console.log("\n=== 4) 关掉 detrend / smooth（f=1.2Hz，win=30）===\n");
const TOGGLES = [
  { label: "完整(基线)", o: { win: 30, smoothK: 4, minGap: .3 } },
  { label: "关 detrend(仅减整段均值)", o: { useDetrend: false, smoothK: 4, minGap: .3 } },
  { label: "关 smooth", o: { win: 30, smoothK: 1, minGap: .3 } },
  { label: "关 detrend + 关 smooth", o: { useDetrend: false, smoothK: 1, minGap: .3 } },
];
console.log("配置                          | 复刻reps | 比值(36周期)");
console.log("-".repeat(58));
for (const t of TOGGLES) {
  const r = replica(cap12.hs, ENG, t.o);
  out.toggle.push({ label: t.label, reps: r.reps, ratio: +(r.reps / 36).toFixed(2) });
  console.log(t.label.padEnd(32) + String(r.reps).padEnd(9) + (r.reps / 36).toFixed(2));
}

/* ============ 5) ASCII 波形：f=0.8（1×）vs f=0.9（2×） ============ */
console.log("\n=== 5) d 波形对比（同一段 2.5s，k 位置为阈）===\n");
for (const f of [0.8, 0.9]) {
  const cap = caps[f] || captureH(framesFromVals(sineVals(f, Math.round(SECS * SRC), SRC), 111), PROF_OFF, { countSecs: SECS });
  const raw = signalWindow3_5(cap.hs, ENG, 3.5);
  const d = smooth(detrend(raw, 30), 4);
  const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
  const k = clamp(rms * 0.85, 0.45, 2.2);
  const from = Math.round(raw.length * 0.5), to = from + Math.round(ENG * 2.5);
  out.wave.push({ freq: f, k: +k.toFixed(3), cyclesInWindow: upCrossings(cap.hs), reps: cap.reps });
  console.log(`f=${f}Hz  k=${k.toFixed(3)}  引擎reps=${cap.reps}  周期数=${upCrossings(cap.hs)}`);
  console.log("  d(t): " + plot(d, k, Math.max(0, from), Math.min(d.length, to)));
}

fs.writeFileSync(path.join(__dirname, "_dbg-2x-mechanism.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_dbg-2x-mechanism.json");
