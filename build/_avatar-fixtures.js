/* 体感角色验收测试的**共享夹具**（合成关节数据，归一化画面坐标，与引擎同一套口径）。
 *
 * 为什么单独一个文件：以前 accept-cat-glb / cat-avatar-test / cat-portrait / avatar-test
 * 各自抄了一份夹具，四份还不一样 —— 同一件事（"站姿"）在四个测试里是四种不同姿势，
 * 于是"某个测试红了"到底是产品变了还是夹具变了，说不清。夹具是**契约的化身**，
 * 只能有一份。
 *
 * ---------- 夹具必须"忠实于真实契约"（含**几何**）----------
 * 踩过的坑（`accept-real-room` 的假链路少给一个 `frameIndex`，产品闸门就误判）说明：
 * 夹具的**字段**必须与真实数据一致。这条同样适用于**数值几何**：
 * 旧夹具是照旧猫模型手写的，骨段长度比真人短 20~40%（上臂 0.1005 vs 模型 0.1265）。
 * 喂给 IK 之后，末端虽然能到位，但肘/膝会被迫折到不自然的角度 ——
 * 截图里就是"双手叉腰、肘向外撇"。那不是模型的问题，是**夹具画错了**。
 * 所以下面所有姿势的骨段长度都取自模型实测（`build/_probe-human-rest-norm.js`
 * 与 `_probe-human-hand.js`）：
 *   上臂 0.1265 · 前臂 0.1288 · **手 0.0874（腕→中指尖）** · 大腿 0.2017 · 小腿 0.2019
 *   站姿关节：踝 0.885 · 膝 0.683 · 髋 0.482 · 盆 0.451 · 肩 0.270 · 颈 0.242
 * `node build/_avatar-fixtures-check.js` 会把这些长度断言一遍，别手改数值不留神。
 *
 * ⚠️ **手长曾经写成 0.026**（= 腕到手心？没有真值锚点），而 `motion-avatar.js` 的
 *    `IDLE_JOINTS.handL/handR` 里是**同一份错误的第二个副本** —— 两处一起错、谁也没发现。
 *    后果是"举手过顶"的边界测试少算一整个手掌（~45px），指尖实际被顶部面板吃掉。
 *    真值：腕→食指尖（引擎 handL 的语义）0.0849、腕→中指尖（最长指）0.0874。
 *    这里取 **0.0874**：构图边界要按"最高可达点"算，取最长指只会**偏保守**。
 *
 * ⚠️ 左右：引擎 `L` = 图像 x 较小侧（屏幕左）。夹具里 `*L` 一律 x < 0.5。
 *    引擎 shoulderL ↔ 模型 RightArm（交叉映射）—— 夹具不需要关心，这是驱动层的事。
 */
"use strict";

const clone = o => JSON.parse(JSON.stringify(o));

/* 自然站姿：与 motion-avatar.js 的 IDLE_JOINTS **同源同值**（都来自模型静止骨架）。
 * ⚠️ 因此"喂 STAND"与"喂 null"对产品来说**是同一件事** —— 想让骨骼动起来做对照，
 *    必须用别的姿势（`squat()` / `armSpread()` / `legsApart()`），别拿 STAND 当"变化后的姿势"。
 *    这个坑踩过一次：human-avatar-test 的"app.js 回调能驱动角色"因此假失败（移动骨骼数=0）。 */
const STAND = {
  head: { x: 0.500, y: 0.098 }, neck: { x: 0.500, y: 0.242 },
  shoulderL: { x: 0.431, y: 0.270 }, shoulderR: { x: 0.569, y: 0.270 },
  midL: { x: 0.423, y: 0.333 }, midR: { x: 0.577, y: 0.333 },
  elbowL: { x: 0.416, y: 0.396 }, elbowR: { x: 0.584, y: 0.396 },
  foreL: { x: 0.412, y: 0.460 }, foreR: { x: 0.588, y: 0.460 },
  wristL: { x: 0.409, y: 0.525 }, wristR: { x: 0.591, y: 0.525 },
  handL: { x: 0.4043, y: 0.6123 }, handR: { x: 0.5957, y: 0.6123 },
  hipMid: { x: 0.500, y: 0.451 }, hipL: { x: 0.463, y: 0.482 }, hipR: { x: 0.537, y: 0.482 },
  kneeL: { x: 0.463, y: 0.683 }, kneeR: { x: 0.537, y: 0.683 },
  shinL: { x: 0.463, y: 0.784 }, shinR: { x: 0.537, y: 0.784 },
  ankleL: { x: 0.463, y: 0.885 }, ankleR: { x: 0.537, y: 0.885 },
  toeL: { x: 0.463, y: 0.925 }, toeR: { x: 0.537, y: 0.925 }
};

const ARM_KEYS = {
  engineL: ["shoulderL", "midL", "elbowL", "foreL", "wristL", "handL"],
  engineR: ["shoulderR", "midR", "elbowR", "foreR", "wristR", "handR"]
};
const LEG_KEYS = {
  engineL: ["hipL", "kneeL", "shinL", "ankleL", "toeL"],
  engineR: ["hipR", "kneeR", "shinR", "ankleR", "toeR"]
};

/* 单侧抬臂到"斜上方 30°"（开合跳张臂的半程）。
 * 肩不动（解剖上肩由躯干决定），肘/腕/手沿骨长往外上方摆 —— 长度严格等于实测骨长。 */
function armUp(side, base) {
  const o = clone(base || STAND);
  const s = side === "engineL" ? -1 : 1;              // 外展方向（引擎 L 在 x<0.5）
  const sh = o[side === "engineL" ? "shoulderL" : "shoulderR"];
  const U = 0.1265, F = 0.1288, H = 0.0874;
  // 上臂：与水平成 30°，向外上方
  const e = { x: sh.x + s * U * Math.cos(Math.PI / 6), y: sh.y - U * Math.sin(Math.PI / 6) };
  // 前臂：与水平成 15°
  const w = { x: e.x + s * F * Math.cos(Math.PI / 12), y: e.y - F * Math.sin(Math.PI / 12) };
  const h = { x: w.x + s * H * Math.cos(Math.PI / 12), y: w.y - H * Math.sin(Math.PI / 12) };
  const k = ARM_KEYS[side];
  o[k[1]] = { x: (sh.x + e.x) / 2, y: (sh.y + e.y) / 2 };   // mid：上臂中点
  o[k[2]] = e;
  o[k[3]] = { x: (e.x + w.x) / 2, y: (e.y + w.y) / 2 };     // fore：前臂中点
  o[k[4]] = w;
  o[k[5]] = h;
  return o;
}

/* 双臂平举（开合跳"张开"瞬间）：两臂都在 z=0 平面内 → 用来验 aim 的平面正确性。 */
function armSpread(base) {
  return armUp("engineR", armUp("engineL", base));
}

/* 双臂**举过头顶**（开合跳的最高点 / 伸展类动作）。
 * ⚠️ 为什么必须有这个姿势：构图安全区那一节原先只喂 `armSpread()`（抬 30°、手根本
 *    不过头），于是"举手时手会不会被顶部面板切掉"这条断言，量到的最高点其实是**头顶**，
 *    等于没验。真人开合跳手是过顶的 —— 必须拿这个姿势去顶边界。
 * 手的位置：肩 y=0.270，臂链 0.1265+0.1288+0.0874=0.3427（竖直向上、带 0.5° 外张）
 * ⇒ 指尖 y ≈ 0.270 − 0.3427×0.995 = **−0.0711**，比头顶（0.098）还高 0.169 归一化单位。
 *
 * ⚠️ 这个姿势比模型的**真实最大伸展**略短（约 0.3% ≈ 1.6px@800）：
 *    骨长取的是 IDLE 手写值（0.3427，实测 0.3442），且手臂带 0.5° 外张不是完全竖直。
 *    单靠它顶边界会**偏乐观一点点**，所以 `accept-human-glb.js` ⑧ 另外补了一条
 *    **与夹具无关**的解析判据（拿 `__modelMetrics().armChain` 算"手臂完全竖直"的极限）。 */
function armsOverhead(base) {
  const o = clone(base || STAND);
  const U = 0.1265, F = 0.1288, H = 0.0874;
  [["engineL", "shoulderL", -1], ["engineR", "shoulderR", 1]].forEach(([side, shKey, s]) => {
    const sh = o[shKey];
    const e = { x: sh.x + s * U * 0.10, y: sh.y - U * 0.995 };   // 上臂近乎竖直向上
    const w = { x: e.x + s * F * 0.10, y: e.y - F * 0.995 };
    const h = { x: w.x + s * H * 0.10, y: w.y - H * 0.995 };
    const k = ARM_KEYS[side];
    o[k[1]] = { x: (sh.x + e.x) / 2, y: (sh.y + e.y) / 2 };      // mid：上臂中点
    o[k[2]] = e;
    o[k[3]] = { x: (e.x + w.x) / 2, y: (e.y + w.y) / 2 };        // fore：前臂中点
    o[k[4]] = w;
    o[k[5]] = h;
  });
  return o;
}

/* 双臂**严格水平共线**平举：肩-肘-腕-手全在一条水平线上，段长严格等于模型骨长。
 *
 * 为什么必须有这个姿势（本轮真机反馈引入）：它是"引擎说**完全伸直**"的最干净输入。
 * 旧 IK 在这个输入下仍会把肘弯 **11.9°** —— 因为旧写法拿"目标到模型根的世界距离"当
 * `d`，而真人骨长比例 ≠ 模型比例，这个比例差被 IK 用**开平方放大**成角度
 * （`acos(1−ε) ≈ √(2ε)`）。孩子原话："我双臂平举时……双臂都向下弯折"。
 * 断言：喂它 ⇒ 模型肘弯曲必须 ≈ 0°（`accept-human-glb.js` ⑨）。 */
function armsStraight(base) {
  const o = clone(base || STAND);
  const U = 0.1265, F = 0.1288, H = 0.0874;
  [["engineL", "shoulderL", -1], ["engineR", "shoulderR", 1]].forEach(([side, shKey, s]) => {
    const sh = o[shKey];
    const e = { x: sh.x + s * U, y: sh.y };
    const w = { x: e.x + s * F, y: e.y };
    const h = { x: w.x + s * H, y: w.y };
    const k = ARM_KEYS[side];
    o[k[1]] = { x: (sh.x + e.x) / 2, y: sh.y };        // mid：上臂中点
    o[k[2]] = e;
    o[k[3]] = { x: (e.x + w.x) / 2, y: sh.y };         // fore：前臂中点
    o[k[4]] = w;
    o[k[5]] = h;
  });
  return o;
}

/* 双腿**严格竖直共线**（髋-膝-踝 同一条竖线，段长严格等于模型骨长）。
 * ⚠️ STAND 的腿本来就是这个姿势 —— 单独列出来是为了让断言**显式**指向"伸直"，
 *    而不是隐含在"站姿"里（"站姿是对的"和"腿是直的"是两件事，别混）。
 * 断言：喂它 ⇒ 模型膝弯曲必须 ≈ 0°。 */
function legsStraight(base) {
  const o = clone(base || STAND);
  const TH = 0.2017, SH = 0.2019;
  ["engineL", "engineR"].forEach(side => {
    const k = LEG_KEYS[side];
    const hip = o[k[0]];
    const kn = { x: hip.x, y: hip.y + TH };
    const an = { x: hip.x, y: kn.y + SH };
    o[k[1]] = kn;
    o[k[2]] = { x: hip.x, y: (kn.y + an.y) / 2 };
    o[k[3]] = an;
    o[k[4]] = { x: hip.x, y: an.y + 0.04 };
  });
  return o;
}

/* 三点在 b 处的**弯曲角**（度）：伸直 = 0°。
 * 输入是 `__poseSnapshot()` 的骨骼世界坐标数组 [x,y,z]。 */
function jointBend(snap, a, b, c) {
  const A = snap[a], B = snap[b], C = snap[c];
  if (!A || !B || !C) return null;
  const u = [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
  const v = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
  const lu = Math.hypot(u[0], u[1], u[2]), lv = Math.hypot(v[0], v[1], v[2]);
  if (!(lu > 1e-9) || !(lv > 1e-9)) return null;
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return 180 - Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
}

/* 只抬一侧、另一侧**原样保持站姿**（对照"没有串扰"）。
 * ⚠️ 别用"把另一侧也挪一下"的写法 —— 那会让"另一侧动没动"这条断言失去意义。 */
function raiseOne(side, base) {
  return armUp(side, base);
}

/* 并腿 → 分开（量腿的动作幅度）：髋下沉、膝踝外移，骨段长度不超可达范围。
 * ⚠️ 髋下沉时**上半身（头/颈/肩/手臂）必须同步下沉** —— 真人分腿/下蹲时肩也会跟着降。
 *    只降髋不降肩，模型的实际肩位就会比引擎给的 `shoulderL` 目标低一大截，
 *    于是"肩→腕"目标距离远小于臂长，IK 只能把肘折起来 → 截图里变成**双手叉腰**。
 *    那是夹具画错了，不是产品缺陷（本项目已栽过同类：旧夹具骨段比真人短 20%）。 */
function legsApart(base) {
  const o = clone(base || STAND);
  const d = 0.038;
  ["head", "neck", "shoulderL", "shoulderR", "midL", "midR", "elbowL", "elbowR",
    "foreL", "foreR", "wristL", "wristR", "handL", "handR"].forEach(k => { o[k].y += d; });
  o.hipMid.y = 0.489; o.hipL.y = 0.520; o.hipR.y = 0.520;
  o.kneeL = { x: 0.393, y: 0.700 }; o.kneeR = { x: 0.607, y: 0.700 };
  o.shinL = { x: 0.373, y: 0.792 }; o.shinR = { x: 0.627, y: 0.792 };
  o.ankleL = { x: 0.343, y: 0.885 }; o.ankleR = { x: 0.657, y: 0.885 };
  o.toeL = { x: 0.343, y: 0.925 }; o.toeR = { x: 0.657, y: 0.925 };
  return o;
}

/* 深蹲（脚不离地、髋大幅下沉）→ 逼 IK 必须把膝盖弯起来（直腿够不到）。
 * 上半身整体随髋下沉 0.14（同上：不这么做手臂会折成"叉腰"）。
 *
 * ⚠️ **腿段长度必须等于模型自己的骨长**（大腿 0.2017 / 小腿 0.2019）。
 *    旧版这里写的是手挑的 `kneeL=(0.380,0.760)`、`ankleL=(0.400,0.885)`，
 *    量出来大腿 0.1610、小腿 0.1266 —— **比模型短 20% / 37%**，正是本文件开头
 *    警告过的同一类错误（"旧夹具骨段比真人短 20~40% ⇒ 膝会被迫折到不自然的角度"）。
 *    旧 IK 用"目标到模型根的距离"当 `d`，短夹具恰好把膝**过度折弯**到 69.2°，
 *    看起来"更像深蹲"，于是这个错误一直没被发现；
 *    换成"复现引擎关节角"之后立刻显形（同一个姿势只剩 33.8°，而引擎自己只说弯 40.1°）。
 *    现在按模型的骨长重画，且把角度做**真的深**（引擎内角 80.1° ⇒ 弯曲 99.9°），
 *    这样 `accept-human-glb.js` ⑦ 的 `> 60°` 阈值**不用动**就仍然成立。
 * 几何（图像坐标，y 向下；髋在 x=0.463，膝往外下、踝回到髋正下方）：
 *   髋(0.463,0.622) → 膝(0.30850,0.75169) → 踝(0.463,0.88167) */
function deepKnee(base) {
  const o = clone(base || STAND);
  const d = 0.140;
  ["head", "neck", "shoulderL", "shoulderR", "midL", "midR", "elbowL", "elbowR",
    "foreL", "foreR", "wristL", "wristR", "handL", "handR"].forEach(k => { o[k].y += d; });
  o.hipMid.y = 0.591; o.hipL.y = 0.622; o.hipR.y = 0.622;
  o.kneeL = { x: 0.30850, y: 0.75169 }; o.kneeR = { x: 0.69150, y: 0.75169 };
  o.shinL = { x: 0.38575, y: 0.81668 }; o.shinR = { x: 0.61425, y: 0.81668 };
  o.ankleL = { x: 0.463, y: 0.88167 }; o.ankleR = { x: 0.537, y: 0.88167 };
  o.toeL = { x: 0.463, y: 0.92167 }; o.toeR = { x: 0.537, y: 0.92167 };
  return o;
}

/* 整体下蹲：躯干与髋下沉、脚不动（髋下降、膝弯）。 */
/* 下蹲：髋沉 0.10、脚不动。
 *
 * ★ 这是**唯一一个"前后方向（朝向相机）缩短"**的夹具 —— 大腿/小腿**故意**比模型骨长短。
 *   真值：大腿 0.1510 / 小腿 0.1520 = 模型 0.2017 / 0.2019 的 0.7486 / 0.7528。
 *   为什么这是**对的**：真人正面下蹲时膝盖往**相机方向**走，大腿与小腿都绕图像平面内的
 *   横轴转了约 41°，投影长度 = 真长 × cos41° ≈ 0.75 倍。两个骨段共用**同一个**系数
 *   （0.7486 vs 0.7528，差 0.6% 来自膝关键点取了整数 0.05）。
 *   所以 `_avatar-fixtures-check.js` 里把它列进 `FORESHORTENED`，**不套"不能短于模型骨长"**
 *   那条下界，改用"两段必须共用同一个缩短系数"来查 —— 手写画短的链会当场露馅。
 *
 * ⚠️ 它同时是 `build/_probe-squat-foreshorten.js` 的主角：引擎报的膝内角是 **180°**
 *    （2D 里看着是直的！），只有"髋→踝投影变短"这一个线索。
 *    ⇒ **纯角度法对它无能为力**（会伸直、脚下沉 0.0606），这是单目 2D 骨架的
 *      **原理性盲区**，已在 `motion-avatar.js` 文件头第 16 条 + `accept-human-glb.js` ⑨
 *      里作为**已知、有界局限**留档。
 *    ⚠️ 曾经试图用"跨帧伸直参考"(`IK_REF`) 补上它 —— 合成夹具上完全成功，但
 *      **真实数据上被否决**（关键点抖动让"绝对伸直"的真人报出最多 24.0° 幻影弯曲，
 *      见 `build/_probe-real-jitter.js`），整段已回退。**别再按这个思路改**。 */
function squat(base) {
  const o = clone(base || STAND);
  ["head", "neck", "shoulderL", "shoulderR", "midL", "midR", "elbowL", "elbowR",
    "foreL", "foreR", "wristL", "wristR", "handL", "handR"].forEach(k => { o[k].y += 0.10; });
  o.hipMid.y += 0.10; o.hipL.y += 0.10; o.hipR.y += 0.10;
  o.kneeL.y += 0.05; o.kneeR.y += 0.05;
  o.shinL.y += 0.025; o.shinR.y += 0.025;
  return o;
}

/* 头明显偏左（用来点名"头骨真的被驱动"）。 */
function headTilt(base) {
  const o = clone(base || STAND);
  o.head = { x: 0.300, y: 0.098 };
  o.neck = { x: 0.420, y: 0.242 };
  return o;
}

/* 上半身有、下半身缺失（测健壮性）。 */
function upperOnly(base) {
  const o = clone(base || STAND);
  ["hipL", "hipR", "kneeL", "kneeR", "shinL", "shinR",
    "ankleL", "ankleR", "toeL", "toeR"].forEach(k => delete o[k]);
  return o;
}

/* 关节数值跳变（模拟误检）。 */
function wildJump(base) {
  const o = clone(base || STAND);
  o.wristL = { x: 0.950, y: 0.050 };
  o.ankleR = { x: 0.050, y: 0.980 };
  return o;
}

/* 归一化关节之间的"骨段长度"（供自检脚本核对夹具是否忠实于模型）。 */
function segLen(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
const MODEL_SEG = {
  upperArm: 0.1265, foreArm: 0.1288, hand: 0.0874,      // hand = 腕→中指尖（实测）
  thigh: 0.2017, shin: 0.2019
};

module.exports = {
  clone, STAND, ARM_KEYS, LEG_KEYS, MODEL_SEG, segLen, jointBend,
  armUp, armSpread, armsOverhead, armsStraight, legsStraight,
  raiseOne, legsApart, deepKnee, squat, headTilt, upperOnly, wildJump
};
