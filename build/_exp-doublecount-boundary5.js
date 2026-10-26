/* ==================================================================
 * _exp-doublecount-boundary5.js — 终极判定：把"真实波形"搬进 2× 深区
 *
 * 问题：合成单音在 1.2Hz（win/周期=0.6）稳 2×；真跳绳 win/周期≈0.86
 *       却 1×。到底是"频率"决定，还是"波形/平稳性"决定？
 *
 * 做法（同一份真实 height 波形，只改时间尺度）：
 *   A) 真实 6s 跳绳 height，原速循环到 30s（带交叉淡化，无拼接突跳）
 *      → 真实周期 p0，真值周期数 = 30/p0
 *   B) 把同一份真实波形**时间伸缩**到周期正好 = 1/1.2s（深区），循环 30s
 *      → 真值周期数 = 36
 *   C) 对照：纯合成单音 1.2Hz → 真值 36
 *   统计每档的引擎 reps 与 真值周期数 的比值。
 *
 *   若 B 仍 ≈1× → 决定因素是**波形形状/平稳性**，真实动作不会踩中 → 不用改。
 *   若 B 变 2×  → 真实波形只要跑到该拍速就会中招 → 需升级为待修。
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
/* 交叉淡化平铺到目标长度 */
function tileXFade(src, targetLen, xfade) {
  const out = new Array(targetLen); const L = src.length;
  const m = src.reduce((a, b) => a + b, 0) / L;
  let pos = 0;
  while (pos < targetLen) {
    for (let i = 0; i < L && pos + i < targetLen; i++) {
      let v = src[i];
      if (i < xfade && pos > 0) { const w = i / xfade; v = w * src[i] + (1 - w) * src[L - xfade + i]; }
      out[pos + i] = v;
    }
    pos += L - xfade;
  }
  // 去均值并归到 [0,1]
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp);
}
/* 线性插值时间伸缩，使源周期 p0 → 目标周期 pT */
function timeStretch(src, p0, pT, targetLen) {
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const u = (i * pT / p0);            // 映射回源时间轴
    const i0 = Math.floor(u) % src.length, i1 = (i0 + 1) % src.length;
    const fr = u - Math.floor(u);
    out[i] = src[i0] * (1 - fr) + src[i1] * fr;
  }
  let mn = Infinity, mx = -Infinity; for (const q of out) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; return out.map(q => (q - mn) / sp);
}

const PROF_OFF = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };
const DUR = 30;
/* 统一约定：所有波形数组一律按 **源帧率 SRC=24fps** 索引（runPose 每 2.5 个引擎帧喂一帧）。
 * 数组长度 = DUR * SRC。 */
const N = Math.round(DUR * SRC);
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, rows: [] };

/* 提取真实跳绳 height（原速 60fps，6s），再**下采样到 24fps**（真实时间不变） */
const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const a = lm.acts["jumpRope"];
const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
const realRun = runPose(frames, PROF_OFF, { countSecs: frames.length / SRC, loop: false });
const real60 = realRun.hs;                          // 60fps
const realSig = [];                                 // 下采样到 24fps
for (let j = 0; j < Math.round(real60.length / RATIO); j++) realSig.push(real60[Math.min(real60.length - 1, Math.round(j * RATIO))]);
const p0 = domPeriod(realSig, SRC);                 // 24fps 下的样本周期
const p0est = p0 || 0.6;
console.log(`真实跳绳 height：时长 ${(real60.length / ENG).toFixed(2)}s  24fps下 自相关周期 p0=${p0est.toFixed(4)}s  (${(1 / p0est).toFixed(2)}Hz)  样本数=${realSig.length}`);

const CASES = [];
/* A：真实波形原速平铺 30s（24fps） */
{
  const vals = tileXFade(realSig, N, 4);
  CASES.push({ key: "A 真实波形 原速(≈" + (1 / p0est).toFixed(2) + "Hz)", vals, truePeriods: +(DUR / p0est).toFixed(1) });
}
/* A2：真实波形原速、逐块直接拼接（不淡化）作对照 */
{
  const vals = new Array(N); for (let i = 0; i < N; i++) vals[i] = realSig[i % realSig.length];
  let mn = Infinity, mx = -Infinity; for (const q of vals) { if (q < mn) mn = q; if (q > mx) mx = q; }
  const sp = (mx - mn) || 1; const norm = vals.map(q => (q - mn) / sp);
  CASES.push({ key: "A2 真实波形 原速直拼", vals: norm, truePeriods: +(DUR / p0est).toFixed(1) });
}
/* B：真实波形时间伸缩到 1.2Hz（深区） */
{
  const vals = timeStretch(realSig, p0est, 1 / 1.2, N);
  CASES.push({ key: "B 真实波形 伸缩→1.2Hz(深区)", vals, truePeriods: +(DUR * 1.2).toFixed(1) });
}
/* B2：真实波形伸缩到 1.67Hz（≈真跳绳频点） */
{
  const vals = timeStretch(realSig, p0est, 1 / 1.67, N);
  CASES.push({ key: "B2 真实波形 伸缩→1.67Hz", vals, truePeriods: +(DUR * 1.67).toFixed(1) });
}
/* C：纯合成单音 1.2Hz 对照（24fps 索引，应≈2×，用于校验实验台） */
{
  const vals = new Array(N); for (let i = 0; i < N; i++) vals[i] = .5 + .5 * Math.sin(2 * Math.PI * 1.2 * (i / SRC));
  CASES.push({ key: "C 纯合成单音 1.2Hz(校验台)", vals, truePeriods: 36 });
}
/* C2：纯合成单音 1.71Hz 对照 */
{
  const vals = new Array(N); for (let i = 0; i < N; i++) vals[i] = .5 + .5 * Math.sin(2 * Math.PI * 1.71 * (i / SRC));
  CASES.push({ key: "C2 纯合成单音 1.71Hz(校验台)", vals, truePeriods: +(DUR * 1.71).toFixed(1) });
}

console.log("\n=== 终极判定（门限关闭，30s，真值周期数由拍速算出）===\n");
console.log("情形                                | 真值周期 | 引擎reps | 比值   | 判定");
console.log("-".repeat(78));
for (const c of CASES) {
  const r = runPose(framesFromVals(c.vals, 909), PROF_OFF, { countSecs: DUR });
  const ratio = c.truePeriods ? r.reps / c.truePeriods : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 1×");
  out.rows.push({ label: c.key, truePeriods: c.truePeriods, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(String(c.key).padEnd(34) + String(c.truePeriods).padEnd(9) + String(r.reps).padEnd(9) + ratio.toFixed(2).padEnd(8) + tag);
}

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary5.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary5.json");
