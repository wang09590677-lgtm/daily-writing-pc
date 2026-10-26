// 诊断：看真实引擎产出的 width / centroidY 到底长什么样（滚动峰峰值分布），
// 判断"绝对幅度门限"应该建在哪个量上（原始值 / 局部去趋势值 / 归一化值）。
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
const { clamp, mean, std, detrend, smooth } = new Function(`
  ${grab("function clamp(v, a, b)", "function mean(arr)")}
  ${grab("function mean(arr)", "function std(arr)")}
  ${grab("function std(arr)", "// 动作参数默认值")}
  ${grab("function detrend(raw, win)", "function smooth(raw, k)")}
  ${grab("function smooth(raw, k)", "// 峰值计次")}
  return { clamp, mean, std, detrend, smooth };
`)();

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const FPS = 60;

function rollingPP(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const a = Math.max(0, i - n + 1);
    let mn = Infinity, mx = -Infinity;
    for (let j = a; j <= i; j++) { if (arr[j] < mn) mn = arr[j]; if (arr[j] > mx) mx = arr[j]; }
    out.push(mx - mn);
  }
  return out;
}
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)]; }

const CASES = [
  ["A_static_2m", "width"], ["B_noise06_2m", "width"], ["C_noise12_2m", "width"],
  ["C2_noise20_2m", "width"], ["G_noise12_4m", "width"], ["D_jack08_2m", "width"],
  ["F_jack08_4m", "width"], ["E_squat06", "centroidY"], ["H_squat06_4m", "centroidY"]
];

console.log("=== 滚动静止窗峰峰值分布（窗=1.5s=90帧）===");
console.log("场景".padEnd(26) + "信号".padEnd(11) + "p10".padEnd(9) + "p50".padEnd(9) + "p90".padEnd(9) + "max".padEnd(9) + "期望门限(0.6x)");
console.log("-".repeat(96));
const summary = {};
for (const [id, key] of CASES) {
  const c = data[id];
  const ser = c.series.filter(r => isFinite(r[key]));
  const arr = ser.map(r => r[key]);
  const w = rollingPP(arr, 90);
  // 跳过开头 2s 的收敛期
  const w2 = w.slice(120);
  const ea = c.profile.expectedAmplitude;
  summary[id] = { key, ea, p10: pct(w2, .1), p50: pct(w2, .5), p90: pct(w2, .9), max: Math.max(...w2) };
  console.log(id.padEnd(26) + key.padEnd(11)
    + pct(w2, .1).toFixed(4).padEnd(9) + pct(w2, .5).toFixed(4).padEnd(9)
    + pct(w2, .9).toFixed(4).padEnd(9) + Math.max(...w2).toFixed(4).padEnd(9) + (ea * 0.6).toFixed(3));
}

console.log("\n=== 关键分离度 ===");
const noise = [summary.B_noise06_2m, summary.C_noise12_2m, summary.C2_noise20_2m];
console.log("静止噪声(2m) 滚动静止窗 p90 ：", noise.map(n => n.p90.toFixed(4)).join("  "));
console.log("真开合跳(2m) 滚动静止窗 p10 ：", summary.D_jack08_2m.p10.toFixed(4), " p50:", summary.D_jack08_2m.p50.toFixed(4));
console.log("→ 分离边界落在 ", Math.max(...noise.map(n => n.p90)).toFixed(4), " ~ ", summary.D_jack08_2m.p10.toFixed(4));

console.log("\n=== 再看：原始 width 序列抽样（真开合跳 2m，每 30 帧取 1）===");
const j = data.D_jack08_2m.series;
const line = [];
for (let i = 0; i < j.length; i += 30) line.push(j[i].width.toFixed(3));
console.log(line.join(" "));

console.log("\n=== 静止 + 噪声（1.2px）width 序列抽样 ===");
const n = data.C_noise12_2m.series;
const line2 = [];
for (let i = 0; i < n.length; i += 30) line2.push(n[i].width.toFixed(3));
console.log(line2.join(" "));

// 归一化后能否区分？看 detrend 后（除以 gstd）的峰峰值
console.log("\n=== detrend 归一化后的滚动峰峰值（证明幅度信息被抹平）===");
for (const [id, key] of [["B_noise06_2m", "width"], ["C_noise12_2m", "width"], ["D_jack08_2m", "width"], ["A_static_2m", "width"]]) {
  const c = data[id];
  const ser = c.series.filter(r => isFinite(r[key]));
  const arr = ser.map(r => r[key]);
  const w = clamp(Math.round((FPS * 60) / Math.max(15, c.profile.tempoBand[1])), 3, Math.round(FPS * 1.5));
  const d = smooth(detrend(arr.slice(), w), Math.round(FPS * 0.06));
  const ww = rollingPP(d, 90).slice(120);
  console.log(`${id.padEnd(20)} detrend 后窗口峰峰值 p50=${pct(ww, .5).toFixed(3)} p90=${pct(ww, .9).toFixed(3)}  (≈恒定，与原始幅度无关)`);
}
