// 回放实验：在同一段**真实引擎产出**的信号序列上，对比
//   ① 现状计次器（复刻 motion-engine.js detectReps）
//   ② 加「绝对幅度门限」的计次器（最小改动方案）
// 检验：是否能做到「站着不动不计数、真动作照数、远距离也照数」。
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b, label) {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("截取失败 " + label);
  return src.slice(i, j);
}
const fns = new Function(`
  ${grab("function clamp(v, a, b)", "function mean(arr)", "clamp")}
  ${grab("function mean(arr)", "function std(arr)", "mean")}
  ${grab("function std(arr)", "// 动作参数默认值", "std")}
  ${grab("function detrend(raw, win)", "function smooth(raw, k)", "detrend")}
  ${grab("function smooth(raw, k)", "// 峰值计次", "smooth")}
  return { clamp, mean, std, detrend, smooth };
`)();
const { clamp, mean, std, detrend, smooth } = fns;

const FPS = 60;   // 实测；series 里 t 也是按帧来的
function win(tempoBandMax) { return clamp(Math.round((FPS * 60) / Math.max(15, tempoBandMax)), 3, Math.round(FPS * 1.5)); }
const SMOOTH_K = Math.max(1, Math.round(FPS * 0.06));

// ---------- ① 现状计次器 ----------
function detect_OLD(series, band, minGap, key) {
  const w = win(band[1]);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [];
  const tail = Math.max(2, Math.round(FPS * 0.35));
  const winSec = 3.5, maxBuf = Math.round(FPS * winSec);
  for (let f = 0; f < series.length; f++) {
    buf.push(series[f][key]);
    while (buf.length > maxBuf) buf.shift();
    if (buf.length < 10) continue;
    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const t = series[f].t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) {
        if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; }
        armed = false;
      }
    }
  }
  return reps;
}

// ---------- ② 新计次器：加绝对幅度门限（尺度无关） ----------
// 关键点：
//   1) 门限用「原始信号（未归一化）的最近峰峰值」和 expectedAmplitude 比 —— 恢复绝对幅度信息
//   2) 用「人形包围盒高度 / 参考身高」做人形尺度参考 —— 距离远/近自动缩放，不写死像素值
//   3) 门限不通过时清掉 armed，杜绝噪声穿透
const REF_HEIGHT = 0.6;      // 站位校准时"人占画面高度"的推荐中值（45%~75%）
const AMP_RATIO = 0.6;       // 峰峰值至少要达到 expectedAmplitude 的 60% 才算"做了动作"
function detect_NEW(series, band, minGap, key, expectedAmplitude, bandMin) {
  const w = win(band[1]);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [];
  const tail = Math.max(2, Math.round(FPS * 0.35));
  const maxBuf = Math.round(FPS * 3.5);
  // 幅度门限的观察窗：至少容纳"最慢那一拍"的一个完整周期
  const ampWinSec = clamp(60 / Math.max(10, bandMin || 20), 1.2, 3.0);
  const ampBuf = [];
  const ampMax = Math.round(FPS * ampWinSec);
  // 人形尺度：用包围盒高度的慢基线（这里用 6 秒滑动均值近似）
  const hBuf = [];
  const hMax = Math.round(FPS * 6);
  let gated = 0, passed = 0;
  for (let f = 0; f < series.length; f++) {
    const row = series[f];
    buf.push(row[key]);
    while (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]);
    while (ampBuf.length > ampMax) ampBuf.shift();
    hBuf.push(row.height);
    while (hBuf.length > hMax) hBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;

    const hBase = hBuf.length ? mean(hBuf) : REF_HEIGHT;
    const bodyScale = clamp(hBase / REF_HEIGHT, 0.5, 1.5);
    const gate = (expectedAmplitude || 0.1) * AMP_RATIO * bodyScale;
    const spread = Math.max(...ampBuf) - Math.min(...ampBuf);
    if (spread < gate) { gated++; armed = false; continue; }
    passed++;

    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2);
    const t = row.t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) {
        if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; }
        armed = false;
      }
    }
  }
  return { reps, gated, passed };
}

// ---------- ③ 只加"绝对门限"但不做距离缩放的版本（对照） ----------
function detect_ABS(series, band, minGap, key, expectedAmplitude, bandMin) {
  const w = win(band[1]);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [], ampBuf = [];
  const tail = Math.max(2, Math.round(FPS * 0.35));
  const maxBuf = Math.round(FPS * 3.5);
  const ampMax = Math.round(FPS * clamp(60 / Math.max(10, bandMin || 20), 1.2, 3.0));
  for (let f = 0; f < series.length; f++) {
    const row = series[f];
    buf.push(row[key]); while (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]); while (ampBuf.length > ampMax) ampBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;
    const gate = (expectedAmplitude || 0.1) * AMP_RATIO;
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
  ["A_static_2m", "width", "完全静止@2m", "应为 0"],
  ["B_noise06_2m", "width", "静止+噪声0.6px@2m", "应为 0"],
  ["C_noise12_2m", "width", "静止+噪声1.2px@2m", "应为 0"],
  ["C2_noise20_2m", "width", "静止+噪声2.0px@2m", "应为 0"],
  ["G_noise12_4m", "width", "静止+噪声1.2px@4m", "应为 0"],
  ["D_jack08_2m", "width", "真开合跳0.8Hz@2m", "12s→约 9 次"],
  ["F_jack08_4m", "width", "真开合跳0.8Hz@4m", "12s→约 9 次"],
  ["E_squat06", "centroidY", "半蹲0.6Hz@2m（回归）", "15s→约 9 次"],
  ["H_squat06_4m", "centroidY", "半蹲0.6Hz@4m", "15s→约 9 次"]
];

const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
const rows = [];
console.log("=== 同一段真实引擎信号上，现状计次器 vs 加绝对幅度门限的计次器 ===\n");
console.log(pad("场景", 30) + pad("信号", 11) + pad("时长", 7) + pad("①现状", 8) + pad("②新(缩放)", 11) + pad("③绝对门限", 11) + "期望");
console.log("-".repeat(92));
for (const [id, key, label, expect] of CASES) {
  const c = data[id];
  if (!c || !c.series) { console.log("缺数据 " + id); continue; }
  const ser = c.series.filter(r => isFinite(r[key]));
  const band = c.profile.tempoBand, gap = c.profile.minRepGap, ea = c.profile.expectedAmplitude;
  const oldR = detect_OLD(ser, band, gap, key);
  const newR = detect_NEW(ser, band, gap, key, ea, band[0]);
  const absR = detect_ABS(ser, band, gap, key, ea, band[0]);
  const dur = ser.length ? ser[ser.length - 1].t : 0;
  const spread = Math.max(...ser.map(r => r[key])) - Math.min(...ser.map(r => r[key]));
  console.log(pad(label, 30) + pad(key, 11) + pad(dur.toFixed(1) + "s", 7)
    + pad(oldR, 8) + pad(`${newR.reps}(gate${newR.gated})`, 11) + pad(absR, 11) + expect
    + `   [原始峰峰值 ${spread.toFixed(4)} / 门限 ${(ea * AMP_RATIO).toFixed(3)}]`);
}

console.log("\n=== 门限尺度验证：原始峰峰值 vs 人形高度（距离→幅度同步缩放）===");
for (const [id, key, label] of CASES) {
  const c = data[id]; if (!c || !c.series) continue;
  const ser = c.series.filter(r => isFinite(r[key]));
  const hs = ser.map(r => r.height);
  const hm = hs.length ? mean(hs) : 0;
  const spread = Math.max(...ser.map(r => r[key])) - Math.min(...ser.map(r => r[key]));
  console.log(`${pad(label, 30)} 人形高度均值=${hm.toFixed(3)} → bodyScale=${clamp(hm / 0.6, 0.5, 1.5).toFixed(3)}  信号峰峰值=${spread.toFixed(4)}`);
}
