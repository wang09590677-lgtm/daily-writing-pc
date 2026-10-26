// 关键对照：同一个真实 motion-engine.js，同一份 Y4M 夹具内容（25fps 视频），
// 但**引擎采样率不同**（浏览器 rAF≈60fps 去采 25fps 视频 → 每帧视频被重复采 ~2.4 次）。
// 目的：确认「浏览器 60fps 采样」是否就是把 mask-centroidY 峰峰值压到 ~0.014 的根因。
//
// 三种采样率：25 / 30 / 60（视频始终 25fps）。只读生产代码，不开浏览器。
const path = require("path");
const ROOT = path.join(__dirname, "..");
const W = 96, H = 72, PIX = W * H;
const VW = 128, VH = 96;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0;
globalThis.__rafCb = null;
globalThis.__rafId = 1;
function fakeCanvas(w, h) {
  return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
    const src = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
    for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = src[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
    return { data: d };
  } }) };
}
globalThis.window = {};
globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
globalThis.navigator = { userAgent: "node" };
require(path.join(ROOT, "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

function genY4M(n, fps, hz = 0.6, amp = 12) {
  const out = [], cx = VW >> 1;
  for (let f = 0; f < n; f++) {
    const y = new Float32Array(VW * VH).fill(24);
    const cy = Math.round(VH / 2 + Math.sin((f / fps) * 2 * Math.PI * hz) * amp);
    const paint = (x0, y0, x1, y1) => { for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = 238; };
    for (const p of [[-10, -19, 10, 9], [-18, -16, -12, 3], [12, -16, 18, 3], [-9, 9, -2, 30], [2, 9, 9, 30]])
      paint(cx + p[0], cy + p[1], cx + p[2], cy + p[3]);
    const hy = cy - 27, hr = 6;
    for (let yy = hy - hr; yy <= hy + hr; yy++) { const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy)))); paint(cx - half, yy, cx + half + 1, yy + 1); }
    out.push(y);
  }
  return out;
}
function downscale(src) {
  const out = new Float32Array(PIX), sx = VW / W, sy = VH / H;
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy;
    let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * VW + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}

const SQUAT = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };
const VFPS = 25; // 视频恒 25fps
const VIDEO_SECS = 40;
const videoFrames = genY4M(VIDEO_SECS * VFPS, VFPS).map(downscale);

function run(fpsSample, previewSecs, countSecs) {
  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(fakeCanvas(VW, VH));
  eng.setProfile(SQUAT);
  const totalSamples = Math.round((previewSecs + countSecs) * fpsSample);
  const dtMs = 1000 / fpsSample;
  const step = (n) => {
    for (let k = 0; k < n; k++) {
      const i = eng.__i === undefined ? 0 : 0; // unused
    }
  };
  let si = 0;
  const advance = (n) => {
    for (let k = 0; k < n && si < totalSamples; k++, si++) {
      const tSec = si / fpsSample;
      const vf = Math.min(videoFrames.length - 1, Math.floor(tSec * VFPS));
      globalThis.__frame = videoFrames[vf];
      globalThis.__clock = tSec * 1000;
      if (globalThis.__rafCb) globalThis.__rafCb();
    }
  };
  if (previewSecs > 0) { eng.preview(); advance(Math.round(previewSecs * fpsSample)); }
  eng.start();
  const trace = [];
  for (let s = 0; s < countSecs; s++) { advance(fpsSample); const st = eng.getState(); trace.push({ area: st.live.area, spread: st.repSpread, gate: st.repGate, amp: st.amplitude, reps: st.reps, fps: st.fps }); }
  const st = eng.getState();
  return { reps: st.reps, trace, fps: st.fps };
}

console.log("=== Y4M 夹具(视频25fps) × 引擎采样率（预览5s → 计数15s，signal=centroidY）===\n");
for (const fpsSample of [25, 30, 60]) {
  const r = run(fpsSample, 5, 15);
  const sp = r.trace.map(x => x.spread), am = r.trace.map(x => x.amp);
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[(b.length - 1) >> 1]; };
  console.log("■ 采样 " + fpsSample + "fps（引擎实测 fps=" + r.fps.toFixed(0) + "）");
  console.log("   spread 逐秒: " + sp.map(x => x.toFixed(4)).join(" "));
  console.log("   → spread p50=" + med(sp).toFixed(4) + " 末=" + sp[sp.length - 1].toFixed(4) + "  gate=" + r.trace[r.trace.length - 1].gate.toFixed(4) + "  幅度末=" + (am[am.length - 1] * 100).toFixed(0) + "%  reps=" + r.reps + "\n");
}
