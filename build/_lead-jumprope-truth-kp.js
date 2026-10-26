/* 【跳绳真值 — 从原始 MediaPipe 关键点独立数】不用引擎信号，只用人体几何量，
 * 让多个互相独立的物理量各自数一遍，一致的那个数就是真值。
 *
 * 关键点索引（MediaPipe Pose 33）：
 *   11/12 肩  13/14 肘  15/16 腕  23/24 髋  25/26 膝  27/28 踝
 * 输出 [x,y,visibility]，x/y 已归一化到 0~1（srcW/srcH 为原始像素）。
 *
 * 对跳绳，几个物理上必然周期性的量：
 *   · 腕 y 均值（handY）      —— 抡绳两个手腕同起同落，一周期一次
 *   · 踝 y 均值（ankleY）     —— 每跳一次离地一次
 *   · 髋 y 均值（hipY）       —— 随跳跃升降
 *   · 肩-腕 距离（armLen）    —— 抡绳一圈一次
 * 每个量都做：线性插值到 60fps → 去均值 → 取峰（局部极大）→ 报次数。
 * 同时报**峰值间隔的中位数**（周期），与 tempoBand [60,120] 对照。
 */
"use strict";
const fs = require("fs"), path = require("path");
const L = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

const IDX = { shoulder: [11, 12], elbow: [13, 14], wrist: [15, 16], hip: [23, 24], knee: [25, 26], ankle: [27, 28], nose: 0 };

function series(frames, pick) {
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || !f.length) continue;
    const v = pick(f);
    if (Number.isFinite(v)) out.push({ t: i / 24, v });
  }
  return out;
}
const avgY = ids => f => { let s = 0, n = 0; for (const id of ids) { if (f[id]) { s += f[id][1]; n++; } } return n ? s / n : NaN; };
const avgX = ids => f => { let s = 0, n = 0; for (const id of ids) { if (f[id]) { s += f[id][0]; n++; } } return n ? s / n : NaN; };
const dist = (a, b) => f => { if (!f[a] || !f[b]) return NaN; return Math.hypot(f[a][0] - f[b][0], f[a][1] - f[b][1]); };

/* 线性插值重采样到 60fps */
function resample(ds, fps) {
  if (ds.length < 3) return [];
  const t0 = ds[0].t, t1 = ds[ds.length - 1].t, n = Math.floor((t1 - t0) * fps) + 1, out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps;
    while (j < ds.length - 2 && ds[j + 1].t < t) j++;
    const a = ds[j], b = ds[Math.min(j + 1, ds.length - 1)];
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    out.push({ t, v: a.v + (b.v - a.v) * u });
  }
  return out;
}
/* 峰值法：平滑 → 局部极大（左右各 h 帧内最大且超阈值） */
function peakCount(s, h, k) {
  const smooth = s.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - h); j <= Math.min(s.length - 1, i + h); j++) { a += s[j].v; n++; } return a / n; });
  const m = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  const sd = Math.sqrt(smooth.reduce((a, b) => a + (b - m) ** 2, 0) / smooth.length) || 1e-6;
  const thr = k * sd;
  const times = [];
  for (let i = h; i < smooth.length - h; i++) {
    const z = smooth[i] - m;
    if (z < thr) continue;
    let isMax = true;
    for (let j = i - h; j <= i + h; j++) if (j !== i && smooth[j] - m > z) { isMax = false; break; }
    if (isMax) times.push(s[i].t);
  }
  const dedup = [];
  for (const t of times) if (!dedup.length || t - dedup[dedup.length - 1] > h / 60) dedup.push(t);
  const gaps = [];
  for (let i = 1; i < dedup.length; i++) gaps.push(dedup[i] - dedup[i - 1]);
  gaps.sort((a, b) => a - b);
  return { n: dedup.length, medGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0 };
}
/* 自相关周期 */
function acPeriod(s) {
  const v = s.map(x => x.v), m = v.reduce((a, b) => a + b, 0) / v.length, z = v.map(x => x - m);
  let best = 0, bestV = -1;
  for (let lag = 5; lag < Math.min(z.length / 2, 240); lag++) {
    let a = 0, na = 0, b = 0, nb = 0;
    for (let i = 0; i + lag < z.length; i++) { a += z[i] * z[i + lag]; na++; b += z[i] * z[i]; nb++; }
    const r = a / (Math.sqrt(b * (z.reduce((p, q, i2) => (i2 + lag < z.length ? p + q * q : p), 0) / Math.max(1, nb)) + 1e-9) || 1);
    if (r > bestV) { bestV = r; best = lag; }
  }
  return best;
}

const SPECS = [
  ["腕 y 均值 (抡绳)", avgY(IDX.wrist)],
  ["踝 y 均值 (离地)", avgY(IDX.ankle)],
  ["髋 y 均值 (升降)", avgY(IDX.hip)],
  ["肩-腕 距离 (绳圈)", dist(11, 15)],
  ["腕 x 跨度", avgX(IDX.wrist)],
  ["鼻 y", f => (f[0] ? f[0][1] : NaN)],
  ["肩-踝 距离 (全身)", dist(11, 27)]
];

for (const key of ["jumpRope", "jumpingJacks", "squat"]) {
  const a = L.acts[key]; if (!a) continue;
  const frames = Array.isArray(a.kps) ? a.kps : (a.frames || a.data);
  if (!frames) { console.log(key, "no frames; keys=", Object.keys(a)); continue; }
  console.log(`\n${"=".repeat(96)}\n【${a.cn}】原始关键点 ${frames.length} 帧 @24fps → ${(frames.length / 24).toFixed(1)}s\n${"-".repeat(96)}`);
  console.log("物理量                  重采样帧  峰值(h=6,k=0.5)  峰值(h=10,k=0.4)   中位间隔   自相关周期   等效/分");
  for (const [name, pick] of SPECS) {
    const ds = series(frames, pick);
    if (ds.length < 20) { console.log(`${name.padEnd(22)} 数据不足`); continue; }
    const rs = resample(ds, 60);
    const p1 = peakCount(rs, 6, 0.5), p2 = peakCount(rs, 10, 0.4);
    const ac = acPeriod(rs);
    const med = p2.medGap || ac / 60;
    console.log(`${name.padEnd(22)} ${String(rs.length).padStart(6)}   ${String(p1.n).padStart(8)}         ${String(p2.n).padStart(8)}      ${med.toFixed(3).padStart(7)}s  ${String(ac).padStart(10)}帧   ${(60 / med).toFixed(0).padStart(6)}`);
  }
}

/* 与引擎实吃序列对照 */
console.log(`\n${"=".repeat(96)}\n【与引擎实吃序列对照】\n${"-".repeat(96)}`);
const eng = R.acts.jumpRope;
const es = eng.series.map(s => ({ t: s.t, v: s[eng.signal] }));
console.log(`引擎信号 "${eng.signal}" 长度 ${es.length}，范围 ${Math.min(...es.map(x => x.v)).toFixed(4)} ~ ${Math.max(...es.map(x => x.v)).toFixed(4)}，峰峰 ${(Math.max(...es.map(x => x.v)) - Math.min(...es.map(x => x.v))).toFixed(4)}`);
console.log(`  峰值法 h=10,k=0.4 → ${peakCount(es, 10, 0.4).n} 次（中位间隔 ${peakCount(es, 10, 0.4).medGap.toFixed(3)}s）`);
console.log(`  自相关周期 → ${acPeriod(es)} 帧 = ${(acPeriod(es) / 60).toFixed(3)}s → ${(60 / (acPeriod(es) / 60)).toFixed(0)}/分`);
const engW = eng.series.map(s => ({ t: s.t, v: s.width }));
console.log(`引擎 width 信号：峰值法 → ${peakCount(engW, 10, 0.4).n} 次（中位间隔 ${peakCount(engW, 10, 0.4).medGap.toFixed(3)}s）`);
