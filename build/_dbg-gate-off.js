/* 决定性对照：2× 计数到底是不是"门限"造成的？
 *
 * 做法（不改任何生产文件，只改**传入的 profile 对象**）：
 *   A) 真值 profile（跳绳 ea=0.05）→ 门限 ≈0.026，正常生效。
 *   B) 把 ea 设成 0.0001 → 门限 ≈0.00005，**等于把门限关掉**。
 *   若 A 与 B 的 reps 基本相同 → 说明计数水平与门限无关（2× 是既有的
 *   迟滞过零在"信号周期 ≈ detrend 窗口"时的固有行为），门限不背锅。
 *   C) 把 ea 设成 0.5 → 门限 ≈0.27，远大于信号 → 全挡。用于确认门限确实在起作用。
 */
"use strict";
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
try { globalThis.navigator = { userAgent: "node" }; } catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

const BH = .65, FY = .88, FREQ = 1.5, ENG = 60, SRC = 24, RATIO = ENG / SRC;
function mk(c) {
  const Y = y => FY - (FY - y) * (1 - c);
  const ht = Y(FY - BH), hr = .055 * BH, sy = Y(ht + .2 * BH), hy = Y(ht + .52 * BH), ky = Y(ht + .75 * BH), ay = Y(FY);
  const so = .085 * BH, ho = .045 * BH, lm = new Array(33);
  for (let i = 0; i < 33; i++) lm[i] = { x: .5, y: .5, visibility: .95 };
  lm[0] = { x: .5, y: ht + hr, visibility: .95 }; lm[7] = { x: .5 - .028, y: ht + hr, visibility: .95 }; lm[8] = { x: .5 + .028, y: ht + hr, visibility: .95 };
  lm[11] = { x: .5 - so, y: sy, visibility: .95 }; lm[12] = { x: .5 + so, y: sy, visibility: .95 };
  lm[13] = { x: .5 - so, y: sy + .18 * BH, visibility: .95 }; lm[14] = { x: .5 + so, y: sy + .18 * BH, visibility: .95 };
  lm[15] = { x: .5 - so, y: sy + .36 * BH, visibility: .95 }; lm[16] = { x: .5 + so, y: sy + .36 * BH, visibility: .95 };
  lm[23] = { x: .5 - ho, y: hy, visibility: .95 }; lm[24] = { x: .5 + ho, y: hy, visibility: .95 };
  lm[25] = { x: .5 - ho, y: ky, visibility: .95 }; lm[26] = { x: .5 + ho, y: ky, visibility: .95 };
  lm[27] = { x: .5 - ho, y: ay, visibility: .95 }; lm[28] = { x: .5 + ho, y: ay, visibility: .95 };
  return lm.map(p => ({ x: p.x, y: p.y, visibility: .95 }));
}
function gen(f, n, fps) { const o = []; for (let i = 0; i < n; i++) { const t = i / fps, p = .5 - .5 * Math.cos(2 * Math.PI * FREQ * t); o.push(mk(f * .09 * p)); } return o; }
function run(frames, profile) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  eng.preview(); let prev = -1;
  const total = ENG + Math.round(20 * ENG);
  let gated = 0, gateFrames = 0;
  for (let i = 0; i < total; i++) {
    if (i === ENG) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prev) { prev = slot; pv.pushLandmarks(frames[slot % frames.length]); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= ENG) { const st = eng.getState(); if (st.repGate > 0) { gateFrames++; if (st.repSpread < st.repGate) gated++; } }
  }
  eng.stop();
  const st = eng.getState();
  return { reps: st.reps, gateEnd: +st.repGate.toFixed(5), gated, gateFrames };
}
const fr = gen(1.0, Math.round(20 * SRC), SRC);
const base = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3 };
console.log("跳绳档案 f=1.0（1.5Hz×20s ⇒ 物理周期 30）\n");
console.log("ea       门限(末)   被挡帧         reps   说明");
console.log("-------------------------------------------------------------");
for (const [ea, note] of [[0.05, "真值（门限正常生效）"], [0.0001, "门限≈关闭"], [0.5, "门限过大（应全挡）"]]) {
  const r = run(fr, { ...base, expectedAmplitude: ea });
  console.log(String(ea).padEnd(9) + String(r.gateEnd).padEnd(11) + String(r.gated + "/" + r.gateFrames).padEnd(14) + String(r.reps).padEnd(7) + note);
}
console.log("\n结论看点：若「门限≈关闭」与「真值」的 reps 相同 → 2× 与门限无关。");
