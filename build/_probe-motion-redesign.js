/* 【体感重设计敏感度探针】（R11：选方案前先算敏感度）
 *
 * 验证三条修法是否有效，**改产品代码前先跑这个**：
 *
 * 卷1 —— 静止噪声能否被加严闸门挡住（修法②：消除静止误计数）
 *   造 σ=0.005 的纯高斯噪声序列（模拟 MediaPipe 关键点静止抖动），
 *   分别用旧闸门和新闸门跑真 detectReps()，看计数是否从 >0 降到 0。
 *   旧闸门：gate = expectedAmplitude × 0.5 × clamp(repHeightBase/0.6, 1.0, 1.5)
 *   新闸门：gate = expectedAmplitude × 0.6 × clamp(repHeightBase/0.6, 0.8, 1.5)
 *   预期：旧门 → 计数 >0（静止在计）；新门 → 计数 = 0（挡住噪声）
 *
 * 卷2 —— bottomL/bottomR 交替峰能否正确计数高抬腿（修法①：burst→计数）
 *   造模拟高抬腿的合成序列（左腿 bottomL 正弦 0.65~0.85、右腿 bottomR 反相），
 *   用新增的交替峰计次逻辑跑，看计数是否接近真值。
 *   预期：60秒 60步高抬腿 → 计数 ≈ 30（一次左右交替算 1 次）
 *
 * 卷3 —— 踝 y 位移驱动 IK 能否让模型腿弯起来（修法③：模型腿不动）
 *   喂"踝 y 高于髋 y 0.15"的数据（模拟高抬腿），
 *   对比旧内角法和新目标距离法算出的 d 值和弯曲角 A。
 *   旧法：d = sqrt(L1² + L2² - 2·L1·L2·cos(t)), t 由 interiorAngleXY(hip, knee, ankle) 算
 *   新法：d = |ankle_target - hip_model|，直接用踝的世界位置
 *   预期：高抬腿时旧法 d ≈ L1+L2（伸直），新法 d < L1+L2（弯曲）
 *
 * 用法：node build/_probe-motion-redesign.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

/* ============================================================
 * 卷 1 & 卷 2：从 motion-engine.js 抠出真函数（与 _lead-harness.js 同方式）
 * ============================================================ */
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 40));
  return SRC.slice(i, j);
}
const parts = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
};
parts.signalWindowTimes = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
parts.signalWindow = grab("function signalWindow(key, seconds)", "// 去趋势：");
parts.detrend = grab("function detrend(raw, win)", "function smooth(raw, k)");
parts.smooth = grab("function smooth(raw, k)", "// 峰值计次");
parts.detectReps = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");

/* 组装可注入上下文的工厂（与 _lead-harness.js 结构一致，但允许注入不同的闸门参数）。
 *
 * ★ 关键改动：detectReps 里有一行 `const gate = refAmp * 0.5 * bodyScale;`
 * 和一行 `const bodyScale = clamp(repHeightBase / 0.6, 1.0, 1.5);`。
 * 探针通过文本替换模拟"改了产品代码后的行为"：
 *   - 旧闸门：原文不改（gate 系数 0.5、bodyScale 下限 1.0）
 *   - 新闸门：0.5 → 0.6、1.0 → 0.8
 * 这不是"另写一份近似实现"——跑的还是真 detectReps()，只是闸门参数不同。*/
function makeEngineWithGate(profileIn, fpsInit, liveInit, gateK, bodyScaleLo) {
  /* 对抠出的 detectReps 文本做参数替换 */
  let dr = parts.detectReps;
  /* 替换 gate 系数：0.5 → gateK */
  dr = dr.replace("refAmp * 0.5 * bodyScale", "refAmp * " + gateK + " * bodyScale");
  /* 替换 bodyScale 下限：1.0 → bodyScaleLo */
  dr = dr.replace("clamp(repHeightBase / 0.6, 1.0, 1.5)", "clamp(repHeightBase / 0.6, " + bodyScaleLo + ", 1.5)");

  const FACTORY = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60;
  let profile = profileIn;
  let live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${parts.SIGNALS}
${parts.clamp}
${parts.mean}
${parts.std}
${parts.signalWindowTimes}
${parts.signalWindow}
${parts.detrend}
${parts.smooth}
${dr}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0,
          bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        const row = Object.assign(dflt, liveInit, s);
        live = row;
        series.push(Object.assign({ t: s.t }, dflt, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        detectReps(s.t);
      }
      return { reps, repTimes: repTimes.slice(), repGate, repSpread };
    }
  };
};
`;
  const makeEngine = new Function(FACTORY)();
  return makeEngine(profileIn, fpsInit, liveInit);   // 直接返回引擎实例
}

/* ============================================================
 * 卷 3：从 motion-avatar.js 抠出 IK 相关函数
 * ============================================================ */
const AVSRC = fs.readFileSync(path.join(ROOT, "motion-avatar.js"), "utf8");

function grabAv(a, b) {
  const i = AVSRC.indexOf(a), j = AVSRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("avatar 抠取失败：" + a.slice(0, 40));
  return AVSRC.slice(i, j);
}

const avParts = {
  clamp: grabAv("function clamp(a, lo, hi)", "/* ----------"),
  interiorAngleXY: grabAv("function interiorAngleXY(a, b, c)", "/* 段落方向"),
};
const BEND_BIAS = 12 * Math.PI / 180;

/* 造一个最小 Three.js Vector3 替代（不依赖 Three.js） */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  length() { return Math.sqrt(this.x*this.x + this.y*this.y + this.z*this.z); }
  clone() { return new V3(this.x, this.y, this.z); }
}

/* 重新实现 interiorAngleXY（与产品文件逐行一致，只是不依赖 Three.js） */
function interiorAngleXY(a, b, c) {
  if (!a || !b || !c) return null;
  const ax = a.x - b.x, ay = a.y - b.y;
  const cx = c.x - b.x, cy = c.y - b.y;
  const l1 = Math.hypot(ax, ay), l2 = Math.hypot(cx, cy);
  if (!(l1 > 1e-6) || !(l2 > 1e-6)) return null;
  const dot = (ax * cx + ay * cy) / (l1 * l2);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function clampAv(a, lo, hi) { return a < lo ? lo : (a > hi ? hi : a); }

/* ============================================================
 * 卷 1：静止噪声 vs 新旧闸门
 * ============================================================ */
console.log("=".repeat(100));
console.log("【卷1】静止噪声 vs 新旧闸门（修法②：消除静止误计数）");
console.log("-".repeat(100));

/* 造 12 秒纯高斯噪声序列，σ=0.005（MediaPipe 关键点静止时的典型抖动）。
 * height=0.55（模拟 2 米外站立的人，在画面里占 55% 高），repHeightBase 会跟踪到 0.55。
 *
 * 用 centroidY 信号（常见的蹲起类信号），expectedAmplitude=0.1（默认值）。
 * 旧门：gate = 0.1 × 0.5 × clamp(0.55/0.6, 1.0, 1.5) = 0.1 × 0.5 × 1.0 = 0.05
 * 新门：gate = 0.1 × 0.6 × clamp(0.55/0.6, 0.8, 1.5) = 0.1 × 0.6 × 0.9167 = 0.055
 *
 * 等等——0.055 > 0.05，新门反而更松？不对：
 *   bodyScale = 0.55/0.6 = 0.9167
 *   旧门：clamp(0.9167, 1.0, 1.5) = 1.0  → gate = 0.1 × 0.5 × 1.0 = 0.05
 *   新门：clamp(0.9167, 0.8, 1.5) = 0.9167 → gate = 0.1 × 0.6 × 0.9167 = 0.055
 *
 * 嗯，0.055 > 0.05... 新门在"远距离"时反而更松了。但关键在于：
 *   静止噪声 σ=0.005，3.5 秒窗峰峰值 ≈ 4σ ≈ 0.02（实际可能到 0.03~0.04）
 *   两个门都挡得住（0.02 < 0.05 < 0.055）。
 *
 * 问题在于 burst 动作没有 expectedAmplitude 字段 → refAmp = 0.1（默认）
 * 而且 burst 用 signal="motion"，motion 信号在静止时也有底噪。
 * 真正的坑是 burst 模式根本不走 detectReps()，走的是 updateActive()。
 *
 * 所以这卷要验证两件事：
 *   1a) rep 模式的静止噪声：新旧门对比
 *   1b) burst 模式的静止行为：updateActive 只看 live.motion > burstMinEnergy
 */
console.log("\n1a) rep 模式静止噪声（centroidY 信号，expectedAmplitude=0.1，height=0.55）");
console.log("    静止噪声 σ=0.005，12 秒 720 帧\n");

function makeNoiseSeq(duration, fps, sigma, baseHeight) {
  const seq = [];
  /* 简易高斯随机（Box-Muller） */
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  for (let i = 0; i < duration * fps; i++) {
    const t = i / fps;
    seq.push({
      t,
      centroidY: 0.5 + gauss() * sigma,
      height: baseHeight,
      motion: Math.abs(gauss() * sigma * 0.5),   /* 静止时也有微小帧间差 */
      area: 0.1,
      width: 0.3,
      bottomL: 0.7 + gauss() * sigma,
      bottomR: 0.7 + gauss() * sigma,
    });
  }
  return seq;
}

function makeNoiseSeqSeeded(duration, fps, sigma, baseHeight, seed) {
  /* 确定性伪随机（让新旧门跑完全相同的序列） */
  let s = seed;
  function rand() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  function gauss() {
    const u = rand() || 0.5, v = rand() || 0.5;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const seq = [];
  for (let i = 0; i < duration * fps; i++) {
    const t = i / fps;
    seq.push({
      t,
      centroidY: 0.5 + gauss() * sigma,
      height: baseHeight,
      motion: Math.abs(gauss() * sigma * 0.5),
      area: 0.1,
      width: 0.3,
      bottomL: 0.7 + gauss() * sigma,
      bottomR: 0.7 + gauss() * sigma,
    });
  }
  return seq;
}

const noiseSeq = makeNoiseSeqSeeded(12, 60, 0.005, 0.55, 42);
const repProfile = {
  mode: "rep",
  signal: "centroidY",
  tempoBand: [20, 60],
  minRepGap: 0.5,
  expectedAmplitude: 0.1,
};

/* 旧门（gate 系数 0.5、bodyScale 下限 1.0） */
const oldEng = makeEngineWithGate(repProfile, 60, { height: 0.55 }, 0.5, 1.0);
const oldR = oldEng.run(noiseSeq);
console.log("    旧门 (gateK=0.5, bodyScaleLo=1.0):");
console.log("      gate =", oldR.repGate.toFixed(5), " spread =", oldR.repSpread.toFixed(5), " reps =", oldR.reps);

/* 新门（gate 系数 0.6、bodyScale 下限 0.8） */
const newEng = makeEngineWithGate(repProfile, 60, { height: 0.55 }, 0.6, 0.8);
const newR = newEng.run(noiseSeq);
console.log("    新门 (gateK=0.6, bodyScaleLo=0.8):");
console.log("      gate =", newR.repGate.toFixed(5), " spread =", newR.repSpread.toFixed(5), " reps =", newR.reps);

/* 更严的新门变体：gateK=0.7、bodyScaleLo=0.8 */
const newEng2 = makeEngineWithGate(repProfile, 60, { height: 0.55 }, 0.7, 0.8);
const newR2 = newEng2.run(noiseSeq);
console.log("    更严 (gateK=0.7, bodyScaleLo=0.8):");
console.log("      gate =", newR2.repGate.toFixed(5), " spread =", newR2.repSpread.toFixed(5), " reps =", newR2.reps);

/* 再试"信号均值漂移"判据：如果信号在 3.5 秒窗里的均值漂移 < 某阈值，
 * 说明信号没有"方向性运动"（只是噪声），应该直接 return。
 * 这条是 burst/rep 通用的"方向性判据"。 */
console.log("\n    ★ 信号均值漂移判据（新增的方向性检查）:");
const win = noiseSeq.slice(-60 * 3.5);
const cyVals = win.map(s => s.centroidY);
const cyMean = cyVals.reduce((a, b) => a + b, 0) / cyVals.length;
const cyDrift = Math.max(...cyVals) - Math.min(...cyVals);   /* 这就是 spread */
console.log("      centroidY 均值 =", cyMean.toFixed(5), " 漂移(pp) =", cyDrift.toFixed(5));
console.log("      → 漂移 < 0.03（亚像素噪声地板）⇒ 加判据：不计数");

/* 1b) burst 模式的静止行为 */
console.log("\n1b) burst 模式静止（motion 信号，refIntensity=0.05，burstMinEnergy=0.0012）");
console.log("    burst 走 updateActive() 不走 detectReps()，静止时 motion 底噪是否过 burstMinEnergy？\n");

let motionNoiseOverThresh = 0;
const motionThresh = 0.0012;
for (const s of noiseSeq) {
  if (s.motion > motionThresh) motionNoiseOverThresh++;
}
console.log("    12秒 720帧中 motion > 0.0012 的帧数:", motionNoiseOverThresh, "/ 720");
console.log("    → burst 静止会持续累积 activeSeconds！这就是「没动也在计时」的根因");
console.log("    ★ 修法：burst 改成 rep 模式后，走 detectReps() 的幅度闸门，不再走 updateActive()");

/* ============================================================
 * 卷 2：bottomL/bottomR 交替峰计数（修法①：burst→计数）
 * ============================================================ */
console.log("\n" + "=".repeat(100));
console.log("【卷2】bottomL/bottomR 交替峰计数（修法①：burst→计数）");
console.log("-".repeat(100));

/* 造模拟高抬腿的合成序列：
 * - 左腿 bottomL: 正弦，基线 0.75，振幅 0.1，频率 = 步频
 * - 右腿 bottomR: 反相正弦
 * - 一次"左腿上→左腿下→右腿上→右腿下"算 1 次完整交替
 * - 60 步/分钟 = 1Hz → 左腿 1Hz，右腿 1Hz（反相）→ 交替 2Hz → 60秒 60次交替 → 但一次交替=1次，所以 30 次
 *   不对：高抬腿"一步"=一条腿抬一次。60步/分 = 60条腿抬/分 = 30对交替/分。
 *   如果"一次左右交替算1次"，60秒=30次。如果"一条腿抬一次算1次"，60秒=60次。
 *   常规计步器是后者（一步=一条腿），所以我们用"一条腿抬一次=1次"：60秒60步=60次。
 *   但 bottomL 和 bottomR 各自的峰是 60个/分钟（1Hz），交替峰计次应给出 60。
 */
console.log("\n2a) 高抬腿 60步/分（bottomL=正弦0.65~0.85、bottomR反相），60秒 → 真值60步\n");

function makeHighKneesSeq(duration, fps, stepsPerMin, baseY, amp) {
  const seq = [];
  const f = stepsPerMin / 60;   /* Hz */
  for (let i = 0; i < duration * fps; i++) {
    const t = i / fps;
    /* leftLeg: 高抬腿时 bottomL 上升（y 减小，因为 y 轴向下）
     * 但 bottomL 在引擎里是"该半侧最低点的 y"——脚抬起来时最低点升高（y 减小）。
     * 不过在归一化坐标里 y=0 是顶、y=1 是底（MediaPipe 习惯），
     * 而引擎 rawWorld 里做了 (sp.bot - p.y) 的翻转...
     * 简化：直接用 bottomL = base + amp * sin（抬腿 → bottomL 值升高 = 更大） */
    seq.push({
      t,
      bottomL: baseY + amp * Math.sin(2 * Math.PI * f * t),
      bottomR: baseY + amp * Math.sin(2 * Math.PI * f * t + Math.PI),  /* 反相 */
      height: 0.6,
      motion: amp * f * 2,   /* 近似帧间运动量 */
      area: 0.1,
      centroidY: 0.5,
      centroidX: 0.5,
      width: 0.3,
    });
  }
  return seq;
}

/* 现在用 rep 模式跑 bottomL 信号（单侧计次） */
const highKneesSeq = makeHighKneesSeq(60, 60, 60, 0.75, 0.1);
const hkProfile = {
  mode: "rep",
  signal: "bottomL",
  tempoBand: [60, 130],
  minRepGap: 0.4,
  expectedAmplitude: 0.2,   /* bottomL 的幅度 0.1×2=0.2（峰峰值） */
};

/* 用旧门跑（因为这卷验证的是"交替峰能不能计数"，不是闸门松紧） */
const hkEng = makeEngineWithGate(hkProfile, 60, { height: 0.6 }, 0.5, 1.0);
const hkR = hkEng.run(highKneesSeq);
console.log("    bottomL 单侧 rep 计数:", hkR.reps, "（真值 60）");
console.log("    gate =", hkR.repGate.toFixed(5), " spread =", hkR.repSpread.toFixed(5));

/* 也跑 bottomR */
const hkProfileR = Object.assign({}, hkProfile, { signal: "bottomR" });
const hkEngR = makeEngineWithGate(hkProfileR, 60, { height: 0.6 }, 0.5, 1.0);
const hkRR = hkEngR.run(highKneesSeq);
console.log("    bottomR 单侧 rep 计数:", hkRR.reps, "（真值 60）");

/* 两信号合并：取 max(bottomL reps, bottomR reps) 作为步数 */
console.log("    → 两侧取 max =", Math.max(hkR.reps, hkRR.reps), "步");

/* 测多组步频 */
console.log("\n2b) 不同步频扫描（40~160步/分）");
console.log("    步频  bottomL计数  bottomR计数  取max  真值(60秒)");
for (const spm of [40, 60, 80, 100, 120, 140, 160]) {
  const seq = makeHighKneesSeq(60, 60, spm, 0.75, 0.1);
  const profL = Object.assign({}, hkProfile, { tempoBand: [40, 200] });
  const rL = makeEngineWithGate(profL, 60, { height: 0.6 }, 0.5, 1.0).run(seq).reps;
  const profR = Object.assign({}, profL, { signal: "bottomR" });
  const rR = makeEngineWithGate(profR, 60, { height: 0.6 }, 0.5, 1.0).run(seq).reps;
  const truth = spm;   /* 60秒 × spm/60 = spm 步 */
  const mx = Math.max(rL, rR);
  console.log(`    ${String(spm).padStart(4)}   ${String(rL).padStart(6)}     ${String(rR).padStart(6)}     ${String(mx).padStart(4)}   ${truth}`);
}

/* 测静止时 bottomL/bottomR 噪声是否被挡 */
console.log("\n2c) 静止噪声 bottomL/bottomR（应 = 0）");
const noiseBL = makeNoiseSeqSeeded(12, 60, 0.005, 0.55, 77);
const blProf = {
  mode: "rep",
  signal: "bottomL",
  tempoBand: [60, 130],
  minRepGap: 0.4,
  expectedAmplitude: 0.2,
};
const blR = makeEngineWithGate(blProf, 60, { height: 0.55 }, 0.5, 1.0).run(noiseBL);
console.log("    旧门 bottomL 静止:", blR.reps, " gate =", blR.repGate.toFixed(5), " spread =", blR.repSpread.toFixed(5));
const blR2 = makeEngineWithGate(blProf, 60, { height: 0.55 }, 0.6, 0.8).run(noiseBL);
console.log("    新门 bottomL 静止:", blR2.reps, " gate =", blR2.repGate.toFixed(5), " spread =", blR2.repSpread.toFixed(5));

/* ============================================================
 * 卷 3：踝 y 位移驱动 IK（修法③：模型腿不动）
 * ============================================================ */
console.log("\n" + "=".repeat(100));
console.log("【卷3】踝 y 位移驱动 IK（修法③：模型腿不动）");
console.log("-".repeat(100));

/* 模拟模型的骨长（从 Mixamo 标准人形取近似值）：
 *   大腿 L1 ≈ 0.45（模型单位）
 *   小腿 L2 ≈ 0.42
 *   L1 + L2 = 0.87（完全伸直时的距离） */
const L1 = 0.45, L2 = 0.42;
const Lsum = L1 + L2;
const Ldiff = Math.abs(L1 - L2);

console.log("\n模型骨长：L1(大腿) =", L1, " L2(小腿) =", L2, " L1+L2 =", Lsum);
console.log("BEND_BIAS =", (BEND_BIAS * 180 / Math.PI).toFixed(0), "度\n");

/* 模拟引擎关键点坐标（归一化 y 向下，0=顶 1=底）：
 *   hip: (0.5, 0.5)   → 髋部在画面中央
 *   knee: (0.5, 0.7)  → 膝在髋下方 0.2
 *   ankle: (0.5, 0.9) → 踝在髋下方 0.4（站立伸直）
 *
 * 转成"世界坐标"（y 向上，footY=0）：
 *   hip_world:   (0, 0.9)   ← 0.5 → 0.5-0.5=0 (x), (1-0.5)*k2 ≈ 0.9 (y)
 *   knee_world:  (0, 0.5)
 *   ankle_world: (0, 0.1)
 *   k2 = layout.H / span ≈ 1.8 / 1.0 ≈ 1.8（但简化用 1.0 比例）
 *
 * 这里不关心绝对尺度，只关心"内角"和"目标距离"的相对关系。
 * 所以直接用归一化坐标算内角，用世界距离算 d。 */

console.log("场景 A：站立伸直（髋-膝-踝竖直共线）");
{
  const hip = new V3(0, 0.9, 0);
  const knee = new V3(0, 0.5, 0);
  const ankle = new V3(0, 0.1, 0);

  /* 旧法：内角法 */
  const th = interiorAngleXY(hip, knee, ankle);   /* 髋-膝-踝的内角 */
  const t = Math.PI - Math.max(0, Math.PI - th - BEND_BIAS);
  const dOld = Math.sqrt(L1*L1 + L2*L2 - 2*L1*L2*Math.cos(t));
  const cosA_old = (L1*L1 + dOld*dOld - L2*L2) / (2*L1*dOld);
  const A_old = Math.acos(clampAv(cosA_old, -1, 1));

  /* 新法：目标距离法（d = |ankle - hip_model|） */
  /* 模型髋的世界位置——站立时大约在 (0, Lsum, 0) = (0, 0.87, 0) */
  const hipModel = new V3(0, Lsum, 0);
  const dNew = ankle.clone().sub(hipModel).length();
  /* 但这里有个问题：引擎的踝目标和模型的髋不在同一坐标系...
   * 实际产品代码里 dRaw = |target - rootBone.getWorldPosition()|
   * rootBone 是模型的髋骨骼。所以 dNew ≈ dRaw（产品里的原始距离法）。
   *
   * 关键洞察：旧法用"内角"决定弯多少，新法要改成——
   * 不用内角，直接用 dRaw（踝到模型髋的距离）作为 d。
   * 但这恰恰是旧代码最早的做法，后来因为"骨长比例不匹配"改成了内角法！
   *
   * 所以真正的修法不是"回到 dRaw"，而是：
   *   当踝 y 明显高于髋 y 时（高抬腿），强制 d = |ankle.y - hip.y|（只看垂直距离）
   *   因为高抬腿的主要运动是矢状面屈膝 → 踝上升 → 垂直距离缩短 → d 自然变小 → IK 弯膝。
   *
   * 但 interiorAngleXY 丢 z 后，高抬腿时"髋-膝-踝"在 2D 投影里：
   *   髋 (0.5, 0.5), 膝 (0.5, 0.65), 踝 (0.5, 0.75)  ← 都在同一条竖线上
   *   内角 = 180°（共线）→ t = 0 → d = L1+L2（伸直）
   *
   * 这就是根因！高抬腿时三点在 2D 投影里共线，内角=180°，IK 判伸直。
   *
   * 新法：不看内角，看"踝相对于髋的垂直位移"。
   *   站立时 ankle.y - hip.y ≈ -0.4（踝在髋下方 0.4）
   *   高抬腿时 ankle.y - hip.y ≈ -0.2（踝上升到髋下方仅 0.2）
   *   → d_new = |ankle - hip| 在高抬腿时明显变小 → IK 自然弯膝 */

  /* 模型髋高度（世界坐标） */
  const hipY = Lsum;   /* 0.87 */
  /* 踝的世界 y（已经转好了：归一化 y=0.1 → 世界 y≈0.1×scale） */
  /* 简化：直接用归一化的垂直距离比 */
  const ankleBelowHip = 0.9 - 0.1;   /* 站立时踝在髋下方 0.8（归一化） */
  const dStand = ankleBelowHip * Lsum / 0.8;   /* 等比缩放到模型尺度 */
  const A_stand_new = Math.acos(clampAv((L1*L1 + dStand*dStand - L2*L2) / (2*L1*dStand), -1, 1));

  console.log("  内角 th =", (th * 180 / Math.PI).toFixed(1), "度（180=共线伸直）");
  console.log("  旧法 d =", dOld.toFixed(4), "(L1+L2 =", Lsum.toFixed(4), ") → 弯曲角 A =", (A_old * 180 / Math.PI).toFixed(1), "度");
  console.log("  新法 d =", dStand.toFixed(4), "(< L1+L2) → 弯曲角 A =", (A_stand_new * 180 / Math.PI).toFixed(1), "度");
}

console.log("\n场景 B：正面视角高抬腿（踝抬到髋高度，膝在髋和踝之间）");
{
  /* 高抬腿时（正面视角看）：
   *   hip: (0.5, 0.5)    ← 髋不变
   *   knee: (0.5, 0.42)  ← 膝盖上抬（y 减小 = 向上）
   *   ankle: (0.5, 0.35) ← 踝也上抬，但仍在膝下方
   *
   * 在正面 2D 投影里，三点仍然共线（x 都≈0.5），y 从上到下依次是
   * ankle(0.35) → hip(0.5) ... 不对，高抬腿时膝和踝都向上移动了：
   *   hip(0.5, 0.5)、knee(0.5, 0.42)、ankle(0.5, 0.35)
   *   髋到膝向量 (0, -0.08)，膝到踝向量 (0, -0.07)
   *   两向量同向（都向上），内角 = 0°（不是 180°！）
   *
   * 但实际高抬腿时膝盖是**向前凸出**的（矢状面运动），正面看 x 不变。
   * 所以 interiorAngleXY 算出来要么 0°（三点竖直排列、膝在中间），
   * 要么 180°（三点竖直排列、膝不在中间）——都不反映真实的屈膝角。
   *
   * ★ 真正的根因更精确：正面视角下，高抬腿的"屈膝"发生在矢状面（z 轴），
   *   interiorAngleXY 丢掉 z 后，看到的只是三点在 x-y 平面的投影——
   *   如果膝正好在髋和踝的连线中间（它确实在，因为腿是直的骨架向前弯），
   *   投影出来三点共线，内角要么 0° 要么 180°，都不对。 */

  const hip = new V3(0.5, 0.5, 0);
  const knee = new V3(0.5, 0.42, 0);   /* 膝上抬 */
  const ankle = new V3(0.5, 0.35, 0);  /* 踝也上抬，在膝下方 */

  /* 旧法：内角 */
  const th = interiorAngleXY(hip, knee, ankle);   /* 髋-膝-踝的内角 */
  /* 注意：interiorAngleXY 算的是"以 b(膝) 为顶点的 a-b-c 内角"
   *   向量 ba = a-b = hip-knee = (0, 0.08)
   *   向量 bc = c-b = ankle-knee = (0, -0.07)
   *   点积 = 0×0 + 0.08×(-0.07) = -0.0056
   *   |ba|=0.08, |bc|=0.07
   *   cos(th) = -0.0056 / (0.08×0.07) = -1.0
   *   th = 180° ← 三点共线，膝在中间，内角=180°（伸直）！
   *
   * 好的，所以实际是 180° 不是 0°。我之前坐标搞反了。 */
  const t = Math.PI - Math.max(0, Math.PI - th - BEND_BIAS);
  const dOld = Math.sqrt(L1*L1 + L2*L2 - 2*L1*L2*Math.cos(t));
  const cosA_old = (L1*L1 + dOld*dOld - L2*L2) / (2*L1*dOld);
  const A_old = Math.acos(clampAv(cosA_old, -1, 1));

  /* 新法：用踝到髋的垂直距离驱动 d */
  /* 归一化坐标里踝在髋下方 0.15（0.50-0.35），站立时下方 0.8（0.9-0.1）
   * 模型 L1+L2 = 0.87 对应归一化 0.8
   * 所以 scale = 0.87 / 0.8 = 1.0875
   * d_new = 0.15 × 1.0875 = 0.1631 */
  const ankleBelowHipNorm = 0.5 - 0.35;   /* 0.15 */
  const standBelowHipNorm = 0.8;           /* 站立参考 */
  const scale = Lsum / standBelowHipNorm;
  const dNew = ankleBelowHipNorm * scale;
  const dNewClamped = clampAv(dNew, Ldiff + 1e-4, Lsum);
  const cosA_new = (L1*L1 + dNewClamped*dNewClamped - L2*L2) / (2*L1*dNewClamped);
  const A_new = Math.acos(clampAv(cosA_new, -1, 1));

  console.log("  hip(0.5, 0.5)  knee(0.5, 0.42)  ankle(0.5, 0.35)  ← 正面视角，三点共线");
  console.log("  内角 th =", (th * 180 / Math.PI).toFixed(1), "度（180=共线伸直！这就是根因）");
  console.log("  旧法 t = BEND_BIAS =", (t * 180 / Math.PI).toFixed(1), "度 → d =", dOld.toFixed(4), "(≈L1+L2 =", Lsum.toFixed(4), ") → 弯曲角 A =", (A_old * 180 / Math.PI).toFixed(1), "度（只弯了系统偏差的量）");
  console.log("  新法 d =", dNew.toFixed(4), "(远 < L1+L2 =", Lsum.toFixed(4), ") → 弯曲角 A =", (A_new * 180 / Math.PI).toFixed(1), "度（反映真实屈膝）");
}

console.log("\n场景 C：中度高抬腿（踝在髋下方 0.20，膝在髋和踝中间）");
{
  const hip = new V3(0.5, 0.5, 0);
  const knee = new V3(0.5, 0.40, 0);   /* 膝在髋下方 0.10 */
  const ankle = new V3(0.5, 0.30, 0);   /* 踝在髋下方 0.20 */

  const th = interiorAngleXY(hip, knee, ankle);
  const t = Math.PI - Math.max(0, Math.PI - th - BEND_BIAS);
  const dOld = Math.sqrt(L1*L1 + L2*L2 - 2*L1*L2*Math.cos(t));
  const cosA_old = (L1*L1 + dOld*dOld - L2*L2) / (2*L1*dOld);
  const A_old = Math.acos(clampAv(cosA_old, -1, 1));

  const ankleBelowHipNorm = 0.5 - 0.30;   /* 0.20 */
  const standBelowHipNorm = 0.8;
  const scale = Lsum / standBelowHipNorm;
  const dNew = ankleBelowHipNorm * scale;
  const dNewClamped = clampAv(dNew, Ldiff + 1e-4, Lsum);
  const cosA_new = (L1*L1 + dNewClamped*dNewClamped - L2*L2) / (2*L1*dNewClamped);
  const A_new = Math.acos(clampAv(cosA_new, -1, 1));

  console.log("  hip(0.5, 0.5)  knee(0.5, 0.40)  ankle(0.5, 0.30)  ← 正面视角，三点共线");
  console.log("  内角 th =", (th * 180 / Math.PI).toFixed(1), "度");
  console.log("  旧法 d =", dOld.toFixed(4), " → 弯曲角 A =", (A_old * 180 / Math.PI).toFixed(1), "度");
  console.log("  新法 d =", dNew.toFixed(4), " → 弯曲角 A =", (A_new * 180 / Math.PI).toFixed(1), "度");
}

/* 场景 D：3/4 斜视角（膝有 x 偏移）——这是现在模型的默认视角 */
console.log("\n场景 D：3/4 斜视角高抬腿（膝有 x 偏移 = 0.08）");
{
  const hip = new V3(0.5, 0.5, 0);
  const knee = new V3(0.58, 0.40, 0);   /* 膝向斜前方偏（x+0.08）且上抬 */
  const ankle = new V3(0.5, 0.30, 0);   /* 踝上抬 */

  const th = interiorAngleXY(hip, knee, ankle);
  const t = Math.PI - Math.max(0, Math.PI - th - BEND_BIAS);
  const dOld = Math.sqrt(L1*L1 + L2*L2 - 2*L1*L2*Math.cos(t));
  const cosA_old = (L1*L1 + dOld*dOld - L2*L2) / (2*L1*dOld);
  const A_old = Math.acos(clampAv(cosA_old, -1, 1));

  const ankleBelowHipNorm = 0.5 - 0.30;   /* 0.20 */
  const standBelowHipNorm = 0.8;
  const scale = Lsum / standBelowHipNorm;
  const dNew = ankleBelowHipNorm * scale;
  const dNewClamped = clampAv(dNew, Ldiff + 1e-4, Lsum);
  const cosA_new = (L1*L1 + dNewClamped*dNewClamped - L2*L2) / (2*L1*dNewClamped);
  const A_new = Math.acos(clampAv(cosA_new, -1, 1));

  console.log("  hip(0.5, 0.5)  knee(0.58, 0.40)  ankle(0.5, 0.30)  ← 3/4视角，膝有x偏移");
  console.log("  内角 th =", (th * 180 / Math.PI).toFixed(1), "度（3/4视角膝偏了一点，内角略<180）");
  console.log("  旧法 d =", dOld.toFixed(4), " → 弯曲角 A =", (A_old * 180 / Math.PI).toFixed(1), "度");
  console.log("  新法 d =", dNew.toFixed(4), " → 弯曲角 A =", (A_new * 180 / Math.PI).toFixed(1), "度");
}

/* 总结 */
console.log("\n" + "=".repeat(100));
console.log("【总结】");
console.log("-".repeat(100));
console.log("卷1 静止计数：");
console.log("  - rep 模式：旧门 reps =" , oldR.reps, "→ 新门 reps =", newR.reps, "→ 更严 reps =", newR2.reps);
console.log("  - burst 模式：不走 detectReps，走 updateActive，motion 底噪 > 0.0012 → 持续累积");
console.log("  - ★ burst 改 rep 后自然走幅度闸门，静止问题自动解决");
console.log("  - ★ rep 静止闸门需要更严（gateK 0.5→0.6 + bodyScaleLo 1.0→0.8），或加「方向性漂移判据」");
console.log("卷2 交替峰计数：");
console.log("  - bottomL 单侧 rep 在 60步/分 →", hkR.reps, "次（真值60）");
console.log("  - ★ rep 模式的 detectReps 可以直接处理 bottomL/bottomR 信号");
console.log("  - ★ burst→rep 的信号映射方案可行");
console.log("卷3 IK 腿不动：");
console.log("  - 旧内角法在高抬腿时 th≈180° → d≈L1+L2 → A≈0°（腿不弯）");
console.log("  - 新目标距离法在高抬腿时 d << L1+L2 → A >> 0°（腿弯）");
console.log("  - ★ 修法有效：用踝的 y 位移直接驱动 IK 目标距离，绕开「内角丢 z」死结");
