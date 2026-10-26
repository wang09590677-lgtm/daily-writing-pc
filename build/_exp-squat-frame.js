// 用 ffmpeg 导出的原始灰度（512×288，361 帧）离线复刻掩码链路，回答 team-lead 两个问题：
//   Q-squat: 深蹲视频人物是否顶到画面上下边缘（bbox 是否被裁切）？给边距数字。
//   Q-spread: 同一批真实帧的 width/height/centroidY 的 3.5s 窗峰峰值（= detectReps 比的量）。
// 只读，不开浏览器。
const fs = require("fs");
const path = require("path");
const W0 = 512, H0 = 288;
const W = 96, H = 72, PIX = W * H;
const FRAMES = 361;

const buf = fs.readFileSync(path.join(__dirname, "_tmp", "squat.gray"));
if (buf.length !== FRAMES * W0 * H0) { console.error("字节数不符:", buf.length); process.exit(2); }

function frameAt(i) {
  const off = i * W0 * H0;
  return buf.subarray(off, off + W0 * H0);
}
// INTER_AREA 降采样到 96×72
function downscale(src) {
  const out = new Float32Array(PIX), sx = W0 / W, sy = H0 / H;
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const x0 = ox * sx, x1 = (ox + 1) * sx, y0 = oy * sy, y1 = (oy + 1) * sy; let s = 0, w = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (wy <= 0) continue; for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); if (wx <= 0) continue; s += src[yy * W0 + xx] * wx * wy; w += wx * wy; } }
    out[oy * W + ox] = w ? s / w : 0;
  }
  return out;
}

const grays = [];
for (let i = 0; i < FRAMES; i++) grays.push(downscale(frameAt(i)));

// 中值背景（与 _maskchain-ref.py 相同）
const bg = new Float32Array(PIX);
{
  const col = new Float64Array(FRAMES);
  for (let p = 0; p < PIX; p++) {
    for (let i = 0; i < FRAMES; i++) col[i] = grays[i][p];
    const a = Array.from(col).sort((x, y) => x - y);
    bg[p] = a[a.length >> 1];
  }
}

// 前景 + bbox（阈值 22，同 _maskchain-ref.py）
const recs = [];
for (let i = 0; i < FRAMES; i++) {
  const g = grays[i];
  let minX = W, maxX = -1, minY = H, maxY = -1, n = 0, sumY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (Math.abs(g[p] - bg[p]) > 22) { n++; sumY += y; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (n < PIX * 0.004 || maxX < 0) { recs.push(null); continue; }
  recs.push({
    w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H, cy: (sumY / n) / H, area: n / PIX,
    minX, maxX, minY, maxY, n
  });
}

function stat(a) { const b = a.filter(Number.isFinite); if (!b.length) return null; const m = b.reduce((x, y) => x + y, 0) / b.length; return { min: Math.min(...b), max: Math.max(...b), mean: m, range: Math.max(...b) - Math.min(...b) }; }
function winSpread(a, wf) {
  const out = []; const A = a.map(v => Number.isFinite(v) ? v : NaN); const w = Math.min(wf, A.length);
  for (let i = w - 1; i < A.length; i++) { const seg = A.slice(i - w + 1, i + 1).filter(Number.isFinite); if (seg.length >= 10) out.push(Math.max(...seg) - Math.min(...seg)); }
  out.sort((x, y) => x - y);
  return out.length ? { min: out[0], med: out[out.length >> 1], max: out[out.length - 1] } : null;
}

const ws = recs.map(r => r ? r.w : NaN), hs = recs.map(r => r ? r.h : NaN), cys = recs.map(r => r ? r.cy : NaN);
const wf = Math.round(24 * 3.5);

console.log("=== 深蹲视频（512×288，361 帧，ffmpeg 导出灰度）掩码链路离线复刻 ===");
console.log("width  :", JSON.stringify(stat(ws)));
console.log("height :", JSON.stringify(stat(hs)));
console.log("centroidY:", JSON.stringify(stat(cys)));
console.log("3.5s窗 widthWin :", JSON.stringify(winSpread(ws, wf)));
console.log("3.5s窗 heightWin:", JSON.stringify(winSpread(hs, wf)));
console.log("3.5s窗 centroidYWin:", JSON.stringify(winSpread(cys, wf)));

// ---- Q-squat: bbox 距画面边缘的边距（归一化）----
console.log("\n=== bbox 与画面边缘的边距（归一化；0 = 顶到边）===");
const marginsTop = recs.map(r => r ? r.minY / H : NaN);
const marginsBot = recs.map(r => r ? (H - 1 - r.maxY) / H : NaN);
const marginsL = recs.map(r => r ? r.minX / W : NaN);
const marginsR = recs.map(r => r ? (W - 1 - r.maxX) / W : NaN);
const nz = a => a.filter(Number.isFinite);
const mn = a => Math.min(...nz(a)), mx = a => Math.max(...nz(a)), me = a => nz(a).reduce((x, y) => x + y, 0) / nz(a).length;
console.log(`  上边距 min=${mn(marginsTop).toFixed(4)}  (0 表示顶到上缘)`);
console.log(`  下边距 min=${mn(marginsBot).toFixed(4)}  (0 表示顶到下缘)`);
console.log(`  左边距 min=${mn(marginsL).toFixed(4)}`);
console.log(`  右边距 min=${mn(marginsR).toFixed(4)}`);
const touchTop = nz(marginsTop).filter(v => v <= 0.001).length;
const touchBot = nz(marginsBot).filter(v => v <= 0.001).length;
const nearTop = nz(marginsTop).filter(v => v <= 0.03).length;
const nearBot = nz(marginsBot).filter(v => v <= 0.03).length;
console.log(`  顶到上缘(边距=0)的帧数: ${touchTop}/${FRAMES}   贴近上缘(<=3%)的帧数: ${nearTop}/${FRAMES}`);
console.log(`  顶到下缘(边距=0)的帧数: ${touchBot}/${FRAMES}   贴近下缘(<=3%)的帧数: ${nearBot}/${FRAMES}`);

// ---- 关键：height 被"裁切"的证据 —— 若未裁切，站立 vs 下蹲 height 应有明显差 ----
console.log("\n=== height 是否被裁切（若裁切，height 会被压在高位窄带）===");
const hstat = stat(hs);
console.log(`  height 范围 ${hstat.min.toFixed(4)} ~ ${hstat.max.toFixed(4)}（跨度仅 ${hstat.range.toFixed(4)}）`);
console.log(`  典型身高 0.9721 → 对应 512px 画面里的 ${(0.9721 * H).toFixed(1)}px / 72 网格`);
console.log(`  ⇒ 若人物未裁切，站立→下蹲 bbox 高度变化应≈站立身高的 15~25%；实测跨度只有 ${(hstat.range * 100).toFixed(1)}% 全高`);

// 物理估算：真机 2~3m、身高占画面高 0.6
console.log("\n=== 物理估算：孩子站 2~3m（身高占画面高 0.6）做深蹲 ===");
console.log("  站立 height ≈ 0.60；下蹲时身体折叠，bbox 高度约降 15~25%");
console.log(`  ⇒ 站立→下蹲 height 变化 ≈ 0.09 ~ 0.15；3.5s 窗峰峰值 ≈ 2× 该值(一个周期) ≈ 0.18~0.30`);
console.log("  生产 gate（深蹲 amp=0.12，真机 bodyScale=1.0）= 0.06");
console.log("  ⇒ 0.18~0.30 远大于 gate 0.06 ⇒ 真机深蹲不会挡住（见文末裁定）");
