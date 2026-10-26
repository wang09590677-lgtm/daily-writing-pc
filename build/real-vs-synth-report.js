// 真实深度数据 vs 合成数据的**特性对照**（不需要真人，用已有真实数据即可）。
//
// 目的：把"为什么合成数据无法代表真实表现"从感觉变成数字。
// 逐项对比引擎赖以工作的几个前提，在两类数据上是否成立。
const fs = require("fs");
const path = require("path");
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");

function load(name) {
  const p = path.join(ORBBEC, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const real = load(process.env.FILE || "real-depth-empty.json");
if (!real) { console.error("缺真实数据，先跑 capture-real-depth.py"); process.exit(1); }

const W = 96, H = 72;
const grid = real.frames[0].grid;

// ---- 真实数据特性 ----
let nz = 0, zeros = 0;
const vals = [];
for (const row of grid) for (const v of row) { if (v > 0) { nz++; vals.push(v); } else zeros++; }

// 相邻格深度差（水平+垂直）
const diffs = [];
let maxStep = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W - 1; x++) {
    const a = grid[y][x], b = grid[y][x + 1];
    if (a > 0 && b > 0) { const d = Math.abs(a - b); diffs.push(d); if (d > maxStep) maxStep = d; }
  }
}
for (let y = 0; y < H - 1; y++) {
  for (let x = 0; x < W; x++) {
    const a = grid[y][x], b = grid[y + 1][x];
    if (a > 0 && b > 0) { const d = Math.abs(a - b); diffs.push(d); if (d > maxStep) maxStep = d; }
  }
}
diffs.sort((p, q) => p - q);
const pct = p => diffs.length ? diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * p))] : 0;

// 相邻格"微小抖动"比例 —— 真实深度即使同一平面也不会完全相等
const jitter = diffs.filter(d => d > 0 && d <= 30).length;
const flat = diffs.filter(d => d === 0).length;

console.log("================ 真实深度 vs 合成深度：关键前提对照 ================");
console.log("");
console.log("前提① 同一物体表面深度恒定（引擎靠「同深度带」圈人）");
console.log(`   真实：相邻格深度差  中位 ${pct(0.5)}mm / p90 ${pct(0.9)}mm / p99 ${pct(0.99)}mm / 最大 ${maxStep}mm`);
console.log(`        完全相同(diff=0) 占 ${(flat / diffs.length * 100).toFixed(1)}%  微小抖动(1~30mm) 占 ${(jitter / diffs.length * 100).toFixed(1)}%`);
console.log(`   合成：恒为 0mm（整具身体赋同一个 D 值）— 100% 平坦`);
console.log("");
console.log("前提② 前景是连通的（引擎取最大连通域）");
console.log(`   真实：96x72 网格里 有效格 ${nz} / 空洞格 ${zeros}（空洞率 ${(zeros / (W * H) * 100).toFixed(1)}%）`);
console.log("        空洞会把人体切成碎块 → 连通域可能不是完整人形");
console.log("   合成：零空洞 —— 人体是一整块完美连通域");
console.log("");
console.log("前提③ 边缘一步跳变（引擎的分割闸门基于此）");
console.log(`   真实：最大相邻差 ${maxStep}mm，p99 ${pct(0.99)}mm → 边缘是渐变的、还有飞点`);
console.log("   合成：人/背景边界刚好一步跳 0 → 数千 mm，分界线锐利无歧义");
console.log("");
console.log("前提④ 深度值精确已知（测试断言都建立在「精确距离」上）");
const uniq = new Set(vals.filter(v => v > 0));
console.log(`   真实：本帧出现 ${uniq.size} 个不同深度值，量化台阶 ${real.stats.quant_gap_med}~${real.stats.quant_gap_max}mm`);
console.log(`   合成：一个场景只用 1~3 个精确值（如 3000 / 4000）`);

// 逐帧看"人往后退"时引擎会怎么选 —— 真实数据里没有"人"，只统计背景结构
console.log("");
console.log("================ 真实空房间的深度结构（引擎眼里的「背景」）================");
const rows = [];
for (let y = 0; y < H; y += 12) {
  const line = [];
  for (let x = 0; x < W; x += 12) {
    const v = grid[y][x];
    line.push(v ? String(Math.round(v / 100) * 100).padStart(5) : "    ∅");
  }
  rows.push("   行" + String(y).padStart(3) + ": " + line.join(" "));
}
console.log(rows.join("\n"));
console.log("");
console.log("  （单位 mm，∅ = 无数据。采样显示每 12 格一个点）");
console.log("");
console.log("================ 结论 ================");
console.log("  合成数据 4 个前提全部「理想成立」，真实数据全部「有条件成立」：");
console.log("    · 同深度带不再是干净的矩形，而是被空洞咬碎的不规则块");
console.log("    · 人体表面本身有几十~上百 mm 起伏，「同一个人」的深度带要足够厚");
console.log("    · 边缘渐变+飞点，靠「最大间隙分簇」可能被飞点干扰");
console.log("  → 合成测试能验证【算法逻辑对不对】，但验证不了【真实数据下参数合不合适】。");
console.log("  → 后者只能靠真人实拍数据回归（本目录 real-depth-person.json）。");
