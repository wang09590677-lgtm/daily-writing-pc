// 回答 Q4 的最终一问：**真机上（2~3m，身高占画面 0.6）孩子做深蹲，height 信号够不够穿过门限？**
//
// 合成一个"会蹲下"的人形：站立时 bbox 高 ≈ 0.6，下蹲时整体压扁（bbox 高降到 h×k），
// 且质心下移。分别量：几何真值 vs 引擎 live.height / repSpread，对比 gate。
//
// 变量：下蹲保留比例 k（1.0=不蹲；0.75=蹲掉 25% 高度=常见深蹲）。
// 只读生产代码，不开浏览器。
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

// 合成"可蹲"人形：standingHpx = 站立时身高像素（VH=96 网格），k=下蹲保留比例
// 站立：头顶在 topStand，脚底在 bottomStand。下蹲：脚底不动，头/躯干整体下移并压扁。
function drawSquat(phase, standingHpx, k, cx = VW / 2, footY = 88, jitter = 0) {
  const y = new Float32Array(VW * VH).fill(24);
  // phase ∈ [0,1]：0=站直，1=蹲到底
  const scale = 1 - (1 - k) * phase;          // 当前身高相对站立的比例
  const hpx = standingHpx * scale;             // 当前身高像素
  const top = footY - hpx;
  const paint = (x0, y0, x1, y1) => { for (let yy = Math.max(0, Math.floor(y0)); yy < Math.min(VH, Math.ceil(y1)); yy++) for (let xx = Math.max(0, Math.floor(x0)); xx < Math.min(VW, Math.ceil(x1)); xx++) y[yy * VW + xx] = 238; };
  // 头顶:躯干:腿 ≈ 0.13:0.42:0.45（按身高比例）
  const headR = 0.075 * hpx;
  paint(cx - 0.11 * hpx, top, cx + 0.11 * hpx, top + 0.12 * hpx);                    // 头(近似方块)
  paint(cx - 0.16 * hpx, top + 0.12 * hpx, cx + 0.16 * hpx, top + 0.54 * hpx);      // 躯干
  paint(cx - 0.30 * hpx, top + 0.16 * hpx, cx - 0.17 * hpx, top + 0.50 * hpx);      // 左臂
  paint(cx + 0.17 * hpx, top + 0.16 * hpx, cx + 0.30 * hpx, top + 0.50 * hpx);      // 右臂
  paint(cx - 0.14 * hpx, top + 0.54 * hpx, cx - 0.02 * hpx, footY);                 // 左腿
  paint(cx + 0.02 * hpx, top + 0.54 * hpx, cx + 0.14 * hpx, footY);                 // 右腿
  return y;
}

function downscale(src, SW, SH) {
  const out = new Float32Array(PIX), sx = SW / W, sy = SH / H;
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * SW + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}
function winSpreadMed(vals, wf) { const out = []; for (let i = wf - 1; i < vals.length; i++) { const seg = vals.slice(i - wf + 1, i + 1); out.push(Math.max(...seg) - Math.min(...seg)); } out.sort((a, b) => a - b); return out.length ? out[out.length >> 1] : null; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const FPS = 25, SECS = 25, PREVIEW = 5, CYCLE = 1.4; // 深蹲 ~0.7Hz
const SQ = { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 };

function frames(standingHpx, k, n) {
  const out = [];
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    const phase = (1 - Math.cos(2 * Math.PI * t / CYCLE)) / 2;   // 0→1→0
    out.push(downscale(drawSquat(phase, standingHpx, k), VW, VH));
  }
  return out;
}

function run(fr, label, standingHpx, k) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(SQ);
  let i = 0; const total = fr.length;
  const step = (n) => { for (let q = 0; q < n && i < total; q++, i++) { globalThis.__frame = fr[i]; globalThis.__clock = i * (1000 / FPS); if (globalThis.__rafCb) globalThis.__rafCb(); } };
  eng.preview(); step(PREVIEW * FPS);
  eng.start();
  const hvE = [], hGeoT = [];
  for (let f = PREVIEW * FPS; f < total; f++) {
    step(1); const st = eng.getState();
    hvE.push(st.live.height);
    const g = fr[f]; let minY = H, maxY = -1;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (g[yy * W + xx] > 120) { if (yy < minY) minY = yy; if (yy > maxY) maxY = yy; }
    hGeoT.push(maxY >= 0 ? (maxY - minY + 1) / H : 0);
  }
  const wf = Math.round(FPS * 3.5);
  const st = eng.getState();
  const geoRange = Math.max(...hGeoT) - Math.min(...hGeoT);
  const engRange = Math.max(...hvE) - Math.min(...hvE);
  const geoWin = winSpreadMed(hGeoT, wf), engWin = winSpreadMed(hvE, wf);
  const gate = st.repGate, spread = st.repSpread;
  console.log(`■ ${label}`);
  console.log(`   站立身高真值=${(standingHpx / VH).toFixed(3)}  下蹲保留 k=${k}  理论身高变化=${(standingHpx * (1 - k) / VH).toFixed(4)}`);
  console.log(`   height 真值(几何) 范围=${geoRange.toFixed(4)} 3.5s窗中位=${geoWin.toFixed(4)}`);
  console.log(`   height 引擎     范围=${engRange.toFixed(4)} 3.5s窗中位=${engWin.toFixed(4)}   压缩=${(geoWin / engWin).toFixed(2)}×`);
  console.log(`   gate=${gate.toFixed(4)}  末帧spread=${spread.toFixed(4)}  reps=${st.reps}  ⇒ ${spread >= gate ? "通过" : "★挡掉"}\n`);
  return { geoWin, engWin, gate, spread, reps: st.reps };
}

console.log("=== 真机条件下合成深蹲（signal=height，amp=0.12）===\n");
// 站立身高占画面: 2~3m 推荐 45~75%，中值 0.6。站立 hpx = 0.6*96 = 57.6 → 用 58。
const STAND = 58;
run(frames(STAND, 1.00, SECS * FPS), "不蹲（对照：静止）", STAND, 1.00);
run(frames(STAND, 0.85, SECS * FPS), "浅蹲（保留 85% 高度）", STAND, 0.85);
run(frames(STAND, 0.75, SECS * FPS), "标准深蹲（保留 75%）", STAND, 0.75);
run(frames(STAND, 0.65, SECS * FPS), "深蹲到底（保留 65%）", STAND, 0.65);

console.log("=== 附录：同一批直方图（门限对 height 的余量）===");
console.log("生产 gate（bodyScale=1.0，站 2~3m）= 0.12 × 0.5 = 0.06");
console.log("若引擎对 height 的压缩 ≈2×，则真值身高变化需 >0.12 才过 —— 即 k<0.8 左右。");
