/* 夹具自检（纯 Node，毫秒级）：`_avatar-fixtures.js` 里的合成姿势是否**忠实于模型几何**。
 *
 * 为什么值得单独一个文件：夹具是"契约的化身"，一旦它的骨段长度与模型不符，
 * IK 就会被逼出畸形姿态（旧夹具上臂 0.1005 vs 模型 0.1265 → 截图里"双手叉腰"），
 * 而这种错误**看起来像产品缺陷**，会浪费大量时间去查驱动层。
 * 这个自检把"夹具错了"和"产品错了"一刀切开。
 *
 * 用法：node build/_avatar-fixtures-check.js
 */
"use strict";
const F = require("./_avatar-fixtures.js");

let pass = 0, fail = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? "  → " + detail : ""}`);
}
const S = F.STAND, M = F.MODEL_SEG;
const L = (k) => S[k];

/* ---- 1. 站姿的骨段长度 = 模型实测 ---- */
check("上臂长 = 模型 0.1265",
  near(F.segLen(L("shoulderL"), L("elbowL")), M.upperArm, 0.002),
  F.segLen(L("shoulderL"), L("elbowL")).toFixed(4));
check("前臂长 = 模型 0.1288",
  near(F.segLen(L("elbowL"), L("wristL")), M.foreArm, 0.002),
  F.segLen(L("elbowL"), L("wristL")).toFixed(4));
check("手长（腕→中指尖）= 模型 0.0874",
  near(F.segLen(L("wristL"), L("handL")), M.hand, 0.002),
  F.segLen(L("wristL"), L("handL")).toFixed(4) + "（曾经写成 0.026 —— 差 236%，见夹具文件头）");
check("大腿长 = 模型 0.2017",
  near(F.segLen(L("hipL"), L("kneeL")), M.thigh, 0.002),
  F.segLen(L("hipL"), L("kneeL")).toFixed(4));
check("小腿长 = 模型 0.2019",
  near(F.segLen(L("kneeL"), L("ankleL")), M.shin, 0.002),
  F.segLen(L("kneeL"), L("ankleL")).toFixed(4));
check("左右完全对称（x 关于 0.5 镜像、y 相同）",
  ["shoulder", "mid", "elbow", "fore", "wrist", "hand", "hip", "knee", "shin", "ankle", "toe"]
    .every(p => {
      const a = S[p + "L"], b = S[p + "R"];
      return a && b && near(a.x + b.x, 1.0, 1e-9) && near(a.y, b.y, 1e-9);
    }), "全部镜像一致");

/* ---- 2. 站姿必须是"腿伸直、手臂下垂" ---- */
const legLen = F.segLen(L("hipL"), L("kneeL")) + F.segLen(L("kneeL"), L("ankleL"));
const hipAnkle = F.segLen(L("hipL"), L("ankleL"));
check("站姿腿基本伸直（髋→踝 ≥ 腿长 × 0.99）",
  hipAnkle >= legLen * 0.99, `髋→踝=${hipAnkle.toFixed(4)} 腿长=${legLen.toFixed(4)}`);
check("站姿手在髋以下（不是 T-pose、不是举着）",
  L("handL").y > L("hipL").y + 0.05, `手y=${L("handL").y} 髋y=${L("hipL").y}`);
check("站姿头在颈以上、颈在肩以上（没写反）",
  L("head").y < L("neck").y && L("neck").y < L("shoulderL").y,
  `头=${L("head").y} 颈=${L("neck").y} 肩=${L("shoulderL").y}`);

/* ---- 3. 每个姿势都必须在合法范围内、且各段不超模型可达长度 ---- */
const POSES = {
  STAND: S, armSpread: F.armSpread(), armsOverhead: F.armsOverhead(),
  raiseL: F.raiseOne("engineL"),
  raiseR: F.raiseOne("engineR"), legsApart: F.legsApart(),
  deepKnee: F.deepKnee(), squat: F.squat(), headTilt: F.headTilt(),
  upperOnly: F.upperOnly(), wildJump: F.wildJump()
};
let rangeBad = [], overBad = [], underBad = [], tiltBad = [];
/* 这两个姿势**故意**不合法：upperOnly 缺关节、wildJump 把关节扔到画面另一角。
 * 它们测的是"产品不崩"，不参与几何可达性核对。 */
const EXEMPT = { upperOnly: 1, wildJump: 1 };
/* ★ **前后方向（朝向相机）缩短**的姿势 —— 它们的骨段**本来就该短于模型骨长**。
 * 为什么：夹具是"引擎给的 2D 投影"，而真人正面下蹲时膝盖往**相机方向**走，
 * 大腿/小腿都绕图像平面内的横轴转了约 41°，投影长度 = 真长 × cos41° ≈ 0.75 倍。
 * 实测：`squat` 大腿 0.1510 / 小腿 0.1520 = 模型 0.2017 / 0.2019 的 **0.7486 / 0.7528**。
 * ⇒ 对它们套"不能短于模型骨长"是**判据本身用错了地方**，不是夹具画错。
 * 但也不能就此不查 —— 见下面那条"两个骨段必须**共用同一个缩短系数**"：
 * 手写画短的链（旧 `deepKnee` 是 20%/37% 两个不同系数）会当场露馅。 */
const FORESHORTENED = { squat: 1 };
Object.keys(POSES).forEach(name => {
  const j = POSES[name];
  if (EXEMPT[name]) return;
  Object.keys(j).forEach(k => {
    const p = j[k];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) rangeBad.push(`${name}.${k} 非有限值`);
    else if (p.x < -0.35 || p.x > 1.35 || p.y < -0.35 || p.y > 1.35) rangeBad.push(`${name}.${k}=(${p.x},${p.y})`);
  });
  ["L", "R"].forEach(s => {
    const need = ["hip" + s, "knee" + s, "ankle" + s, "shoulder" + s, "elbow" + s, "wrist" + s];
    if (!need.every(k => j[k])) return;      // 故意缺关节的姿势（upperOnly）跳过骨长核对
    const th = F.segLen(j["hip" + s], j["knee" + s]);
    const sh = F.segLen(j["knee" + s], j["ankle" + s]);
    const ua = F.segLen(j["shoulder" + s], j["elbow" + s]);
    const fa = F.segLen(j["elbow" + s], j["wrist" + s]);
    // 目标骨段可以**短于**模型骨长（= 关节弯了），但不能长过模型（= IK 必然够不到）
    if (th > M.thigh * 1.02) overBad.push(`${name}.大腿${s}=${th.toFixed(4)}>${M.thigh}`);
    if (sh > M.shin * 1.02) overBad.push(`${name}.小腿${s}=${sh.toFixed(4)}>${M.shin}`);
    if (ua > M.upperArm * 1.02) overBad.push(`${name}.上臂${s}=${ua.toFixed(4)}>${M.upperArm}`);
    if (fa > M.foreArm * 1.02) overBad.push(`${name}.前臂${s}=${fa.toFixed(4)}>${M.foreArm}`);
    /* ★ **下界**：骨段也不能明显短于模型骨长。
     * 真人的大腿/小腿/上臂/前臂长度**不随姿势变化**，所以夹具里每一段的长度都应当
     * ≈ 模型骨长（留 ±8% 容纳真人比例差）。这条是补上来的 ——
     * 原来只查"不能长过模型"，于是"**画短了**"这个方向**一条判据都没有**。
     * 而项目已经在这个方向上踩过两次：
     *   · 手臂：`MODEL_SEG.hand` 写 0.026（真值 0.0874，**短 236%**）；
     *   · 腿：`deepKnee` 大腿/小腿写 0.1610/0.1266（模型 0.2017/0.2019，**短 20%/37%**）。
     * 后果不是"够不到"（短了不会让 IK 饱和），而是**逼 IK 过度折弯** ——
     * 旧 `deepKnee` 因此折出 69.2° 的"深蹲"，看起来更像真的，所以一直没被发现。
     * ⚠️ 例外：`FORESHORTENED`（前后方向缩短）的姿势**本来就该短**，见上面那条注释。 */
    if (!FORESHORTENED[name]) {
      if (th < M.thigh * 0.92) underBad.push(`${name}.大腿${s}=${th.toFixed(4)}`);
      if (sh < M.shin * 0.92) underBad.push(`${name}.小腿${s}=${sh.toFixed(4)}`);
      if (ua < M.upperArm * 0.92) underBad.push(`${name}.上臂${s}=${ua.toFixed(4)}`);
      if (fa < M.foreArm * 0.92) underBad.push(`${name}.前臂${s}=${fa.toFixed(4)}`);
    } else {
      /* 前后方向缩短的姿势：**两个骨段必须共用同一个缩短系数**。
       * 这是"它确实是投影、不是手写画短"的判据 —— 一次绕图像平面内横轴的旋转
       * 对同一条链的两段施加**同一个** cos(倾角)，而手写画短是各画各的。
       * 旧 `deepKnee` 的 20% / 37% 就是两个系数，用这条会当场抓出来。 */
      const kT = th / M.thigh, kS = sh / M.shin;
      if (Math.abs(kT - kS) > 0.02) {
        tiltBad.push(`${name}.腿${s} 大腿×${kT.toFixed(4)} vs 小腿×${kS.toFixed(4)}`);
      }
      if (kT >= 1 || kS >= 1) tiltBad.push(`${name}.腿${s} 标了"前后缩短"却没缩短`);
    }
    /* 手也一起查：它曾经被写短 236%，而"写短"不会让 IK 饱和（只是量错），
     * 所以只有这条**长度**核对才拦得住 —— 单看"能不能到位"是看不出来的。 */
    if (j["hand" + s]) {
      const hd = F.segLen(j["wrist" + s], j["hand" + s]);
      if (hd > M.hand * 1.02) overBad.push(`${name}.手${s}=${hd.toFixed(4)}>${M.hand}`);
      if (hd < M.hand * 0.92) underBad.push(`${name}.手${s}=${hd.toFixed(4)}<${(M.hand * 0.92).toFixed(4)}`);
    }
  });
});
check("所有姿势的关节都在合法归一化范围内", rangeBad.length === 0, rangeBad.slice(0, 3).join(" | ") || "全部合法");
check("所有姿势的骨段都不超过模型可达长度（否则 IK 必然饱和）",
  overBad.length === 0, overBad.slice(0, 3).join(" | ") || "全部可达");
/* ★ **下界**（本轮补上）：骨段也不能明显**短于**模型骨长。
 * 真人的大腿/小腿/上臂/前臂长度**不随姿势变化**，所以夹具里每一段都应当 ≈ 模型骨长
 * （留 ±8% 容纳真人比例差）。这条以前**完全缺失** —— 只查"不能长过模型"，
 * 于是"**画短了**"这个方向一条判据都没有。而项目已经在这个方向上踩过两次：
 *   · 手臂：`MODEL_SEG.hand` 写 0.026（真值 0.0874，**短 236%**）；
 *   · 腿：`deepKnee` 大腿/小腿写 0.1610/0.1266（模型 0.2017/0.2019，**短 20%/37%**）。
 * 后果不是"够不到"（短了不会让 IK 饱和），而是**逼 IK 过度折弯** ——
 * 旧 `deepKnee` 因此折出 69.2° 的"深蹲"，看起来更像真的，所以一直没被发现。
 * ⇒ 「长得像对的」不等于「几何是对的」，长度必须**双向**核对。 */
check("所有姿势的骨段都不明显短于模型骨长（防「夹具画短 ⇒ IK 被迫过度折弯」）",
  underBad.length === 0, underBad.slice(0, 3).join(" | ") || "全部达标");
check("标为「前后方向缩短」的姿势：两个骨段共用同一个缩短系数（防「手写画短」冒充投影）",
  tiltBad.length === 0, tiltBad.slice(0, 3).join(" | ") || "系数一致");

/* ---- 3b. 躯干长度必须守恒（守"上半身与下半身同步下沉"）----
 * 这条才是**真正**防"双手叉腰"的判据。此前这里放的是一条"肩→腕 ≈ 臂长"的检查，
 * 但它对**整体平移不敏感** —— 只把髋降下去、肩留在原处，"肩→腕"距离**一点没变**，
 * 照样 100% 通过。所以那条检查根本拦不住它声称要拦的错误（自欺的判据）。
 *
 * 真正的物理约束是：真人下沉时肩与髋**一起**降，躯干长度（肩↔髋）基本不变。
 * 于是断言每个姿势的 (hipL.y − shoulderL.y) 都与站姿一致（±0.01）。
 * 只降髋不降肩 → 该值变大 → 立刻红。 */
const torsoRef = S.hipL.y - S.shoulderL.y;
const torsoBad = [];
Object.keys(POSES).forEach(name => {
  if (EXEMPT[name]) return;
  const j = POSES[name];
  if (!j.hipL || !j.shoulderL) return;
  const t = j.hipL.y - j.shoulderL.y;
  if (Math.abs(t - torsoRef) > 0.01) torsoBad.push(`${name}=${t.toFixed(3)}`);
});
check("所有姿势的躯干长度(髋↔肩)与站姿一致（守「上下半身同步下沉」，防手臂被折成叉腰）",
  torsoBad.length === 0, torsoBad.join(", ") || `全部 ≈ ${torsoRef.toFixed(3)}`);

/* 附带一条"目标点可达"的检查：肩→腕 的距离不该超过臂长（否则 IK 必然饱和）。
 * ⚠️ 注意它**只能**证明"目标可达"，**不能**代替上面那条躯干守恒 —— 见上。 */
const armLen = M.upperArm + M.foreArm;
const armBad = [];
Object.keys(POSES).forEach(name => {
  if (EXEMPT[name]) return;
  const j = POSES[name];
  ["L", "R"].forEach(s => {
    if (!j["shoulder" + s] || !j["wrist" + s]) return;
    const d = F.segLen(j["shoulder" + s], j["wrist" + s]) / armLen;
    if (d > 1.03) armBad.push(`${name}.${s}=${(d * 100).toFixed(0)}%`);
  });
});
check("所有姿势的'肩→腕'都不超过臂长（目标点可达，IK 不会饱和）",
  armBad.length === 0, armBad.join(", ") || "全部可达");

/* ---- 4. 各姿势的"意图"必须真的成立 ---- */
/* 这条是给"构图安全区"那一节兜底的：如果 armsOverhead 的手其实没过头顶，
 * 那"举手会不会被顶部面板切掉"就又在量头顶了（= 原来那条假判据的老路）。 */
check("armsOverhead：双手确实**高过头顶**（否则'举手顶边界'那条构图判据又是空的）",
  POSES.armsOverhead.handL.y < S.head.y - 0.05 && POSES.armsOverhead.handR.y < S.head.y - 0.05,
  `手y=${POSES.armsOverhead.handL.y.toFixed(3)} 头y=${S.head.y}`);
check("armUp：抬起的腕高于肩、且更外展",
  POSES.raiseL.wristL.y < S.shoulderL.y && POSES.raiseL.wristL.x < S.shoulderL.x - 0.15,
  `腕=(${POSES.raiseL.wristL.x.toFixed(3)},${POSES.raiseL.wristL.y.toFixed(3)}) 肩=(${S.shoulderL.x},${S.shoulderL.y})`);
check("raiseOne：只动了一侧（另一侧与站姿完全一致）",
  JSON.stringify(POSES.raiseL.handR) === JSON.stringify(S.handR) &&
  JSON.stringify(POSES.raiseL.wristR) === JSON.stringify(S.wristR),
  "右侧未变");
check("armSpread：两手都在肩上、左右对称",
  POSES.armSpread.wristL.y < S.shoulderL.y && POSES.armSpread.wristR.y < S.shoulderR.y &&
  near(POSES.armSpread.wristL.y, POSES.armSpread.wristR.y, 1e-9), "对称");
check("legsApart：踝确实外移了 ≥ 0.10（幅度断言的基础）",
  S.ankleL.x - POSES.legsApart.ankleL.x >= 0.10,
  `Δx=${(S.ankleL.x - POSES.legsApart.ankleL.x).toFixed(4)}`);
check("deepKnee：髋→踝 明显短于腿长（膝盖**必须**弯，直腿够不到）",
  F.segLen(POSES.deepKnee.hipL, POSES.deepKnee.ankleL) < legLen * 0.80,
  `髋→踝=${F.segLen(POSES.deepKnee.hipL, POSES.deepKnee.ankleL).toFixed(4)} 腿长=${legLen.toFixed(4)}`);
check("squat：髋下沉 0.10、脚不动（髋会跟着降）",
  near(POSES.squat.hipL.y - S.hipL.y, 0.10, 1e-9) &&
  JSON.stringify(POSES.squat.ankleL) === JSON.stringify(S.ankleL), "髋 +0.10，踝未变");
check("headTilt：头明显偏左（x < 0.35）", POSES.headTilt.head.x < 0.35, "head.x=" + POSES.headTilt.head.x);
check("upperOnly：下半身关节确实缺失",
  !("kneeL" in POSES.upperOnly) && !("ankleR" in POSES.upperOnly), "-");
check("wildJump：两个关节被扔到画面另一角",
  POSES.wildJump.wristL.x > 0.9 && POSES.wildJump.ankleR.x < 0.1, "-");
check("usable() 的必填关节一个不少（head/neck/hipMid/hipL/hipR/shoulderL/shoulderR/kneeL/kneeR）",
  ["head", "neck", "hipMid", "hipL", "hipR", "shoulderL", "shoulderR", "kneeL", "kneeR"]
    .every(k => S[k]), "-");

console.log(`\n===== 夹具自检 ${pass}/${pass + fail} 通过 =====`);
if (fail) process.exit(1);
