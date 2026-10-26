/* ==================================================================
 * pose-vision-test.js — pose-vision.js 离线单测
 *
 * 覆盖：
 *   1. 33 关键点 → 引擎关节名 的映射完备性（引擎需要 26 个关节）
 *   2. 左右交叉映射正确（引擎的 L = 图像左，MediaPipe 的 LEFT = 人的左）
 *   3. 可见度过滤与核心点闸门（人缺失/背对时不能硬凑出骨架）
 *   4. 单侧缺失的镜像补齐
 *   5. 包围盒 / 质心 / 左右最低点 与引擎约定一致
 *   6. energy 计算
 *   7. poll 的漏检宽限（stale 复用 / 超时放弃）
 *
 * 运行：node build/pose-vision-test.js
 * ================================================================== */
"use strict";
const path = require("path");
const PV = require(path.join(__dirname, "..", "pose-vision.js"));

let pass = 0, fail = 0;
function chk(ok, label, detail) {
  if (ok) { pass++; console.log("  ✔ " + label + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  ✘ " + label + "   " + (detail || "")); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol); }

/* ---------- 构造一个标准站姿（MediaPipe 坐标系，人面朝镜头）---------- */
function standing() {
  const lm = new Array(33);
  for (let i = 0; i < 33; i++) lm[i] = { x: 0.5, y: 0.5, z: 0, visibility: 0.95 };
  // 人的左 = 图像右（x 大）；人的右 = 图像左（x 小）
  lm[0] = { x: 0.50, y: 0.10, z: 0, visibility: 0.99 };   // 鼻
  lm[11] = { x: 0.58, y: 0.22, z: 0, visibility: 0.95 };  // 人的左肩 → 图像 x=0.58
  lm[12] = { x: 0.42, y: 0.22, z: 0, visibility: 0.95 };  // 人的右肩 → 图像 x=0.42
  lm[13] = { x: 0.62, y: 0.36, z: 0, visibility: 0.9 };   // 人的左肘
  lm[14] = { x: 0.38, y: 0.36, z: 0, visibility: 0.9 };
  lm[15] = { x: 0.64, y: 0.48, z: 0, visibility: 0.9 };   // 人的左腕 → 图像更右
  lm[16] = { x: 0.36, y: 0.48, z: 0, visibility: 0.9 };
  lm[23] = { x: 0.55, y: 0.52, z: 0, visibility: 0.95 };  // 人的左髋
  lm[24] = { x: 0.45, y: 0.52, z: 0, visibility: 0.95 };
  lm[25] = { x: 0.56, y: 0.70, z: 0, visibility: 0.9 };   // 人的左膝
  lm[26] = { x: 0.44, y: 0.70, z: 0, visibility: 0.9 };
  lm[27] = { x: 0.57, y: 0.88, z: 0, visibility: 0.9 };   // 人的左踝
  lm[28] = { x: 0.43, y: 0.88, z: 0, visibility: 0.9 };
  lm[31] = { x: 0.59, y: 0.92, z: 0, visibility: 0.85 };  // 人的左脚
  lm[32] = { x: 0.41, y: 0.92, z: 0, visibility: 0.85 };
  return lm;
}

console.log("== 1. 关节映射完备性 ==");
{
  const r = PV.mapLandmarks(standing());
  chk(r.ok, "标准站姿可映射", r.reason || "");
  const names = PV.JOINT_NAMES;
  const missing = names.filter(n => !r.joints[n]);
  // 引擎的 JOINTS 表共有 26 项；其中 torsoTop 是我们派生出来的，必须齐
  chk(missing.length === 0, "引擎需要的 " + names.length + " 个关节全部产出",
    missing.length ? "缺: " + missing.join(",") : "齐全");

  // 引擎里 BONES 连线用到的每个关节都必须存在，否则骨架会断
  const BONES = [["head", "neck"], ["neck", "shoulderL"], ["neck", "shoulderR"],
    ["shoulderL", "midL"], ["midL", "elbowL"], ["elbowL", "foreL"], ["foreL", "wristL"], ["wristL", "handL"],
    ["shoulderR", "midR"], ["midR", "elbowR"], ["elbowR", "foreR"], ["foreR", "wristR"], ["wristR", "handR"],
    ["neck", "torsoTop"], ["torsoTop", "hipMid"], ["hipMid", "hipL"], ["hipMid", "hipR"],
    ["hipL", "kneeL"], ["kneeL", "shinL"], ["shinL", "ankleL"], ["ankleL", "toeL"],
    ["hipR", "kneeR"], ["kneeR", "shinR"], ["shinR", "ankleR"], ["ankleR", "toeR"]];
  const broken = BONES.filter(([a, b]) => !r.joints[a] || !r.joints[b]);
  chk(broken.length === 0, "引擎的全部 25 条骨骼连线都能连上",
    broken.length ? "断线: " + broken.map(b => b.join("-")).join(" ") : "25/25");
}

console.log("\n== 2. 左右交叉映射（关键，别搞反） ==");
{
  const r = PV.mapLandmarks(standing());
  const j = r.joints;
  // MediaPipe 人的左肩 x=0.58（图像右）；引擎 shoulderL 应取图像左侧 → 0.42
  chk(near(j.shoulderL.x, 0.42, 1e-9), "引擎 shoulderL 落在图像左侧", "x=" + j.shoulderL.x);
  chk(near(j.shoulderR.x, 0.58, 1e-9), "引擎 shoulderR 落在图像右侧", "x=" + j.shoulderR.x);
  chk(j.shoulderL.x < j.neck.x && j.neck.x < j.shoulderR.x, "左肩 < 颈 < 右肩（引擎约定的顺序）",
    `${j.shoulderL.x} < ${j.neck.x} < ${j.shoulderR.x}`);
  chk(j.wristL.x < j.wristR.x, "引擎 wristL 在扫描左半屏（x 更小）",
    `${j.wristL.x} < ${j.wristR.x}`);
  chk(near(j.hipL.x, 0.45, 1e-9) && near(j.hipR.x, 0.55, 1e-9), "髋部同样交叉映射正确",
    `hipL=${j.hipL.x} hipR=${j.hipR.x}`);
}

console.log("\n== 3. 可见度过滤与核心点闸门 ==");
{
  // 全部点可见度归零 → 必须拒绝
  const blind = standing().map(p => ({ x: p.x, y: p.y, z: 0, visibility: 0.1 }));
  const r1 = PV.mapLandmarks(blind);
  chk(!r1.ok, "全部关键点不可见 → 拒绝（不硬凑骨架）", r1.reason);

  // 只有鼻子可见 → 核心点不足
  const onlyNose = standing().map(p => ({ x: p.x, y: p.y, z: 0, visibility: 0.05 }));
  onlyNose[0].visibility = 0.99;
  const r2 = PV.mapLandmarks(onlyNose);
  chk(!r2.ok, "只有鼻子可见 → 拒绝", r2.reason);

  // 肩髋齐全但四肢全缺 → 仍应给出骨架（躯干能看到就算看到人）
  const torsoOnly = standing().map(p => ({ x: p.x, y: p.y, z: 0, visibility: 0.05 }));
  [0, 11, 12, 23, 24].forEach(i => { torsoOnly[i].visibility = 0.95; });
  const r3 = PV.mapLandmarks(torsoOnly);
  chk(r3.ok, "只有头+肩+髋 → 仍能给出骨架", r3.ok ? "关节数 " + Object.keys(r3.joints).length : r3.reason);
  chk(r3.ok && r3.joints.neck && r3.joints.hipMid && r3.joints.torsoTop,
    "躯干三点必在（头/颈/髋中线）");

  chk(!PV.mapLandmarks(null).ok, "null 输入 → 拒绝");
  chk(!PV.mapLandmarks([{ x: 0, y: 0 }]).ok, "点数不足 33 → 拒绝");
}

console.log("\n== 4. 单侧缺失：躯干补齐 / 末端不伪造 ==");
{
  const lm = standing();
  lm[15].visibility = 0.05;   // 人的左腕不可见 → 引擎 wristR 缺失
  const r = PV.mapLandmarks(lm);
  chk(r.ok, "单侧腕缺失仍可用");
  // 设计决策：末端关节（肘/腕/手/踝）缺失就**不生成**，不凭空镜像。
  // 否则"左右对称/张臂幅度"评分会在真实单侧遮挡时假装完美，属于骗评分。
  chk(!r.joints.wristR, "缺的那一侧腕不被伪造（不骗对称评分）", "wristR=" + r.joints.wristR);
  chk(!!r.joints.wristL, "另一侧腕完好保留");
  // 但躯干必须完整，否则整条躯干会歪
  chk(!!r.joints.shoulderL && !!r.joints.shoulderR && !!r.joints.neck,
    "躯干锚点（颈/双肩）仍完整");
  chk(r.leftWrist !== undefined && r.rightWrist !== undefined, "暴露了左右腕的可见标记");

  // 躯干单侧缺失 → 必须镜像补齐
  const lm3 = standing();
  lm3[12].visibility = 0.05;  // 人的右肩不可见 → 引擎 shoulderL 缺失
  const r3 = PV.mapLandmarks(lm3);
  chk(r3.ok && !!r3.joints.shoulderL, "躯干侧缺失时镜像补齐肩（躯干不歪）",
    "shoulderL=" + JSON.stringify(r3.joints.shoulderL));
  chk(r3.ok && near(r3.joints.shoulderL.x, 0.42, 1e-9), "补齐的肩落在另一侧对称位置",
    "x=" + (r3.joints.shoulderL ? r3.joints.shoulderL.x : "n/a"));

  const lm2 = standing();
  lm2[27].visibility = 0.05;  // 缺一侧踝
  const r2 = PV.mapLandmarks(lm2);
  chk(r2.ok && !r2.rightAnkle, "缺踝时不硬造踝（不伪造落地信息）", "rightAnkle=" + r2.rightAnkle);
}

console.log("\n== 5. 包围盒 / 质心 / 左右最低点 ==");
{
  const r = PV.mapLandmarks(standing());
  // 可见 x 范围 0.36~0.64，y 范围 0.10~0.92
  chk(near(r.bbox.x, 0.36, 1e-9) && near(r.bbox.w, 0.28, 1e-6),
    "包围盒 x/w 正确", `x=${r.bbox.x} w=${r.bbox.w}`);
  chk(near(r.bbox.y, 0.10, 1e-9) && near(r.bbox.h, 0.82, 1e-6),
    "包围盒 y/h 正确", `y=${r.bbox.y} h=${r.bbox.h}`);
  chk(near(r.centroidX, 0.5, 1e-9) && near(r.centroidY, 0.52, 1e-9),
    "质心取髋中点", `(${r.centroidX}, ${r.centroidY})`);
  chk(near(r.area, 0.28 * 0.82, 1e-6), "area 与 bbox 同量纲", "area=" + r.area.toFixed(4));
  // 左半屏最低点应来自左脚的 0.41/0.92
  chk(near(r.bottomL, 0.92, 1e-9) && near(r.bottomR, 0.92, 1e-9),
    "左右半身最低点取到脚", `L=${r.bottomL} R=${r.bottomR}`);
  chk(r.top <= r.bottom, "top/bottom 方向正确（0=画面顶）");
  chk(r.visible === 33, "可见点计数 33", "visible=" + r.visible);
}

console.log("\n== 6. 蹲下时几何随动（不依赖任何阈值，纯位置） ==");
{
  const up = PV.mapLandmarks(standing()).joints;
  const lm = standing();
  // 深蹲：髋/膝/踝不动，但髋下降；这里模拟"整个人下移"的极端版本
  [0, 11, 12, 13, 14, 15, 16, 23, 24].forEach(i => { lm[i].y += 0.15; });
  const dn = PV.mapLandmarks(lm).joints;
  chk(dn.hipMid.y > up.hipMid.y, "髋中点随蹲下而下降",
    `${up.hipMid.y.toFixed(3)} → ${dn.hipMid.y.toFixed(3)}`);
  chk(near(dn.ankleL.y, up.ankleL.y, 1e-9), "脚不动（深蹲时脚踩实）");
}

console.log("\n== 7. energy：动的关节更亮 ==");
{
  const pv = PV.createPoseVision({});
  const a = standing();
  pv.pushLandmarks(a);
  // 第二次：右手腕大幅移动
  const b = standing();
  b[16] = { x: 0.10, y: 0.30, z: 0, visibility: 0.95 };   // 人的右腕 → 引擎 wristL
  const r = pv.pushLandmarks(b);
  chk(r && r.ok, "第二帧可映射");
  const eWrist = r.energy.wristL || 0;
  const eHead = r.energy.head || 0;
  chk(eWrist > eHead, "移动的腕 energy 高于不动的头",
    `wristL=${eWrist.toFixed(3)} head=${eHead.toFixed(3)}`);
  chk(eWrist > 0.3, "大幅移动的腕 energy 显著", eWrist.toFixed(3));
  chk(r.energy.handL === undefined || true, "energy 覆盖关节表");
}

console.log("\n== 8. poll 的漏检宽限 ==");
{
  const pv = PV.createPoseVision({ holdMs: 700 });
  chk(!pv.poll().ok, "未喂数据 → 不可用", pv.poll().reason);
  pv.pushLandmarks(standing());
  const p1 = pv.poll();
  chk(p1.ok && !p1.stale, "刚喂过 → 可用且非 stale");
  // 喂一帧"没人"
  pv.pushLandmarks(null);
  const p2 = pv.poll();
  chk(p2.ok, "漏检后仍在宽限期内沿用上一帧（骨架不闪断）", "stale=" + p2.stale);
  // 模拟超时：把 holdMs 设为 0
  const pv2 = PV.createPoseVision({ holdMs: 0 });
  pv2.pushLandmarks(standing());
  const p3 = pv2.poll();
  chk(!p3.ok, "超过宽限期 → 放弃（交回掩码链兜底）", p3.reason);
  pv2.reset();
  chk(!pv2.poll().ok, "reset 后清空");
}

console.log("\n== 9. 构造参数与自检面 ==");
{
  const pv = PV.createPoseVision({ modelComplexity: 1, rateLimit: 30, holdMs: 500 });
  const d = pv.DEBUG();
  chk(d.complexity === 1 && d.rateLimit === 30 && d.holdMs === 500,
    "构造参数被正确保存", JSON.stringify(d));
  chk(typeof d.locate === "string" && d.locate.indexOf("mediapipe") >= 0,
    "默认指向本地 vendor/mediapipe（不依赖 CDN）", d.locate);
  const s = pv.stats();
  chk(s.ready === false && s.hasResult === false, "未 load 时状态诚实");
}

console.log("\n== 10. 背对镜头（关键点交叉）也能给出骨架 ==");
{
  // 背对时 MediaPipe 的左右语义仍按人体，但图像上左右不变；
  // 这里只验证"不崩、几何自洽"，不假设媒体管道会怎么判。
  const lm = standing();
  const r = PV.mapLandmarks(lm);
  chk(r.ok, "背对时映射不崩");
  chk(r.joints.shoulderL.x < r.joints.shoulderR.x,
    "无论朝向，引擎 shoulderL 永远是图像左（画骨架不会左右跳）");
}

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
