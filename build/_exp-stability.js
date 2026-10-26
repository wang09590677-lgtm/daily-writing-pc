// 稳定性刻画：逐秒统计门限通过率，判断修复是"稳定挡住噪声 / 稳定放行动作"
// 还是"擦边"（擦边 = 脆弱，真机会时好时坏）。
const fs = require("fs");
const path = require("path");
const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function rows(id, key, ea) {
  const c = all[id];
  const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
  const out = [];
  for (let f = 0; f < ser.length; f++) {
    const t = ser[f].t, from = t - 3.5;
    let lo = f; while (lo > 0 && ser[lo - 1].t >= from) lo--;
    let mn = Infinity, mx = -Infinity;
    for (let i = lo; i <= f; i++) { const v = ser[i][key]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const gate = ea * 0.5 * clamp((ser[f].height || 0.6) / 0.6, 1.0, 1.5);
    out.push({ t, spread: mx - mn, gate, open: mx - mn >= gate });
  }
  return out;
}

const CASES = [
  ["J1_static_2m", "width", "静止+噪1.2px@2m", 0.18],
  ["J2_full_2m", "width", "全幅开合跳@2m", 0.18],
  ["J3_half_2m", "width", "半幅开合跳@2m", 0.18],
  ["E_squat06", "centroidY", "半蹲0.6Hz@2m", 0.06]
];

console.log("=== 逐秒门限通过率（1 = 该秒内多数帧放行）===");
for (const [id, key, label, ea] of CASES) {
  const r = rows(id, key, ea);
  const secs = Math.ceil(r[r.length - 1].t);
  const line = [];
  for (let s = 0; s < secs; s++) {
    const seg = r.filter(x => x.t >= s && x.t < s + 1);
    const p = seg.filter(x => x.open).length / seg.length * 100;
    line.push(String(Math.round(p)).padStart(4));
  }
  console.log(label.padEnd(20) + "|" + line.join(""));
  console.log("".padEnd(20) + "| 秒:0   1   2   3   4   5   6   7   8   9  10  11");
}

console.log("\n=== 尾段稳定性（去掉前 3 秒启动瞬态后的通过率）===");
for (const [id, key, label, ea] of CASES) {
  const r = rows(id, key, ea).filter(x => x.t >= 3);
  const open = r.filter(x => x.open).length / r.length * 100;
  console.log(label.padEnd(20) + "通过率 " + open.toFixed(0) + "%  (n=" + r.length + ")");
}
