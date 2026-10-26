/* ==================================================================
 * _exp-realvideo-offline.js — 把真实演示视频帧逐帧喂进**真实 motion-engine.js**
 * （纯 Node，不开浏览器，不占 Chrome），读新门限下的实际计数。
 *
 * 数据：build/_tmp/<act>.gray（由 build/_dump-gray.py 从 build/_frames2 生成）
 *
 * 关键：引擎采样到 96×72，闸门比的是 signalWindow(key, 3.5) 的峰峰值，
 *       gate = expectedAmplitude × 0.5 × clamp(repHeightBase/0.6, 1.0, 1.5)。
 *       profile 一律取 data/fitness-plan.js 的真值。
 *
 * 输出：每个 action 的 reps / 末帧 repGate / repSpread / 被挡帧数 / 3.5s窗峰峰中位。
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;

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
// Node 22 的 globalThis.navigator 是只读 getter，直接赋值会抛错 → 用 defineProperty 兜底
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

// 真实动作 profile（data/fitness-plan.js 真值）
const PROF = {
  jumpingJacks: { cn: "开合跳",   p: { mode: "rep", signal: "width",  tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 } },
  squat:        { cn: "徒手深蹲", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9,  expectedAmplitude: 0.12 } },
  jumpRope:     { cn: "跳绳",     p: { mode: "rep", signal: "width",  tempoBand: [20, 55], minRepGap: 0.7,  expectedAmplitude: 0.045 } },
  highKnees:    { cn: "原地高抬腿跑", p: { mode: "rep", signal: "width", tempoBand: [60, 130], minRepGap: 0.45, expectedAmplitude: 0.20 } },
  burpee:       { cn: "波比跳",   p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4,  expectedAmplitude: 0.16 } }
};

const dims = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_dims.json"), "utf8"));

function loadFrames(act) {
  const d = dims[act];
  const buf = fs.readFileSync(path.join(__dirname, "_tmp", act + ".gray"));
  const SW = d.w, SH = d.h, fsz = SW * SH;
  const n = Math.floor(buf.length / fsz);
  const frames = [];
  const sx = SW / W, sy = SH / H;
  for (let i = 0; i < n; i++) {
    const base = i * fsz;
    const out = new Float32Array(PIX);
    for (let oy = 0; oy < H; oy++) {
      const y0 = oy * sy, y1 = (oy + 1) * sy;
      for (let ox = 0; ox < W; ox++) {
        const x0 = ox * sx, x1 = (ox + 1) * sx;
        let s = 0, w = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue;
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue;
            s += buf[base + yy * SW + xx] * wx * wy; w += wx * wy;
          }
        }
        out[oy * W + ox] = w ? s / w : 0;
      }
    }
    frames.push(out);
  }
  return frames;
}

function med(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; }
function winSpreadMed(vals, wf) {
  const out = [];
  for (let i = wf - 1; i < vals.length; i++) {
    const seg = vals.slice(i - wf + 1, i + 1).filter(Number.isFinite);
    if (seg.length >= 5) out.push(Math.max(...seg) - Math.min(...seg));
  }
  return med(out);
}

/* 跑引擎：先 preview 预热背景，再 start 计数。
 * loopSecs>0 时把这段视频循环播放到该时长（真机孩子是持续做的，
 * 短视频只播一遍样本太短、3.5s 窗都填不满，会低估计数）。 */
function runEngine(frames, profile, fps, previewFrames, targetSecs) {
  const sig = profile.signal;
  const totalOnce = frames.length;
  const needFrames = Math.max(totalOnce, Math.round((targetSecs || 0) * fps));
  const total = previewFrames + needFrames;

  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(fakeCanvas(VW, VH));
  eng.setProfile(profile);

  const rec = { w: [], h: [], cy: [], gate: [], spread: [], repsAtEnd: 0, gatedFrames: 0, gateFrames: 0 };
  let i = 0, frameIdx = 0;
  const step = (n, counting) => {
    for (let k = 0; k < n; k++, i++) {
      globalThis.__frame = frames[frameIdx % totalOnce];
      frameIdx++;
      globalThis.__clock = i * (1000 / fps);
      if (globalThis.__rafCb) globalThis.__rafCb();
      if (counting) {
        const st = eng.getState();
        rec.w.push(st.live.width); rec.h.push(st.live.height); rec.cy.push(st.live.centroidY);
        rec.gate.push(st.repGate); rec.spread.push(st.repSpread);
        if (st.repGate > 0) { rec.gateFrames++; if (st.repSpread < st.repGate) rec.gatedFrames++; }
        rec.repsAtEnd = st.reps;
      }
    }
  };
  eng.preview(); step(previewFrames, false);
  eng.start();
  step(needFrames, true);
  eng.stop();

  const vals = sig === "width" ? rec.w : (sig === "height" ? rec.h : rec.cy);
  const wf = Math.round(fps * 3.5);
  const fin = vals.filter(Number.isFinite);
  return {
    reps: rec.repsAtEnd, signal: sig,
    signalRange: fin.length ? +(Math.max(...fin) - Math.min(...fin)).toFixed(4) : null,
    signalMean: fin.length ? +(fin.reduce((a, b) => a + b, 0) / fin.length).toFixed(4) : null,
    winSpreadMed: winSpreadMed(vals, wf),
    gate: rec.gate[rec.gate.length - 1],
    heightMean: rec.h.filter(Number.isFinite).length ? +(rec.h.filter(Number.isFinite).reduce((a, b) => a + b, 0) / rec.h.filter(Number.isFinite).length).toFixed(4) : null,
    gatedFrames: rec.gatedFrames, gateFrames: rec.gateFrames,
    secs: +(needFrames / fps).toFixed(1)
  };
}

const FPS = 24;
const p2 = n => String(n).padEnd(6);
console.log("=== 真实演示视频帧 → 真实 motion-engine.js（掩码链路，纯 Node）===\n");
console.log("动作".padEnd(14) + "信号".padEnd(9) + "ea".padEnd(7) + "时长".padEnd(7) + "reps".padEnd(7) +
  "3.5s窗峰峰(中位)".padEnd(17) + "末门限".padEnd(9) + "被挡帧".padEnd(12) + "判定");
console.log("-".repeat(110));
const results = {};
for (const act of Object.keys(PROF)) {
  if (!dims[act]) { console.log("跳过", act); continue; }
  const frames = loadFrames(act);
  // 循环到 20 秒（≈480 帧），既有足够 3.5s 窗，也模拟持续跟练
  const r = runEngine(frames, PROF[act].p, FPS, Math.round(1.0 * FPS), 20);
  results[act] = { cn: PROF[act].cn, ...r };
  const verdict = r.gatedFrames === 0 ? "全程未挡" : (r.reps > 0 ? "部分被挡但有计数" : "★ 全程被挡（0 次）");
  console.log(PROF[act].cn.padEnd(14) + p2(r.signal) + p2(PROF[act].p.expectedAmplitude) + p2(r.secs + "s") + p2(r.reps) +
    p2(String(r.winSpreadMed)) + p2(String(r.gate)) + p2(r.gatedFrames + "/" + r.gateFrames) + verdict);
}
fs.writeFileSync(path.join(__dirname, "_exp-realvideo-offline.json"), JSON.stringify(results, null, 2));
console.log("\n结果已写入 build/_exp-realvideo-offline.json");
