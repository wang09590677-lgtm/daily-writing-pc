/* 体感角色验收的 **3D 夹具**：在 `_avatar-fixtures.js`（2D）的基础上给每个关节补 `z`。
 *
 * 为什么必须单独一份（本轮真机反馈引入）：
 *   孩子原话：「跟练模型只是对正面平面的运动识别比较准，对前后方向动作无法识别，
 *             比如我正对着摄像头跑步、双臂正向举起落下、正对镜头高抬腿」。
 *   这些都是**矢状面（前后方向）**的动作。而 2D 夹具**表达不了它们** ——
 *   把"手臂指向相机"投影到 2D 之后，肩/肘/腕三点**完全重合**，
 *   2D 数据里根本看不出"这是一次前平举"。于是这条路径**从来没被验过**，
 *   51 条断言全绿也照样漏（和上一轮"没有严格伸直的夹具"是同一类盲区）。
 *
 * ---------- z 的口径 ----------
 * **直接沿用 MediaPipe**：`z` 与 `x` 同量纲，**负 = 靠近相机**，原点大致在髋中点。
 * 这样夹具与真实链路是同一个口径 —— 不需要任何换算，也就不会在换算上出错
 * （本项目已栽过"两个副本各自换算"的坑，见 `_avatar-fixtures.js` 头部的 `hand` 长度）。
 * 角色世界坐标里 `+z` 朝向相机（`motion-avatar.js` 的相机在 z=+3 朝 −z），
 * 换算在 `motion-avatar.js` 的 `rawWorld()` 里做，**只做一次**。
 *
 * ---------- 坐标约定 ----------
 *   x 向右、y **向下**（图像坐标）、z **远离相机**（MediaPipe 口径）。
 *   绕 x 轴旋转 θ（在 y-z 平面内，这就是矢状面）：
 *     (dy, dz) → (dy·cosθ + dz·sinθ, −dy·sinθ + dz·cosθ)
 *   验证 θ=90°、点相对支点 (0, L, 0)（正下方）⇒ (0, 0, −L)：**指向相机** ✓
 */
"use strict";

const F = require("./_avatar-fixtures.js");

const D2R = Math.PI / 180;

/* 2D 姿势 → 3D（z 全 0）。用来把 2D 夹具当"矢状面没动"的基线。 */
function lift(p) {
  const o = F.clone(p);
  Object.keys(o).forEach(k => { if (o[k]) o[k].z = 0; });
  return o;
}

/* 去掉 z（模拟**当前**链路的所见：pose-vision 的 makePt 只留 x/y，
 * motion-avatar 的 rawWorld 又把 z 写成 0）。这是"复现缺陷"用的投影。 */
function project2D(p) {
  const o = F.clone(p);
  Object.keys(o).forEach(k => { if (o[k]) delete o[k].z; });
  return o;
}

/* 把 `keys` 列出的关节绕 `pivotKey` 在 y-z 平面内转 theta（**弧度**）。
 * pivot 本身不动。中间点（mid/fore/shin）是中点，绕支点转之后仍是中点 ✓。 */
function swing(pose, keys, pivotKey, theta) {
  const pv = pose[pivotKey];
  if (!pv) return pose;
  const c = Math.cos(theta), s = Math.sin(theta);
  keys.forEach(k => {
    const q = pose[k];
    if (!q) return;
    const dy = q.y - pv.y, dz = (q.z || 0) - (pv.z || 0);
    q.y = pv.y + dy * c + dz * s;
    q.z = (pv.z || 0) + (-dy * s + dz * c);
  });
  return pose;
}

/* 前平举：双臂从垂在身侧 → 绕肩**向前（朝相机）**抬起 deg 度。
 * deg=90 ⇒ 手臂水平指向相机；2D 投影里肩/肘/腕**三点重合**
 * ⇒ 引擎拿到一条长度 ≈0 的链，IK 会把手臂折成一团。这就是孩子报的第一个现象。 */
function frontRaise(deg, base) {
  const o = lift(base || F.STAND);
  const t = deg * D2R;
  [["engineL", "shoulderL"], ["engineR", "shoulderR"]].forEach(([side, shKey]) => {
    const k = F.ARM_KEYS[side];
    swing(o, [k[1], k[2], k[3], k[4], k[5]], shKey, t);
  });
  return o;
}

/* 高抬腿：大腿绕髋向前抬 deg 度，小腿**回到竖直下垂**（于是膝屈约 deg 度）。
 * deg=100 ⇒ 大腿略高于水平、指向相机，小腿竖直垂着 —— 正对镜头的高抬腿。
 * 2D 投影里膝内角仍 ≈ 180−10 = 170°（**看着是直的**）⇒ 角色腿不弯、整条腿被平移上提。 */
function highKnee(side, deg, base) {
  const o = lift(base || F.STAND);
  const k = F.LEG_KEYS[side];
  const t = deg * D2R;
  swing(o, [k[1], k[2], k[3], k[4]], k[0], t);        // 整条腿绕髋前摆
  swing(o, [k[2], k[3], k[4]], k[1], -t);             // 小腿绕膝回摆 ⇒ 竖直下垂
  return o;
}

/* 正对镜头跑步的一个瞬间：左腿前摆 + 右腿后摆，两臂反相前后摆。
 * `phase` ∈ [-1, 1]：+1 = 左腿抬到最高。 */
function runStride(phase, legDeg, armDeg, base) {
  const o = lift(base || F.STAND);
  const pl = Math.max(-1, Math.min(1, phase));
  const legT = (legDeg || 45) * D2R, armT = (armDeg || 35) * D2R;
  /* 腿：前摆侧的大腿向前，小腿略回摆（跑姿不会把小腿甩直） */
  const legSide = pl >= 0 ? "engineL" : "engineR";
  const kL = F.LEG_KEYS[legSide];
  swing(o, [kL[1], kL[2], kL[3], kL[4]], kL[0], legT * Math.abs(pl));
  swing(o, [kL[2], kL[3], kL[4]], kL[1], -legT * 0.55 * Math.abs(pl));
  /* 手臂：与同侧腿**反相**（真人跑姿） */
  const armSide = pl >= 0 ? "engineR" : "engineL";
  const kA = F.ARM_KEYS[armSide];
  swing(o, [kA[1], kA[2], kA[3], kA[4], kA[5]], armSide === "engineL" ? "shoulderL" : "shoulderR",
    armT * Math.abs(pl));
  return o;
}

/* **真·3D 深蹲**：髋下沉 `depth`，膝盖同时**朝相机方向前移**，脚不动。
 * 与 2D 的 `squat()` 不同 —— 这里膝盖有真实的 z（负=朝相机），
 * 所以"引擎报的膝内角"在 3D 下是**真的弯**，而不是 2D 投影里的 180°。
 * 这正是上一轮标记的"2D 原理性盲区"在 3D 数据下的对照。 */
function squat3d(depth, base) {
  const o = lift(base || F.STAND);
  const TH = F.MODEL_SEG.thigh, SH = F.MODEL_SEG.shin;
  ["head", "neck", "shoulderL", "shoulderR", "midL", "midR", "elbowL", "elbowR",
    "foreL", "foreR", "wristL", "wristR", "handL", "handR"].forEach(k => { o[k].y += depth; });
  o.hipMid.y += depth;
  ["engineL", "engineR"].forEach(side => {
    const k = F.LEG_KEYS[side];
    const hip = o[k[0]], ank = o[k[3]];
    hip.y += depth;
    /* 在 y-z 平面里解两段骨：膝到髋的距离 = TH、到踝的距离 = SH。
     * a = 沿"髋→踝"的分量，b = 垂直分量（朝相机 −z）。 */
    const ay = ank.y - hip.y, az = (ank.z || 0) - (hip.z || 0);
    const D = Math.hypot(ay, az);
    const a = (TH * TH - SH * SH + D * D) / (2 * D);
    const b = Math.sqrt(Math.max(0, TH * TH - a * a));
    const uy = ay / D, uz = az / D;
    /* 垂直方向取"朝相机"那一侧：把 u 在 y-z 平面内转 +90°。
     * (uy,uz) 转 +90° ⇒ (uz, −uy)。要 z 分量为负（朝相机）⇒ 取 −(uz, −uy)。 */
    const py = -uz, pz = uy;
    const sgn = pz <= 0 ? 1 : -1;            // 让垂直分量的 z 为负
    const kn = { x: hip.x, y: hip.y + a * uy + sgn * b * py, z: (hip.z || 0) + a * uz + sgn * b * pz };
    o[k[1]] = kn;
    o[k[2]] = { x: hip.x, y: (kn.y + ank.y) / 2, z: ((kn.z || 0) + (ank.z || 0)) / 2 };
    o[k[4]] = { x: ank.x, y: ank.y + 0.04, z: ank.z || 0 };
  });
  return o;
}

/* 矢状面姿势的"真值摘要"：这条链**该有多大的前后分量**。
 * ⚠️ 必须同时给出**中间关节**（肘/膝）的 z —— 只看"根→末"的 Δz 会漏掉整类姿势：
 *    高抬腿/深蹲时踝几乎在髋正下方，`Δz(髋→踝) ≈ 0`，但**膝**明显朝相机。
 *    第一版就是这么量错的（把 3D 深蹲的膝前移量成了 0）。
 * 返回每侧：`dzMid` = 肘/膝相对根的深度偏移（负 = 朝相机）、`fwdMid` = 它占该骨长的比例、
 * `bend` = 该关节的 **3D** 内角弯曲度（真值，2D 投影里会变成 0）。 */
function sagittalTruth(pose) {
  const chain = (rootK, midK, endK, segMid, segEnd) => {
    const a = pose[rootK], m = pose[midK], b = pose[endK];
    if (!a || !m || !b) return null;
    const dzMid = (m.z || 0) - (a.z || 0);
    const u = [a.x - m.x, a.y - m.y, (a.z || 0) - (m.z || 0)];
    const v = [b.x - m.x, b.y - m.y, (b.z || 0) - (m.z || 0)];
    const lu = Math.hypot(u[0], u[1], u[2]), lv = Math.hypot(v[0], v[1], v[2]);
    const cos = lu > 1e-9 && lv > 1e-9
      ? (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv) : 1;
    return {
      dzMid: +dzMid.toFixed(4),
      fwdMid: +(Math.abs(dzMid) / segMid).toFixed(3),
      lenMid: +Math.hypot(m.x - a.x, m.y - a.y, (m.z || 0) - (a.z || 0)).toFixed(4),
      lenEnd: +Math.hypot(b.x - m.x, b.y - m.y, (b.z || 0) - (m.z || 0)).toFixed(4),
      bend: +(180 - Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toFixed(1)
    };
  };
  return {
    armL: chain("shoulderL", "elbowL", "handL", F.MODEL_SEG.upperArm, F.MODEL_SEG.foreArm),
    armR: chain("shoulderR", "elbowR", "handR", F.MODEL_SEG.upperArm, F.MODEL_SEG.foreArm),
    legL: chain("hipL", "kneeL", "ankleL", F.MODEL_SEG.thigh, F.MODEL_SEG.shin),
    legR: chain("hipR", "kneeR", "ankleR", F.MODEL_SEG.thigh, F.MODEL_SEG.shin)
  };
}

module.exports = {
  lift, project2D, swing, sagittalTruth,
  frontRaise, highKnee, runStride, squat3d,
  STAND3D: lift(F.STAND)
};
