"use strict";
/* 探针 2：检查"手臂高于头顶"这种状态下，bbox 顶/底边是否被手臂接管。
 * 这正是"手臂抬高放下会触发跳绳/高抬腿计数"的物理条件。
 *
 * 做法：在真机数据里找 wrist.y < nose.y（手抬到脸以上）的帧，
 * 统计这些帧里 bbox 顶边由谁决定；再把这些帧单独串成序列量峰峰值。
 *
 * 用法：node build/_probe-arm-pollution.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const MP = PV.MP;

const ARM = new Set([MP.L_SHOULDER, MP.R_SHOULDER, MP.L_ELBOW, MP.R_ELBOW,
  MP.L_WRIST, MP.R_WRIST, MP.L_PINKY, MP.R_PINKY, MP.L_INDEX, MP.R_INDEX, MP.L_THUMB, MP.R_THUMB]);
const LEG = new Set([MP.L_HIP, MP.R_HIP, MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE,
  MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT]);
const grp = i => ARM.has(i) ? "ARM" : LEG.has(i) ? "LEG" : "HEAD";
const NAME = {}; for (const k of Object.keys(MP)) NAME[MP[k]] = k;
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const toLM = fr => fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }));

function geom(fr, filter) {
  let minY = Infinity, maxY = -Infinity, minYi = -1, maxYi = -1, bL = 0, bLi = -1, bR = 0, bRi = -1;
  for (let i = 0; i < fr.length; i++) {
    if (filter && !filter(i)) continue;
    const p = fr[i]; if (!p || !(vis(p) >= PV.VIS_MIN)) continue;
    const x = p[0], y = p[1];
    if (y < minY) { minY = y; minYi = i; }
    if (y > maxY) { maxY = y; maxYi = i; }
    if (x < 0.5) { if (y > bL) { bL = y; bLi = i; } } else { if (y > bR) { bR = y; bRi = i; } }
  }
  return { height: Math.max(0, maxY - minY), top: minY, bot: maxY, bL, bR, minYi, maxYi, bLi, bRi };
}

console.log("=== 步骤 1：真机各动作里「手抬到头部以上」的帧占比，以及这些帧的 bbox 顶边归属 ===");
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  const frames = act.frames.filter(Boolean);
  let n = 0, hi = 0, topArm = 0, botArm = 0;
  for (const fr of frames) {
    const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
    n++;
    const nose = fr[MP.NOSE], wl = fr[MP.L_WRIST], wr = fr[MP.R_WRIST];
    const handHigh = (wl && vis(wl) >= PV.VIS_MIN && wl[1] < nose[1]) || (wr && vis(wr) >= PV.VIS_MIN && wr[1] < nose[1]);
    const a = geom(fr, null);
    if (a.minYi >= 0 && ARM.has(a.minYi)) topArm++;
    if (a.maxYi >= 0 && ARM.has(a.maxYi)) botArm++;
    if (handHigh) hi++;
  }
  console.log(`【${act.cn}】${n} 帧 | 手过头顶帧 ${hi} (${(100 * hi / n).toFixed(0)}%) | bbox顶边由手臂决定 ${(100 * topArm / n).toFixed(0)}% | 底边由手臂决定 ${(100 * botArm / n).toFixed(0)}%`);
}

console.log("\n=== 步骤 2：为什么「手抬到头顶」帧里顶边仍是 HEAD？看具体数值 ===");
{
  const act = LMJ.acts.jumpingJacks;   // 开合跳，手臂大量过头顶
  const frames = act.frames.filter(Boolean);
  const idx = frames.findIndex(fr => { const wl = fr[MP.L_WRIST]; return wl && vis(wl) >= PV.VIS_MIN && wl[1] < fr[MP.NOSE][1] - 0.05; });
  const fr = frames[idx];
  const a = geom(fr, null);
  console.log(`  开合跳第 ${idx} 帧（手明显过头顶）`);
  console.log(`    NOSE   y=${fr[MP.NOSE][1].toFixed(4)}`);
  console.log(`    L_WRIST y=${fr[MP.L_WRIST][1].toFixed(4)}  R_WRIST y=${fr[MP.R_WRIST][1].toFixed(4)}`);
  console.log(`    L_INDEX y=${fr[MP.L_INDEX][1].toFixed(4)}  R_INDEX y=${fr[MP.R_INDEX][1].toFixed(4)}`);
  console.log(`    bbox 顶边 = ${a.top.toFixed(4)} 由 ${NAME[a.minYi]} 决定`);
  console.log(`    → 结论：手腕比鼻尖低 ${(fr[MP.L_WRIST][1] - fr[MP.NOSE][1]).toFixed(4)}，手并没有真的高过头顶`);
}
