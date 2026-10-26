/* 【最后一块拼图】跳绳的 signal:"height" 为什么分辨不出？
 *
 * 已有决定性证据（build/_dbg-jumprope-ideal.js）：
 *   把从原始关键点重建的干净信号喂给现行引擎 →
 *     踝y/膝y/鼻y/肩y 都数出 9（真值 10）；基线引擎一律 15~18（超计）
 *   而引擎实吃的 signal:"height" → 现行只数出 5
 * 所以：现行计数器是准的，问题在 height 这个信号本身。
 *
 * 本脚本对比「引擎实吃 height」与「从同类几何量重建的 height」逐帧形态，
 * 找出 height 的失真模式（平滑？延迟？幅度衰减？被身体其他部分污染？）。
 * 用法：node build/_dbg-height-vs-geom.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const L = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const jr = R.acts.jumpRope;
const hv = jr.series.map(o => o.height);
const tv = jr.series.map(o => o.t);

function stats(v) {
  const n = v.length, m = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { n, m, sd, min: Math.min(...v), max: Math.max(...v), pp: Math.max(...v) - Math.min(...v) };
}
const s = stats(hv);
console.log("【引擎实吃 height】 n=" + s.n + " 均值=" + s.m.toFixed(4) + " 标准差=" + s.sd.toFixed(5) + " 范围=" + s.min.toFixed(4) + "~" + s.max.toFixed(4) + " 峰峰=" + s.pp.toFixed(4));

/* 逐帧打印 height，压缩成一行符号串（每帧一个字符，按分位数着色） */
const lo = s.min + s.pp * 0.33, hi = s.min + s.pp * 0.66;
let line = "";
for (let i = 0; i < hv.length; i++) line += hv[i] > hi ? "#" : (hv[i] > lo ? "+" : ".");
console.log("\nheight 逐帧（. 低 1/3 | + 中 1/3 | # 高 1/3）:");
for (let i = 0; i < line.length; i += 100) console.log("  t=" + tv[i].toFixed(2).padStart(5) + "  " + line.slice(i, i + 100));

/* 从关键点重建同类量并对比周期性 */
const IDX = { hip: [23, 24], ankle: [27, 28], knee: [25, 26], nose: [0], shoulder: [11, 12] };
const avgY = ids => f => { let a = 0, n = 0; for (const id of ids) { if (f[id]) { a += f[id][1]; n++; } } return n ? a / n : NaN; };
const frames = L.acts.jumpRope.frames || L.acts.jumpRope;

function ds(frames, pick) { const o = []; for (let i = 0; i < frames.length; i++) { const f = frames[i]; if (!f || !f.length) continue; const v = pick(f); if (Number.isFinite(v)) o.push({ t: i / 24, v }); } return o; }
function resample(d, fps) { if (d.length < 3) return []; const t0 = d[0].t, t1 = d[d.length - 1].t, n = Math.floor((t1 - t0) * fps) + 1, o = []; let j = 0; for (let i = 0; i < n; i++) { const t = t0 + i / fps; while (j < d.length - 1 && d[j + 1].t < t) j++; const a = d[j], b = d[Math.min(d.length - 1, j + 1)]; const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; o.push({ t, v: a.v + (b.v - a.v) * u }); } return o; }

console.log("\n【从关键点重建的同类几何量】");
console.log("量".padEnd(12) + "峰峰".padStart(10) + "标准差".padStart(11) + "峰值数".padStart(8) + "  vs 实吃height峰峰 " + s.pp.toFixed(4));
for (const [nm, pick] of [["hip 髋y", avgY(IDX.hip)], ["ankle 踝y", avgY(IDX.ankle)], ["knee 膝y", avgY(IDX.knee)], ["nose 鼻y", avgY(IDX.nose)], ["shoulder 肩y", avgY(IDX.shoulder)]]) {
  const d = resample(ds(frames, pick), 60);
  const v = d.map(o => o.v), st = stats(v);
  let pk = 0, lastT = -9;
  for (let i = 2; i < d.length - 2; i++) if (d[i].v > d[i - 1].v && d[i].v >= d[i + 1].v && d[i].v > d[i - 2].v && d[i].v >= d[i + 2].v && d[i].t - lastT > 0.3) { pk++; lastT = d[i].t; }
  console.log(nm.padEnd(12) + st.pp.toFixed(4).padStart(10) + st.sd.toFixed(5).padStart(11) + String(pk).padStart(8) + "                " + (st.pp / s.pp).toFixed(2) + "x");
}

/* 引擎的 live.height 是怎么算的？对照源码找定义 */
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
const m = SRC.match(/height\s*=\s*[^;\n]*maxY[^;\n]*/);
console.log("\n【引擎 height 的定义（源码原句）】");
if (m) console.log("  " + m[0].trim());
const m2 = SRC.match(/height\s*=\s*maxY[^;\n]*/);
if (m2) console.log("  " + m2[0].trim());
