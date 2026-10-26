// 夹具对照：在**同一个真实 motion-engine.js**（node 里跑，无浏览器）上，逐帧喂三种夹具，
// 打印 centroidY / area 的逐秒演化与峰峰值，定位「我的 _exp-series（真实浏览器采集，用我的
// canvas 夹具）spread≈0.11」与「回归 Y4M 夹具 spread≈0.015」差 6 倍的根因。
//
// 三种夹具：
//   Y4M     —— motion-browser-test.js 的 buildY4M（无抖动、确定性、0.6Hz ±12px）
//   CANVAS  —— 我的 _exp-capture.js drawFig（带 ±0.4px 抖动）
//   CANVAS0 —— 我的 drawFig 但抖动=0（隔离"抖动"这一个变量）
//
// 只读生产代码；不开浏览器。
const path = require("path");
const ROOT = path.join(__dirname, "..");
const W = 96, H = 72, PIX = W * H;
const VW = 128, VH = 96;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0;
globalThis.__rafCb = null;
globalThis.__rafId = 1;

function fakeCanvas(w, h) {
  return {
    width: w, height: h,
    getContext: () => ({
      drawImage() {},
      getImageData: () => {
        const src = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
        for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = src[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
        return { data: d };
      }
    })
  };
}
globalThis.window = {};
globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
globalThis.navigator = { userAgent: "node" };
require(path.join(ROOT, "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

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

function genCanvas(n, fps, jitter, hz = 0.6, amp = 12) {
  const rnd = lcg(20260926), out = [], cx = VW / 2;
  for (let f = 0; f < n; f++) {
    const dyPx = Math.sin((f / fps) * 2 * Math.PI * hz) * amp;
    const S = 1, J = jitter;
    const y = new Float32Array(VW * VH).fill(12);
    const cy = VH / 2 + dyPx * S;
    const box = (x, yy, w, h) => {
      const jx = (rnd() - 0.5) * 2 * J, jy = (rnd() - 0.5) * 2 * J;
      const x0 = Math.round(x + jx), y0 = Math.round(yy + jy), w0 = Math.max(2, Math.round(w * S)), h0 = Math.max(2, Math.round(h * S));
      for (let py = y0; py < y0 + h0; py++) for (let px = x0; px < x0 + w0; px++) if (px >= 0 && px < VW && py >= 0 && py < VH) y[py * VW + px] = 238;
    };
    box(cx - 9 * S, cy + 9 * S, 7, 30); box(cx + 2 * S, cy + 9 * S, 7, 30);
    box(cx - 10 * S, cy - 19 * S, 20, 28);
    box(cx - 18 * S, cy - 16 * S, 6, 19); box(cx + 12 * S, cy - 16 * S, 6, 19);
    const hy = cy - 27 * S, hr = Math.round(6 * S);
    for (let yy = hy - hr; yy <= hy + hr; yy++) { const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy)))); for (let px = cx - half; px <= cx + half; px++) if (px >= 0 && px < VW && yy >= 0 && yy < VH) y[yy * VW + px] = 238; }
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

// 采样 96×72 归一化 centroidY 的真实峰峰值（独立于引擎，用掩码质心近似：取亮于阈值的像素质心）
function maskCentroid(frames96) {
  const out = [];
  for (const f of frames96) {
    let s = 0, n = 0;
    for (let i = 0; i < PIX; i++) if (f[i] > 120) { s += Math.floor(i / W); n++; }
    out.push(n ? (s / n) / H : 0.5);
  }
  return out;
}

function run(frames96, profile, fps, previewSecs, countSecs, label) {
  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(fakeCanvas(VW, VH));
  eng.setProfile(profile);
  const dtMs = 1000 / fps, total = frames96.length;
  let i = 0;
  const step = (n) => { for (let k = 0; k < n && i < total; k++, i++) { globalThis.__frame = frames96[i]; globalThis.__clock = i * dtMs; if (globalThis.__rafCb) globalThis.__rafCb(); } };
  if (previewSecs > 0) { eng.preview(); step(Math.round(previewSecs * fps)); }
  eng.start();
  const trace = [];
  const cnt = Math.round(countSecs * fps);
  for (let s = 0; s < countSecs; s++) {
    step(fps);
    const st = eng.getState();
    trace.push({ t: s + 1, area: st.live.area, cy: st.live.centroidY, spread: st.repSpread, gate: st.repGate, amp: st.amplitude, reps: st.reps });
  }
  const st = eng.getState();
  return { reps: st.reps, trace };
}

const FPS = 25, PREVIEW = 5, COUNT = 15, N = (PREVIEW + COUNT) * FPS;
const variants = [
  ["Y4M   (回归夹具, 无抖动)", downscaleAll(genY4M(N, FPS))],
  ["CANVAS(我的夹具, 抖动0.4)", downscaleAll(genCanvas(N, FPS, 0.4))],
  ["CANVAS(我的夹具, 抖动 0 )", downscaleAll(genCanvas(N, FPS, 0))]
];
function downscaleAll(arr) { return arr.map(downscale); }

console.log("=== 三夹具对照（真实引擎，node 离线；预览 5s → 计数 15s，signal=centroidY）===\n");
for (const [label, frames] of variants) {
  const mc = maskCentroid(frames);
  const ss = mc.slice(Math.round(5 * FPS));
  const mcRange = Math.max(...ss) - Math.min(...ss);
  const r = run(frames, SQUAT, FPS, PREVIEW, COUNT, label);
  console.log("■ " + label);
  console.log("   独立参照(亮像素质心 range, 稳态) = " + mcRange.toFixed(4));
  console.log("   逐秒: " + r.trace.map(x => `${x.t}s:cy=${x.cy.toFixed(3)}/ar=${x.area.toFixed(3)}/sp=${x.spread.toFixed(4)}/g=${x.gate.toFixed(3)}/reps=${x.reps}`).join("\n        "));
  console.log("   → 末态 reps=" + r.reps + "  spread=" + r.trace[r.trace.length - 1].spread.toFixed(4) + "  gate=" + r.trace[r.trace.length - 1].gate.toFixed(4) + "  幅度=" + (r.trace[r.trace.length - 1].amp * 100).toFixed(0) + "%\n");
}
