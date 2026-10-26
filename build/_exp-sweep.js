// 门限比例敏感性扫描：在同一段真实引擎数据上，看 AMP_RATIO 取不同值时
// 「静止噪声是否被挡住」与「真动作是否数得出来」的取舍。
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
const { clamp, mean, detrend, smooth } = new Function(`
  ${grab("function clamp(v, a, b)", "function mean(arr)")}
  ${grab("function mean(arr)", "function std(arr)")}
  ${grab("function std(arr)", "// 动作参数默认值")}
  ${grab("function detrend(raw, win)", "function smooth(raw, k)")}
  ${grab("function smooth(raw, k)", "// 峰值计次")}
  return { clamp, mean, detrend, smooth };
`)();

const FPS = 60, SMOOTH_K = Math.max(1, Math.round(FPS * 0.06));
const REF_HEIGHT = 0.6;

function detect(series, band, minGap, key, ea, ratio, zoom) {
  const w = clamp(Math.round((FPS * 60) / Math.max(15, band[1])), 3, Math.round(FPS * 1.5));
  const tail = Math.max(2, Math.round(FPS * 0.35));
  const maxBuf = Math.round(FPS * 3.5);
  const ampMax = Math.round(FPS * clamp(60 / Math.max(10, band[0]), 1.2, 3.0));
  const hMax = Math.round(FPS * 6);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [], ampBuf = [], hBuf = [];
  for (let f = 0; f < series.length; f++) {
    const row = series[f];
    buf.push(row[key]); if (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]); if (ampBuf.length > ampMax) ampBuf.shift();
    hBuf.push(row.height); if (hBuf.length > hMax) hBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;
    const hBase = mean(hBuf);
    const sc = zoom ? clamp(hBase / REF_HEIGHT, 0.5, 1.5) : 1;
    const gate = ea * ratio * sc;
    const spread = Math.max(...ampBuf) - Math.min(...ampBuf);
    if (spread < gate) { armed = false; continue; }
    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const t = row.t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; } armed = false; }
    }
  }
  return reps;
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const CASES = [
  ["A_static_2m", "width", "静止@2m", 0], ["B_noise06_2m", "width", "静止噪0.6@2m", 0],
  ["C_noise12_2m", "width", "静止噪1.2@2m", 0], ["C2_noise20_2m", "width", "静止噪2.0@2m", 0],
  ["G_noise12_4m", "width", "静止噪1.2@4m", 0],
  ["D_jack08_2m", "width", "开合跳@2m", "~9"], ["F_jack08_4m", "width", "开合跳@4m", "~9"],
  ["E_squat06", "centroidY", "半蹲@2m(回归)", 9], ["H_squat06_4m", "centroidY", "半蹲@4m", 9]
];
const ratios = [0.4, 0.5, 0.6, 0.7, 0.8];

for (const zoom of [true, false]) {
  console.log(`\n=== ${zoom ? "门限随人形高度缩放（推荐）" : "门限写死（不做距离缩放）"} ===`);
  let hdr = "场景".padEnd(18) + "期望".padEnd(8);
  for (const r of ratios) hdr += ("RATIO=" + r).padEnd(11);
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const [id, key, label, expect] of CASES) {
    const c = data[id];
    const ser = c.series.filter(r => isFinite(r[key]));
    let line = label.padEnd(18) + String(expect).padEnd(8);
    for (const r of ratios) line += String(detect(ser, c.profile.tempoBand, c.profile.minRepGap, key, c.profile.expectedAmplitude, r, zoom)).padEnd(11);
    console.log(line);
  }
}
