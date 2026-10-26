/* _dbg-stretch-validate.js — 校验"时间伸缩"是否真的把频率搬到目标值 */
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
try { globalThis.navigator = { userAgent: "node" }; } catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine; const MP = PV.MP;
function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: .5, y: .5, visibility: .95 }; return a; }
function makeBody(opt) { const lm = blank(); const bodyH = opt.bodyH, feetY = opt.feetY, cx = .5, c = opt.compress || 0;
  const Y = y => feetY - (feetY - y) * (1 - c); const headTop = Y(feetY - bodyH), headR = .055 * bodyH, nose = { x: cx, y: headTop + headR };
  const shoulderY = Y(headTop + .20 * bodyH), hipY = Y(headTop + .52 * bodyH), kneeY = Y(headTop + .75 * bodyH), ankleY = Y(feetY);
  const shOff = .085 * bodyH, hipOff = .045 * bodyH; const shL = { x: cx - shOff, y: shoulderY }, shR = { x: cx + shOff, y: shoulderY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY }; const phi = opt.armPhi || 0, armL = .36 * bodyH * (1 - c * .5);
  const arm = (sh, side) => ({ e: { x: sh.x + side * armL * .5 * Math.sin(phi), y: sh.y + armL * .5 * Math.cos(phi) }, w: { x: sh.x + side * armL * Math.sin(phi), y: sh.y + armL * Math.cos(phi) } });
  const aL = arm(shL, -1), aR = arm(shR, 1); const spread = (opt.legSpread || 0) * bodyH;
  const leg = (hip, side) => ({ k: { x: hip.x + side * spread * .45, y: kneeY }, a: { x: hip.x + side * spread, y: ankleY } });
  const lL = leg(hipL, -1), lR = leg(hipR, 1);
  lm[MP.NOSE] = { ...nose, visibility: .95 }; lm[MP.L_EYE] = { x: cx - .012, y: nose.y - .006, visibility: .95 }; lm[MP.R_EYE] = { x: cx + .012, y: nose.y - .006, visibility: .95 };
  lm[MP.L_EAR] = { x: cx - .028, y: nose.y, visibility: .95 }; lm[MP.R_EAR] = { x: cx + .028, y: nose.y, visibility: .95 };
  lm[MP.L_SHOULDER] = { ...shL, visibility: .95 }; lm[MP.R_SHOULDER] = { ...shR, visibility: .95 }; lm[MP.L_ELBOW] = { ...aL.e, visibility: .95 }; lm[MP.R_ELBOW] = { ...aR.e, visibility: .95 };
  lm[MP.L_WRIST] = { ...aL.w, visibility: .95 }; lm[MP.R_WRIST] = { ...aR.w, visibility: .95 }; lm[MP.L_INDEX] = { x: aL.w.x, y: aL.w.y, visibility: .95 }; lm[MP.R_INDEX] = { x: aR.w.x, y: aR.w.y, visibility: .95 };
  lm[MP.L_HIP] = { ...hipL, visibility: .95 }; lm[MP.R_HIP] = { ...hipR, visibility: .95 }; lm[MP.L_KNEE] = { ...lL.k, visibility: .95 }; lm[MP.R_KNEE] = { ...lR.k, visibility: .95 };
  lm[MP.L_ANKLE] = { ...lL.a, visibility: .95 }; lm[MP.R_ANKLE] = { ...lR.a, visibility: .95 }; lm[MP.L_HEEL] = { x: lL.a.x, y: ankleY + .01, visibility: .95 }; lm[MP.R_HEEL] = { x: lR.a.x, y: ankleY + .01, visibility: .95 };
  lm[MP.L_FOOT] = { x: lL.a.x + .02, y: ankleY + .015, visibility: .95 }; lm[MP.R_FOOT] = { x: lR.a.x - .02, y: ankleY + .015, visibility: .95 }; return lm; }
const BODY_H = .65, FEET_Y = .88;
function makeRnd(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function jitterLM(lm, rnd, j) { return lm.map(p => ({ x: p.x + (rnd() - .5) * 2 * j, y: p.y + (rnd() - .5) * 2 * j, visibility: p.visibility })); }
function framesFromVals(vals, seed) { return vals.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * Math.max(0, Math.min(1, x)) }), makeRnd(seed || 999), .0025)); }
const ENG = 60, SRC = 24, RATIO = ENG / SRC;
function captureSignal(frames, profile, opt) { globalThis.__clock = 0; const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = opt.previewFrames || ENG, total = prev + Math.round(opt.countSecs * ENG); const sig = []; let prevSlot = -1, srcIdx = -1, lastLm = null; eng.preview();
  for (let i = 0; i < total; i++) { if (i === prev) eng.start(); const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) { prevSlot = slot; srcIdx++; const fi = opt.loop === false ? srcIdx : (srcIdx % frames.length); const f = frames[fi]; if (f) lastLm = f; if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG); if (globalThis.__rafCb) globalThis.__rafCb(); if (i >= prev) sig.push(eng.getState().live.height); }
  eng.stop(); return { reps: eng.getState().reps, sig }; }
function domPeriod(v, fps) { const fin = v.filter(Number.isFinite); if (fin.length < 20) return null; const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  let bl = 0, best = -Infinity; const maxLag = Math.min(Math.round(fps * 6), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.1); lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; s /= (x.length - lag); if (s > best) { best = s; bl = lag; } } return bl ? bl / fps : null; }
function timeStretch(src, p0, pT, targetLen) { const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) { const u = i * pT / p0; const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length, fr = u - Math.floor(u); out[i] = src[i0] * (1 - fr) + src[i1] * fr; }
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; } const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp); }

const baseOff = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };
const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const a = lm.acts["jumpRope"];
const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
const cap = captureSignal(frames, baseOff, { countSecs: frames.length / SRC, loop: false });
const src24 = []; for (let j = 0; j < Math.round(cap.sig.length / RATIO); j++) src24.push(cap.sig[Math.min(cap.sig.length - 1, Math.round(j * RATIO))]);
const p0 = domPeriod(src24, SRC);
console.log(`源(真跳绳 6s, 24fps) 自相关周期 p0=${p0.toFixed(4)}s → ${(1 / p0).toFixed(3)}Hz\n`);
console.log("目标Hz | 目标周期s | 伸缩后实测周期s | 实测Hz | 误差%");
console.log("-".repeat(60));
for (const f of [0.9, 1.2, 1.5, 1.71, 2.0, 2.5]) {
  const N = Math.round(30 * SRC);
  const vals = timeStretch(src24, p0, 1 / f, N);
  // 直接对 vals 本身做自相关（不经过引擎）——但 vals 是 24fps 的"压缩量"，对应 height 的线性函数
  const per = domPeriod(vals, SRC);
  console.log(String(f).padEnd(7) + (1 / f).toFixed(4).padEnd(11) + per.toFixed(4).padEnd(17) + (1 / per).toFixed(3).padEnd(8) + (((1 / per) - f) / f * 100).toFixed(1));
}
