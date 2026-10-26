/* ==================================================================
 * _exp-doublecount-boundary2.js — 2× 边界 v2（只在 v1 基础上补两类决定性实验）
 *
 * v1 已得（build/_doublecount-boundary.log）：
 *   · 轴1 频率：纯正弦 height，0.9~2.0Hz 稳定 2×（win/周期 0.45~1.0）；≤0.75Hz 与 3.0Hz 回到 1×
 *   · 轴2 波形：正弦 / +二次谐波 / 带平台 / +抖动 —— **全都仍 2×**
 *   · 轴3 可见度：下肢剔除 / 半可信 / 置空 —— 全都仍 2×
 *   即：2× 对**波形形状与可见度完全不敏感**。这本身是强线索：
 *   它更像「detrend 的滑动均值窗 ≈ 半周期」造成的形状/频谱效应，与波形细节无关。
 *
 * v2 要补的（决定"真实动作会不会踩中"）：
 *   轴2b 非平稳性：真人不是节拍器。加
 *        ⑥ 周期抖动（每拍周期 ±10% / ±20% / ±40%）
 *        ⑦ 幅度抖动（每拍幅度 ±25%）
 *        ⑧ 周期+幅度抖动
 *        ⑨ 不规律间歇（偶尔停一拍）
 *      —— 若"周期抖动"就把 2× 打掉，真实动作就不会踩中（真人每拍时长本就有 5~20% 波动）。
 *   轴1b 更细的频率过渡：0.70~1.00Hz（步长 0.025）找 1×→2× 的**确切开关点**，换算出 win/周期 阈值。
 *   机制：对引擎看到的 live.height 做频谱分析，看能量是否在 2× 输入频率处出现（证明是倍频/形状效应）。
 *
 * 纯 Node，不开浏览器。只读产品文件。运行：node build/_exp-doublecount-boundary2.js
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
  return { reps: eng.getState().reps, gateEnd: eng.getState().repGate, hs };
}
function upCrossings(v) {
  const fin = v.filter(Number.isFinite);
  if (!fin.length) return 0;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  let n = 0, below = false;
  for (const x of fin) { if (x < m) below = true; else if (below) { n++; below = false; } }
  return n;
}
/* 简化 DFT：把序列重采样到 256 点，看目标频点的能量占比 */
function spectrum(v, fps) {
  const fin = v.filter(Number.isFinite);
  const N = 256;
  const s = new Array(N);
  for (let i = 0; i < N; i++) s[i] = fin[Math.min(fin.length - 1, Math.floor(i * fin.length / N))];
  const m = s.reduce((a, b) => a + b, 0) / N;
  const x = s.map(q => q - m);
  const freqs = [];
  for (let k = 1; k <= 24; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { const a = -2 * Math.PI * k * n / N; re += x[n] * Math.cos(a); im += x[n] * Math.sin(a); }
    freqs.push(Math.sqrt(re * re + im * im) / N);
  }
  const tot = freqs.reduce((a, b) => a + b, 0) || 1;
  const perBin = 1 / (N / fps * 1); // 以"每 1/N 的采样时长"为基
  // 直接返回前 12 个 bin 的归一化幅度（bin k 的频率 = k * fps / N）
  return { freqs: freqs.slice(0, 12).map(q => +(q / tot).toFixed(4)), binHz: +(fps / N).toFixed(3) };
}

const PROF_OFF = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 };
const PROF_ON = { ...PROF_OFF, expectedAmplitude: .05 };
const WIN_JR = Math.min(Math.max(Math.round(ENG * 60 / 120), 3), Math.round(ENG * 1.5)) / ENG;
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC, winJR: WIN_JR }, fineFreq: [], nonstat: [], spectrum: [], real: [] };

/* 波形生成器：支持周期抖动 / 幅度抖动 / 间歇 */
function buildSignal(kind, n, freq, fps, opt) {
  opt = opt || {};
  const rnd = makeRnd(opt.seed || 12345);
  if (!opt.periodJit && !opt.ampJit && !opt.dropRep && (kind === "sine")) {
    const a = []; for (let i = 0; i < n; i++) a.push((1 - Math.cos(2 * Math.PI * freq * (i / fps))) / 2);
    return { v: a, cycles: Math.round(freq * n / fps) };
  }
  // 逐拍构造：每拍时长抖动、幅度抖动、可跳过
  const v = new Array(n).fill(0);
  let t = 0, cycles = 0;
  while (t < n / fps) {
    let dur = 1 / freq;
    if (opt.periodJit) dur *= (1 + (rnd() - .5) * 2 * opt.periodJit);
    let amp = 1;
    if (opt.ampJit) amp = Math.max(.2, 1 + (rnd() - .5) * 2 * opt.ampJit);
    const drop = opt.dropRep && rnd() < opt.dropRep;
    const durF = dur * fps;
    for (let k = 0; k < durF; k++) {
      const idx = Math.round(t * fps) + k;
      if (idx >= n) break;
      const ph = k / durF;
      let val = (1 - Math.cos(2 * Math.PI * ph)) / 2;
      if (opt.plateau) { const lo = .5 - opt.plateau / 2, hi = .5 + opt.plateau / 2; val = Math.max(0, Math.min(1, (val - lo) / (hi - lo))); }
      v[idx] = drop ? 0 : amp * val;
    }
    t += dur;
    if (!drop) cycles++;
  }
  return { v, cycles };
}
function framesFromVals(vals, seed) {
  return vals.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * Math.max(0, x) }), makeRnd(seed || 999), .0025));
}

/* ============================================================
 * 轴 1b：细频率过渡（纯正弦，找 1×→2× 的开关点）
 * ============================================================ */
console.log("=== 轴 1b：细频率过渡（纯正弦 height，30s，门限关闭）===\n");
console.log("频率Hz | 物理周期数 | 引擎reps | 比值   | win/周期 | 判定");
console.log("-".repeat(64));
for (let freq = 0.70; freq <= 1.0001; freq += 0.025) {
  const n = Math.round(30 * SRC);
  const { v } = buildSignal("sine", n, freq, SRC, {});
  const r = runPose(framesFromVals(v, 111), PROF_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.hs);
  const ratio = cyc ? r.reps / cyc : 0;
  const wp = WIN_JR / (1 / freq);
  const tag = ratio >= 1.6 ? "2×" : (ratio >= 1.25 ? "过渡" : "1×");
  out.fineFreq.push({ freq: +freq.toFixed(3), cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), winOverPeriod: +wp.toFixed(3), tag });
  console.log(pad(freq.toFixed(3), 7) + pad(cyc, 11) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + pad(wp.toFixed(3), 10) + tag);
}

/* ============================================================
 * 轴 2b：非平稳性（真人不是节拍器）
 * ============================================================ */
const TRIG = 1.2;
console.log(`\n=== 轴 2b：非平稳性（频率 ${TRIG}Hz，门限关闭，30s）—— 真人每拍时长有波动 ===\n`);
console.log("波形情形                          | 设计周期 | 引擎reps | 比值(引擎/设计) | 判定");
console.log("-".repeat(82));
const NONSTAT = [
  { key: "基准 纯正弦（无抖动）", o: {} },
  { key: "周期抖动 ±10%", o: { periodJit: .10 } },
  { key: "周期抖动 ±20%", o: { periodJit: .20 } },
  { key: "周期抖动 ±40%", o: { periodJit: .40 } },
  { key: "幅度抖动 ±25%", o: { ampJit: .25 } },
  { key: "周期±20% + 幅度±25%", o: { periodJit: .20, ampJit: .25 } },
  { key: "周期±20% + 幅度±25% + 平台", o: { periodJit: .20, ampJit: .25, plateau: .34 } },
  { key: "偶发停一拍（8% 概率）", o: { dropRep: .08 } },
  { key: "周期±20% + 停一拍 8%", o: { periodJit: .20, dropRep: .08 } }
];
for (const c of NONSTAT) {
  const n = Math.round(30 * SRC);
  const b = buildSignal("sine", n, TRIG, SRC, { seed: 4242, ...c.o });
  const r = runPose(framesFromVals(b.v, 222), PROF_OFF, { countSecs: 30 });
  const ratio = b.cycles ? r.reps / b.cycles : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.nonstat.push({ label: c.key, designedCycles: b.cycles, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(c.key, 34) + pad(b.cycles, 9) + pad(r.reps, 9) + pad(ratio.toFixed(2), 16) + tag);
}

/* ============================================================
 * 机制：频谱（1× vs 2× 的对比）
 * ============================================================ */
console.log("\n=== 机制：引擎 live.height 的频谱（重采样 256 点，bin = 60/256 = 0.234Hz）===\n");
for (const freq of [0.75, 1.0, 1.2, 1.5]) {
  const n = Math.round(30 * SRC);
  const { v } = buildSignal("sine", n, freq, SRC, {});
  const r = runPose(framesFromVals(v, 333), PROF_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.hs);
  const sp = spectrum(r.hs, ENG);
  const fBin = Math.round(freq / sp.binHz);       // 输入频率落在第几个 bin
  const f2Bin = Math.round(2 * freq / sp.binHz);  // 2× 频率
  out.spectrum.push({ freq, ratio: +(r.reps / cyc).toFixed(2), inputBin: fBin, inputMag: sp.freqs[fBin - 1] || 0, dblBin: f2Bin, dblMag: sp.freqs[f2Bin - 1] || 0, top: sp.freqs.slice(0, 8) });
  console.log(`输入 ${freq}Hz（比值 ${(r.reps / cyc).toFixed(2)}×）：bin 幅度前 8 = [${sp.freqs.slice(0, 8).join(", ")}]`);
  console.log(`   → 输入频率 bin#${fBin} 幅度=${(sp.freqs[fBin - 1] || 0).toFixed(4)}  2×频率 bin#${f2Bin} 幅度=${(sp.freqs[f2Bin - 1] || 0).toFixed(4)}`);
}

/* ============================================================
 * 参照：真实视频（_lm.json）—— 用**同一套**稳健周期计数
 * ============================================================ */
console.log("\n=== 参照：真实视频（_lm.json）===  门限关闭 vs 真值\n");
try {
  const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
  const CASES = [
    { act: "jumpingJacks", cn: "开合跳", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 } },
    { act: "squat", cn: "徒手深蹲", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: .12 } },
    { act: "jumpRope", cn: "跳绳", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 } },
    { act: "burpee", cn: "波比跳", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: .16 } }
  ];
  console.log("动作     | 信号   | 时长s | reps(真值) | reps(门限关) | 比值(关/真值) | 门限影响");
  console.log("-".repeat(78));
  for (const c of CASES) {
    const a = lm.acts[c.act]; if (!a) continue;
    const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
    const secs = frames.length / SRC;
    const rOn = runPose(frames, c.p, { countSecs: secs, loop: false });
    const rOff = runPose(frames, { ...c.p, expectedAmplitude: 1e-6 }, { countSecs: secs, loop: false });
    const impact = rOff.reps - rOn.reps;
    out.real.push({ cn: c.cn, signal: c.p.signal, secs: +secs.toFixed(1), repsGateOn: rOn.reps, repsGateOff: rOff.reps, gateImpact: impact });
    console.log(pad(c.cn, 9) + pad(c.p.signal, 9) + pad(secs.toFixed(1), 7) + pad(rOn.reps, 12) + pad(rOff.reps, 14) + pad((rOn.reps ? (rOff.reps / rOn.reps).toFixed(2) : "-"), 15) + impact);
  }
} catch (e) { console.log("跳过：" + e.message); }

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary2.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary2.json");
