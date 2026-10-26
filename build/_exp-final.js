// 最终对比：把两组真实引擎采集（基础场景 + 真实幅度开合跳）合起来，
// 报「现状计次器」与「加绝对幅度门限的计次器」的计数，并附信号量级统计。
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

const FPS = 60, SMOOTH_K = Math.max(1, Math.round(FPS * 0.06)), REF_HEIGHT = 0.6;

function detect_OLD(ser, band, minGap, key) {
  const w = clamp(Math.round((FPS * 60) / Math.max(15, band[1])), 3, Math.round(FPS * 1.5));
  const tail = Math.max(2, Math.round(FPS * 0.35)), maxBuf = Math.round(FPS * 3.5);
  let armed = false, lastAt = -1, reps = 0; const buf = [];
  for (const row of ser) {
    buf.push(row[key]); while (buf.length > maxBuf) buf.shift();
    if (buf.length < 10) continue;
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
function detect_NEW(ser, band, minGap, key, ea, ratio, zoom) {
  const w = clamp(Math.round((FPS * 60) / Math.max(15, band[1])), 3, Math.round(FPS * 1.5));
  const tail = Math.max(2, Math.round(FPS * 0.35)), maxBuf = Math.round(FPS * 3.5);
  // 与生产 detectReps 一致：幅度门限看的是**同一个 raw 窗（3.5s）**，不是"一个最慢周期"
  const ampMax = maxBuf, hMax = Math.round(FPS * 6);
  let armed = false, lastAt = -1, reps = 0, gatedFrames = 0;
  const buf = [], ampBuf = [], hBuf = [];
  for (const row of ser) {
    buf.push(row[key]); if (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]); if (ampBuf.length > ampMax) ampBuf.shift();
    hBuf.push(row.height); if (hBuf.length > hMax) hBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;
    // zoom: true = 只往上缩放（与生产 detectReps 一致，下限 1.0）；false = 不缩放
    const sc = zoom ? clamp(mean(hBuf) / REF_HEIGHT, 1.0, 1.5) : 1;
    const gate = ea * ratio * sc;
    const spread = Math.max(...ampBuf) - Math.min(...ampBuf);
    if (spread < gate) { gatedFrames++; armed = false; continue; }
    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2), t = row.t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; } armed = false; }
    }
  }
  return { reps, gatedFrames };
}
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)]; }
function rollPP(a, n) {const o=[];for(let i=0;i<a.length;i++){let mn=Infinity,mx=-Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++){if(a[j]<mn)mn=a[j];if(a[j]>mx)mx=a[j];}o.push(mx-mn);}return o;}

const d1 = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const d2 = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8"));
const all = Object.assign({}, d1, d2);
delete all.A_static_2m; // 用 J1 的静止场景（同尺寸）替代，避免重复

const CASES = [
  ["J1_static_2m", "width", "静止+噪1.2px@2m", "0（现缺陷：乱数）"],
  ["C_noise12_2m", "width", "静止+噪1.2px@2m(窄人形)", "0（现缺陷：乱数）"],
  ["C2_noise20_2m", "width", "静止+噪2.0px@2m", "0（现缺陷：乱数）"],
  ["G_noise12_4m", "width", "静止+噪1.2px@4m", "0（现缺陷：乱数）"],
  ["J2_full_2m", "width", "全幅开合跳@2m", "12s→约 9"],
  ["J3_half_2m", "width", "半幅开合跳@2m", "12s→约 9"],
  ["J4_full_4m", "width", "全幅开合跳@4m", "12s→约 9"],
  ["E_squat06", "centroidY", "半蹲0.6Hz@2m(回归)", "15s→9（硬约束）"],
  ["H_squat06_4m", "centroidY", "半蹲0.6Hz@4m", "15s→9"]
];

const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
console.log("=== 最终对照（数据源：真实 motion-engine.js 产出的逐帧信号）===");
console.log("   ②新 = 生产 detectReps 的门限参数：ratio=0.5、只往上缩放（下限 1.0）");
console.log(pad("场景", 30) + pad("信号", 10) + pad("时长", 7) + pad("①现状", 7) + pad("②新@0.5", 9) + pad("②新@0.4", 9) + "期望");
console.log("-".repeat(100));
for (const [id, key, label, expect] of CASES) {
  const c = all[id]; if (!c || !c.series) { console.log("缺数据 " + id); continue; }
  const ser = c.series.filter(r => isFinite(r[key]));
  const dur = ser[ser.length - 1].t;
  const o = detect_OLD(ser, c.profile.tempoBand, c.profile.minRepGap, key);
  const n6 = detect_NEW(ser, c.profile.tempoBand, c.profile.minRepGap, key, c.profile.expectedAmplitude, 0.5, true);
  const n4 = detect_NEW(ser, c.profile.tempoBand, c.profile.minRepGap, key, c.profile.expectedAmplitude, 0.4, true);
  console.log(pad(label, 30) + pad(key, 10) + pad(dur.toFixed(1) + "s", 7) + pad(o, 7)
    + pad(n6.reps, 9) + pad(n4.reps, 9) + expect);
}

console.log("\n=== 信号幅度量级（跳过起始 2.5s 收敛期，1.5s 滚动峰峰值 p10/p50/p90）===");
console.log(pad("场景", 30) + pad("人形高", 9) + pad("p10", 9) + pad("p50", 9) + pad("p90", 9) + "expectedAmp");
console.log("-".repeat(96));
for (const [id, key, label] of CASES) {
  const c = all[id]; if (!c || !c.series) continue;
  const ser = c.series.filter(r => isFinite(r[key]));
  const arr = ser.map(r => r[key]);
  const w = rollPP(arr, 90).slice(150);
  const hm = mean(ser.map(r => r.height));
  console.log(pad(label, 30) + pad(hm.toFixed(3), 9) + pad(pct(w, .1).toFixed(4), 9)
    + pad(pct(w, .5).toFixed(4), 9) + pad(pct(w, .9).toFixed(4), 9) + c.profile.expectedAmplitude);
}
