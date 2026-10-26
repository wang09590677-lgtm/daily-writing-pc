// 回答 team-lead Q4：引擎的 live.centroidY 峰峰值 vs 几何真值（人物质心）峰峰值，
// 量化"掩码链路压缩"倍数；并顺带在真实深蹲帧上复查同一压缩。
// 只读生产代码，不开浏览器。
const fs = require("fs");
const path = require("path");
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
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* ---------- 夹具 1：Y4M 合成人形（motion-browser-test.js）---------- */
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
function downscaleWH(src, SW, SH) {
  const out = new Float32Array(PIX), sx = SW / W, sy = SH / H;
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * SW + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}

function winSpreadPerFrame(vals, winFrames) {
  const out = [];
  for (let i = winFrames - 1; i < vals.length; i++) {
    const seg = vals.slice(i - winFrames + 1, i + 1);
    out.push(Math.max(...seg) - Math.min(...seg));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[out.length >> 1] : null;
}

const SQ = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };
const FPS = 25, SECS = 25;

function run(frames96, profile, fps, label) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(profile);
  let i = 0; const total = frames96.length;
  const step = (n) => { for (let k = 0; k < n && i < total; k++, i++) { globalThis.__frame = frames96[i]; globalThis.__clock = i * (1000 / fps); if (globalThis.__rafCb) globalThis.__rafCb(); } };
  // 真实 App 流程：preview 预热 → start
  eng.preview(); step(Math.round(5 * fps));
  eng.start();
  const cyE = [], geoC = [], arE = [];
  for (let f = 0; f < frames96.length - Math.round(5 * fps); f++) {
    step(1);
    const st = eng.getState();
    cyE.push(st.live.centroidY); arE.push(st.live.area);
    // 几何真值：亮像素质心（与引擎无关）
    const g = frames96[Math.round(5 * fps) + f];
    let s = 0, n = 0;
    for (let p = 0; p < PIX; p++) if (g[p] > 120) { s += Math.floor(p / W); n++; }
    geoC.push(n ? (s / n) / H : NaN);
  }
  const wf = Math.round(fps * 3.5);
  const cyEwin = winSpreadPerFrame(cyE.filter(Number.isFinite), wf);
  const geoCwin = winSpreadPerFrame(geoC.filter(Number.isFinite), wf);
  const rng = a => { const b = a.filter(Number.isFinite); return Math.max(...b) - Math.min(...b); };
  console.log(`■ ${label}`);
  console.log(`   引擎 live.centroidY : 全程范围=${rng(cyE).toFixed(4)}  3.5s窗峰峰中位=${cyEwin.toFixed(4)}  area稳态=${arE[arE.length - 1].toFixed(3)}`);
  console.log(`   几何真值(亮质心)   : 全程范围=${rng(geoC).toFixed(4)}  3.5s窗峰峰中位=${geoCwin.toFixed(4)}`);
  console.log(`   ⇒ 压缩倍数 = 真值/引擎 = ${(geoCwin / cyEwin).toFixed(2)}×`);
  return { cyEwin, geoCwin };
}

console.log("=== Q4：引擎 centroidY vs 几何真值（都算 3.5s 窗峰峰中位）===\n");
const a = run(genY4M(SECS * FPS, FPS).map(f => downscaleWH(f, VW, VH)), SQ, FPS, "Y4M 合成人形（±12px 刚性平移，0.6Hz）");
console.log("   几何理论峰峰 = 2×12px / 96 = 0.2500（合成人形在 128×96 里 ±12px）\n");

// 真实深蹲帧
const buf = fs.readFileSync(path.join(__dirname, "_tmp", "squat.gray"));
const N = 361, SW = 512, SH = 288;
const subs = [];
for (let i = 0; i < N; i++) { const raw = buf.subarray(i * SW * SH, (i + 1) * SW * SH); subs.push(downscaleWH(raw, SW, SH)); }
const b = run(subs, SQ, 24, "真实深蹲视频（512×288→96×72，24fps）");
console.log();
console.log("=== 判定 ===");
console.log("若 Y4M 的压缩倍数 >2×，说明 (b) 成立：掩码链路把运动物体的 centroidY 压掉了，");
console.log("不是 (a) 反推公式错（公式已核对：halfSquatWarm.signal=centroidY、ea=0.06，amplitude() 用 signalList()[0]）。");
