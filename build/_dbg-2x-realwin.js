/* ==================================================================
 * _dbg-2x-realwin.js — 为什么真视频没 2×？（只读，纯 Node）
 *
 * 疑问：合成纯正弦在 win/周期≈0.44~1.5 全 2×；真视频跳绳的计次信号
 *       也是 height、周期也落在该区间，却没有 2×。差在哪？
 *
 * 做法：对每个真实动作，录下它的**计次信号**（门限关闭），测：
 *   · 主导周期（自相关第一峰，比过零稳）→ win/周期
 *   · 原始信号过均值次数
 *   · 引擎 reps
 *   · 把同一段信号喂给离线复刻，看复刻是否也 1×（确认差异来自信号本身，
 *     不是复刻与引擎不一致）
 * 并打印真跳绳 height 的 d(t) 波形，和合成 1.2Hz 对比看"形状差"。
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
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

const ENG = 60, SRC = 24, RATIO = ENG / SRC;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 录计次信号：key = width / height / centroidY */
function captureSignal(frames, profile, key, opt) {
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prev = opt.previewFrames || ENG;
  const total = prev + Math.round(opt.countSecs * ENG);
  const sig = [], liveH = [];
  let prevSlot = -1, srcIdx = -1, lastLm = null;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prev) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) { prevSlot = slot; srcIdx++;
      const fi = opt.loop === false ? srcIdx : (srcIdx % frames.length);
      const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prev) { const L = eng.getState().live; sig.push(L[key]); liveH.push(L.height); }
  }
  eng.stop();
  return { reps: eng.getState().reps, sig, liveH };
}
/* 自相关第一峰 → 主导周期（秒） */
function dominantPeriod(v, fps) {
  const fin = v.filter(Number.isFinite);
  if (fin.length < 20) return null;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  const x = fin.map(q => q - m);
  let bestLag = 0, best = -Infinity;
  const maxLag = Math.min(Math.round(fps * 3), Math.floor(x.length / 2));
  for (let lag = Math.round(fps * 0.15); lag <= maxLag; lag++) {
    let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    s /= (x.length - lag);
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? bestLag / fps : null;
}
function rawUp(v) {
  const fin = v.filter(Number.isFinite); if (!fin.length) return 0;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  let n = 0, below = false;
  for (const x of fin) { if (x < m) below = true; else if (below) { n++; below = false; } }
  return n;
}
function mean(v) { const f = v.filter(Number.isFinite); return f.reduce((a, b) => a + b, 0) / f.length; }

/* 与引擎逐字一致的复刻 */
function detrend(raw, win) {
  const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length; let gvar = 0;
  for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; }
  return out;
}
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }
function replica(hs, fps, win, smoothK, minGap) {
  let armed = false, lastAt = -1, reps = 0;
  const tails = Math.max(2, Math.round(fps * 0.35));
  for (let t = 9; t < hs.length; t++) {
    const rawFull = hs.slice(0, t + 1);
    const k2 = Math.round(3.5 * fps), raw = rawFull.slice(Math.max(0, rawFull.length - k2));
    if (raw.length < 10) continue;
    const d = smooth(detrend(raw, win), smoothK);
    const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const now = (t + 1) / fps, tail = Math.min(d.length, tails);
    for (let i = d.length - tail; i < d.length; i++) { const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= minGap) { reps += 1; lastAt = now; } armed = false; } }
  }
  return reps;
}
function plot(d, k, from, to) {
  const ch = " .:-=+*#%@"; const seg = d.slice(from, to);
  const lo = Math.min(...seg, -k), hi = Math.max(...seg, k), span = (hi - lo) || 1;
  let s = ""; for (const v of seg) { const idx = Math.round((v - lo) / span * (ch.length - 1)); s += ch[Math.max(0, Math.min(ch.length - 1, idx))]; }
  return s;
}

const CASES = [
  { act: "jumpingJacks", cn: "开合跳", key: "width", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 } },
  { act: "squat", cn: "徒手深蹲", key: "height", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: .12 } },
  { act: "halfSquatWarm", cn: "半蹲热身", key: "centroidY", p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: .9, expectedAmplitude: .06 } },
  { act: "jumpRope", cn: "跳绳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 } },
  { act: "burpee", cn: "波比跳", key: "height", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: .16 } }
];

const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC }, rows: [], jumpRopePlot: null };

console.log("=== 真实动作：计次信号的 win/周期 及复刻对照（门限关闭）===\n");
console.log("动作     | 信号     | 时长s | win帧 | win秒 | 主导周期s | win/周期 | 原始过零 | 引擎reps | 复刻reps | 判定");
console.log("-".repeat(118));
for (const c of CASES) {
  const a = lm.acts[c.act]; if (!a) continue;
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const secs = frames.length / SRC;
  const cap = captureSignal(frames, { ...c.p, expectedAmplitude: 1e-6 }, c.key, { countSecs: secs, loop: false });
  const win = clamp(Math.round(ENG * 60 / Math.max(15, c.p.tempoBand[1])), 3, Math.round(ENG * 1.5));
  const smoothK = Math.max(1, Math.round(ENG * 0.06));
  const per = dominantPeriod(cap.sig, ENG);
  const wp = per ? (win / ENG) / per : null;
  const rc = replica(cap.sig, ENG, win, smoothK, c.p.minRepGap);
  const ratio = cap.reps ? rc / cap.reps : 0;
  const tag = ratio >= 1.6 ? "★ 复刻 2×" : (ratio >= 1.25 ? "偏高" : "1×");
  out.rows.push({ cn: c.cn, signal: c.key, secs: +secs.toFixed(1), win, winSec: +(win / ENG).toFixed(3), dominantPeriod: per ? +per.toFixed(3) : null, winOverPeriod: wp ? +wp.toFixed(3) : null, rawUpCross: rawUp(cap.sig), engineReps: cap.reps, replicaReps: rc, tag });
  console.log(c.cn.padEnd(9) + c.key.padEnd(10) + secs.toFixed(1).padEnd(7) + String(win).padEnd(7) + (win / ENG).toFixed(3).padEnd(7) +
    (per ? per.toFixed(3) : "-").padEnd(11) + (wp ? wp.toFixed(3) : "-").padEnd(10) + String(rawUp(cap.sig)).padEnd(10) + String(cap.reps).padEnd(10) + String(rc).padEnd(10) + tag);
}

/* 真跳绳 height 的 d(t) 波形 vs 合成 1.2Hz */
try {
  const a = lm.acts["jumpRope"];
  const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
  const c = CASES.find(x => x.act === "jumpRope");
  const cap = captureSignal(frames, { ...c.p, expectedAmplitude: 1e-6 }, "height", { countSecs: frames.length / SRC, loop: false });
  const win = 30, smoothK = 4;
  const raw = cap.liveH.slice(Math.max(0, cap.liveH.length - Math.round(3.5 * ENG)));
  const d = smooth(detrend(raw, win), smoothK);
  const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) || 1;
  const k = clamp(rms * 0.85, 0.45, 2.2);
  const hp = plot(d, k, 0, d.length);
  console.log("\n=== 真跳绳 height 的 d(t)（整段 3.5s 窗，k=" + k.toFixed(3) + "）===\n" + hp);
  console.log("\n波形字符含义：' '=低于-k，'@'=最高；上下各穿越一次才算一拍。");
  out.jumpRopePlot = { k: +k.toFixed(3), win, smoothK, engineReps: cap.reps, cycles: rawUp(cap.liveH) };
} catch (e) { console.log("跳绳波形跳过：" + e.message); }

fs.writeFileSync(path.join(__dirname, "_dbg-2x-realwin.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_dbg-2x-realwin.json");
