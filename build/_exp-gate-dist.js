// 权威测量：用生产版 detectReps 的**同一套窗口逻辑**，逐帧记录 spread 与 gate，
// 输出分位数分布，判断每个场景是"稳定通过 / 稳定挡住 / 擦边"。
// 同时直接从原始 JSON 复算 width 包络，交叉核对。
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }

const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));

// 复刻生产 signalWindow：从末尾往回取到 t-3.5
function prodSpread(gateFn, series, key) {
  const rows = [];
  for (let f = 0; f < series.length; f++) {
    const t = series[f].t, from = t - 3.5;
    let lo = f;
    while (lo > 0 && series[lo - 1].t >= from) lo--;
    let mn = Infinity, mx = -Infinity;
    for (let i = lo; i <= f; i++) { const v = series[i][key]; if (v < mn) mn = v; if (v > mx) mx = v; }
    rows.push({ t, spread: mx - mn, gate: gateFn(series[f].height), n: f - lo + 1 });
  }
  return rows;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)]; }

const CASES = [
  ["J2_full_2m", "width", "全幅开合跳@2m", 0.18],
  ["J3_half_2m", "width", "半幅开合跳@2m", 0.18],
  ["J4_full_4m", "width", "全幅开合跳@4m", 0.18],
  ["J1_static_2m", "width", "静止+噪1.2px@2m", 0.18],
  ["E_squat06", "centroidY", "半蹲0.6Hz@2m", 0.06],
  ["H_squat06_4m", "centroidY", "半蹲0.6Hz@4m", 0.06]
];

console.log("=== 生产窗口(3.5s)下的 spread 分布 vs gate ===");
console.log("场景".padEnd(22) + "窗口帧数".padEnd(10) + "gate".padEnd(9) + "spread p10".padEnd(12) + "p50".padEnd(9) + "p90".padEnd(9) + "通过%".padEnd(8) + "原始width包络");
console.log("-".repeat(112));
for (const [id, key, label, ea] of CASES) {
  const c = all[id];
  const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
  const gateFn = h => ea * 0.5 * clamp((h || 0.6) / 0.6, 1.0, 1.5);
  const rows = prodSpread(gateFn, ser, key).slice(60);   // 跳过 1s 预热
  const sp = rows.map(r => r.spread), ga = rows.map(r => r.gate);
  const pass = rows.filter(r => r.spread >= r.gate).length / rows.length * 100;
  const ws = ser.map(r => r[key]);
  console.log(label.padEnd(22) + String(rows[0].n).padEnd(10)
    + pct(ga, .5).toFixed(4).padEnd(9)
    + pct(sp, .1).toFixed(4).padEnd(12) + pct(sp, .5).toFixed(4).padEnd(9) + pct(sp, .9).toFixed(4).padEnd(9)
    + (pass.toFixed(0) + "%").padEnd(8)
    + ("[" + Math.min(...ws).toFixed(3) + ", " + Math.max(...ws).toFixed(3) + "]"));
}

console.log("\n=== 结论要点 ===");
console.log("· 静止场景 spread p50 应远低于 gate，通过% 应接近 0");
console.log("· 大幅动作 spread p10 应高于 gate，通过% 应接近 100（否则动作会被削）");
console.log("· 擦边 = 通过% 在 20~80 之间，是脆弱场景，需重点回归");
