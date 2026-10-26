"use strict";
/* 探针 4：找到"手臂接管包围盒底边"的真实条件，并量出它对 height 的污染幅度。
 *
 * 已知（探针 1/2 实测）：
 *   · 站立动作里，bbox 顶边 = 指尖/头，底边 = 腿 —— 手臂基本不污染。
 *   · 波比跳（有俯撑）里，bbox 底边 52% 由手臂决定、顶边 53% 由手臂决定。
 * 本探针沿时间轴打印波比跳的逐帧状态，找出"手臂接管"发生在什么姿态。
 *
 * 用法：node build/_probe-arm-edge-condition.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;
const NAME = {}; for (const k of Object.keys(MP)) NAME[MP[k]] = k;
const ARM = new Set([MP.L_SHOULDER, MP.R_SHOULDER, MP.L_ELBOW, MP.R_ELBOW,
  MP.L_WRIST, MP.R_WRIST, MP.L_PINKY, MP.R_PINKY, MP.L_INDEX, MP.R_INDEX, MP.L_THUMB, MP.R_THUMB]);
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const toLM = fr => fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }));

function geom(fr) {
  let minY = Infinity, maxY = -Infinity, minYi = -1, maxYi = -1;
  for (let i = 0; i < fr.length; i++) {
    const p = fr[i]; if (!p || !(vis(p) >= PV.VIS_MIN)) continue;
    if (p[1] < minY) { minY = p[1]; minYi = i; }
    if (p[1] > maxY) { maxY = p[1]; maxYi = i; }
  }
  return { top: minY, bot: maxY, h: maxY - minY, minYi, maxYi };
}

const act = LMJ.acts.burpee;
const frames = act.frames.filter(Boolean);
console.log(`【${act.cn}】共 ${frames.length} 帧，逐帧看 hipMid.y（人是否倒地/下蹲）与边界归属`);
console.log("帧    hipMidY   bbox高   顶边归属     底边归属");
for (let i = 0; i < frames.length; i += 4) {
  const fr = frames[i]; const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
  const g = geom(fr);
  const hipY = m.joints.hipMid.y;
  console.log(`${String(i).padStart(3)}   ${hipY.toFixed(3)}     ${g.h.toFixed(3)}   ${NAME[g.minYi].padEnd(11)} ${NAME[g.maxYi]}`);
}

/* 分姿态统计：hipMid.y > 0.6 视为"明显下蹲/俯撑" */
console.log("\n=== 按姿态分组：手臂是否接管边界 ===");
for (const [label, test] of [["站立/直立 (hipY<0.55)", y => y < 0.55], ["下蹲/俯撑 (hipY>=0.55)", y => y >= 0.55]]) {
  let n = 0, tA = 0, bA = 0;
  for (const fr of frames) {
    const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
    if (!test(m.joints.hipMid.y)) continue;
    n++;
    const g = geom(fr);
    if (ARM.has(g.minYi)) tA++;
    if (ARM.has(g.maxYi)) bA++;
  }
  if (n) console.log(`  ${label.padEnd(24)} ${String(n).padStart(3)} 帧 | 顶边臂 ${(100 * tA / n).toFixed(0)}% | 底边臂 ${(100 * bA / n).toFixed(0)}%`);
}
