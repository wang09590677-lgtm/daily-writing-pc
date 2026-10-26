/* 诊断：合成关键点的几何信号是否与"周期数"一一对应；
 * 以及引擎 reps 是否 ≈ 周期数（排查合成重演里 2× 过计的来源）。 */
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
/* 纯横向：双腿张开 = 唯一变化量，双臂完全不动（隔离 width 信号） */
function body(bh, feetY, spread) {
  const lm = blank(), cx = .5, headTop = feetY - bh, headR = .055 * bh;
  const shY = headTop + .20 * bh, hipY = headTop + .52 * bh, kneeY = headTop + .75 * bh, ankY = feetY;
  const shOff = .085 * bh, hipOff = .045 * bh;
  const shL = { x: cx - shOff, y: shY }, shR = { x: cx + shOff, y: shY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY };
  lm[MP.NOSE] = { x: cx, y: headTop + headR, visibility: .95 };
  lm[MP.L_EAR] = { x: cx - .028, y: headTop + headR, visibility: .95 };
  lm[MP.R_EAR] = { x: cx + .028, y: headTop + headR, visibility: .95 };
  lm[MP.L_EYE] = { x: cx - .012, y: headTop + headR - .006, visibility: .95 };
  lm[MP.R_EYE] = { x: cx + .012, y: headTop + headR - .006, visibility: .95 };
  lm[MP.L_SHOULDER] = { ...shL, visibility: .95 }; lm[MP.R_SHOULDER] = { ...shR, visibility: .95 };
  lm[MP.L_ELBOW] = { x: shL.x, y: shY + .18 * bh, visibility: .95 };
  lm[MP.R_ELBOW] = { x: shR.x, y: shY + .18 * bh, visibility: .95 };
  lm[MP.L_WRIST] = { x: shL.x, y: shY + .36 * bh, visibility: .95 };
  lm[MP.R_WRIST] = { x: shR.x, y: shY + .36 * bh, visibility: .95 };
  lm[MP.L_INDEX] = { x: shL.x, y: shY + .36 * bh, visibility: .95 };
  lm[MP.R_INDEX] = { x: shR.x, y: shY + .36 * bh, visibility: .95 };
  lm[MP.L_HIP] = { ...hipL, visibility: .95 }; lm[MP.R_HIP] = { ...hipR, visibility: .95 };
  lm[MP.L_KNEE] = { x: hipL.x - spread * .45, y: kneeY, visibility: .95 };
  lm[MP.R_KNEE] = { x: hipR.x + spread * .45, y: kneeY, visibility: .95 };
  lm[MP.L_ANKLE] = { x: hipL.x - spread, y: ankY, visibility: .95 };
  lm[MP.R_ANKLE] = { x: hipR.x + spread, y: ankY, visibility: .95 };
  lm[MP.L_HEEL] = { x: hipL.x - spread, y: ankY + .01, visibility: .95 };
  lm[MP.R_HEEL] = { x: hipR.x + spread, y: ankY + .01, visibility: .95 };
  lm[MP.L_FOOT] = { x: hipL.x - spread + .02, y: ankY + .015, visibility: .95 };
  lm[MP.R_FOOT] = { x: hipR.x + spread - .02, y: ankY + .015, visibility: .95 };
  return lm;
}
const bh = .65, feetY = .88, SPREAD_MAX = .18 * .65; // 做满时两踝各外移 0.117（比例同开合跳）
function gen(f, freq, n, fps) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = i / fps, p = .5 - .5 * Math.cos(2 * Math.PI * freq * t); out.push(body(bh, feetY, f * SPREAD_MAX * p)); }
  return out;
}
function run(fr, profile, engFps = 60, srcFps = 24) {
  const ratio = engFps / srcFps;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const w = [], gates = [], spreads = []; const t0 = 0;
  eng.preview();
  let prev = -1;
  const total = Math.round(1 * engFps) + Math.round(15 * engFps);
  for (let i = 0; i < total; i++) {
    if (i === Math.round(1 * engFps)) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prev) { prev = slot; const f = fr[slot % fr.length]; pv.pushLandmarks(f.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / engFps);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= Math.round(1 * engFps)) { const st = eng.getState(); w.push(st.live.width); gates.push(st.repGate); spreads.push(st.repSpread); }
  }
  eng.stop();
  // 几何参考：窗口峰峰中位
  const wf = Math.round(srcFps * 3.5), sp = [];
  for (let i = wf - 1; i < w.length; i++) { const s = w.slice(i - wf + 1, i + 1); sp.push(Math.max(...s) - Math.min(...s)); }
  sp.sort((a, b) => a - b);
  return { reps: eng.getState().reps, widthRange: +(Math.max(...w) - Math.min(...w)).toFixed(4), winSpreadMed: sp[sp.length >> 1] && +sp[sp.length >> 1].toFixed(4), gate: gates[gates.length - 1] };
}
const P = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 };
console.log("纯横向开合（isolated width，双臂不动）· 0.6Hz×15s → 期望周期数 = 9\n");
console.log("幅度f   width整段峰峰   3.5s窗峰峰中位   门限     reps(注意 minRepGap=0.45s)");
for (const f of [0.15, 0.25, 0.35, 0.5, 0.7, 1.0]) {
  const r = run(gen(f, 0.6, Math.round(20 * 24), 24), P);
  console.log(String(f).padEnd(8) + String(r.widthRange).padEnd(16) + String(r.winSpreadMed).padEnd(17) + String(r.gate).padEnd(9) + r.reps);
}
