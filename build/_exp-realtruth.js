/* ==================================================================
 * _exp-realtruth.js — 真实视频 5 样本的"独立真值"三法交叉核对（只读，纯 Node）
 *   法1 峰值法：原始几何信号（mapLandmarks）平滑后取显著峰（prominence×minGap）
 *   法2 单帧全局：整段一次 detrend + 迟滞过零（= F 的"每样本只处理一次"极限）
 *   法3 团队已用几何周期数 cycOnce（转录 _exp-pose-actualcount.json）
 * 目的：判定"现状 10/6/6/12/4"里，哪些是真计数、哪些含 2×。
 * 输出 build/_exp-realtruth.json
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;
globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fc(w, h) { return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
  const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
  for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return { data: d };
} }) }; }
globalThis.window = {}; globalThis.document = { createElement: () => fc(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; } catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
const FPS = 60, clamp = (v, a, b) => Math.min(b, Math.max(a, v)), mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const PROFS = {
  jumpingJacks: { cn: "开合跳", act: "jumpingJacks", signal: "width", p: { tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 } },
  squat: { cn: "徒手深蹲", act: "squat", signal: "height", p: { tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 } },
  halfSquatWarm: { cn: "半蹲热身", act: "squat", signal: "centroidY", p: { tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 } },
  jumpRope: { cn: "跳绳", act: "jumpRope", signal: "height", p: { tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 } },
  burpee: { cn: "波比跳", act: "burpee", signal: "height", p: { tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 0.16 } }
};
function geomSeries(name) {
  const A = PROFS[name]; const act = lm.acts[A.act];
  const vals = [];
  for (const f of act.frames) { if (!f) continue;
    const m = PV.mapLandmarks(f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })));
    if (!m.ok) continue;
    vals.push(A.signal === "width" ? m.width : (A.signal === "height" ? m.height : m.centroidY));
  }
  return vals; // 源 24Hz
}
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length); for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }
// 法1 峰值法（源24Hz）
function peakCount(sig, minGap) {
  const s = smooth(sig, 3); const mn = Math.min(...s), mx = Math.max(...s), ptp = mx - mn;
  const md = Math.max(1, Math.round(minGap * 24)); const thr = mn + ptp * 0.45;
  const peaks = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] >= thr && s[i] >= s[i - 1] && s[i] > s[i + 1]) {
      if (!peaks.length) { peaks.push(i); continue; }
      if (i - peaks[peaks.length - 1] >= md) peaks.push(i); else if (s[i] > s[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    }
  }
  return peaks.length;
}
// 法2 单帧全局（引擎 60fps：把源序列送进引擎，门限关，复刻 detrend 一次性）
const serData = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
function detrend(raw, win) { const out = new Array(raw.length), half = Math.max(1, Math.floor(win / 2)); const gm = mean(raw); let gv = 0; for (const r of raw) gv += (r - gm) * (r - gm); const gstd = Math.sqrt(gv / raw.length) || 1e-6; for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1); let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; } return out; }
function singleShotGlobal(sig, minGap, bandMax) { const win = clamp(Math.round(FPS * 60 / Math.max(15, bandMax)), 3, Math.round(FPS * 1.5)); const d = smooth(detrend(sig, win), 4); const rms = Math.sqrt(mean(d.map(v => v * v))) || 1; const k = clamp(rms * 0.85, 0.45, 2.2); let armed = false, last = -1, reps = 0; for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < -k) armed = true; else if (v > k && armed) { const now = i / FPS; if (last < 0 || now - last >= minGap) { reps++; last = now; } armed = false; } } return reps; }

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-pose-actualcount.json"), "utf8"));
const out = {};
console.log("=== 真实视频 5 样本：独立真值三法交叉核对 ===\n");
console.log("动作".padEnd(11) + "现状".padEnd(6) + "法1峰值".padEnd(9) + "法2单帧全局".padEnd(12) + "法3几何周期".padEnd(11) + "现状/法3");
for (const name of Object.keys(PROFS)) {
  const A = PROFS[name];
  const g = geomSeries(name);
  const p1 = peakCount(g, A.p.minRepGap);
  const rs = serData.acts[name];
  const p2 = rs ? singleShotGlobal(rs.series.map(r => r[rs.signal]), A.p.minRepGap, A.p.tempoBand[1]) : null;
  const p3 = ref.realvideo[name] ? ref.realvideo[name].cycOnce : null;
  const sq = rs ? rs.repsGateOn : (ref.realvideo[name] ? ref.realvideo[name].once.reps : null);
  out[name] = { cn: A.cn, statusQuo: sq, peak: p1, singleShot: p2, geometric: p3 };
  console.log(A.cn.padEnd(11) + String(sq).padEnd(7) + String(p1).padEnd(10) + String(p2).padEnd(13) + String(p3).padEnd(12) + (p3 ? (sq / p3).toFixed(2) : "-"));
}
fs.writeFileSync(path.join(__dirname, "_exp-realtruth.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-realtruth.json");
