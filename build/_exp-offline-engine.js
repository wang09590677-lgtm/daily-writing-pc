// 离线跑**真实 motion-engine.js**：给一个假的 canvas 源，逐帧喂灰度图，拿到真实的
// live.centroidY / reps / repGate / repSpread。不开浏览器，不占 Chrome。
//
// 目的：把「真实浏览器链路」下的 centroidY 峰峰值测出来，分辨两种夹具：
//   ① Y4M 夹具（buildY4M，motion-browser-test.js 用的那个）—— 回归测试的来源
//   ② 我的 canvas 夹具（_exp-capture.js 的 drawFig）—— _exp-series.json 的来源
// 并且复现「预览预热 → 开始计数」的真实 App 流程（回归测试就是这么跑的）。
const path = require("path");
const ROOT = path.join(__dirname, "..");
const W = 96, H = 72, PIX = W * H;
const VW = 128, VH = 96;

/* ---------------- 全局 shim ---------------- */
globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0;
globalThis.__rafCb = null;
globalThis.__rafId = 1;

function makeFakeCanvas(w, h) {
  return {
    width: w, height: h,
    getContext() {
      return {
        drawImage() { /* no-op：真正的像素由 getImageData 提供 */ },
        getImageData() {
          const src = globalThis.__frame;
          const data = new Uint8ClampedArray(PIX * 4);
          for (let i = 0, p = 0; i < PIX; i++, p += 4) {
            const v = src[i] | 0;
            data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
          }
          return { data };
        }
      };
    }
  };
}

globalThis.window = {};
globalThis.document = { createElement: (tag) => makeFakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
globalThis.navigator = { userAgent: "node" };

require(path.join(ROOT, "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* ---------------- 帧生成（都先造 128×96，再降采样到 96×72，模拟引擎采样）---------------- */
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ① Y4M 夹具：完全照搬 motion-browser-test.js 的 buildY4M（无抖动、B=238、bg=24、±12px）
function genY4MFrames(n, fps) {
  const out = [];
  const cx = Math.round(VW / 2);
  for (let f = 0; f < n; f++) {
    const y = new Float32Array(VW * VH).fill(24);
    const cy = Math.round(VH / 2 + Math.sin((f / fps) * 2 * Math.PI * 0.6) * 12);
    const paint = (x0, y0, x1, y1) => {
      for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++)
        for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = 238;
    };
    for (const p of [[-10, -19, 10, 9], [-18, -16, -12, 3], [12, -16, 18, 3], [-9, 9, -2, 30], [2, 9, 9, 30]])
      paint(cx + p[0], cy + p[1], cx + p[2], cy + p[3]);
    const hy = cy - 27, hr = 6;
    for (let yy = hy - hr; yy <= hy + hr; yy++) {
      const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy))));
      paint(cx - half, yy, cx + half + 1, yy + 1);
    }
    out.push(y);
  }
  return out;
}

// ② 我的 canvas 夹具：照搬 _exp-capture.js 的 drawFig（含 LCG 抖动），深蹲 = draw(sin*12,0,0,0.4,1)
function genCanvasFrames(n, fps, seed = 20260926) {
  const rnd = lcg(seed);
  const out = [];
  const cx = VW / 2;
  for (let f = 0; f < n; f++) {
    const t = f / fps;
    const dyPx = Math.sin(t * 2 * Math.PI * 0.6) * 12;
    const S = 1, J = 0.4;
    const y = new Float32Array(VW * VH).fill(12);
    const cy = VH / 2 + dyPx * S;
    const box = (x, yy, w, h) => {
      const jx = (rnd() - 0.5) * 2 * J, jy = (rnd() - 0.5) * 2 * J;
      const x0 = Math.round(x + jx), y0 = Math.round(yy + jy);
      const w0 = Math.max(2, Math.round(w * S)), h0 = Math.max(2, Math.round(h * S));
      for (let py = y0; py < y0 + h0; py++) for (let px = x0; px < x0 + w0; px++)
        if (px >= 0 && px < VW && py >= 0 && py < VH) y[py * VW + px] = 238;
    };
    box(cx - 9 * S, cy + 9 * S, 7, 30);
    box(cx + 2 * S, cy + 9 * S, 7, 30);
    box(cx - 10 * S, cy - 19 * S, 20, 28);
    box(cx - 18 * S, cy - 16 * S, 6, 19);
    box(cx + 12 * S, cy - 16 * S, 6, 19);
    const hy = cy - 27 * S, hr = Math.round(6 * S);
    for (let yy = hy - hr; yy <= hy + hr; yy++) {
      const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy))));
      for (let px = cx - half; px <= cx + half; px++)
        if (px >= 0 && px < VW && yy >= 0 && yy < VH) y[yy * VW + px] = 238;
    }
    out.push(y);
  }
  return out;
}

function downscale(src) {
  const out = new Float32Array(PIX);
  const sx = VW / W, sy = VH / H;
  for (let oy = 0; oy < H; oy++) {
    const y0 = oy * sy, y1 = (oy + 1) * sy;
    for (let ox = 0; ox < W; ox++) {
      const x0 = ox * sx, x1 = (ox + 1) * sx;
      let s = 0, w = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue;
          s += src[yy * VW + xx] * wx * wy; w += wx * wy;
        }
      }
      out[oy * W + ox] = w ? s / w : 0;
    }
  }
  return out;
}

/* ---------------- 跑引擎 ---------------- */
const SQUAT = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };

function runEngine(frames96, profile, fps, previewSecs, countSecs) {
  const total = frames96.length;
  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(makeFakeCanvas(VW, VH));
  eng.setProfile(profile);

  const dtMs = 1000 / fps;
  let i = 0;
  const step = (n) => {
    for (let k = 0; k < n && i < total; k++, i++) {
      globalThis.__frame = frames96[i];
      globalThis.__clock = i * dtMs;
      if (globalThis.__rafCb) globalThis.__rafCb();
    }
  };

  let gateAtMid = 0, spreadAtMid = 0, ampAtMid = 0;
  if (previewSecs > 0) {
    eng.preview();
    step(Math.round(previewSecs * fps));
  }
  eng.start();
  const countFrames = Math.round(countSecs * fps);
  const half = i + Math.floor(countFrames / 2);
  step(Math.floor(countFrames / 2));
  { const st = eng.getState(); gateAtMid = st.repGate; spreadAtMid = st.repSpread; ampAtMid = st.amplitude; }
  step(countFrames - Math.floor(countFrames / 2));
  const st = eng.getState();
  return { reps: st.reps, gateEnd: st.repGate, spreadEnd: st.repSpread, ampEnd: st.amplitude, ampMid: ampAtMid, spreadMid: spreadAtMid };
}

/* ---------------- 场景 ---------------- */
const FPS = 25;
const PREVIEW = 5, COUNT = 15; // 回归：预览约 5s 后开始，计 15s
const N = (PREVIEW + COUNT) * FPS;

const y4m = genY4MFrames(N, FPS).map(downscale);
const mine = genCanvasFrames(N, FPS).map(downscale);

function med(a) { const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; }

// 稳态峰峰值（后 10s）直接量 96×72 归一化 centroidY 的 raw range，作为独立参照
function rawRange(frames96, fromSec, fps) {
  const vals = [];
  for (let i = Math.round(fromSec * fps); i < frames96.length; i++) vals.push(frames96[i]);
  // centroidY 需要引擎算，这里只用「人形质心」近似不了；改由引擎的 series 提供（见下）
  return vals;
}

console.log("=== 离线真实 motion-engine.js（掩码链路，signal=centroidY, expectedAmp=0.06）===\n");
for (const [name, frames] of [["Y4M 夹具（motion-browser-test.js 用的）", y4m], ["我的 canvas 夹具（_exp-series 用的）", mine]]) {
  const noPrev = runEngine(frames, SQUAT, FPS, 0, COUNT);
  const withPrev = runEngine(frames, SQUAT, FPS, PREVIEW, COUNT);
  console.log("■ " + name);
  console.log("   无预览预热(直接 start) : reps=" + noPrev.reps + "  gate末=" + noPrev.gateEnd.toFixed(4) + "  spread末=" + noPrev.spreadEnd.toFixed(4) + "  幅度末=" + (noPrev.ampEnd * 100).toFixed(0) + "%");
  console.log("   有预览预热(5s→start) : reps=" + withPrev.reps + "  gate末=" + withPrev.gateEnd.toFixed(4) + "  spread末=" + withPrev.spreadEnd.toFixed(4) + "  幅度末=" + (withPrev.ampEnd * 100).toFixed(0) + "%  幅度中=" + (withPrev.ampMid * 100).toFixed(0) + "%");
  console.log("");
}
