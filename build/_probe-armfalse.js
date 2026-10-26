/* 【手臂污染专项探针】2026-10-21
 *
 * 老李真机反馈：
 *   「静止不动确实不会触发计数，但是我手臂抬高放下会触发跳绳、高抬腿的计数」
 *
 * 本探针从 motion-engine.js 原文抠出真 detectReps()，用 A/B 对照证明：
 *   旧信号（bottomL / bottomR / height）会被手臂污染 → 误计数
 *   新信号（ankleY_L / ankleY_R / centroidY）只认腿/躯干 → 不误计
 *   同时在"真实做动作"的场景上证明新信号没退步（不会把真动作挡掉）
 *
 * 用法：node build/_probe-armfalse.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 30));
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

/* 与产品文件同一嵌套层级：detectReps 引用 series/fps/live/profile/repCounters 等闭包变量。
 * dflt 里补 ankleY_L / ankleY_R —— 这是 2026-10-21 新加的信号，必须让 series 带上，
 * 否则 signalWindow 里 SIGNALS.ankleY_L 会读到 undefined，spread 恒 NaN。 */
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
${parts.detectReps}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0,
          bottomL: 0, bottomR: 0, ankleY_L: 0, ankleY_R: 0,
          left: 0, right: 0, upper: 0, lower: 0 };
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
let makeEngine;
try {
  makeEngine = new Function(FACTORY)();
} catch (e) {
  console.error("✗ 组装失败：", e.message);
  process.exit(1);
}

/* ---------- 序列构造 ---------- */
const FPS = 60, SEC = 12, N = FPS * SEC;
function seq(fn) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    out.push(Object.assign({ t }, fn(t, i)));
  }
  return out;
}
/* 确定性伪随机（不用 Math.random，保证每次跑结果一致、可回归） */
function noise(i, seed) {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;   // [-1, 1)
}

/* 站立基线：孩子站 2~3 米，人占画面高约 0.6 */
const LIVE = { height: 0.6, centroidY: 0.55 };

/* S1 手臂主导（脚出画，站太近的常见情形）
 * 左半侧能看到的点里，手腕垂得最低 → bottomL 完全由手腕决定。
 * 真实世界里这就是"只抬手臂、腿一动不动"。 */
const S1 = seq((t, i) => ({
  bottomL: 0.50 + 0.20 * Math.sin(2 * Math.PI * 1.2 * t),   // 手臂抬高放下 1.2Hz
  bottomR: 0.50 + 0.20 * Math.sin(2 * Math.PI * 1.2 * t + 0.4),
  ankleY_L: 0, ankleY_R: 0,        // 脚出画 → 踝不可见 → 无信号
  height: 0.60,
  motion: 0.004 + 0.0006 * noise(i, 1)
}));

/* S2 跳绳误触发复现：手腕摇绳、身体完全不跳。
 * height = 包围盒高度，顶边由手决定 → 手臂一动 height 就起伏。 */
const S2 = seq((t, i) => ({
  height: 0.98 - (0.45 + 0.12 * Math.sin(2 * Math.PI * 1.6 * t)),  // 摇绳 1.6Hz
  centroidY: 0.55,                  // 髋一动不动
  bottomL: 0.95, bottomR: 0.95,
  ankleY_L: 0.95, ankleY_R: 0.95,   // 脚站得稳稳的
  motion: 0.005 + 0.0008 * noise(i, 2)
}));

/* S3 真实原地高抬腿：左右交替 1.2Hz（72 步/分），手臂不动。
 * 抬左腿时左踝从 0.95 升到 0.72（幅度 0.23）。 */
const S3 = seq(t => ({
  ankleY_L: 0.95 - 0.23 * Math.max(0, Math.sin(2 * Math.PI * 1.2 * t)),
  ankleY_R: 0.95 - 0.23 * Math.max(0, -Math.sin(2 * Math.PI * 1.2 * t)),
  bottomL: 0.95 - 0.23 * Math.max(0, Math.sin(2 * Math.PI * 1.2 * t)),
  bottomR: 0.95 - 0.23 * Math.max(0, -Math.sin(2 * Math.PI * 1.2 * t)),
  centroidY: 0.55,
  height: 0.60,
  motion: 0.01
}));

/* S4 真实跳绳 + 手腕摇绳：跳 1.6Hz，手腕 3.2Hz（手腕频率是跳跃的 2 倍，真实如此）。
 * 期望：新信号(centroidY) 数出 12*1.6≈19 次；旧信号(height) 被手腕带着数成 ≈38 次。 */
const S4 = seq((t, i) => ({
  centroidY: 0.55 + 0.025 * Math.sin(2 * Math.PI * 1.6 * t),   // 每跳一次髋起伏一次
  height: 0.98 - (0.45 + 0.10 * Math.sin(2 * Math.PI * 3.2 * t)),
  bottomL: 0.95, bottomR: 0.95,
  ankleY_L: 0.95, ankleY_R: 0.95,
  motion: 0.008 + 0.0006 * noise(i, 4)
}));

/* S5 静止 + 亚像素噪声（回归保护：任何配置都不该计数） */
const S5 = seq((t, i) => ({
  bottomL: 0.95 + 0.002 * noise(i, 5),
  bottomR: 0.95 + 0.002 * noise(i, 6),
  ankleY_L: 0.95 + 0.002 * noise(i, 7),
  ankleY_R: 0.95 + 0.002 * noise(i, 8),
  centroidY: 0.55 + 0.0015 * noise(i, 9),
  height: 0.60 + 0.0015 * noise(i, 10),
  motion: 0.0012 + 0.0002 * noise(i, 11)
}));

/* ---------- 跑 ---------- */
const HI_KNEE = { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 };
const HI_KNEE_OLD = { mode: "rep", signal: "bottomL", signals: ["bottomL", "bottomR"], tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 };
const ROPE = { mode: "rep", signal: "centroidY", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.04 };
const ROPE_OLD = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.04 };

function run(profile, s) { return makeEngine(profile, FPS, LIVE).run(s); }

let pass = 0, fail = 0;
function check(name, got, want, ok) {
  const good = ok;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}: 实得 ${got}${want ? "，期望 " + want : ""}`);
  if (good) pass++; else fail++;
}

console.log("=== 手臂污染专项 A/B（fps=60，12 秒）===\n");

console.log("S1 只抬手臂、腿不动（脚出画，手腕成为半侧最低点）");
const s1old = run(HI_KNEE_OLD, S1), s1new = run(HI_KNEE, S1);
console.log(`  旧信号 bottomL/bottomR → ${s1old.reps} 次  (gate=${s1old.repGate.toFixed(4)} spread=${s1old.repSpread.toFixed(4)})`);
console.log(`  新信号 ankleY_L/R    → ${s1new.reps} 次  (gate=${s1new.repGate.toFixed(4)} spread=${s1new.repSpread.toFixed(4)})`);
check("旧信号确实被手臂污染（复现 bug）", s1old.reps, ">0", s1old.reps > 0);
check("新信号 0 计数（修复生效）", s1new.reps, "0", s1new.reps === 0);

console.log("\nS2 手腕摇绳、身体不跳（跳绳被误触发的复现）");
const s2old = run(ROPE_OLD, S2), s2new = run(ROPE, S2);
console.log(`  旧信号 height      → ${s2old.reps} 次  (gate=${s2old.repGate.toFixed(4)} spread=${s2old.repSpread.toFixed(4)})`);
console.log(`  新信号 centroidY   → ${s2new.reps} 次  (gate=${s2new.repGate.toFixed(4)} spread=${s2new.repSpread.toFixed(4)})`);
check("旧信号确实被手臂污染（复现 bug）", s2old.reps, ">0", s2old.reps > 0);
check("新信号 0 计数（修复生效）", s2new.reps, "0", s2new.reps === 0);

console.log("\nS3 真实原地高抬腿（左右交替 1.2Hz，真值 12×1.2×2 = 28.8 次）");
const s3new = run(HI_KNEE, S3), s3old = run(HI_KNEE_OLD, S3);
console.log(`  新信号 ankleY_L/R → ${s3new.reps} 次`);
console.log(`  旧信号 bottomL/R  → ${s3old.reps} 次（对照：真实动作时新旧都该能数）`);
check("新信号数出真实次数（±3）", s3new.reps, "26~32", s3new.reps >= 26 && s3new.reps <= 32);
check("新信号不比旧信号差（退步保护）", s3new.reps, ">= 旧-2", s3new.reps >= s3old.reps - 2);

console.log("\nS4 真实跳绳 + 摇绳（跳 1.6Hz 真值 ≈19 次；手腕 3.2Hz 会骗出 ≈38 次）");
const s4new = run(ROPE, S4), s4old = run(ROPE_OLD, S4);
console.log(`  新信号 centroidY → ${s4new.reps} 次`);
console.log(`  旧信号 height    → ${s4old.reps} 次（被 3.2Hz 的手腕带着翻倍）`);
check("新信号数出真实次数（±3）", s4new.reps, "16~22", s4new.reps >= 16 && s4new.reps <= 22);
check("新信号比旧信号准（不再翻倍）", s4new.reps, "旧的一半左右", s4new.reps < s4old.reps * 0.75);

console.log("\nS5 静止 + 亚像素噪声（回归保护）");
const s5a = run(HI_KNEE, S5), s5b = run(ROPE, S5), s5c = run(HI_KNEE_OLD, S5), s5d = run(ROPE_OLD, S5);
console.log(`  新/旧 × 高抬腿/跳绳 四种配置 → ${s5a.reps} / ${s5b.reps} / ${s5c.reps} / ${s5d.reps} 次`);
check("全部 0 计数", s5a.reps + s5b.reps + s5c.reps + s5d.reps, "0", (s5a.reps + s5b.reps + s5c.reps + s5d.reps) === 0);

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
