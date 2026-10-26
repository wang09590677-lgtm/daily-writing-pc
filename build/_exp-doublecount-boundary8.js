/* ==================================================================
 * _exp-doublecount-boundary8.js — 干净法：真实跳绳关键点「放慢播放」
 *
 * 前面用"时间伸缩波形"有插值伪影，不可靠。这里改用零伪影的办法：
 * 把**真实的 145 帧跳绳关键点**按不同速度喂给引擎（每帧多停留几个引擎帧），
 * 真实波形原样不变，只是节奏变慢 → 频率下移进 2× 区。
 *
 * 若慢放到 ~1.0Hz 触发 2×、而原速 1.71Hz 不触发 —— 则证明
 * 触发条件是「计次信号基频落进 win/周期∈[0.44,1.0] 窗口」，
 * 与波形形状无关；真实动作只要把那一套动作做慢/做快就会进出该窗口。
 *
 * 纯 Node，只读产品文件。输出 build/_exp-doublecount-boundary8.json
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

const ENG = 60, SRC = 24, RATIO = ENG / SRC;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 以 hold 个引擎帧喂一帧关键点（hold = RATIO / speed） */
function runSpeed(frames, profile, key, speed, opt) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const hold = Math.max(1, Math.round(RATIO / speed));
  const prev = opt.previewFrames || ENG, total = prev + Math.round(opt.countSecs * ENG);
  const sig = [];
  let slot = -1, srcIdx = -1, lastLm = null;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prev) eng.start();
    const s = Math.floor(i / hold);
    if (s !== slot) { slot = s; srcIdx++; const f = frames[srcIdx % frames.length]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prev) sig.push(eng.getState().live[key]);
  }
  eng.stop();
  return { reps: eng.getState().reps, sig };
}
/* 稳健基频估计：自相关的**第一个**显著局部峰（避免取到倍频） */
function fundamentalPeriod(v, fps) {
  const fin = v.filter(Number.isFinite); if (fin.length < 40) return null;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length; const x = fin.map(q => q - m);
  const maxLag = Math.min(Math.round(fps * 4), Math.floor(x.length / 2));
  const ac = new Array(maxLag + 1).fill(0);
  for (let lag = 1; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]; ac[lag] = s / (x.length - lag); }
  let mx = 0; for (let lag = 1; lag <= maxLag; lag++) if (ac[lag] > mx) mx = ac[lag];
  const thr = 0.35 * mx;
  for (let lag = Math.round(fps * 0.12); lag < maxLag; lag++) {
    if (ac[lag] > thr && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) return lag / fps;
  }
  return null;
}

const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const ACTS = [
  { act: "jumpRope", cn: "跳绳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: 1e-6 } },
  { act: "jumpingJacks", cn: "开合跳", key: "width", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: 1e-6 } },
  { act: "squat", cn: "徒手深蹲", key: "height", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: 1e-6 } },
  { act: "halfSquatWarm", cn: "半蹲热身", key: "centroidY", p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: .9, expectedAmplitude: 1e-6 } },
  { act: "burpee", cn: "波比跳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 1e-6 } }
];
const DUR = 30;
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, actions: [] };

for (const A of ACTS) {
  const a = lm.acts[A.act]; if (!a) continue;
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const win = clamp(Math.round(ENG * 60 / Math.max(15, (A.p.tempoBand)[1])), 3, Math.round(ENG * 1.5));
  const fLo = 0.44 / (win / ENG), fHi = 1 / (2 * A.p.minRepGap);
  console.log(`\n=== ${A.cn}（${A.key}，win=${(win / ENG).toFixed(3)}s，minGap=${A.p.minRepGap}s）理论 2× 窗口 ${fLo.toFixed(2)}~${fHi.toFixed(2)}Hz ===`);
  console.log("  播放速度 | 实测基频Hz | win/周期 | 真值周期 | 引擎reps | 比值   | 判定");
  console.log("  " + "-".repeat(70));
  const rows = [];
  for (const speed of [0.30, 0.40, 0.50, 0.60, 0.70, 0.85, 1.00, 1.20, 1.50]) {
    const r = runSpeed(frames, A.p, A.key, speed, { countSecs: DUR });
    const per = fundamentalPeriod(r.sig, ENG);
    const f = per ? 1 / per : null;
    const truth = f ? DUR * f : 0;
    const ratio = truth ? r.reps / truth : 0;
    const wp = per ? (win / ENG) / per : null;
    const inWin = f && f >= fLo && f <= fHi;
    const tag = (ratio >= 1.6 ? "★ 2×" : (ratio >= 1.25 ? "偏高" : "1×")) + (inWin ? " [窗内]" : "");
    rows.push({ speed, freq: f ? +f.toFixed(3) : null, winOverPeriod: wp ? +wp.toFixed(3) : null, truth: +truth.toFixed(1), reps: r.reps, ratio: +ratio.toFixed(2), inWindow: !!inWin, tag });
    console.log("  " + pad(speed.toFixed(2), 8) + pad(f ? f.toFixed(3) : "-", 11) + pad(wp ? wp.toFixed(3) : "-", 10) + pad(truth.toFixed(1), 9) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
  }
  out.actions.push({ cn: A.cn, key: A.key, winSec: +(win / ENG).toFixed(3), minRepGap: A.p.minRepGap, window: { lo: +fLo.toFixed(2), hi: +fHi.toFixed(2) }, rows });
}

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary8.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary8.json");
