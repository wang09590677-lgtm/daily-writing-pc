/* 最小复现：同一进程里连续跑多段，检查是否有跨实例状态泄漏
 * （TRACE 单跑 jr f=1.0 → reps=30；但在全量扫描里同一配置 → reps=1） */
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

const MP = PV.MP;
function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: .5, y: .5, visibility: .95 }; return a; }
function makeBody(opt) {
  const lm = blank(), bodyH = opt.bodyH, feetY = opt.feetY, cx = .5, c = opt.compress || 0;
  const Y = y => feetY - (feetY - y) * (1 - c);
  const headTop = Y(feetY - bodyH), headR = .055 * bodyH, nose = { x: cx, y: headTop + headR };
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
function genJumpRope(f, freq, n, fps) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = i / fps, p = .5 - .5 * Math.cos(2 * Math.PI * freq * t); out.push(makeBody({ bodyH: BH, feetY: FY, armPhi: .15, legSpread: .01, compress: f * .09 * p })); }
  return out;
}
const P = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 };
function mkFrame(fr, i) { return fr[i % fr.length].map(p => ({ x: p.x, y: p.y, visibility: p.visibility })); }

function run(fr, countSecs, label) {
  const engFps = 60, srcFps = 24, ratio = engFps / srcFps, PREV = engFps;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(P);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  eng.preview(); let prev = -1;
  const total = PREV + Math.round(countSecs * engFps);
  for (let i = 0; i < total; i++) {
    if (i === PREV) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prev) { prev = slot; pv.pushLandmarks(mkFrame(fr, slot)); }
    globalThis.__clock = (i + 1) * (1000 / engFps);
    if (globalThis.__rafCb) globalThis.__rafCb();
  }
  eng.stop();
  console.log(`${label}: reps=${eng.getState().reps} fps=${eng.getState().fps.toFixed(1)}`);
  return eng.getState().reps;
}

const fr = genJumpRope(1.0, 1.5, Math.round(20 * 24), 24);
console.log("=== 同一配置，分别在不同「进程内历史」下跑 ===\n");
run(fr, 10, "A 单独跑 10s       ");
run(fr, 20, "B 单独跑 20s       ");
run(genJumpRope(.5, 1.5, Math.round(20 * 24), 24), 20, "C 先跑 f=0.5 20s   ");
run(fr, 20, "D 接着跑 f=1.0 20s ");
console.log("\n=== 关键：先跑一段别的动作再跑 f=1.0（模拟扫描顺序）===");
run(genJumpRope(.15, 1.5, Math.round(20 * 24), 24), 20, "E f=0.15 20s       ");
run(fr, 20, "F f=1.0 20s        ");
