/* 判定"真实跳绳视频到底跳了几次"——用最直接的物理判据，不依赖全身 height。
 *
 * 判据依据：跳绳时人体腾空那一瞬，双脚（踝关节）最高 → 踝 y 出现局部最小值；
 * 落地时 y 最大。**一个完整跳绳 = 一次踝 y 的极小值**。
 * 用多种平滑/最小间隔/关节组合做稳健性交叉，避免单一口径误导。
 * 只读 _tmp/_lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const FPS = 24;

// MediaPipe 索引：27/28 = 踝，29/30 = 脚跟，31/32 = 脚尖，23/24 = 髋，0 = 鼻
const JOINTS = {
  "踝(27,28)": [27, 28],
  "脚跟(29,30)": [29, 30],
  "脚尖(31,32)": [31, 32],
  "髋(23,24)": [23, 24],
  "鼻(0)": [0],
};

function seriesOf(name, idxs) {
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const ys = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][1] : NaN).filter(Number.isFinite);
    out.push(ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN);
  }
  return out;
}
// 线性插值补 NaN
function fill(a) {
  const o = a.slice();
  for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) {
    let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--;
    let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++;
    o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : (n < o.length ? a[n] : 0));
  }
  return o;
}
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }

// 数"局部极小值"（起跳最高点）：y 先降后升 = 极小；要求相对幅度和最小间隔
function countMinima(a, minGapFrames, minProm) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) {
    if (a[i] <= a[i - 1] && a[i] < a[i + 1]) {
      if (idx.length && i - idx[idx.length - 1] < minGapFrames) {
        // 同一次跳跃内的抖动：保留 y 更小（更高）的那个
        if (a[i] < a[idx[idx.length - 1]]) idx[idx.length - 1] = i;
      } else idx.push(i);
    }
  }
  // 幅度过滤：峰高（相对相邻极大）太小的丢掉
  const keep = [];
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const lo = Math.max(0, i - 15), hi = Math.min(a.length, i + 15);
    const maxAround = Math.max(...a.slice(lo, hi));
    if (maxAround - a[i] >= minProm) keep.push(i);
  }
  return keep;
}

console.log("=== 真实跳绳：踝/脚 y 的【起跳次数】判定（一个极小值 = 跳一次）===");
const v = fill(seriesOf("jumpRope", JOINTS["踝(27,28)"]));
console.log(`帧数 ${v.length}  时长 ${(v.length / FPS).toFixed(2)}s  踝y 范围 ${Math.min(...v).toFixed(4)}~${Math.max(...v).toFixed(4)}`);
console.log("\n平滑窗口  最小间隔  幅度门限  起跳次数   频率(/分)");
for (const sk of [1, 3, 5]) {
  const s = smooth(v, sk);
  for (const g of [3, 5, 7]) {
    for (const p of [0.01, 0.02]) {
      const m = countMinima(s, g, p);
      console.log(`   ${String(sk).padStart(2)}      ${String(g).padStart(2)}帧     ${p.toFixed(2)}      ${String(m.length).padStart(4)}      ${(m.length / (v.length / FPS) * 60).toFixed(0)}`);
    }
  }
}

console.log("\n=== 各关节交叉（平滑5/间隔5帧/门限0.015）===");
for (const [label, idxs] of Object.entries(JOINTS)) {
  const a = fill(seriesOf("jumpRope", idxs));
  const m = countMinima(smooth(a, 5), 5, 0.015);
  console.log(`  ${label.padEnd(12)} 起跳次数=${String(m.length).padStart(3)}  (${(m.length / (a.length / FPS) * 60).toFixed(0)}/分)`);
}

console.log("\n=== 其他动作同法（对照，看该方法是否给出合理值）===");
for (const name of ["jumpingJacks", "squat", "burpee"]) {
  const a = fill(seriesOf(name, JOINTS["踝(27,28)"]));
  const m = countMinima(smooth(a, 5), 5, 0.02);
  console.log(`  ${LM.acts[name].cn.padEnd(10)} 踝极小值=${String(m.length).padStart(3)}  (${(m.length / (a.length / FPS) * 60).toFixed(0)}/分)`);
}

// 打印跳绳踝 y 序列的抽样，供人工核对形态
const s = smooth(v, 3);
console.log("\n=== 跳绳踝 y 序列（每 5 帧抽 1，↓=极小值附近）===");
let line = "";
for (let i = 0; i < s.length; i += 5) {
  const isMin = i > 0 && i < s.length - 1 && s[i] <= s[i - 1] && s[i] < s[i + 1];
  line += (isMin ? "↓" : (s[i] < 0.75 ? "·" : " "));
  if (line.length % 40 === 0) { console.log("  " + line); line = ""; }
}
if (line) console.log("  " + line);
const rr = Math.min(...s), RR = Math.max(...s);
console.log(`  (· = 踝y<0.75 即脚抬起; ↓ = 局部极小即起跳最高点; 阈值参考 min=${rr.toFixed(3)} max=${RR.toFixed(3)})`);
