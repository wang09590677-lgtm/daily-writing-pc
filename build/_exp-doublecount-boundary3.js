/* ==================================================================
 * _exp-doublecount-boundary3.js — 轴 2 决断：更"像真人"的强非正弦波形 + 与真实信号对照
 *
 * 背景：
 *  · v1 轴2 的 平台/谐波 仍 2×，但那两档**还是圆柱形**（dwell≤34%，h2≤0.30），
 *    对"正弦性"的破坏太弱。
 *  · v2 发现真跳绳在 win/周期≈0.86（落在合成的 2× 区间）却**不 2×**。
 *    所以决定"真实动作会不会踩中"的，很可能是**波形的非正弦程度**，不是频率。
 *  · 本脚本把波形轴做狠：脉冲/梯形（大口 dwell）、削顶、半波、锯齿、强二次/三次谐波…
 *    每档都在 f=1.2Hz（合成 2× 深区）与 f=1.7Hz（≈真跳绳）两个频点上跑。
 *    只要**任何一档**回落 1×，就说明真实动作不会踩中。
 *
 * 纯 Node，不开浏览器，只读产品文件。
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
const ENG = 60, SRC = 24, RATIO = ENG / SRC;
function runPose(frames, profile, opt) {
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
function upCrossings(v) {
  const fin = v.filter(Number.isFinite);
  if (!fin.length) return 0;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  let n = 0, below = false;
  for (const x of fin) { if (x < m) below = true; else if (below) { n++; below = false; } }
  return n;
}

/* ---- 波形库：都返回 [0,1] 的"每周期形状函数" ---- */
const c01 = v => Math.min(1, Math.max(0, v));
const sine01 = p => (1 - Math.cos(2 * Math.PI * p)) / 2;
// 梯形：上升 rise、顶部平 dwellTop、下降 fall、底部平 dwellBot（比例之和=1）
function trapezoid(p, rise, dwellTop, fall) {
  const q = ((p % 1) + 1) % 1;
  if (q < rise) return c01(q / rise);
  if (q < rise + dwellTop) return 1;
  if (q < rise + dwellTop + fall) return c01(1 - (q - rise - dwellTop) / fall);
  return 0;
}
const SHAPES = [
  { key: "① 纯正弦", f: sine01 },
  { key: "② +二次谐波 h2=0.5", f: p => 0.6 * sine01(p) + 0.4 * ((1 - Math.cos(4 * Math.PI * p)) / 2) },
  { key: "③ +三次谐波 h3=0.4", f: p => 0.7 * sine01(p) + 0.3 * ((1 - Math.cos(6 * Math.PI * p)) / 2) },
  { key: "④ 梯形 顶停50%", f: p => trapezoid(p, 0.25, 0.50, 0.25) },
  { key: "④b 梯形 顶停20%", f: p => trapezoid(p, 0.40, 0.20, 0.40) },
  { key: "⑤ 削顶正弦 [0.3,0.7]", f: p => c01(Math.min(0.7, Math.max(0.3, sine01(p)))) },
  { key: "⑥ 硬削顶方波化 [0.15,0.85]", f: p => c01(Math.min(0.85, Math.max(0.15, sine01(p)))) },
  { key: "⑦ 半波整流", f: p => Math.max(0, Math.sin(2 * Math.PI * p)) },
  { key: "⑧ 锯齿", f: p => ((p % 1) + 1) % 1 },
  { key: "⑨ 非对称(快起慢落)", f: p => { const q = ((p % 1) + 1) % 1; return q < 0.25 ? q / 0.25 : 1 - (q - 0.25) / 0.75; } },
  { key: "⑩ 脉冲(峰占25%)", f: p => { const q = ((p % 1) + 1) % 1; return (q < 0.125 || q > 0.875) ? 1 : 0; } }
];
function buildVals(shapeFn, freq, n, fps) {
  const v = new Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(0, Math.min(1, shapeFn(freq * (i / fps))));
  return { v, cycles: Math.round(freq * n / fps) };
}

const PROF_OFF = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, freq: 1.2, shapes: [], freq17: [], realRef: null };

console.log("=== 轴 2 决断：强非正弦波形（f=1.2Hz，门限关闭，30s）===\n");
console.log("波形                             | 物理周期数 | 引擎reps | 比值   | 判定");
console.log("-".repeat(76));
for (const s of SHAPES) {
  const n = Math.round(30 * SRC);
  const b = buildVals(s.f, 1.2, n, SRC);
  const r = runPose(framesFromVals(b.v, 555), PROF_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.hs);
  const ratio = cyc ? r.reps / cyc : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.shapes.push({ label: s.key, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(s.key, 33) + pad(cyc, 11) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
}

console.log("\n=== 同 11 档在 f=1.7Hz（≈真跳绳频点，门限关闭，30s）===\n");
console.log("波形                             | 物理周期数 | 引擎reps | 比值   | 判定");
console.log("-".repeat(76));
for (const s of SHAPES) {
  const n = Math.round(30 * SRC);
  const b = buildVals(s.f, 1.7, n, SRC);
  const r = runPose(framesFromVals(b.v, 777), PROF_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.hs);
  const ratio = cyc ? r.reps / cyc : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.freq17.push({ label: s.key, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(s.key, 33) + pad(cyc, 11) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
}

/* 真实信号参照：把真跳绳计次信号直接跑一遍引擎 + 过零 */
try {
  const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
  const a = lm.acts["jumpRope"];
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const secs = frames.length / SRC;
  const r = runPose(frames, PROF_OFF, { countSecs: secs, loop: false });
  const cyc = upCrossings(r.hs);
  out.realRef = { cn: "跳绳", secs: +secs.toFixed(2), cycles: cyc, reps: r.reps, ratio: +(r.reps / cyc).toFixed(2) };
  console.log(`\n真实跳绳参照：时长 ${secs.toFixed(2)}s  过零周期=${cyc}  引擎reps=${r.reps}  比值=${(r.reps / cyc).toFixed(2)}`);
} catch (e) { console.log("真实参照跳过：" + e.message); }

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary3.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary3.json");
