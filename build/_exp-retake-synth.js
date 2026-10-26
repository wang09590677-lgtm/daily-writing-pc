/* ==================================================================
 * _exp-retake-synth.js — 「真人取景规格」合成重演，找门限的挡/过边界
 *
 * 为什么需要它
 *   真实演示视频是宣传素材：相机在动、背景在动、人物大比例裁切。
 *   在这种画面上引擎的**掩码链路会饱和**（live.height 均值 = 1.0），
 *   得不到"门限到底挡不挡"的干净结论（见 _exp-realvideo-offline.js）。
 *   所以另做一段**参数可控、背景干净、取景符合真机**的合成重演。
 *
 * 取景规格（照真机的要求）
 *   · 人占画面高约 65%（孩子站 2~3 米、站位校准后的推荐中值）
 *   · 人体上下都留边距（**不裁切**）
 *   · 双脚在画面 85% 高度处，头部在 ~20% 处
 *   · 人体比例：头/躯干/双臂/分腿，手臂能举过头顶，符合开合跳/跳绳
 *
 * 扫的变量
 *   f = 动作幅度系数（相对"做满幅度"）：0.3 / 0.5 / 0.7 / 0.85 / 1.0
 *   动作：开合跳（width 信号）、跳绳（height 信号）
 *   每个 f 都跑**真实 motion-engine.js**，读新门限下的实际 reps / repGate / repSpread / 被挡帧。
 *
 * 只读产品文件。运行：node build/_exp-retake-synth.js
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const SW = 192, SH = 144;         // 超采样画布（2×）
const W = 96, H = 72, PIX = W * H;
const SUBSAMPLE = 2;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fakeCanvas(w, h) {
  return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
    const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
    for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
    return { data: d };
  } }) };
}
globalThis.window = {}; globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* ---------------- 人体光栅化（超采样画布上）---------------- */
function seg(buf, x0, y0, x1, y1, th, val) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const steps = Math.max(2, Math.ceil(len * 2)), hth = th / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, px = x0 + dx * t, py = y0 + dy * t;
    for (let yy = Math.floor(py - hth); yy <= Math.ceil(py + hth); yy++)
      for (let xx = Math.floor(px - hth); xx <= Math.ceil(px + hth); xx++) {
        if (xx < 0 || xx >= SW || yy < 0 || yy >= SH) continue;
        if ((xx - px) * (xx - px) + (yy - py) * (yy - py) <= hth * hth) buf[yy * SW + xx] = val;
      }
  }
}
function circle(buf, cx, cy, r, val) {
  for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++)
    for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
      if (xx < 0 || xx >= SW || yy < 0 || yy >= SH) continue;
      if ((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy) <= r * r) buf[yy * SW + xx] = val;
    }
}
/* opt: { bodyFrac, feetFrac, phi, spreadFrac, compress } */
function drawPerson(buf, opt) {
  const Bh = opt.bodyFrac * SH;
  const cx = SW / 2;
  const feetY = opt.feetFrac * SH;
  const s = 1 - (opt.compress || 0);            // 纵向压缩（跳绳的蹲伸）
  const Y = (y) => feetY - (feetY - y) * s;     // 向脚底压缩
  const headTop = Y(feetY - Bh);
  const headR = 0.075 * Bh * s;
  const shoulderY = Y(headTop + 2 * headR + 0.02 * Bh);
  const hipY = Y(headTop + 0.46 * Bh);
  const shXoff = 0.11 * Bh, hipXoff = 0.05 * Bh;
  const armL = 0.36 * Bh * s, spread = (opt.spreadFrac || 0) * Bh;
  const phi = opt.phi || 0;
  // 躯干
  seg(buf, cx, shoulderY, cx, hipY, 0.22 * Bh, 220);
  // 头
  circle(buf, cx, headTop + headR, headR, 228);
  // 双臂：phi=0 垂下，phi=π/2 侧平举，phi=π 举过头顶
  for (const side of [-1, 1]) {
    const shX = cx + side * shXoff;
    const handX = shX + side * armL * Math.sin(phi);
    const handY = shoulderY + armL * Math.cos(phi);
    seg(buf, shX, shoulderY, handX, handY, 0.07 * Bh, 210);
  }
  // 双腿：并拢 → 分开
  for (const side of [-1, 1]) {
    const hipX = cx + side * hipXoff;
    const footX = cx + side * (hipXoff + spread);
    seg(buf, hipX, hipY, footX, feetY, 0.08 * Bh, 210);
  }
}
function downscale(src) {
  const out = new Float32Array(PIX);
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    let acc = 0;
    for (let dy = 0; dy < SUBSAMPLE; dy++) for (let dx = 0; dx < SUBSAMPLE; dx++)
      acc += src[(oy * SUBSAMPLE + dy) * SW + (ox * SUBSAMPLE + dx)];
    out[oy * W + ox] = acc / (SUBSAMPLE * SUBSAMPLE);
  }
  return out;
}

/* ---------------- 帧序列生成 ---------------- */
const BODY_FRAC = 0.65;   // 人占画面高 65%（真机推荐中值）
const FEET_FRAC = 0.85;   // 双脚在 85% 高度
const BG = 20, FG = 225;

function genOpenjump(f, freq, n, fps, jitter) {
  // 开合跳：开合度 p 从 0→1，手臂由垂下扫到过顶，双腿分开
  const frames = [], buf = new Float32Array(SW * SH);
  let seed = 99173 + Math.round(f * 1e4);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    buf.fill(BG);
    const t = i / fps;
    const p = 0.5 - 0.5 * Math.cos(2 * Math.PI * freq * t);      // 0..1
    const jx = (rnd() - 0.5) * 2 * (jitter || 0), jy = (rnd() - 0.5) * 2 * (jitter || 0);
    drawPerson(buf, { bodyFrac: BODY_FRAC, feetFrac: FEET_FRAC,
      phi: f * Math.PI * p, spreadFrac: f * 0.11 * p, compress: 0.05 * p,
      _jx: jx, _jy: jy });
    frames.push(downscale(buf));
  }
  return frames;
}
function genJumpRope(f, freq, n, fps, jitter) {
  // 跳绳：全身纵向压缩-伸展（蹲伸），height 信号；身体小幅弹动
  const frames = [], buf = new Float32Array(SW * SH);
  let seed = 77113 + Math.round(f * 1e4);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    buf.fill(BG);
    const t = i / fps;
    const p = 0.5 - 0.5 * Math.cos(2 * Math.PI * freq * t);
    drawPerson(buf, { bodyFrac: BODY_FRAC, feetFrac: FEET_FRAC,
      phi: 0.1, spreadFrac: 0.02, compress: f * 0.16 * p });
    frames.push(downscale(buf));
  }
  return frames;
}

/* ---------------- 跑引擎 ---------------- */
function med(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; }
function winSpreadMed(vals, wf) {
  const out = [];
  for (let i = wf - 1; i < vals.length; i++) {
    const seg = vals.slice(i - wf + 1, i + 1).filter(Number.isFinite);
    if (seg.length >= 5) out.push(Math.max(...seg) - Math.min(...seg));
  }
  return med(out);
}
function runEngine(frames, profile, fps, previewFrames) {
  const sig = profile.signal;
  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(fakeCanvas(SW, SH));
  eng.setProfile(profile);
  const rec = { sig: [], gate: [], spread: [], h: [] };
  let i = 0;
  const step = (n, counting) => {
    for (let k = 0; k < n && i < frames.length; k++, i++) {
      globalThis.__frame = frames[i];
      globalThis.__clock = i * (1000 / fps);
      if (globalThis.__rafCb) globalThis.__rafCb();
      if (counting) {
        const st = eng.getState();
        rec.sig.push(st.live[sig]); rec.h.push(st.live.height);
        rec.gate.push(st.repGate); rec.spread.push(st.repSpread);
      }
    }
  };
  eng.preview(); step(Math.round(previewFrames), false);
  eng.start();
  step(frames.length - i, true);
  eng.stop();
  const st = eng.getState();
  const vals = rec.sig.filter(Number.isFinite);
  const hs = rec.h.filter(Number.isFinite);
  const wf = Math.round(fps * 3.5);   // ★ 闸门真实用的是 3.5s 窗
  const gs = rec.gate.filter(g => g > 0);
  let gated = 0;
  for (let k = 0; k < rec.gate.length; k++) if (rec.gate[k] > 0 && rec.spread[k] < rec.gate[k]) gated++;
  return {
    reps: st.reps, signal: sig,
    sigMean: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null,
    sigRange: vals.length ? +(Math.max(...vals) - Math.min(...vals)).toFixed(4) : null,
    winMed: winSpreadMed(rec.sig, wf),
    heightMean: hs.length ? +(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(4) : null,
    heightRange: hs.length ? +(Math.max(...hs) - Math.min(...hs)).toFixed(4) : null,
    gateEnd: st.repGate, gateMean: gs.length ? +(gs.reduce((a, b) => a + b, 0) / gs.length).toFixed(4) : null,
    gatedFrames: gated, gateFrames: gs.length
  };
}

/* ---------------- 场景 ---------------- */
const FPS = 24, DUR = 20, PREVIEW = Math.round(1.0 * FPS);
const N = Math.round(DUR * FPS);
const JJ = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 };
const JR = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 };
const FS = [0.3, 0.5, 0.7, 0.85, 1.0];

const out = { openjump: [], jumpRope: [] };
const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };

console.log("=== 合成真机取景（人占画面高 65%，不裁切）→ 真实 motion-engine.js ===\n");
console.log("【开合跳 · width · expectedAmplitude=0.18 · 0.8Hz × 20s（满幅期望≈16 次）】");
console.log(pad("幅度系数f", 11) + pad("人高均值", 10) + pad("width 3.5s窗峰峰", 18) + pad("末门限", 9) + pad("reps", 7) + pad("被挡帧", 12) + "判定");
console.log("-".repeat(96));
for (const f of FS) {
  const fr = genOpenjump(f, 0.8, N, FPS, 0.25);
  const r = runEngine(fr, JJ, FPS, PREVIEW);
  out.openjump.push({ f, ...r });
  const v = r.gatedFrames === 0 ? "全程未挡" : (r.reps > 0 ? "部分被挡但有计数" : "★ 全程被挡 0 次");
  console.log(pad(f, 11) + pad(r.heightMean, 10) + pad(String(r.winMed), 18) + pad(String(r.gateEnd), 9) + pad(r.reps, 7) + pad(r.gatedFrames + "/" + r.gateFrames, 12) + v);
}

console.log("\n【跳绳 · height · expectedAmplitude=0.05 · 1.5Hz × 20s（满幅期望≈30 次）】");
console.log(pad("幅度系数f", 11) + pad("人高均值", 10) + pad("height 3.5s窗峰峰", 19) + pad("末门限", 9) + pad("reps", 7) + pad("被挡帧", 12) + "判定");
console.log("-".repeat(96));
for (const f of FS) {
  const fr = genJumpRope(f, 1.5, N, FPS, 0.25);
  const r = runEngine(fr, JR, FPS, PREVIEW);
  out.jumpRope.push({ f, ...r });
  const v = r.gatedFrames === 0 ? "全程未挡" : (r.reps > 0 ? "部分被挡但有计数" : "★ 全程被挡 0 次");
  console.log(pad(f, 11) + pad(r.heightMean, 10) + pad(String(r.winMed), 19) + pad(String(r.gateEnd), 9) + pad(r.reps, 7) + pad(r.gatedFrames + "/" + r.gateFrames, 12) + v);
}

fs.writeFileSync(path.join(__dirname, "_exp-retake-synth.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-retake-synth.json");
