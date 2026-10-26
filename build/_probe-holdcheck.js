/* 【保持类姿态判据探针】2026-10-21
 *
 * 老李要求：「平板支撑、单脚站立这种项目还是应该按读秒计算的，不过要体感到
 * 正确运动才能计时，感应不到正确动作不可以计时。」
 *
 * 本探针从 motion-engine.js 原文抠出真 holdPoseOk / ang3 / updateHold / stability，
 * 用真实几何数据验证三条判据：
 *   plank       俯撑（躯干水平 + 肩髋踝共线）→ 计秒；站着/跪着/塌腰 → 不计
 *   wallSit     大腿水平                     → 计秒；站着            → 不计
 *   singleLeg   两踝高度差明显               → 计秒；双脚站          → 不计
 * 另测：骨架缺失（掩码链路兜底）→ 一律不计秒。
 *
 * 用法：node build/_probe-holdcheck.js
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
parts.signalWindow = grab("function signalWindow(key, seconds)", "// 去趋势：");
/* holdPoseOk + ang3 是一整块（holdPoseOk 内部调 ang3），一起抠 */
parts.holdPose = grab("    function holdPoseOk(kind) {", "    /* 高频连续动作（burst）");
/* updateHold 单独抠 */
parts.updateHold = grab("    function updateHold(dt) {", "    /* 保持类动作的");
/* stability 依赖 signalWindow / std / clamp / cfg */
parts.stability = grab("    function stability() {", "    // 强度：这一组平均运动量");

/* 组装成工厂：把真函数放进与产品一致的闭包层级 */
const FACTORY = `
return function makeHold(profileIn) {
  let profile = profileIn;
  let holdSeconds = 0;
  let series = [];
  let live = { centroidY: 0.5, motion: 0.004 };
  let fps = 60;
  let skel = { has: true, joints: {} };
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
${parts.SIGNALS}
${parts.clamp}
${parts.mean}
${parts.std}
${parts.signalWindow}
${parts.stability}
${parts.holdPose}
${parts.updateHold}
  return {
    setJoints(j) { skel.joints = j || {}; skel.has = !!(j && Object.keys(j).length); },
    setLive(v) { live = Object.assign(live, v); },
    push(t, cy) { series.push({ t, centroidY: cy }); },
    tick(dt) { updateHold(dt); },
    get holdSeconds() { return holdSeconds; }
  };
};
`;
let makeHold;
try {
  makeHold = new Function(FACTORY)();
} catch (e) {
  console.error("✗ 组装失败：", e.message);
  process.exit(1);
}
console.log("✓ 已从产品文件抠出 holdPoseOk / ang3 / updateHold / stability 并组装");
console.log("  holdPoseOk 长度 =", parts.holdPose.length, "字符（原文）\n");

/* ---------- 关节构造 ---------- */
/* 站立（2~3 米，人占画面高约 0.6：头顶 0.10、肩 0.25、髋 0.55、膝 0.78、踝 0.95） */
const STAND = () => ({
  shoulderL: { x: 0.42, y: 0.25 }, shoulderR: { x: 0.58, y: 0.25 },
  hipMid: { x: 0.50, y: 0.55 },
  kneeL: { x: 0.45, y: 0.78 }, kneeR: { x: 0.55, y: 0.78 },
  ankleL: { x: 0.45, y: 0.95 }, ankleR: { x: 0.55, y: 0.95 }
});

/* 平板支撑（俯撑）：身体水平。肩在最左、髋在中间、踝在最右，y 都 ≈0.60。
 * 相机在孩子侧向 2 米处拍全身 → 躯干在画面里接近水平。 */
const PLANK = () => ({
  shoulderL: { x: 0.22, y: 0.60 }, shoulderR: { x: 0.24, y: 0.61 },
  hipMid: { x: 0.48, y: 0.62 },
  kneeL: { x: 0.70, y: 0.63 }, kneeR: { x: 0.72, y: 0.62 },
  ankleL: { x: 0.80, y: 0.62 }, ankleR: { x: 0.82, y: 0.61 }
});
/* 塌腰的平板支撑：髋掉下去，肩-髋-踝不再共线 */
const PLANK_SAG = () => {
  const j = PLANK();
  j.hipMid = { x: 0.48, y: 0.72 };   // 腰塌了 0.10
  return j;
};
/* 撅屁股的平板支撑：髋翘上去 */
const PLANK_PIKE = () => {
  const j = PLANK();
  j.hipMid = { x: 0.48, y: 0.52 };   // 屁股翘高 0.10
  return j;
};
/* 跪着（不是俯撑）：躯干竖直但重心低 */
const KNEEL = () => ({
  shoulderL: { x: 0.44, y: 0.42 }, shoulderR: { x: 0.56, y: 0.42 },
  hipMid: { x: 0.50, y: 0.62 },
  kneeL: { x: 0.46, y: 0.80 }, kneeR: { x: 0.54, y: 0.80 },
  ankleL: { x: 0.46, y: 0.92 }, ankleR: { x: 0.54, y: 0.92 }
});

/* 靠墙静蹲：大腿水平（髋与膝几乎同高），整体下沉 */
const WALLSIT = () => ({
  shoulderL: { x: 0.43, y: 0.48 }, shoulderR: { x: 0.57, y: 0.48 },
  hipMid: { x: 0.50, y: 0.70 },
  kneeL: { x: 0.45, y: 0.73 }, kneeR: { x: 0.55, y: 0.73 },   // 膝与髋几乎同高 → 大腿水平
  ankleL: { x: 0.45, y: 0.95 }, ankleR: { x: 0.55, y: 0.95 }
});
/* 半蹲（没蹲到位）：大腿还斜着 */
const HALF_SQUAT = () => ({
  shoulderL: { x: 0.43, y: 0.38 }, shoulderR: { x: 0.57, y: 0.38 },
  hipMid: { x: 0.50, y: 0.60 },
  kneeL: { x: 0.45, y: 0.78 }, kneeR: { x: 0.55, y: 0.78 },
  ankleL: { x: 0.45, y: 0.95 }, ankleR: { x: 0.55, y: 0.95 }
});

/* 单腿站立：右脚抬起（右踝升到 0.68） */
const SINGLE = () => ({
  shoulderL: { x: 0.42, y: 0.25 }, shoulderR: { x: 0.58, y: 0.25 },
  hipMid: { x: 0.50, y: 0.55 },
  kneeL: { x: 0.45, y: 0.78 }, kneeR: { x: 0.55, y: 0.70 },
  ankleL: { x: 0.45, y: 0.95 }, ankleR: { x: 0.55, y: 0.68 }   // 右脚抬离地面
});
/* 只是轻轻点地（离地 0.03，不算单腿站立） */
const SINGLE_TIPTOE = () => {
  const j = SINGLE();
  j.ankleR = { x: 0.55, y: 0.92 };
  return j;
};

/* ---------- 跑 ---------- */
let pass = 0, fail = 0;
function check(name, got, ok) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${got ? "  → " + got : ""}`);
  if (ok) pass++; else fail++;
}

/* 模拟一段 6 秒的保持：joints 固定，centroidY 稳定（真保持时重心不动），
 * 但 motion 给一点底噪（真实摄像头必然有）—— 旧逻辑下这就会计秒。 */
function simulate(profile, joints, seconds) {
  const h = makeHold(profile);
  h.setJoints(joints);
  const FPS = 60, N = Math.round(seconds * FPS);
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    h.push(t, 0.55 + 0.001 * ((i % 7) - 3));   // 微小抖动
    h.setLive({ motion: 0.004 });               // 静止底噪，旧逻辑会当"在动"
    h.tick(1 / FPS);
  }
  return h.holdSeconds;
}

console.log("=== 保持类姿态判据（真实几何，fps=60，每段模拟 6 秒）===\n");

console.log("plank（平板支撑）");
const pOk = simulate({ mode: "hold", holdCheck: "plank" }, PLANK(), 6);
const pSag = simulate({ mode: "hold", holdCheck: "plank" }, PLANK_SAG(), 6);
const pPike = simulate({ mode: "hold", holdCheck: "plank" }, PLANK_PIKE(), 6);
const pKneel = simulate({ mode: "hold", holdCheck: "plank" }, KNEEL(), 6);
const pStand = simulate({ mode: "hold", holdCheck: "plank" }, STAND(), 6);
console.log(`  趴平(正确)      → ${pOk.toFixed(1)} 秒`);
console.log(`  塌腰            → ${pSag.toFixed(1)} 秒`);
console.log(`  撅屁股          → ${pPike.toFixed(1)} 秒`);
console.log(`  跪着            → ${pKneel.toFixed(1)} 秒`);
console.log(`  站着            → ${pStand.toFixed(1)} 秒`);
check("趴平计满 6 秒", `${pOk.toFixed(1)}s`, Math.abs(pOk - 6) < 0.2);
check("塌腰不计秒", `${pSag.toFixed(1)}s`, pSag < 0.2);
check("撅屁股不计秒", `${pPike.toFixed(1)}s`, pPike < 0.2);
check("跪着不计秒", `${pKneel.toFixed(1)}s`, pKneel < 0.2);
check("站着不计秒", `${pStand.toFixed(1)}s`, pStand < 0.2);

console.log("\nwallSit（靠墙静蹲）");
const wOk = simulate({ mode: "hold", holdCheck: "wallSit" }, WALLSIT(), 6);
const wHalf = simulate({ mode: "hold", holdCheck: "wallSit" }, HALF_SQUAT(), 6);
const wStand = simulate({ mode: "hold", holdCheck: "wallSit" }, STAND(), 6);
console.log(`  大腿水平(正确)  → ${wOk.toFixed(1)} 秒`);
console.log(`  半蹲(没蹲平)    → ${wHalf.toFixed(1)} 秒`);
console.log(`  站着            → ${wStand.toFixed(1)} 秒`);
check("蹲平计满 6 秒", `${wOk.toFixed(1)}s`, Math.abs(wOk - 6) < 0.2);
check("半蹲不计秒", `${wHalf.toFixed(1)}s`, wHalf < 0.2);
check("站着不计秒", `${wStand.toFixed(1)}s`, wStand < 0.2);

console.log("\nsingleLeg（单腿站立）");
const sOk = simulate({ mode: "hold", holdCheck: "singleLeg" }, SINGLE(), 6);
const sTip = simulate({ mode: "hold", holdCheck: "singleLeg" }, SINGLE_TIPTOE(), 6);
const sStand = simulate({ mode: "hold", holdCheck: "singleLeg" }, STAND(), 6);
console.log(`  一腿离地(正确)  → ${sOk.toFixed(1)} 秒`);
console.log(`  轻轻点地        → ${sTip.toFixed(1)} 秒`);
console.log(`  双脚站立        → ${sStand.toFixed(1)} 秒`);
check("抬脚计满 6 秒", `${sOk.toFixed(1)}s`, Math.abs(sOk - 6) < 0.2);
check("点地不计秒", `${sTip.toFixed(1)}s`, sTip < 0.2);
check("双脚站不计秒", `${sStand.toFixed(1)}s`, sStand < 0.2);

console.log("\n骨架缺失（MediaPipe 漏检 / 掩码链路兜底）");
const noSkel = simulate({ mode: "hold", holdCheck: "plank" }, {}, 6);
const noSkel2 = simulate({ mode: "hold", holdCheck: "wallSit" }, null, 6);
const noSkel3 = simulate({ mode: "hold", holdCheck: "singleLeg" }, undefined, 6);
console.log(`  plank / wallSit / singleLeg → ${noSkel.toFixed(1)} / ${noSkel2.toFixed(1)} / ${noSkel3.toFixed(1)} 秒`);
check("三种动作都不计秒（感应不到人就不计时）", "全 0", noSkel < 0.2 && noSkel2 < 0.2 && noSkel3 < 0.2);

console.log("\n对照：旧逻辑（无 holdCheck）在静止底噪下的行为");
const oldOk = simulate({ mode: "hold" }, PLANK(), 6);
const oldStand = simulate({ mode: "hold" }, STAND(), 6);
console.log(`  趴平  → ${oldOk.toFixed(1)} 秒`);
console.log(`  站着  → ${oldStand.toFixed(1)} 秒  ← 旧逻辑站着也在计秒，这就是要改的问题`);
check("旧逻辑站着也计满（证明新判据确实解决了问题）", `${oldStand.toFixed(1)}s`, Math.abs(oldStand - 6) < 0.2);

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
