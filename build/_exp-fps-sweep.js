// 扫 (视频帧率 × 引擎采样率)：定位「浏览器 rAF 采样 > 视频帧率 → 帧重复」把
// mask-centroidY 峰峰值压低多少。这决定回归 Y4M 夹具在真实浏览器里 spread 的真值。
// 只读生产代码，不开浏览器。
const path = require("path");
const ROOT = path.join(__dirname, "..");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fakeCanvas(w, h) { return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
  const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
  for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return { data: d };
} }) }; }
globalThis.window = {}; globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {}; globalThis.navigator = { userAgent: "node" };
require(path.join(ROOT, "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

function genY4M(n, videoFps, hz, amp) {
  const out = [], cx = VW >> 1;
  for (let f = 0; f < n; f++) {
    const y = new Float32Array(VW * VH).fill(24);
    const cy = Math.round(VH / 2 + Math.sin((f / videoFps) * 2 * Math.PI * hz) * amp);
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
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * VW + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}
const SQUAT = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };

function run(videoFrames, videoFps, sampleFps, previewSecs, countSecs) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(SQUAT);
  let si = 0; const total = Math.round((previewSecs + countSecs) * sampleFps);
  const adv = (n) => { for (let k = 0; k < n && si < total; k++, si++) { const tSec = si / sampleFps; const vf = Math.min(videoFrames.length - 1, Math.floor(tSec * videoFps)); globalThis.__frame = videoFrames[vf]; globalThis.__clock = tSec * 1000; if (globalThis.__rafCb) globalThis.__rafCb(); } };
  if (previewSecs > 0) { eng.preview(); adv(Math.round(previewSecs * sampleFps)); }
  eng.start();
  const sp = [], am = [];
  for (let s = 0; s < countSecs; s++) { adv(sampleFps); const st = eng.getState(); sp.push(st.repSpread); am.push(st.amplitude); }
  const st = eng.getState();
  return { reps: st.reps, gate: st.repGate, spEnd: sp[sp.length - 1], amEnd: am[am.length - 1], amMax: Math.max(...am), fps: st.fps };
}

const SECS = 40;
console.log("=== Y4M 合成人形(±12px,0.6Hz) × (视频帧率, 引擎采样率) → spread / 幅度 / reps ===");
console.log("   （浏览器实际=视频25fps、rAF采样~60fps；headless 下视频解码常更慢，故并列 15/20/25）\n");
console.log("视频fps 采样fps | 末spread | 末幅度% | 幅度峰值% | gate  | reps | 引擎fps");
for (const videoFps of [15, 20, 25, 30]) {
  const vf = genY4M(Math.round(SECS * videoFps), videoFps, 0.6, 12).map(downscale);
  for (const sampleFps of [60, 90, 120]) {
    const r = run(vf, videoFps, sampleFps, 5, 15);
    const verdict = r.spEnd >= r.gate ? "通过" : "挡掉";
    console.log(`  ${String(videoFps).padStart(3)}     ${String(sampleFps).padStart(3)}   |  ${r.spEnd.toFixed(4)} |   ${(r.amEnd * 100).toFixed(0).padStart(3)}%   |   ${(r.amMax * 100).toFixed(0).padStart(3)}%    | ${r.gate.toFixed(4)} |  ${String(r.reps).padStart(2)}  | ${r.fps.toFixed(0)}  ${verdict}`);
  }
}
