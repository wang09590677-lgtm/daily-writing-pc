/* ==================================================================
 * _exp-doublecount-boundary6.js — 决断 v2：真实波形扫频 + minRepGap 交互
 *
 * 关键假设（v5 后修正）：
 *   1) 2× 的成因是 detrend 滑动均值窗→在 win/周期≳0.44 时 d 变"尖"，
 *      每周期两次穿 +k。频率是主控。
 *   2) 高频端计数不再翻倍，不是因为 d 不尖了，而是 **minRepGap 把
 *      紧跟真峰之后的伪峰按掉**（伪峰滞后 ≈ 半周期）。
 *   3) 真跳绳 1.71Hz：半周期 0.292s < minRepGap 0.3s → 恰好被按掉 → 1×。
 *      若孩子跳得稍慢（如 1.4~1.5Hz，半周期 0.33~0.36s > 0.3s）→ 伪峰不再被按 → 2×。
 *
 * 验证：把真跳绳 height 波形**时间伸缩**到 0.9→2.2Hz 逐点扫，
 *   每个频点同时跑 minRepGap=0.3（真实配置）与 minRepGap=0（暴露原始过零），
 *   并对照 半周期 vs minRepGap 的抑制关系。
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
function domPeriod(v, fps) {
  const fin = v.filter(Number.isFinite); if (fin.length < 20) return null;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  let bl = 0, best = -Infinity; const maxLag = Math.min(Math.round(fps * 3), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.15); lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; s /= (x.length - lag); if (s > best) { best = s; bl = lag; } }
  return bl ? bl / fps : null;
}
function timeStretch(src, p0, pT, targetLen) {
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const u = (i * pT / p0);
    const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length;
    const fr = u - Math.floor(u);
    out[i] = src[i0] * (1 - fr) + src[i1] * fr;
  }
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp);
}
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const baseProf = { mode: "rep", signal: "height", tempoBand: [60, 120], expectedAmplitude: 1e-6 };
const DUR = 30, N = Math.round(DUR * SRC);
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC, realHz: null }, rows: [] };

const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const a = lm.acts["jumpRope"];
const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
const realRun = runPose(frames, baseProf, { countSecs: frames.length / SRC, loop: false });
const real60 = realRun.hs;
const realSig = []; for (let j = 0; j < Math.round(real60.length / RATIO); j++) realSig.push(real60[Math.min(real60.length - 1, Math.round(j * RATIO))]);
const p0est = domPeriod(realSig, SRC) || 0.6;
out.meta.realHz = +(1 / p0est).toFixed(3);
console.log(`真实跳绳 height：p0=${p0est.toFixed(4)}s (${(1 / p0est).toFixed(2)}Hz)\n`);

console.log("=== 真实跳绳波形 时间伸缩扫频（30s，门限关闭）===\n");
console.log("目标Hz | 真值周期 | minGap=0.3 | 比值 | minGap=0 | 半周期s | 半周期>minGap? | 判定");
console.log("-".repeat(92));
for (const f of [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.71, 1.8, 2.0, 2.2]) {
  const vals = timeStretch(realSig, p0est, 1 / f, N);
  const framesV = framesFromVals(vals, 909);
  const trueP = +(DUR * f).toFixed(1);
  const r3 = runPose(framesV, { ...baseProf, minRepGap: .3 }, { countSecs: DUR });
  const r0 = runPose(framesV, { ...baseProf, minRepGap: 0 }, { countSecs: DUR });
  const half = (1 / f) / 2;
  const suppressed = half < 0.3;
  const ratio = r3.reps / trueP;
  const tag = ratio >= 1.6 ? "★ 2×" : (ratio >= 1.25 ? "偏高" : "✔ 1×");
  out.rows.push({ freq: f, truePeriods: trueP, repsMg03: r3.reps, repsMg0: r0.reps, ratio: +ratio.toFixed(2), halfPeriod: +half.toFixed(3), suppressed, tag });
  console.log(pad(f.toFixed(2), 7) + pad(trueP, 9) + pad(r3.reps, 12) + pad(ratio.toFixed(2), 6) + pad(r0.reps, 9) + pad(half.toFixed(3), 9) + pad(suppressed ? "是(按掉)" : "否(漏出)", 14) + tag);
}

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary6.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary6.json");
