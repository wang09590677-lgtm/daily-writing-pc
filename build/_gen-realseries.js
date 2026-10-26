/* ==================================================================
 * _gen-realseries.js — 用真实姿态主链路录下 5 个真实动作的计次信号序列
 *   （供 _exp-fix-candidates.js 离线回放候选计次器）
 *
 * 门限关闭（ea=1e-6）录制，保证序列不受闸门裁剪 → 候选计次器可自由对比。
 * 只读产品文件。输出 build/_tmp/_realseries.json
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
function record(frames, profile) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = ENG, secs = frames.length / SRC, total = prev + Math.round(secs * ENG);
  const series = [];
  let prevSlot = -1, srcIdx = -1, lastLm = null;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prev) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) { prevSlot = slot; srcIdx++;
      const fi = srcIdx; const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prev) { const L = eng.getState().live; series.push({ t: (i + 1 - prev) / ENG, width: L.width, height: L.height, centroidY: L.centroidY }); }
  }
  eng.stop();
  return { reps: eng.getState().reps, series };
}

const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const ACTS = [
  { cn: "开合跳", act: "jumpingJacks", key: "width", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 } },
  { cn: "徒手深蹲", act: "squat", key: "height", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: .12 } },
  { cn: "半蹲热身", act: "halfSquatWarm", useAct: "squat", key: "centroidY", p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: .9, expectedAmplitude: .06 } },
  { cn: "跳绳", act: "jumpRope", key: "height", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 } },
  { cn: "波比跳", act: "burpee", key: "height", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: .16 } }
];
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, acts: {} };
for (const A of ACTS) {
  const a = lm.acts[A.useAct || A.act]; if (!a) continue;
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const gOff = record(frames, { ...A.p, expectedAmplitude: 1e-6 });
  const gOn = record(frames, A.p);
  out.acts[A.act] = { cn: A.cn, signal: A.key, profile: A.p, repsGateOn: gOn.reps, repsGateOff: gOff.reps, secs: +(frames.length / SRC).toFixed(3), series: gOff.series };
  console.log(`${A.cn} 6s级: 门限关=${gOff.reps} 门限开=${gOn.reps} 序列长=${gOff.series.length}`);
}
fs.writeFileSync(path.join(__dirname, "_tmp", "_realseries.json"), JSON.stringify(out));
console.log("\n已写入 build/_tmp/_realseries.json");
