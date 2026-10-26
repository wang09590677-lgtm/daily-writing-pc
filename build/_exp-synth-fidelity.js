// 保真度自检：把合成"可蹲人形"喂真实引擎，打印 引擎height / 几何height / area / mask bbox，
// 确认合成夹具是否被引擎正确跟踪（避免用坏夹具得出坏结论）。
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

function drawSquat(phase, standingHpx, k, cx = VW / 2, footY = 88) {
  const y = new Float32Array(VW * VH).fill(24);
  const scale = 1 - (1 - k) * phase;
  const hpx = standingHpx * scale, top = footY - hpx;
  const paint = (x0, y0, x1, y1) => { for (let yy = Math.max(0, Math.floor(y0)); yy < Math.min(VH, Math.ceil(y1)); yy++) for (let xx = Math.max(0, Math.floor(x0)); xx < Math.min(VW, Math.ceil(x1)); xx++) y[yy * VW + xx] = 238; };
  paint(cx - 0.11 * hpx, top, cx + 0.11 * hpx, top + 0.12 * hpx);
  paint(cx - 0.16 * hpx, top + 0.12 * hpx, cx + 0.16 * hpx, top + 0.54 * hpx);
  paint(cx - 0.30 * hpx, top + 0.16 * hpx, cx - 0.17 * hpx, top + 0.50 * hpx);
  paint(cx + 0.17 * hpx, top + 0.16 * hpx, cx + 0.30 * hpx, top + 0.50 * hpx);
  paint(cx - 0.14 * hpx, top + 0.54 * hpx, cx - 0.02 * hpx, footY);
  paint(cx + 0.02 * hpx, top + 0.54 * hpx, cx + 0.14 * hpx, footY);
  return y;
}
function downscale(src) { const out = new Float32Array(PIX), sx = VW / W, sy = VH / H; for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) { const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0; for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * VW + xx] * wx * wy; w += wx * wy; } } out[oy * W + ox] = w ? s / w : 0; } return out; }

const FPS = 25, SECS = 20, PREVIEW = 5, CYCLE = 1.4, STAND = 58;
const SQ = { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 };
const fr = [];
for (let f = 0; f < SECS * FPS; f++) { const t = f / FPS; const phase = (1 - Math.cos(2 * Math.PI * t / CYCLE)) / 2; fr.push(downscale(drawSquat(phase, STAND, 0.65))); }

globalThis.__clock = 0;
const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(SQ);
let i = 0; const step = (n) => { for (let q = 0; q < n && i < fr.length; q++, i++) { globalThis.__frame = fr[i]; globalThis.__clock = i * (1000 / FPS); if (globalThis.__rafCb) globalThis.__rafCb(); } };
eng.preview(); step(PREVIEW * FPS); eng.start();
console.log("秒 | 引擎height | 几何height | area  | maskSpread | gate");
for (let s = 0; s < 12; s++) {
  step(FPS);
  const st = eng.getState();
  const g = fr[i - 1]; let minY = H, maxY = -1;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (g[yy * W + xx] > 120) { if (yy < minY) minY = yy; if (yy > maxY) maxY = yy; }
  const geoH = maxY >= 0 ? (maxY - minY + 1) / H : 0;
  const num = (v, d) => (typeof v === "number" && isFinite(v)) ? v.toFixed(d) : "  n/a";
  console.log(`${String(s + 1).padStart(2)} |   ${num(st.live.height, 3)}    |   ${geoH.toFixed(3)}    | ${num(st.live.area, 3)} |  ${num(st.repSpread, 4)}   | ${num(st.repGate, 3)}`);
}
const st = eng.getState();
console.log(`\n最终 keys=${Object.keys(st).join(",")}`);
console.log(`最终 reps=${st.reps}（20s×0.71Hz ≈ 14 拍）  repGate=${st.repGate}  repSpread=${st.repSpread}`);
