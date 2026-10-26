// 验证假设：合成"开合跳"的 width 信号是否在约 3.5s（一个窗口长度）后
// 被背景模型吸收而衰减？若是，则"通过率骤降"是信号层面的既有行为，与门限无关。
const fs = require("fs");
const path = require("path");
const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));

for (const [id, key] of [["J2_full_2m", "width"], ["J1_static_2m", "width"], ["E_squat06", "centroidY"]]) {
  const ser = all[id].series.filter(r => isFinite(r[key]));
  // 每 0.25 秒取该区间内的极小/极大，看振幅随时间变化
  console.log("\n=== " + id + " / " + key + " —— 每 0.25s 的 min~max 振幅 ===");
  const bins = [];
  for (let s = 0; s < 12; s += 0.25) {
    const seg = ser.filter(r => r.t >= s && r.t < s + 0.25).map(r => r[key]);
    if (!seg.length) continue;
    bins.push({ s, amp: Math.max(...seg) - Math.min(...seg), mn: Math.min(...seg), mx: Math.max(...seg) });
  }
  // 每 8 个 bin（2 秒）打印一行
  for (let i = 0; i < bins.length; i += 8) {
    const g = bins.slice(i, i + 8);
    console.log("  t=" + g[0].s.toFixed(2) + "~" + (g[g.length - 1].s + 0.25).toFixed(2) + "s: "
      + g.map(b => b.amp.toFixed(3)).join(" "));
  }
  // 逐 2 秒的极差（真振幅）
  const chunk = [];
  for (let s = 0; s < 12; s += 2) {
    const seg = ser.filter(r => r.t >= s && r.t < s + 2).map(r => r[key]);
    chunk.push(Math.max(...seg) - Math.min(...seg));
  }
  console.log("  每 2 秒的真实峰峰值: " + chunk.map(v => v.toFixed(3)).join("  "));
}
