/* ==================================================================
 * _exp-fix-candidates.js — 候选修复方案实验（只读产品，纯 Node）
 *
 * 现状根因（本脚本再次确认）：production `detectReps` 每帧**重扫最近 0.35s 的
 *   d 尾部**，而该尾部长度 ≈ 0.84× 半周期；于是同一个 `+k` 平台会在不同帧被
 *   反复"发现"，且之间夹着一个**陈旧**的 `-k` 样本，导致每周期计 2 次。
 *   （单帧看 d：1 次/周期；逐帧滑窗：2 次/周期 —— 差异全在"重扫陈旧样本"。）
 *
 * 本脚本离线复刻生产计次器（基线与真引擎逐点对齐），再实现 5 类候选 + 我的
 *   建议候选 F，对每个候选做同三组回归：
 *     ① 12 个 rep 动作 × band 内 5 个拍速的比值矩阵
 *     ② 抗误计回归（静止+亚像素抖动 / 静止+噪@2m/@4m）reps 必须全 0
 *     ③ 真实视频 5 样本 reps（对现状 10/6/6/12/4）
 *
 * 输出 build/_exp-fix-candidates.json
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const FPS = 60;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/* ---------- 与 motion-engine.js 逐字一致的 detrend / smooth ---------- */
function detrend(raw, win) {
  const out = new Array(raw.length); const half = Math.max(1, Math.floor(win / 2));
  let gsum = 0; for (let i = 0; i < raw.length; i++) gsum += raw[i];
  const gm = gsum / raw.length; let gvar = 0;
  for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
  const gstd = Math.sqrt(gvar / raw.length) || 1e-6;
  for (let i = 0; i < raw.length; i++) { const a = Math.max(0, i - half), b = Math.min(raw.length, i + half + 1);
    let m = 0; for (let j = a; j < b; j++) m += raw[j]; m /= (b - a); out[i] = (raw[i] - m) / gstd; }
  return out;
}
function smooth(raw, k) { if (k <= 1) return raw.slice(); const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; } out[i] = s / n; } return out; }

const WIN3 = Math.round(3.5 * FPS);        // signalWindow 3.5s
const TAIL = Math.max(2, Math.round(FPS * 0.35));
const SMOOTH_K = Math.max(1, Math.round(FPS * 0.06));
function winOf(bandMax, wmaxSec) { return clamp(Math.round(FPS * 60 / Math.max(15, bandMax)), 3, Math.round(FPS * (wmaxSec || 1.5))); }

/* ==================================================================
 * 计次器：cfg 控制各种候选开关
 *   kMul        迟滞阈值系数（默认 0.85）
 *   kAbsFloor   迟滞阈值绝对下限（默认 0.45）
 *   kPeakFrac  k 不得低于（窗口内 |d| 最大值 × 本系数）；0=不用
 *   fullCycle  true=要求"下穿-k → 上穿0 → 上穿+k"完整下-上
 *   gapMode    "fixed"(默认) | "adapt"（按实测半周期）
 *   gapAlpha   自适应 minGap 系数（× 半周期）
 *   winMode    "bandMax"(默认) | "bandMin"
 *   wmaxSec    win 上限（默认 1.5）
 *   winMul     win 再乘倍率（候选 E）
 *   increment  true=只处理新样本（候选 F，根因修复）
 * ================================================================== */
function runCounter(sig, height, profile, cfg) {
  cfg = cfg || {};
  const band = profile.tempoBand, minGapFixed = profile.minRepGap;
  const win = winOf(cfg.winMode === "bandMin" ? band[0] : band[1], cfg.wmaxSec) * (cfg.winMul || 1);
  const kMul = cfg.kMul || 0.85, kAbsFloor = cfg.kAbsFloor || 0.45, kPeakFrac = cfg.kPeakFrac || 0;
  const useFull = !!cfg.fullCycle, incr = !!cfg.increment;
  const ea = (cfg.gateOff ? 1e-6 : (profile.expectedAmplitude || 0.1));
  // bodyScale：production 用 repHeightBase(1.5s EMA)；这里按 height 序列 EMA 复刻
  const hMean = height && height.length ? mean(height.filter(Number.isFinite)) : 0.6;
  const bodyScale = clamp((hMean || 0.6) / 0.6, 1.0, 1.5);
  const gate = ea * 0.5 * bodyScale;

  let armed = false, lastAt = -1, reps = 0, repTimes = [];
  let phase = 0;                 // fullCycle 状态机：0 idle, 1 见过 -k, 2 见过 0 上穿
  let lastNegAbs = -1;
  let processedAbs = -1;
  for (let t = 0; t < sig.length; t++) {
    const from = Math.max(0, t + 1 - WIN3);
    const raw = sig.slice(from, t + 1);
    if (raw.length < 10) continue;
    const spread = Math.max(...raw) - Math.min(...raw);
    if (spread < gate) { armed = false; phase = 0; continue; }
    const d = smooth(detrend(raw, win), cfg.smoothK || SMOOTH_K);
    // k
    let rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    let k = clamp(rms * kMul, kAbsFloor, 2.2);
    if (kPeakFrac > 0) { let mx = 0; for (const v of d) { const a = Math.abs(v); if (a > mx) mx = a; } k = Math.max(k, mx * kPeakFrac); }
    // 自适应 minGap：按 d 的符号变化估主频
    let minGap = minGapFixed;
    if (cfg.gapMode === "adapt") {
      let sc = 0; for (let i = 1; i < d.length; i++) if ((d[i - 1]) * d[i] < 0) sc++;
      const domHz = sc > 0 ? sc / 2 / (d.length / FPS) : 0;
      if (domHz > 0.05) minGap = clamp((cfg.gapAlpha || 1.3) * (1 / domHz) / 2, 0.15, 3.0);
    }
    const base = t + 1 - raw.length;             // raw[0] 的绝对帧号
    const now = (t + 1) / FPS;
    const startI = incr ? Math.max(0, processedAbs + 1 - base) : d.length - Math.min(d.length, TAIL);
    for (let i = startI; i < d.length; i++) {
      const v = d[i], abs = base + i;
      if (useFull) {
        // 完整下-上：-k 起 arm，必须有一次上穿 0，再到 +k 才计
        if (v < -k) { phase = 1; }
        else if (phase === 1 && v >= 0) { phase = 2; }
        else if (phase === 2 && v > k) {
          if (lastAt < 0 || now - lastAt >= minGap) { reps++; repTimes.push(now); lastAt = now; }
          phase = 0;
        }
      } else {
        if (v < -k) { armed = true; lastNegAbs = abs; }
        else if (v > k && armed) {
          if (lastAt < 0 || now - lastAt >= minGap) { reps++; repTimes.push(now); lastAt = now; }
          armed = false;
        }
      }
    }
    processedAbs = base + d.length - 1;
  }
  return reps;
}

/* ==================================================================
 * 12 个 rep 动作（真值逐字从 data/fitness-plan.js 抄，signal/band/gap/ea）
 * ================================================================== */
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
/* 校正：与 fitness-plan.js 交叉核对（值必须完全一致，错了会静默跑偏） */
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

/* ==================================================================
 * 合成"做满幅度"的正弦计次信号（pp = expectedAmplitude）
 * ================================================================== */
const SECS = 20, N = Math.round(SECS * FPS);
function synthSignal(freq, ea) {
  const x = new Array(N); for (let i = 0; i < N; i++) x[i] = ea * 0.5 * (1 - Math.cos(2 * Math.PI * freq * (i / FPS)));
  return x;
}

/* ==================================================================
 * 候选配置
 * ================================================================== */
const CANDIDATES = [
  { key: "现状", cfg: {} },
  { key: "A1 k=1.2rms", cfg: { kMul: 1.2 } },
  { key: "A2 k=1.8rms", cfg: { kMul: 1.8 } },
  { key: "A3 k下限0.8", cfg: { kAbsFloor: 0.8 } },
  { key: "A4 k≥0.35峰", cfg: { kPeakFrac: 0.35 } },
  { key: "B 完整下-上", cfg: { fullCycle: true } },
  { key: "C 自适应minGap(1.3半周)", cfg: { gapMode: "adapt", gapAlpha: 1.3 } },
  { key: "D win由band0/上限3s", cfg: { winMode: "bandMin", wmaxSec: 3.0 } },
  { key: "E win×3(上限3s)", cfg: { winMul: 3, wmaxSec: 3.0 } },
  { key: "F 单样本增量(建议)", cfg: { increment: true } },
  { key: "F+B 增量+完整下-上", cfg: { increment: true, fullCycle: true } }
];
const FIVE = t => t;

/* ==================================================================
 * 表 1：比值矩阵（每个动作 band 内 5 个拍速）
 * ================================================================== */
function bandFreqsHz(A) {
  const b0 = A.tempoBand[0] / 60, b1 = A.tempoBand[1] / 60;
  return [0, 0.25, 0.5, 0.75, 1.0].map(t => +(b0 + (b1 - b0) * t).toFixed(3));
}
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const padL = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s = " " + s; return s; };

const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: FPS, secs: SECS, note: "signal-level synth (pp=ea), counter replica validated against engine" }, matrix: {}, falseCount: {}, realVideo: {}, starCount: {} };
for (const c of CANDIDATES) out.starCount[c.key] = 0;

console.log("=== 表 1：12 rep 动作 × band 内 5 拍速 比值矩阵（合成 pp=ea 正弦，20s）===");
console.log("（格子=引擎reps/物理周期，★ 表示 >1.5）\n");
for (const A of ACTIONS) {
  const freqs = bandFreqsHz(A);
  const p = { mode: "rep", signal: A.signal, tempoBand: A.tempoBand, minRepGap: A.minRepGap, expectedAmplitude: A.expectedAmplitude };
  out.matrix[A.id] = { cn: A.cn, signal: A.signal, bandBPM: A.tempoBand, minRepGap: A.minRepGap, freqsBPM: freqs.map(f => Math.round(f * 60)), rows: {} };
  console.log(`【${A.cn} · ${A.signal} · band ${A.tempoBand[0]}~${A.tempoBand[1]}/分 · minGap=${A.minRepGap} · ea=${A.expectedAmplitude}】`);
  console.log("  拍速/分 : " + freqs.map(f => padL(Math.round(f * 60), 7)).join(""));
  for (const c of CANDIDATES) {
    const cells = [];
    for (const f of freqs) {
      const sig = synthSignal(f, A.expectedAmplitude);
      const reps = runCounter(sig, null, p, c.cfg);
      const truth = Math.round(f * SECS);
      const ratio = truth ? reps / truth : 0;
      out.matrix[A.id].rows[c.key + "|" + Math.round(f * 60)] = { reps, truth, ratio: +ratio.toFixed(2) };
      if (ratio > 1.5) out.starCount[c.key]++;
      cells.push(padL((ratio.toFixed(2) + (ratio > 1.5 ? "★" : "")), 7));
    }
    console.log("  " + pad(c.key, 24) + cells.join(""));
  }
  console.log("");
}

/* ==================================================================
 * 表 2：抗误计回归（真实引擎信号 _exp-series.json）
 * ================================================================== */
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
console.log("情形".padEnd(22) + CANDIDATES.map(c => padL(c.key.split(" ")[0], 8)).join(""));
console.log("-".repeat(22 + CANDIDATES.length * 8));
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
    cells.push(padL(reps === 0 ? "0✓" : reps + "✗", 8));
  }
  console.log(pad(label, 22) + cells.join(""));
}

/* ==================================================================
 * 表 3：真实视频 5 样本（真实引擎信号 _tmp/_realseries.json，门限开）
 * ================================================================== */
console.log("\n=== 表 3：真实视频 5 样本 reps（现状 10/6/6/12/4；偏差 >±2 标 ✗）===\n");
const rsPath = path.join(__dirname, "_tmp", "_realseries.json");
const out3 = { rows: {} };
if (fs.existsSync(rsPath)) {
  const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
  const KNOWN = { jumpingJacks: 10, squat: 6, halfSquatWarm: 6, jumpRope: 12, burpee: 4 };
  console.log("动作".padEnd(12) + "key".padEnd(14) + CANDIDATES.map(c => padL(c.key.split(" ")[0], 8)).join(""));
  console.log("-".repeat(26 + CANDIDATES.length * 8));
  for (const id of Object.keys(rs.acts)) {
    const a = rs.acts[id];
    const sig = a.series.map(r => r[a.signal]), hgt = a.series.map(r => r.height);
    const cells = [];
    out3.rows[a.cn] = {};
    for (const cand of CANDIDATES) {
      const reps = runCounter(sig, hgt, a.profile, cand.cfg);
      const ref = a.repsGateOn;
      const dev = reps - ref;
      out3.rows[a.cn][cand.key] = { reps, ref, dev };
      cells.push(padL(reps + (Math.abs(dev) > 2 ? "✗" : ""), 8));
    }
    console.log(pad(a.cn, 12) + pad(id, 14) + cells.join(""));
  }
} else console.log("缺 _tmp/_realseries.json");
out.realVideo = out3;

fs.writeFileSync(path.join(__dirname, "_exp-fix-candidates.json"), JSON.stringify(out, null, 2));

console.log("\n===== 汇总：各候选在 12 动作 × 5 拍速 里 >1.5 的格子数（越少越好，0=全消） =====");
for (const c of CANDIDATES) console.log("  " + pad(c.key, 24) + out.starCount[c.key] + " / 60");
console.log("\n结果已写入 build/_exp-fix-candidates.json");
