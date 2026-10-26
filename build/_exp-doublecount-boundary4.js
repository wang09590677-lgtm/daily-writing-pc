/* ==================================================================
 * _exp-doublecount-boundary4.js — 决断实验：什么波形的 2× 会消失
 *
 * 已知（纯数学已验证）：detrend+迟滞 对**纯单音正弦**在 win/周期≳0.44 时产 2×。
 * 已知（真视频）：真跳绳同区间却 1×。差异必在信号"非单音/不平稳"上。
 *
 * 本脚本在 f=1.2Hz（2× 深区）逐档注入"真实信号才有的成分"：
 *   单音正弦 / +第二不共度音 / 慢速幅度调制AM / 双音拍频 / 啁啾 /
 *   真实跳绳信号 / 真实跳绳信号(重采样到正好1.2Hz) …
 * 只要有一档回落 1×，即证明"真实动作不会踩中"（判定标准）。
 *
 * 纯 Node，只读产品文件。
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
/* 自相关主导周期 */
function domPeriod(v, fps) {
  const fin = v.filter(Number.isFinite); if (fin.length < 20) return null;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  let bl = 0, best = -Infinity; const maxLag = Math.min(Math.round(fps * 3), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.15); lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; s /= (x.length - lag); if (s > best) { best = s; bl = lag; } }
  return bl ? bl / fps : null;
}
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const PROF_OFF = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, trigFreq: 1.2, variants: [] };

/* 真实跳绳 height 信号（从 _lm.json 提出来，供"真实信号注入"档用） */
let realJR = null, realJRPeriod = null;
try {
  const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
  const a = lm.acts["jumpRope"];
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const r = runPose(frames, PROF_OFF, { countSecs: frames.length / SRC, loop: false });
  realJR = r.hs; realJRPeriod = domPeriod(r.hs, ENG);
} catch (e) { console.log("真实跳绳提取失败：" + e.message); }

const N = Math.round(30 * SRC), DUR = 30, F = 1.2;
const S = t => Math.sin(2 * Math.PI * F * t);
const S2 = (t, f, ph) => Math.sin(2 * Math.PI * f * t + (ph || 0));

const VARIANTS = [
  { key: "① 纯单音正弦 1.2Hz", v: i => .5 + .5 * S2(i / SRC, 1.2) },
  { key: "② +不共度低音 0.37Hz(0.35)", v: i => .5 + .5 * S2(i / SRC, 1.2) + .35 * .5 * S2(i / SRC, 0.37) },
  { key: "③ +不共度高音 3.7Hz(0.35)", v: i => .5 + .5 * S2(i / SRC, 1.2) + .35 * .5 * S2(i / SRC, 3.7) },
  { key: "④ 慢速幅度调制 AM±35%", v: i => .5 + .5 * (1 + .35 * S2(i / SRC, 0.29)) * S2(i / SRC, 1.2) },
  { key: "⑤ 双音拍频 1.2+1.35", v: i => .5 + .25 * S2(i / SRC, 1.2) + .25 * S2(i / SRC, 1.35) },
  { key: "⑥ 啁啾 1.0→1.4Hz", v: i => .5 + .5 * Math.sin(2 * Math.PI * (1.0 * (i / SRC) + .5 * .4 / DUR * (i / SRC) * (i / SRC))) },
  { key: "⑦ 周期抖动±40%(逐拍)", v: i => null },  // 特殊处理
  { key: "⑧ 真实跳绳 height(6s循环)", v: i => null }, // 特殊处理
];
function buildSpecial(key) {
  if (key.startsWith("⑦")) {
    const rnd = makeRnd(4242); const arr = new Array(N).fill(.5); let t = 0;
    while (t < DUR) { const dur = (1 / 1.2) * (1 + (rnd() - .5) * 0.8); const durF = dur * SRC;
      for (let k = 0; k < durF; k++) { const idx = Math.round(t * SRC) + k; if (idx >= N) break; arr[idx] = .5 + .5 * Math.sin(2 * Math.PI * k / durF); } t += dur; }
    return arr;
  }
  if (key.startsWith("⑧") && realJR) {
    const arr = new Array(N); for (let i = 0; i < N; i++) arr[i] = realJR[i % realJR.length];
    return arr;
  }
  return null;
}

console.log("=== 决断：f=1.2Hz 深区，逐档注入「真实成分」（门限关闭，30s）===\n");
console.log("波形                              | 物理周期 | 引擎reps | 比值   | 判定");
console.log("-".repeat(80));
for (const c of VARIANTS) {
  let vals = buildSpecial(c.key);
  if (!vals) vals = []; for (let i = 0; i < N; i++) vals.push(c.v(i));
  vals = vals.map(x => Math.max(0, Math.min(1, x)));
  const r = runPose(framesFromVals(vals, 321), PROF_OFF, { countSecs: DUR });
  const cyc = upCrossings(r.hs);
  const ratio = cyc ? r.reps / cyc : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.variants.push({ label: c.key, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(c.key, 33) + pad(cyc, 9) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
}

/* 真跳绳整体参照 */
if (realJR) {
  const cyc = upCrossings(realJR.slice(0, Math.round(DUR * ENG)));
  console.log(`\n真跳绳 height 信号（6s循环30s）：过零周期=${cyc}（仅规模参照）。直接跑真实6s段见 boundary2/realwin。`);
}

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary4.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary4.json");
