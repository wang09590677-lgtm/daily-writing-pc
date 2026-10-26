// 量化：生产门限用"当前帧 live.height"，其抖动会让 gate 随时间抖动。
// 对比"瞬时高度"与"6s 均值高度"两种尺度的稳定度。
const fs = require("fs");
const path = require("path");
const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) * (v - m)))); }

console.log("=== live.height 抖动（直接决定 gate 抖动）===");
console.log("场景".padEnd(24) + "height mean".padEnd(13) + "std".padEnd(10) + "变异系数".padEnd(11) + "min~max");
console.log("-".repeat(80));
for (const id of Object.keys(all)) {
  const hs = all[id].series.map(r => r.height).filter(isFinite);
  const m = mean(hs), s = std(hs);
  console.log(id.padEnd(24) + m.toFixed(4).padEnd(13) + s.toFixed(4).padEnd(10)
    + ((s / m) * 100).toFixed(2).padEnd(11) + Math.min(...hs).toFixed(3) + "~" + Math.max(...hs).toFixed(3));
}
console.log("\n结论：height 抖动若 <5%，gate 抖动也 <5% —— 说明 gate 本身稳定；");
console.log("      此时若计数仍在 5~9 之间摆动，说明**信号 spread 恰好卡在 gate 边界**（擦边），");
console.log("      而不是 gate 在乱动。擦边场景需要真机确认，不能靠调 gate 掩盖。");
