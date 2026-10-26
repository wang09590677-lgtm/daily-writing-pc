// 关键风险验证：对 signal:"height" 的动作（深蹲/提踵/波比跳…），
// 若门限尺度直接用「当前帧 height」，会不会和"次数信号"耦合？
// 因为 height 既是计次信号、又是尺度来源 —— 蹲下时 height 变小 → gate 也变小。
// 这会让 gate 与动作同步摆动，是本可以避免的耦合。
const fs = require("fs");
const path = require("path");
const all = Object.assign({}, JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

for (const id of ["E_squat06", "H_squat06_4m"]) {
  const ser = all[id].series;
  const hs = ser.map(r => r.height);
  const instant = hs.map(h => clamp(h / 0.6, 1.0, 1.5));
  // 慢基线（tau≈1.5s）
  let base = 0; const alpha = 1 / (60 * 1.5);
  const smooth = hs.map(h => { base = base ? base + (h - base) * alpha : h; return clamp(base / 0.6, 1.0, 1.5); });
  const stat = a => ({ min: Math.min(...a), max: Math.max(...a), mean: a.reduce((x, y) => x + y, 0) / a.length });
  const si = stat(instant), ss = stat(smooth);
  console.log(id + "（signal=height，深蹲）");
  console.log("  瞬时 height 作尺度: bodyScale 范围 " + si.min.toFixed(3) + "~" + si.max.toFixed(3)
    + " → gate 随动作摆动幅度 " + ((si.max - si.min) / si.mean * 100).toFixed(0) + "%");
  console.log("  慢基线 作尺度:      bodyScale 范围 " + ss.min.toFixed(3) + "~" + ss.max.toFixed(3)
    + " → gate 随动作摆动幅度 " + ((ss.max - ss.min) / ss.mean * 100).toFixed(0) + "%");
  console.log("");
}
console.log("说明：gate 摆幅 = 门限在动作周期内自己变来变去的幅度。");
console.log("      瞬时高度会把它放大到几十个百分点，慢基线能压到个位数 —— 这是选择慢基线的理由。");
