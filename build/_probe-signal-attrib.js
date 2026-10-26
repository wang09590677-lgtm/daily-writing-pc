"use strict";
/* 归因探针：用**真机关键点**逐帧跑真实的 mapLandmarks()，
 * 拆出 height / bottomL / bottomR 到底由哪些关键点驱动，
 * 并对比"含手臂"与"屏蔽手臂"两条信号的峰峰值差异。
 * 目的：用真数据证明"手臂动作污染信号"，不靠猜。
 *
 * 用法：node build/_probe-signal-attrib.js
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
const HEAD = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const grp = i => ARM.has(i) ? "ARM" : LEG.has(i) ? "LEG" : HEAD.has(i) ? "HEAD" : "?";

const toLM = fr => fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] }));
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];

/* 按给定口径算 bbox / bottom，并记录"贡献者"下标 */
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
  return { top: minY, bot: maxY, height: Math.max(0, maxY - minY), bL, bR, minYi, maxYi, bLi, bRi };
}

function run(key) {
  const act = LMJ.acts[key]; if (!act) return;
  const frames = act.frames.filter(Boolean);
  const cnt = { top: {}, bot: {}, bL: {}, bR: {} };
  const S = { H_all: [], H_noArm: [], bL_all: [], bL_noArm: [], bR_all: [], bR_noArm: [] };
  let n = 0;
  for (const fr of frames) {
    const m = PV.mapLandmarks(toLM(fr)); if (!m.ok) continue;
    const a = geom(fr, null), t = geom(fr, i => !ARM.has(i));
    n++;
    cnt.top[grp(a.minYi)] = (cnt.top[grp(a.minYi)] || 0) + 1;
    cnt.bot[grp(a.maxYi)] = (cnt.bot[grp(a.maxYi)] || 0) + 1;
    cnt.bL[grp(a.bLi)] = (cnt.bL[grp(a.bLi)] || 0) + 1;
    cnt.bR[grp(a.bRi)] = (cnt.bR[grp(a.bRi)] || 0) + 1;
    S.H_all.push(m.height); S.H_noArm.push(t.height);
    S.bL_all.push(m.bottomL); S.bL_noArm.push(t.bL);
    S.bR_all.push(m.bottomR); S.bR_noArm.push(t.bR);
  }
  const pct = o => Object.keys(o).sort((p, q) => o[q] - o[p]).map(k => `${k}:${(100 * o[k] / n).toFixed(0)}%`).join(" ");
  const pp = a => a.length ? (Math.max(...a) - Math.min(...a)) : 0;
  console.log(`\n【${act.cn}】${n} 可用帧`);
  console.log(`  bbox 顶边由谁决定   : ${pct(cnt.top)}`);
  console.log(`  bbox 底边由谁决定   : ${pct(cnt.bot)}`);
  console.log(`  bottomL  由谁决定   : ${pct(cnt.bL)}`);
  console.log(`  bottomR  由谁决定   : ${pct(cnt.bR)}`);
  console.log(`  峰峰值 height  含臂=${pp(S.H_all).toFixed(4)} 屏蔽臂=${pp(S.H_noArm).toFixed(4)}`);
  console.log(`  峰峰值 bottomL 含臂=${pp(S.bL_all).toFixed(4)} 屏蔽臂=${pp(S.bL_noArm).toFixed(4)}`);
  console.log(`  峰峰值 bottomR 含臂=${pp(S.bR_all).toFixed(4)} 屏蔽臂=${pp(S.bR_noArm).toFixed(4)}`);
}
for (const k of ["highKnees", "jumpRope", "jumpingJacks", "squat", "burpee"]) run(k);
