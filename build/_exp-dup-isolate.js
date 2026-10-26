// 决定性对照：同一段运动（0.6Hz、±12px 纵向平移、同一个 drawFig 人形），
// 只变「帧是不是每采样一次就重画」这一个变量，看真实引擎里的 spread 差多少。
//   ① 每采样重画（= 我的 _exp-capture 夹具：rAF 60fps 每次画新帧 → 无重复帧）
//   ② 视频 25fps，引擎采样 60fps（= 回归 Y4M 夹具真实情形：每帧被采 ~2.4 次 → 大量重复帧）
//   ③ 视频 12fps，引擎采样 60fps（重复更严重）
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

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// drawFig 人形（与 _exp-capture.js 相同），dy 由调用者给
function drawFigCanvas(dyPx, rnd) {
  const S = 1, J = 0.4, cx = VW / 2, cy = VH / 2 + dyPx * S;
  const y = new Float32Array(VW * VH).fill(12);
  const box = (x, yy, w, h) => {
    const jx = (rnd() - 0.5) * 2 * J, jy = (rnd() - 0.5) * 2 * J;
    const x0 = Math.round(x + jx), y0 = Math.round(yy + jy), w0 = Math.max(2, Math.round(w * S)), h0 = Math.max(2, Math.round(h * S));
    for (let py = y0; py < y0 + h0; py++) for (let px = x0; px < x0 + w0; px++) if (px >= 0 && px < VW && py >= 0 && py < VH) y[py * VW + px] = 238;
  };
  box(cx - 9 * S, cy + 9 * S, 7, 30); box(cx + 2 * S, cy + 9 * S, 7, 30);
  box(cx - 10 * S, cy - 19 * S, 20, 28);
  box(cx - 18 * S, cy - 16 * S, 6, 19); box(cx + 12 * S, cy - 16 * S, 6, 19);
  const hy = cy - 27 * S, hr = 6;
  for (let yy = hy - hr; yy <= hy + hr; yy++) { const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy)))); for (let px = cx - half; px <= cx + half; px++) if (px >= 0 && px < VW && yy >= 0 && yy < VH) y[yy * VW + px] = 238; }
  return y;
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
const SAMPLE = 60, SECS = 20, PREVIEW = 5;

// 预生成"视频帧序列"（给定视频帧率）；①②③ 共用同一 drawFig 人形
function makeVideo(videoFps, seed) {
  const rnd = lcg(seed), n = SECS * videoFps, out = [];
  for (let f = 0; f < n; f++) {
    const t = f / videoFps;
    out.push(downscale(drawFigCanvas(Math.sin(t * 2 * Math.PI * 0.6) * 12, rnd)));
  }
  return out;
}
const freshRnd = lcg(20260926);
function run(feedFrameAtSec, label) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(SQUAT);
  let si = 0; const total = SECS * SAMPLE;
  const adv = (n) => { for (let k = 0; k < n && si < total; k++, si++) { const tSec = si / SAMPLE; globalThis.__frame = feedFrameAtSec(tSec); globalThis.__clock = tSec * 1000; if (globalThis.__rafCb) globalThis.__rafCb(); } };
  eng.preview(); adv(PREVIEW * SAMPLE);
  eng.start();
  const sp = [];
  for (let s = 0; s < SECS - PREVIEW; s++) { adv(SAMPLE); sp.push(eng.getState().repSpread); }
  const st = eng.getState();
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[(b.length - 1) >> 1]; };
  console.log(`${label.padEnd(46)} spread p50=${med(sp).toFixed(4)} 末=${sp[sp.length - 1].toFixed(4)} gate=${st.repGate.toFixed(4)} 幅度末=${(st.amplitude * 100).toFixed(0)}% reps=${st.reps}  末状态=${sp[sp.length - 1] >= st.repGate ? "通过" : "挡掉"}`);
  return med(sp);
}

console.log("=== 同一 drawFig 人形、同一 0.6Hz ±12px 运动；只变「帧是否每采样重画」===");
console.log("   引擎采样恒 60fps\n");
run(() => drawFigCanvas(Math.sin(performance.now() / 1000 * 2 * Math.PI * 0.6) * 12, freshRnd), "① 每采样重画（我的夹具，无重复帧）");
const v25 = makeVideo(25, 20260926);
run(t => v25[Math.min(v25.length - 1, Math.floor(t * 25))], "② 视频25fps → 60fps 采样（重复 ~2.4×）");
const v12 = makeVideo(12, 20260926);
run(t => v12[Math.min(v12.length - 1, Math.floor(t * 12))], "③ 视频12fps → 60fps 采样（重复 5×）");

console.log("\n=== 回归日志直接反推（真实浏览器，无需我复算）===");
console.log("  半蹲热身 幅度读数 14~15%（该动作 expectedAmplitude=0.06）");
for (const p of [0.14, 0.15]) console.log(`    ${(p * 100).toFixed(0)}% → range = ${(p * 1.6).toFixed(2)}×0.06 = ${(p * 1.6 * 0.06).toFixed(4)}`);
console.log("  ⇒ 真实浏览器链路下该夹具 spread ≈ 0.014~0.024，gate ≈ 0.033~0.075（bodyScale 1.1~1.5）⇒ 全程挡掉 ⇒ 0 次");
