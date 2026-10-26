// 变体对比：门限窗口取「整段 raw(3.5s)」 vs 「一个最慢周期」；
// 并检查把 armed 在门限不过时清零的效果。
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
const FPS = 60, SMOOTH_K = Math.max(1, Math.round(FPS * 0.06)), REF_HEIGHT = 0.6;

// variant: "whole" = 用 raw(3.5s) 峰峰值；"period" = 用最慢周期的窗
function detect(ser, band, minGap, key, ea, ratio, zoom, variant) {
  const w = clamp(Math.round((FPS * 60) / Math.max(15, band[1])), 3, Math.round(FPS * 1.5));
  const tail = Math.max(2, Math.round(FPS * 0.35)), maxBuf = Math.round(FPS * 3.5);
  const ampMax = variant === "whole" ? maxBuf : Math.round(FPS * clamp(60 / Math.max(10, band[0]), 1.2, 3.0));
  const hMax = Math.round(FPS * 6);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [], ampBuf = [], hBuf = [];
  for (const row of ser) {
    buf.push(row[key]); if (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]); if (ampBuf.length > ampMax) ampBuf.shift();
    hBuf.push(row.height); if (hBuf.length > hMax) hBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;
    // zoom: "none"=不缩放；"both"=上下都缩放；"up"=只往上缩放（远距离不降门限，防噪声地板）
    const sc = !zoom ? 1
      : zoom === "up" ? clamp(mean(hBuf) / REF_HEIGHT, 1.0, 1.5)
      : clamp(mean(hBuf) / REF_HEIGHT, 0.5, 1.5);
    if (Math.max(...ampBuf) - Math.min(...ampBuf) < ea * ratio * sc) { armed = false; continue; }
    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2), t = row.t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; } armed = false; }
    }
  }
  return reps;
}

const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));
const CASES = [
  ["J1_static_2m", "width", "静止噪@2m", 0], ["C_noise12_2m", "width", "静止噪1.2@2m", 0],
  ["C2_noise20_2m", "width", "静止噪2.0@2m", 0], ["G_noise12_4m", "width", "静止噪1.2@4m", 0],
  ["J2_full_2m", "width", "全幅开合@2m", 9], ["J3_half_2m", "width", "半幅开合@2m", 9],
  ["J4_full_4m", "width", "全幅开合@4m", 9],
  ["E_squat06", "centroidY", "半蹲@2m(回归)", 9], ["H_squat06_4m", "centroidY", "半蹲@4m", 9]
];
const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
for (const zoom of ["none", "up", "both"]) {
  for (const ratio of [0.35, 0.4, 0.5]) {
    console.log(`\n--- 缩放=${zoom}  RATIO=${ratio}  门限=expectedAmplitude*${ratio}*scale ---`);
    console.log(pad("场景", 20) + pad("期望", 6) + "计数");
    let bad = 0;
    for (const [id, key, label, expect] of CASES) {
      const c = all[id]; if (!c || !c.series) continue;
      const ser = c.series.filter(r => isFinite(r[key]));
      const r = detect(ser, c.profile.tempoBand, c.profile.minRepGap, key, c.profile.expectedAmplitude, ratio, zoom, "whole");
      const ok = (expect === 0 && r === 0) || (expect > 0 && r >= Math.max(1, Math.round(expect * 0.6)) && r <= Math.round(expect * 2.2));
      if (!ok) bad++;
      console.log(pad(label, 20) + pad(expect, 6) + r + (ok ? "  ✓" : "  ✗"));
    }
    console.log(`不合格项：${bad}`);
  }
}
