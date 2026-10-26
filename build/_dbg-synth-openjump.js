/* 诊断：合成开合跳关键点 → 引擎 width 信号 / detrend / 过零 的逐帧实况。
 * 目的：查清"小幅度过计到 30、大幅度反而 0"是生成器问题还是引擎行为。 */
"use strict";
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;
globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fakeCanvas(w, h) { return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
  const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
  for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return { data: d };
} }) }; }
globalThis.window = {}; globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; } catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

// 复用 _exp-pose-synth-retake.js 的生成器：直接内联同样代码（保持一致性）
const MP = PV.MP;
function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: .5, y: .5, visibility: .95 }; return a; }
function makeBody(opt) {
  const lm = blank(), bodyH = opt.bodyH, feetY = opt.feetY, cx = .5, c = opt.compress || 0;
  const Y = y => feetY - (feetY - y) * (1 - c);
  const headTop = Y(feetY - bodyH), headR = .055 * bodyH;
  const nose = { x: cx, y: headTop + headR };
  const shoulderY = Y(headTop + .20 * bodyH), hipY = Y(headTop + .52 * bodyH), kneeY = Y(headTop + .75 * bodyH), ankleY = Y(feetY);
  const shOff = .085 * bodyH, hipOff = .045 * bodyH;
  const shL = { x: cx - shOff, y: shoulderY }, shR = { x: cx + shOff, y: shoulderY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY };
  const phi = opt.armPhi || 0, armL = .36 * bodyH * (1 - c * .5);
  const arm = (sh, side) => ({ e: { x: sh.x + side * armL * .5 * Math.sin(phi), y: sh.y + armL * .5 * Math.cos(phi) }, w: { x: sh.x + side * armL * Math.sin(phi), y: sh.y + armL * Math.cos(phi) } });
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
const BH = .65, FY = .88;
function makeRnd(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function jit(lm, rnd, j) { return lm.map(p => ({ x: p.x + (rnd() - .5) * 2 * j, y: p.y + (rnd() - .5) * 2 * j, visibility: p.visibility })); }
function gen(f, freq, n, fps, j) { const rnd = makeRnd(4242 + Math.round(f * 1e4)), o = []; for (let i = 0; i < n; i++) { const t = i / fps, p = .5 - .5 * Math.cos(2 * Math.PI * freq * t); o.push(jit(makeBody({ bodyH: BH, feetY: FY, armPhi: f * Math.PI * p, legSpread: f * .11 * p, compress: .04 * p }), rnd, j)); } return o; }

const P = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 };
function run(f) {
  const fr = gen(f, .8, Math.round(20 * 24), 24, .0025);
  const engFps = 60, srcFps = 24, ratio = engFps / srcFps, PREV = engFps;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(P);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const Wv = [], G = [], Sp = [], R = [];
  eng.preview(); let prev = -1;
  const total = PREV + Math.round(20 * engFps);
  for (let i = 0; i < total; i++) {
    if (i === PREV) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prev) { prev = slot; const ff = fr[slot % fr.length]; pv.pushLandmarks(ff.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / engFps);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= PREV) { const st = eng.getState(); Wv.push(st.live.width); G.push(st.repGate); Sp.push(st.repSpread); R.push(st.reps); }
  }
  eng.stop();
  // 打印前 6 秒逐帧（每 6 帧抽样）宽度 + 过零统计
  const wf = Math.round(srcFps * 3.5);
  const sp = [];
  for (let i = wf - 1; i < Wv.length; i++) { const s = Wv.slice(i - wf + 1, i + 1); sp.push(Math.max(...s) - Math.min(...s)); }
  sp.sort((a, b) => a - b);
  console.log(`f=${f}: reps=${eng.getState().reps}  width整段[${Math.min(...Wv).toFixed(4)},${Math.max(...Wv).toFixed(4)}] 3.5s窗峰峰中位=${sp[sp.length >> 1].toFixed(4)} gate=${G[G.length - 1].toFixed(4)}`);
  // 抽样宽度波形
  let s = "  width 波形(每0.25s): ";
  for (let k = 0; k < Wv.length; k += Math.round(engFps * .25)) s += Wv[k].toFixed(3) + " ";
  console.log(s);
}
console.log("=== 合成开合跳 f 扫描（0.8Hz×20s，期望 16 周期）===\n");
for (const f of [.15, .25, .35, .5, 1]) run(f);
