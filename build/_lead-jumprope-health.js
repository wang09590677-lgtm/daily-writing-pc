/* 【跳绳信号体检】打印引擎实际消费的 height 序列（跳绳）+ 各种计数法的命中位置，
 * 判断"真值10"在引擎信号上是否成立，还是信号本身就只有 6~8 个可辨周期。
 * 只读 _realseries.json + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smooth(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } return fill(out); };

// 1) 物理真值：踝 y 极小值的位置（24fps → 转 60fps 时刻）
const ank = smooth(lmCol("jumpRope", [27, 28], 1), 3);
const minPos = [];
for (let i = 1; i < ank.length - 1; i++) {
  if (ank[i] <= ank[i - 1] && ank[i] < ank[i + 1]) {
    if (minPos.length && i - minPos[minPos.length - 1] < 3) { if (ank[i] < ank[minPos[minPos.length - 1]]) minPos[minPos.length - 1] = i; }
    else minPos.push(i);
  }
}
console.log("=== 跳绳物理真值（踝y极小值）===");
console.log(`个数=${minPos.length}  时刻(s)=${minPos.map(i => (i / 24).toFixed(2)).join(", ")}`);
console.log(`间隔(s)=${minPos.slice(1).map((v, k) => (v / 24 - minPos[k] / 24).toFixed(2)).join(", ")}`);

// 2) 引擎消费的 height 序列
const a = R.acts.jumpRope;
const h = a.series.map(s => s.height);
const lo = Math.min(...h), hi = Math.max(...h);
console.log(`\n=== 引擎 height 序列（${h.length}帧 60fps）范围 ${lo.toFixed(4)}~${hi.toFixed(4)} 峰峰=${(hi - lo).toFixed(4)} ea=${a.profile.expectedAmplitude} gate=${(a.profile.expectedAmplitude * 0.5).toFixed(4)} ===`);

// 用离线"正确"法：整段 detrend + 逐样本判定，打印命中
const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
const std = x => { const m = mean(x); return Math.sqrt(mean(x.map(v => (v - m) * (v - m)))); };
function hitsOffline(v, gapS, fps) {
  const half = 15, g = std(v) || 1;
  const d = v.map((x, i) => { const A = Math.max(0, i - half), B = Math.min(v.length, i + half + 1); let m = 0; for (let j = A; j < B; j++) m += v[j]; m /= (B - A); return (x - m) / g; });
  const s = smooth(d, 4);
  const rms = Math.sqrt(mean(s.map(x => x * x))) || 1, k = Math.max(0.45, Math.min(2.2, rms * 0.85));
  let armed = false, last = -1e9; const hits = [];
  for (let i = 0; i < s.length; i++) { const x = s[i]; if (x < -k) armed = true; else if (x > k && armed) { const t = i / fps; if (t - last >= gapS) { hits.push(t); last = t; } armed = false; } }
  return { hits, k };
}
const HO = hitsOffline(h, 0.3, 60);
console.log(`\n离线逐样本（居中窗15帧 + 整段std）reps=${HO.hits.length} k=${HO.k.toFixed(2)}`);
console.log(`  命中时刻(s)=${HO.hits.map(x => x.toFixed(2)).join(", ")}`);

// 3) 字符波形 + 标出物理真值(○)与离线命中(★)
console.log("\n=== height 波形（每字符=1帧，★离线命中，○踝极小值真值）===");
const nrm = x => Math.round((x - lo) / (hi - lo + 1e-9) * 10);
const rows = Array.from({ length: 11 }, () => new Array(h.length).fill(" "));
for (let i = 0; i < h.length; i++) rows[10 - nrm(h[i])][i] = "·";
for (const t of HO.hits) { const i = Math.round(t * 60) - 1; if (i >= 0 && i < h.length) rows[10 - nrm(h[i])][i] = "★"; }
for (const p of minPos) { const i = Math.round(p * 60 / 24) - 1; if (i >= 0 && i < h.length) { const r = 10 - nrm(h[i]); if (rows[r][i] !== "★") rows[r][i] = "○"; } }
for (const r of rows) console.log("  |" + r.join(""));
console.log("  +" + "-".repeat(h.length));
console.log("   " + "0".padEnd(60) + "3.0s".padEnd(60) + "6.0s");

// 4) 数值抽样：每拍附近
console.log("\n=== 每个踝极小值时刻附近的 height 值 ===");
for (const p of minPos) {
  const i = Math.round(p * 60 / 24) - 1;
  const seg = h.slice(Math.max(0, i - 8), Math.min(h.length, i + 9));
  console.log(`  真值@${(p / 24).toFixed(2)}s: ${seg.map(v => v.toFixed(3)).join(" ")}`);
}
