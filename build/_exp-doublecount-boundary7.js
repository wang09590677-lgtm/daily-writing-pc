/* ==================================================================
 * _exp-doublecount-boundary7.js — 逐动作：真实波形扫频 vs 各自 tempoBand
 *
 * 结论要靠这张表：对 5 个动作各自的**真实计次信号**做时间伸缩扫频，
 * 每个频点跑门限关闭的引擎，得到"该拍速下是否 2×"。
 * 再把该动作 tempoBand 换算成 BPM 区间，标出与 2× 区间的重叠。
 *
 * 2× 区间（经验）：
 *   下界：win/周期 ≥ 0.44  →  f ≥ 0.44 / win_sec
 *   上界：半周期 < minRepGap 时伪峰被按掉 → f > 1/(2*minRepGap)
 * 本脚本用真实波形实测验证该区间。
 *
 * 纯 Node，只读产品文件。输出 build/_exp-doublecount-boundary7.json
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
  return vals.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * Math.max(0, Math.min(1, x)) }), makeRnd(seed || 999), .0025));
}
const ENG = 60, SRC = 24, RATIO = ENG / SRC;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function captureSignal(frames, profile, key, opt) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = opt.previewFrames || ENG, total = prev + Math.round(opt.countSecs * ENG);
  const sig = []; let prevSlot = -1, srcIdx = -1, lastLm = null; eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prev) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) { prevSlot = slot; srcIdx++;
      const fi = opt.loop === false ? srcIdx : (srcIdx % frames.length);
      const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prev) sig.push(eng.getState().live[key]);
  }
  eng.stop();
  return { reps: eng.getState().reps, sig };
}
function runFrames(frames, profile, opt) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = opt.previewFrames || ENG, total = prev + Math.round(opt.countSecs * ENG);
  const hs = []; let prevSlot = -1, srcIdx = -1, lastLm = null; eng.preview();
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
function domPeriod(v, fps) {
  const fin = v.filter(Number.isFinite); if (fin.length < 20) return null;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  let bl = 0, best = -Infinity; const maxLag = Math.min(Math.round(fps * 4), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.2); lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; s /= (x.length - lag); if (s > best) { best = s; bl = lag; } }
  return bl ? bl / fps : null;
}
function timeStretch(src, scale, targetLen) {  // scale = 源样本数/目标样本数 的倒数：目标更慢→scale>1
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const u = i * src.length / targetLen;
    const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u);
    out[i] = src[i0] * (1 - fr) + src[i1] * fr;
  }
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp);
}
/* 把真实波形整体平移到目标频率：目标周期 = 1/f，源周期 = 源时长/源周期数。
 * 做法：把源波形做比例缩放，使它的"源主导周期"变成 1/f。 */
function stretchToFreq(src, srcPeriodSec, f, srcFps, targetLen) {
  const targetPeriodSamples = (1 / f) * srcFps;
  const srcPeriodSamples = srcPeriodSec * srcFps;
  const k = targetPeriodSamples / srcPeriodSamples; // 目标每周期样本 / 源每周期样本
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const u = i / k;
    const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u);
    out[i] = src[i0] * (1 - fr) + src[i1] * fr;
  }
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp);
}

const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const ACTS = [
  { act: "jumpingJacks", cn: "开合跳", key: "width", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 } },
  { act: "squat", cn: "徒手深蹲", key: "height", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: .12 } },
  { act: "halfSquatWarm", cn: "半蹲热身", key: "centroidY", p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: .9, expectedAmplitude: .06 } },
  { act: "jumpRope", cn: "跳绳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 } },
  { act: "burpee", cn: "波比跳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: .16 } }
];
const DUR = 30, N = Math.round(DUR * SRC);
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, actions: [] };

for (const A of ACTS) {
  const a = lm.acts[A.act]; if (!a) continue;
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const cap = captureSignal(frames, { ...A.p, expectedAmplitude: 1e-6 }, A.key, { countSecs: frames.length / SRC, loop: false });
  // 下采样到 24fps
  const src24 = []; for (let j = 0; j < Math.round(cap.sig.length / RATIO); j++) src24.push(cap.sig[Math.min(cap.sig.length - 1, Math.round(j * RATIO))]);
  const p0 = domPeriod(src24, SRC) || (1 / ((A.p.tempoBand[0] + A.p.tempoBand[1]) / 2 / 60));
  const win = clamp(Math.round(ENG * 60 / Math.max(15, A.p.tempoBand[1])), 3, Math.round(ENG * 1.5));
  const fLo = 0.44 / (win / ENG), fHi = 1 / (2 * A.p.minRepGap);
  const bandLo = A.p.tempoBand[0] / 60, bandHi = A.p.tempoBand[1] / 60;
  console.log(`\n=== ${A.cn}（${A.key}，band ${A.p.tempoBand[0]}~${A.p.tempoBand[1]}BPM=${bandLo.toFixed(2)}~${bandHi.toFixed(2)}Hz，minGap=${A.p.minRepGap}s，win=${(win / ENG).toFixed(3)}s）===`);
  console.log(`  真实信源 p0=${p0.toFixed(3)}s (${(1 / p0).toFixed(2)}Hz)  理论2×区间=${fLo.toFixed(2)}~${fHi.toFixed(2)}Hz`);
  console.log("  频率Hz | 真值周期 | reps | 比值   | 判定");
  console.log("  " + "-".repeat(50));
  const rows = [];
  const grid = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0, 1.2, 1.5, 1.71, 2.0, 2.5, 3.0];
  for (const f of grid) {
    const vals = stretchToFreq(src24, p0, f, SRC, N);
    const r = runFrames(framesFromVals(vals, 707), { ...A.p, expectedAmplitude: 1e-6 }, { countSecs: DUR });
    const trueP = DUR * f, ratio = r.reps / trueP;
    const inBand = f >= bandLo && f <= bandHi;
    const tag = (ratio >= 1.6 ? "★ 2×" : (ratio >= 1.25 ? "偏高" : "1×")) + (inBand ? " (带内)" : "");
    rows.push({ f, truePeriods: +trueP.toFixed(1), reps: r.reps, ratio: +ratio.toFixed(2), inBand, tag });
    console.log("  " + pad(f.toFixed(2), 7) + pad(trueP.toFixed(1), 9) + pad(r.reps, 6) + pad(ratio.toFixed(2), 8) + tag);
  }
  out.actions.push({ cn: A.cn, key: A.key, band: A.p.tempoBand, minRepGap: A.p.minRepGap, winSec: +(win / ENG).toFixed(3), srcPeriod: +p0.toFixed(3), predicted2xLo: +fLo.toFixed(2), predicted2xHiI: +fHi.toFixed(2), rows });
}

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary7.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary7.json");
