// 决定性：把**真实深蹲视频帧**（build/_tmp/squat.gray，512×288→96×72）逐帧喂进真实 motion-engine.js，
// 读 live.height / repSpread / repGate / reps，并与独立几何量对比。
// 这是"真机深蹲会不会被门限挡住"的最直接证据（无浏览器）。
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

const SW = 512, SH = 288, N = 361, FPS = 24;
const buf = fs.readFileSync(path.join(__dirname, "_tmp", "squat.gray"));
function downscale(src) {
  const out = new Float32Array(PIX), sx = SW / W, sy = SH / H;
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * SW + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}
const frames = [];
for (let i = 0; i < N; i++) frames.push(downscale(buf.subarray(i * SW * SH, (i + 1) * SW * SH)));

// 独立几何：帧内前景包围盒高（阈值 120，直接用亮度；真实视频人物亮）
function geoHeight(g) { let minY = H, maxY = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] > 120) { if (y < minY) minY = y; if (y > maxY) maxY = y; } return maxY >= 0 ? (maxY - minY + 1) / H : 0; }
const geoH = frames.map(geoHeight);

// profile 按 data/fitness-plan.js 真值
const PROFILES = {
  squat:      { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 },
  jumpRope:   { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 },
  jumpingJacks: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 },
  burpee:     { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 0.16 }
};
function winSpreadMed(vals, wf) { const out = []; for (let i = wf - 1; i < vals.length; i++) { const seg = vals.slice(i - wf + 1, i + 1).filter(Number.isFinite); if (seg.length >= 5) out.push(Math.max(...seg) - Math.min(...seg)); } out.sort((a, b) => a - b); return out.length ? out[out.length >> 1] : null; }

function runEngine(fr, profile, label) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(profile);
  let i = 0; const total = fr.length;
  const step = (n) => { for (let q = 0; q < n && i < total; q++, i++) { globalThis.__frame = fr[i]; globalThis.__clock = i * (1000 / FPS); if (globalThis.__rafCb) globalThis.__rafCb(); } };
  eng.preview(); step(Math.round(0.2 * FPS));
  eng.start();
  const sig = profile.signal; const vals = [], spreads = [];
  while (i < total) { step(1); const st = eng.getState(); vals.push(st.live[sig]); spreads.push(st.repSpread); }
  const st = eng.getState();
  const wf = Math.round(FPS * 3.5);
  const winMed = winSpreadMed(vals, wf);
  console.log(`■ ${label}  (signal=${sig}, amp=${profile.expectedAmplitude})`);
  console.log(`   live.${sig}: 全程范围=${(Math.max(...vals.filter(Number.isFinite)) - Math.min(...vals.filter(Number.isFinite))).toFixed(4)}  稳态均值=${(vals.slice(-Math.round(FPS * 5)).reduce((a, b) => a + b, 0) / Math.round(FPS * 5)).toFixed(4)}`);
  console.log(`   3.5s窗峰峰中位(引擎)=${winMed == null ? "n/a" : winMed.toFixed(4)}   gate=${st.repGate.toFixed(4)}  末帧spread=${st.repSpread.toFixed(4)}  reps=${st.reps}  ⇒ ${st.repSpread >= st.repGate ? "通过" : "★挡掉"}`);
  return { winMed, gate: st.repGate, spread: st.repSpread, reps: st.reps };
}

console.log("=== 真实深蹲视频 → 真实引擎（24fps，无重复帧）===\n");
console.log(`独立几何 height：范围=${(Math.max(...geoH) - Math.min(...geoH)).toFixed(4)}  稳态=${geoH.slice(-120).reduce((a, b) => a + b, 0) / 120}  3.5s窗峰峰中位=${winSpreadMed(geoH, Math.round(FPS * 3.5)).toFixed(4)}`);
console.log("（注意：该视频人物裁切，height 0.9167~1.0，绝对变化被压缩）\n");
const r = runEngine(frames, PROFILES.squat, "徒手深蹲（真值 profile）");

console.log("\n=== 对照：把 squat 视频当 jumpRope 的 height（amp=0.05）跑 ===");
runEngine(frames, PROFILES.jumpRope, "跳绳口径");

console.log("\n=== 真机估算（若人物不裁切，站 2~3m，身高 0.6）===");
console.log("  gate(深蹲, bodyScale=1.0) = 0.12×0.5 = 0.060");
const comp = (Math.max(...geoH) - Math.min(...geoH)) > 0 ? (winSpreadMed(geoH, Math.round(FPS * 3.5)) / (r.winMed || 1)) : NaN;
console.log(`  实测掩码链路对 height 的压缩 ≈ ${comp.toFixed(2)}×（几何真值/引擎）`);
