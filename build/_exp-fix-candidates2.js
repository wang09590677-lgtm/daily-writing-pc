/* ==================================================================
 * _exp-fix-candidates2.js — 候选修复方案实验（第二轮：含根因修法 F / F′）
 *   只读产品文件，纯 Node。输出 build/_exp-fix-candidates2.json
 *
 * 背景：第一轮（_exp-fix-candidates.js）证明
 *   · 现状根因 = 每帧重扫最近 0.35s 的 d 尾部 → 同一 +k 平台被反复发现
 *   · 候选 F（单样本增量：每个样本只处理一次）在合成信号上 0/60 星
 *   · 但 F 在真实视频上把计数近乎腰斩（开合跳 10→5、跳绳 12→6）
 *
 * 本轮新增根因分析：
 *   production 的 detrend 窗口以样本 i 为中心、但在**段右端被裁剪**：
 *   仅有 [i-half, L-1]，缺右半窗 → 段右端样本的局部均值有偏（右边缘偏置）。
 *   F 每帧只处理"最新样本"，即永远在看被裁剪的右端样本 → 真实带噪信号上系统性少计。
 *   由此给出 **F′（居中延迟处理）**：每个样本只处理一次，且只在它已获得
 *   「完整居中窗口」（即再等 half 帧）之后才处理 → 既消除重复扫尾(2×)，
 *   又消除右端偏置(少计)。
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const FPS = 60;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function detrend(raw, win) {
  const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length; let gvar = 0;
  for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a);
    out[i] = (raw[i] - m) / gstd;
  }
  return out;
}
function smooth(raw, k) {
  if (k <= 1) return raw.slice(); const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; }
  return out;
}

const WIN3 = Math.round(3.5 * FPS);
const TAIL = Math.max(2, Math.round(FPS * 0.35));
const SMOOTH_K = Math.max(1, Math.round(FPS * 0.06));
function winOf(bandMax, wmaxSec) { return clamp(Math.round(FPS * 60 / Math.max(15, bandMax)), 3, Math.round(FPS * (wmaxSec || 1.5))); }

/* ---------------- 计次器（含 F′） ----------------
 * mode:
 *   "status"  生产现状：每帧重扫尾部 TAIL
 *   "incr"    F：每帧处理本帧新增的样本（含当前帧样本）
 *   "incrC"   F′：每帧只处理「刚好获得完整居中窗口」的那个样本（延迟 half 帧）
 * 其它开关沿用第一轮：kMul/kAbsFloor/kPeakFrac/fullCycle/gapMode/gapAlpha/winMode/wmaxSec/winMul
 * -------------------------------------------------- */
function runCounter(sig, height, profile, cfg) {
  cfg = cfg || {};
  const band = profile.tempoBand, minGapFixed = profile.minRepGap;
  const win = winOf(cfg.winMode === "bandMin" ? band[0] : band[1], cfg.wmaxSec) * (cfg.winMul || 1);
  const kMul = cfg.kMul || 0.85, kAbsFloor = cfg.kAbsFloor || 0.45, kPeakFrac = cfg.kPeakFrac || 0;
  const useFull = !!cfg.fullCycle, mode = cfg.mode || "status";
  const ea = (cfg.gateOff ? 1e-6 : (profile.expectedAmplitude || 0.1));
  const hMean = height && height.length ? mean(height.filter(Number.isFinite)) : 0.6;
  const bodyScale = clamp((hMean || 0.6) / 0.6, 1.0, 1.5);
  const gate = ea * 0.5 * bodyScale;

  const half = Math.floor(win / 2);
  const delay = mode === "incrC" ? clamp(half, 0, 45) : 0;

  let armed = false, lastAt = -1, reps = 0, repTimes = [];
  let phase = 0;
  let processedAbs = -1;

  for (let t = 0; t < sig.length; t++) {
    const from = Math.max(0, t + 1 - WIN3);
    const raw = sig.slice(from, t + 1);
    if (raw.length < 10) continue;
    const spread = Math.max(...raw) - Math.min(...raw);
    if (spread < gate) { armed = false; phase = 0; continue; }
    const d = smooth(detrend(raw, win), cfg.smoothK || SMOOTH_K);
    let rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    let k = clamp(rms * kMul, kAbsFloor, 2.2);
    if (kPeakFrac > 0) { let mx = 0; for (const v of d) { const a = Math.abs(v); if (a > mx) mx = a; } k = Math.max(k, mx * kPeakFrac); }
    let minGap = minGapFixed;
    if (cfg.gapMode === "adapt") {
      let sc = 0; for (let i = 1; i < d.length; i++) if ((d[i - 1]) * d[i] < 0) sc++;
      const domHz = sc > 0 ? sc / 2 / (d.length / FPS) : 0;
      if (domHz > 0.05) minGap = clamp((cfg.gapAlpha || 1.3) * (1 / domHz) / 2, 0.15, 3.0);
    }
    const base = t + 1 - raw.length;
    const now = (t + 1) / FPS;

    let lo, hi;
    if (mode === "incrC") {
      const targetAbs = t - delay;                 // 本帧恰好获得完整居中窗口的样本（绝对帧号）
      if (targetAbs < 0) continue;
      hi = targetAbs - base;                       // 转成当前窗口内下标
      lo = Math.max(0, processedAbs + 1 - base);   // 只处理尚未处理过的
      if (hi < lo) continue;
    } else if (mode === "incr") {
      lo = Math.max(0, processedAbs + 1 - base); hi = d.length - 1;
    } else {
      lo = d.length - Math.min(d.length, TAIL); hi = d.length - 1;
    }

    for (let i = lo; i <= hi; i++) {
      if (i < 0 || i >= d.length) continue;
      const v = d[i];
      if (useFull) {
        if (v < -k) phase = 1;
        else if (phase === 1 && v >= 0) phase = 2;
        else if (phase === 2 && v > k) {
          if (lastAt < 0 || now - lastAt >= minGap) { reps++; repTimes.push(+now.toFixed(2)); lastAt = now; }
          phase = 0;
        }
      } else {
        if (v < -k) armed = true;
        else if (v > k && armed) {
          if (lastAt < 0 || now - lastAt >= minGap) { reps++; repTimes.push(+now.toFixed(2)); lastAt = now; }
          armed = false;
        }
      }
    }
    processedAbs = base + hi;
  }
  return reps;
}

/* ---------------- 12 个 rep 动作（真值逐字抄自 data/fitness-plan.js） ---------------- */
const ACTIONS = [
  { id: "halfSquatWarm", cn: "半蹲热身", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 },
  { id: "jumpingJacks", cn: "开合跳", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 },
  { id: "jumpRope", cn: "跳绳", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 },
  { id: "squat", cn: "徒手深蹲", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 },
  { id: "lunge", cn: "弓步蹲", signal: "height", tempoBand: [12, 36], minRepGap: 1.1, expectedAmplitude: 0.12 },
  { id: "calfRaise", cn: "提踵", signal: "height", tempoBand: [20, 55], minRepGap: 0.7, expectedAmplitude: 0.045 },
  { id: "gluteBridge", cn: "臀桥", signal: "height", tempoBand: [15, 40], minRepGap: 1.0, expectedAmplitude: 0.08 },
  { id: "stepUp", cn: "台阶踏步", signal: "centroidY", tempoBand: [15, 40], minRepGap: 1.1, expectedAmplitude: 0.09 },
  { id: "abWheel", cn: "跪姿健腹轮", signal: "centroidY", tempoBand: [8, 25], minRepGap: 1.2, expectedAmplitude: 0.10 },
  { id: "deadBug", cn: "死虫式", signal: "height", tempoBand: [10, 30], minRepGap: 1.2, expectedAmplitude: 0.06 },
  { id: "burpee", cn: "波比跳", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 0.16 },
  { id: "lateralHop", cn: "侧向跳", signal: "width", tempoBand: [40, 100], minRepGap: 0.45, expectedAmplitude: 0.18 }
];
const EXPECT = {
  halfSquatWarm: ["centroidY", 15, 40, 0.9, 0.06], jumpingJacks: ["width", 40, 90, 0.45, 0.18],
  jumpRope: ["height", 60, 120, 0.3, 0.05], squat: ["height", 15, 45, 0.9, 0.12],
  lunge: ["height", 12, 36, 1.1, 0.12], calfRaise: ["height", 20, 55, 0.7, 0.045],
  gluteBridge: ["height", 15, 40, 1.0, 0.08], stepUp: ["centroidY", 15, 40, 1.1, 0.09],
  abWheel: ["centroidY", 8, 25, 1.2, 0.10], deadBug: ["height", 10, 30, 1.2, 0.06],
  burpee: ["height", 12, 35, 1.4, 0.16], lateralHop: ["width", 40, 100, 0.45, 0.18]
};
for (const A of ACTIONS) {
  const e = EXPECT[A.id];
  if (!e || e[0] !== A.signal || e[1] !== A.tempoBand[0] || e[2] !== A.tempoBand[1] || e[3] !== A.minRepGap || e[4] !== A.expectedAmplitude)
    throw new Error("动作真值与 fitness-plan.js 不符: " + A.id);
}
console.log("真值交叉核对通过：12 个 rep 动作 signal/band/minRepGap/expectedAmplitude 与 fitness-plan.js 一致。\n");

const SECS = 20, N = Math.round(SECS * FPS);
function synthSignal(freq, ea) {
  const x = new Array(N); for (let i = 0; i < N; i++) x[i] = ea * 0.5 * (1 - Math.cos(2 * Math.PI * freq * (i / FPS)));
  return x;
}

/* ---------------- 候选集 ---------------- */
const CANDIDATES = [
  { key: "现状", cfg: { mode: "status" } },
  { key: "A1 k=1.2rms", cfg: { mode: "status", kMul: 1.2 } },
  { key: "A2 k=1.8rms", cfg: { mode: "status", kMul: 1.8 } },
  { key: "A3 k下限0.8", cfg: { mode: "status", kAbsFloor: 0.8 } },
  { key: "A4 k≥0.35峰", cfg: { mode: "status", kPeakFrac: 0.35 } },
  { key: "B 完整下-上", cfg: { mode: "status", fullCycle: true } },
  { key: "C 自适应minGap", cfg: { mode: "status", gapMode: "adapt", gapAlpha: 1.3 } },
  { key: "D win由band0/上限3s", cfg: { mode: "status", winMode: "bandMin", wmaxSec: 3.0 } },
  { key: "E win×3(上限3s)", cfg: { mode: "status", winMul: 3, wmaxSec: 3.0 } },
  { key: "F 单样本增量", cfg: { mode: "incr" } },
  { key: "F′ 居中延迟增量", cfg: { mode: "incrC" } },
  { key: "F+B 增量+完整下-上", cfg: { mode: "incr", fullCycle: true } },
  { key: "F′+B 居中增量+完整", cfg: { mode: "incrC", fullCycle: true } }
];

const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const padL = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s = " " + s; return s; };

const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: FPS, secs: SECS, note: "signal-level synth (pp=ea) + real captured series", round: 2 }, matrix: {}, falseCount: {}, realVideo: {}, starCount: {} };
for (const c of CANDIDATES) out.starCount[c.key] = 0;

console.log("=== 表 1：12 rep 动作 × band 内 3~5 拍速 比值矩阵（合成 pp=ea 正弦，20s）===");
console.log("（格子=引擎reps/物理周期，★ 表示 >1.5）\n");
for (const A of ACTIONS) {
  const b0 = A.tempoBand[0] / 60, b1 = A.tempoBand[1] / 60;
  const freqs = [0, 0.25, 0.5, 0.75, 1.0].map(t => +(b0 + (b1 - b0) * t).toFixed(3));
  const p = { mode: "rep", signal: A.signal, tempoBand: A.tempoBand, minRepGap: A.minRepGap, expectedAmplitude: A.expectedAmplitude };
  out.matrix[A.id] = { cn: A.cn, signal: A.signal, bandBPM: A.tempoBand, minRepGap: A.minRepGap, rows: {} };
  console.log(`【${A.cn} · ${A.signal} · band ${A.tempoBand[0]}~${A.tempoBand[1]}/分 · minGap=${A.minRepGap} · ea=${A.expectedAmplitude}】`);
  console.log("  拍速/分 : " + freqs.map(f => padL(Math.round(f * 60), 8)).join(""));
  for (const c of CANDIDATES) {
    const cells = [];
    for (const f of freqs) {
      const sig = synthSignal(f, A.expectedAmplitude);
      const reps = runCounter(sig, null, p, c.cfg);
      const truth = Math.round(f * SECS);
      const ratio = truth ? reps / truth : 0;
      out.matrix[A.id].rows[c.key + "|" + Math.round(f * 60)] = { reps, truth, ratio: +ratio.toFixed(2) };
      if (ratio > 1.5) out.starCount[c.key]++;
      cells.push(padL((ratio.toFixed(2) + (ratio > 1.5 ? "★" : "")), 8));
    }
    console.log("  " + pad(c.key, 22) + cells.join(""));
  }
  console.log("");
}

/* ---------------- 表 2：抗误计回归 ---------------- */
console.log("=== 表 2：抗误计回归（静止 / 静止+亚像素抖动 / 静止+噪@2m/@4m）—— reps 必须全 0 ===\n");
const serData = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const FALSE_CASES = [
  ["A_static_2m", "width", "完全静止@2m"],
  ["B_noise06_2m", "width", "静止+噪0.6px@2m"],
  ["C_noise12_2m", "width", "静止+噪1.2px@2m"],
  ["C2_noise20_2m", "width", "静止+噪2.0px@2m"],
  ["G_noise12_4m", "width", "静止+噪1.2px@4m"]
];
out.falseCount.rows = {};
console.log(pad("情形", 22) + CANDIDATES.map(c => padL(c.key.split(" ")[0].replace("′", ""), 7)).join(""));
console.log("-".repeat(22 + CANDIDATES.length * 7));
for (const [id, key, label] of FALSE_CASES) {
  const c = serData[id]; if (!c || !c.series) { console.log("缺 " + id); continue; }
  const ser = c.series.filter(r => isFinite(r[key]));
  const sig = ser.map(r => r[key]), hgt = ser.map(r => r.height);
  const p = c.profile;
  const cells = [];
  out.falseCount.rows[label] = {};
  for (const cand of CANDIDATES) {
    const reps = runCounter(sig, hgt, p, cand.cfg);
    out.falseCount.rows[label][cand.key] = reps;
    cells.push(padL(reps === 0 ? "0✓" : reps + "✗", 7));
  }
  console.log(pad(label, 22) + cells.join(""));
}

/* ---------------- 表 3：真实视频 5 样本 ---------------- */
console.log("\n=== 表 3：真实视频 5 样本 reps（现状参考 10/6/6/12/4；偏差 >±2 标 ✗）===\n");
const rsPath = path.join(__dirname, "_tmp", "_realseries.json");
const out3 = { rows: {} };
if (fs.existsSync(rsPath)) {
  const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
  console.log(pad("动作", 11) + pad("key", 14) + CANDIDATES.map(c => padL(c.key.split(" ")[0].replace("′", ""), 7)).join(""));
  console.log("-".repeat(25 + CANDIDATES.length * 7));
  for (const id of Object.keys(rs.acts)) {
    const a = rs.acts[id];
    const sig = a.series.map(r => r[a.signal]), hgt = a.series.map(r => r.height);
    const cells = [];
    out3.rows[a.cn] = { ref: a.repsGateOn, scores: {} };
    for (const cand of CANDIDATES) {
      const reps = runCounter(sig, hgt, a.profile, cand.cfg);
      const dev = reps - a.repsGateOn;
      out3.rows[a.cn].scores[cand.key] = { reps, dev };
      cells.push(padL(reps + (Math.abs(dev) > 2 ? "✗" : ""), 7));
    }
    console.log(pad(a.cn, 11) + pad(id, 14) + cells.join(""));
  }
} else console.log("缺 _tmp/_realseries.json");
out.realVideo = out3;

fs.writeFileSync(path.join(__dirname, "_exp-fix-candidates2.json"), JSON.stringify(out, null, 2));

console.log("\n===== 汇总：各候选 12 动作 × 5 拍速 >1.5 星数（越少越好） =====");
for (const c of CANDIDATES) console.log("  " + pad(c.key, 24) + out.starCount[c.key] + " / 60");
console.log("\n结果已写入 build/_exp-fix-candidates2.json");
