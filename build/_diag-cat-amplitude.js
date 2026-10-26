/* 诊断：体感猫「动作看起来明显不明显」的**量化**度量（只读，不改产品文件）。
 *
 * 用户原话：「跟着感应动作运动的人形猫咪动作还不如最早你生成的那个版本准确，
 *            是不是因为四肢比例不够修长导致我觉得他动作看起来动的不明显呢？」
 *
 * 本脚本回答 1~5、7（第 6 条骨骼拉伸在 _diag-cat-lab.js 里做）：
 *   1. 幅度量化：喂受控合成姿态，量模型末端骨骼的世界位移（米 + 占模型身高比）
 *   2. 人体 vs 模型段长比（上臂/前臂/大腿/小腿/脚掌）
 *   3. bodySpan（k2 动态缩放）对幅度的影响
 *   4. IK 饱和：目标是否超出模型肢体可达范围
 *   5. JOINT_SMOOTH 对快速动作的衰减（实测传递率 + 逐关节每帧 lerp 次数）
 *   7. 与「最早版本」(_rollback/motion-avatar.before-cat.js 纯几何人偶) 的解析对比
 *
 * 用法：NODE_PATH=... node build/_diag-cat-amplitude.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 受控合成姿态（归一化画面坐标，与引擎同一口径） ---------------- */
function base() {
  return {
    head: { x: 0.5, y: 0.10 }, neck: { x: 0.5, y: 0.22 },
    shoulderL: { x: 0.43, y: 0.27 }, shoulderR: { x: 0.57, y: 0.27 },
    midL: { x: 0.425, y: 0.32 }, midR: { x: 0.575, y: 0.32 },
    elbowL: { x: 0.42, y: 0.37 }, elbowR: { x: 0.58, y: 0.37 },
    foreL: { x: 0.416, y: 0.42 }, foreR: { x: 0.584, y: 0.42 },
    wristL: { x: 0.414, y: 0.465 }, wristR: { x: 0.586, y: 0.465 },
    handL: { x: 0.413, y: 0.49 }, handR: { x: 0.587, y: 0.49 },
    hipMid: { x: 0.5, y: 0.56 }, hipL: { x: 0.462, y: 0.563 }, hipR: { x: 0.538, y: 0.563 },
    kneeL: { x: 0.46, y: 0.712 }, kneeR: { x: 0.54, y: 0.712 },
    shinL: { x: 0.459, y: 0.80 }, shinR: { x: 0.541, y: 0.80 },
    ankleL: { x: 0.458, y: 0.888 }, ankleR: { x: 0.542, y: 0.888 },
    toeL: { x: 0.458, y: 0.93 }, toeR: { x: 0.542, y: 0.93 }
  };
}
function withJoints(over) {
  const b = base();
  for (const k of Object.keys(over)) b[k] = Object.assign({}, b[k] || {}, over[k]);
  return b;
}
const ARM_DOWN = withJoints({});
const ARM_T = withJoints({
  shoulderL: { x: 0.43, y: 0.26 }, midL: { x: 0.37, y: 0.255 }, elbowL: { x: 0.31, y: 0.25 },
  foreL: { x: 0.25, y: 0.248 }, wristL: { x: 0.19, y: 0.245 }, handL: { x: 0.15, y: 0.243 },
  shoulderR: { x: 0.57, y: 0.26 }, midR: { x: 0.63, y: 0.255 }, elbowR: { x: 0.69, y: 0.25 },
  foreR: { x: 0.75, y: 0.248 }, wristR: { x: 0.81, y: 0.245 }, handR: { x: 0.85, y: 0.243 }
});
const ARM_UP = withJoints({
  shoulderL: { x: 0.43, y: 0.26 }, midL: { x: 0.42, y: 0.19 }, elbowL: { x: 0.41, y: 0.13 },
  foreL: { x: 0.405, y: 0.09 }, wristL: { x: 0.40, y: 0.055 }, handL: { x: 0.40, y: 0.03 },
  shoulderR: { x: 0.57, y: 0.26 }, midR: { x: 0.58, y: 0.19 }, elbowR: { x: 0.59, y: 0.13 },
  foreR: { x: 0.595, y: 0.09 }, wristR: { x: 0.60, y: 0.055 }, handR: { x: 0.60, y: 0.03 }
});
const LEGS_TOGETHER = withJoints({
  kneeL: { x: 0.49, y: 0.712 }, kneeR: { x: 0.51, y: 0.712 },
  shinL: { x: 0.492, y: 0.80 }, shinR: { x: 0.508, y: 0.80 },
  ankleL: { x: 0.495, y: 0.888 }, ankleR: { x: 0.505, y: 0.888 },
  toeL: { x: 0.495, y: 0.93 }, toeR: { x: 0.505, y: 0.93 }
});
const LEGS_APART = withJoints({
  kneeL: { x: 0.40, y: 0.712 }, kneeR: { x: 0.60, y: 0.712 },
  shinL: { x: 0.36, y: 0.80 }, shinR: { x: 0.64, y: 0.80 },
  ankleL: { x: 0.32, y: 0.888 }, ankleR: { x: 0.68, y: 0.888 },
  toeL: { x: 0.31, y: 0.93 }, toeR: { x: 0.69, y: 0.93 }
});
const KNEE_STRAIGHT = withJoints({
  kneeL: { x: 0.461, y: 0.712 }, kneeR: { x: 0.539, y: 0.712 },
  shinL: { x: 0.4595, y: 0.80 }, shinR: { x: 0.5405, y: 0.80 },
  ankleL: { x: 0.458, y: 0.888 }, ankleR: { x: 0.542, y: 0.888 }
});
/* 屈膝 = 把脚抬起来（踝靠向髋）—— 只有"髋→踝距离 < 腿长"时膝盖才可能弯。
 * 第一版把膝点本身移开、踝不动，结果 d 仍 > 腿长 → 腿始终锁死在伸直态 → 膝位移恒为 0
 * （这个"锁死"本身就是重要发现，见报告第 4 条）。 */
const KNEE_BENT = withJoints({
  kneeL: { x: 0.40, y: 0.70 }, kneeR: { x: 0.60, y: 0.70 },
  shinL: { x: 0.43, y: 0.71 }, shinR: { x: 0.57, y: 0.71 },
  ankleL: { x: 0.44, y: 0.72 }, ankleR: { x: 0.56, y: 0.72 },
  toeL: { x: 0.44, y: 0.74 }, toeR: { x: 0.56, y: 0.74 }
});
/* span 变体：把**整个姿态**按比例缩放（绕身体中心）—— 这样"姿态形状"不变、只改"人体在
 * 画面里的大小"，即 bodySpan。若 k2 是纯尺寸归一化，则世界位移应基本不变；
 * 若被 clamp[0.32,1.15] 截断或模型肢体够不到，才会出现压缩。 */
function scalePose(src, f) {
  const p = JSON.parse(JSON.stringify(src));
  const cy = 0.5, cx = 0.5;
  Object.keys(p).forEach(k => { p[k].x = cx + (p[k].x - cx) * f; p[k].y = cy + (p[k].y - cy) * f; });
  return p;
}
/* 目标世界坐标（与产品 rawWorld 同一公式：k2 = H/span，scale = H/RAW_H，REST_LOWEST=0.08） */
const RAW_H = 2.96, REST_LOWEST = 0.08;
function targetWorld(p, key, span, layout) {
  const q = p[key];
  if (!q) return null;
  const scale = layout.H / RAW_H, k2 = layout.H / span;
  let bot = -Infinity;
  ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => { if (p[k]) bot = Math.max(bot, p[k].y); });
  return [(q.x - 0.5) * k2, layout.footY + REST_LOWEST * scale + (bot - q.y) * k2, 0];
}
function poseSpan(p) {
  const top = p.head.y;
  let bot = -Infinity;
  ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => { if (p[k]) bot = Math.max(bot, p[k].y); });
  return bot - top;
}

/* ---------------- puppeteer 起手式（照抄 _dbg-cat-ik.js） ---------------- */
(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-catamp-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    defaultViewport: { width: 1000, height: 720 },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("skeleton ready=" + sk.ready + " failed=" + sk.failed + " bones=" + sk.boneCount + " skinned=" + sk.skinnedCount + " reason=" + (sk.reason || "-"));

  const SETTLE = 40;
  async function measure(joints) {
    return page.evaluate(({ j, n }) => {
      const M = window.MotionAvatar;
      for (let i = 0; i < n; i++) M.updateFromSkeleton(j);
      M.__renderNow();
      const g = k => { const w = M.__boneWorld(k); return w ? [w.x, w.y, w.z] : null; };
      const snap = {};
      ["RightHand", "LeftHand", "RightFoot", "LeftFoot", "RightLowerLeg", "LeftLowerLeg",
        "RightLowerArm", "LeftLowerArm", "RightUpperArm", "LeftUpperArm",
        "RightUpperLeg", "LeftUpperLeg", "Hips", "Head", "Neck",
        "RightShoulder", "LeftShoulder", "RightToes", "LeftToes"].forEach(k => { snap[k] = g(k); });
      return { snap, ik: M.__ikError(), layout: M.__layout() };
    }, { j: joints, n: SETTLE });
  }
  const d3 = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : NaN;
  const d2 = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1]) : NaN;

  const out = {};

  /* ---- 模型骨骼链长度（debug().links） ---- */
  const dbg = await page.evaluate(() => window.MotionAvatar.debug());
  const LAY = (await measure(ARM_DOWN)).layout;
  const linkLen = {};
  dbg.links.forEach(l => { linkLen[l.name] = l.length; });
  out.meta = { layout: LAY, linkLen, boneCount: dbg.boneCount, skinnedCount: dbg.skinnedCount };

  /* =================== 1. 幅度量化 =================== */
  const idle = await measure(ARM_DOWN);
  const armT = await measure(ARM_T);
  const armUp = await measure(ARM_UP);
  const legsTogether = await measure(LEGS_TOGETHER);
  const legsApart = await measure(LEGS_APART);
  const kneeStraight = await measure(KNEE_STRAIGHT);
  const kneeBent = await measure(KNEE_BENT);
  const H = LAY.H;

  const amp = [];
  const addAmp = (label, a, b, bone, tag) => {
    const d = d3(a.snap[bone], b.snap[bone]);
    amp.push({ label, bone, tag, disp: d, frac: d / H, from: a.snap[bone], to: b.snap[bone] });
  };
  addAmp("手臂 下垂→侧平举", idle, armT, "RightHand", "arm");
  addAmp("手臂 下垂→侧平举", idle, armT, "LeftHand", "arm");
  addAmp("手臂 下垂→上举", idle, armUp, "RightHand", "arm");
  addAmp("手臂 下垂→上举", idle, armUp, "LeftHand", "arm");
  addAmp("腿 并腿→分开", legsTogether, legsApart, "RightFoot", "leg");
  addAmp("腿 并腿→分开", legsTogether, legsApart, "LeftFoot", "leg");
  addAmp("膝 直→屈膝抬脚(膝点)", kneeStraight, kneeBent, "RightLowerLeg", "knee");
  addAmp("膝 直→屈膝抬脚(踝点)", kneeStraight, kneeBent, "RightFoot", "knee");
  out.amplitude = amp;

  /* =================== 2. 人体 vs 模型 段长比 =================== */
  const span = (() => {
    const j = ARM_DOWN;
    const top = j.head.y;
    let bot = -Infinity;
    ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => { if (j[k]) bot = Math.max(bot, j[k].y); });
    return bot - top;
  })();
  const jl = (a, b) => { const p = ARM_DOWN[a], q = ARM_DOWN[b]; return Math.hypot(p.x - q.x, p.y - q.y); };
  const human = {
    upperArm: jl("shoulderL", "elbowL"), foreArm: jl("elbowL", "wristL"),
    thigh: jl("hipL", "kneeL"), shin: jl("kneeL", "ankleL"), foot: jl("ankleL", "toeL")
  };
  const humanFrac = {}; Object.keys(human).forEach(k => humanFrac[k] = human[k] / span);
  const modelFrac = {
    upperArm: linkLen["RightUpperArm"] / H, foreArm: linkLen["RightLowerArm"] / H,
    thigh: linkLen["RightUpperLeg"] / H, shin: linkLen["RightLowerLeg"] / H,
    foot: linkLen["RightFoot"] / H
  };
  const ratio = {}; Object.keys(modelFrac).forEach(k => ratio[k] = modelFrac[k] / humanFrac[k]);
  out.segments = { span, H, humanNorm: human, humanFrac, modelFrac, ratio,
    modelWorld: { upperArm: linkLen["RightUpperArm"], foreArm: linkLen["RightLowerArm"], thigh: linkLen["RightUpperLeg"], shin: linkLen["RightLowerLeg"], foot: linkLen["RightFoot"] } };
  out.armReach = { modelUpperArmPlusForearm: linkLen["RightUpperArm"] + linkLen["RightLowerArm"],
    modelThighPlusShin: linkLen["RightUpperLeg"] + linkLen["RightLowerLeg"],
    humanArmWorld: (human.upperArm + human.foreArm) / span * H,
    humanLegWorld: (human.thigh + human.shin) / span * H };

  /* =================== 3. bodySpan 影响 =================== */
  const spanRes = [];
  for (const f of [0.40, 0.70, 1.00, 1.30, 1.60]) {
    const pa = scalePose(ARM_DOWN, f), pb = scalePose(ARM_UP, f);
    const a = await measure(pa), b = await measure(pb);
    const spanTrue = poseSpan(pa);                 // 真实 span
    const spanUsed = Math.min(1.15, Math.max(0.32, spanTrue));  // 产品 clamp 后
    const d = d3(a.snap.RightHand, b.snap.RightHand);
    const k2 = a.layout.H / spanUsed;
    // 该姿态下"目标"的腕位移（世界）——用于看模型跟丢了多少
    const ta = targetWorld(pa, "wristL", spanUsed, a.layout), tb = targetWorld(pb, "wristL", spanUsed, a.layout);
    const td = d3(ta, tb);
    spanRes.push({ f, spanTrue, spanUsed, clamped: spanTrue !== spanUsed, k2, H: a.layout.H,
      handDisp: d, targetDisp: td, track: d / td, fracOfH: d / a.layout.H });
  }
  out.bodySpan = spanRes;

  /* =================== 4. IK 饱和（目标距离 vs 模型链长） =================== */
  const ikRows = [];
  const ikPoses = [["站姿(arms down)", idle, ARM_DOWN], ["双臂侧平举", armT, ARM_T], ["双臂上举", armUp, ARM_UP],
    ["并腿站", legsTogether, LEGS_TOGETHER], ["双腿分开", legsApart, LEGS_APART],
    ["直腿", kneeStraight, KNEE_STRAIGHT], ["屈膝抬脚", kneeBent, KNEE_BENT]];
  for (const [name, m, pose] of ikPoses) {
    const ik = m.ik || {};
    const sp = poseSpan(pose);
    const wT = targetWorld(pose, "wristL", sp, m.layout), aT = targetWorld(pose, "ankleL", sp, m.layout);
    const kT = targetWorld(pose, "kneeL", sp, m.layout), eT = targetWorld(pose, "elbowL", sp, m.layout);
    const armRoot = m.snap.RightUpperArm, legRoot = m.snap.RightUpperLeg;
    const armReach = out.armReach.modelUpperArmPlusForearm, legReach = out.armReach.modelThighPlusShin;
    const armD = d3(armRoot, wT), legD = d3(legRoot, aT);
    ikRows.push({
      name, err: ik,
      armRootToTarget: armD, armReach, armSat: armD > armReach + 1e-3,
      legRootToTarget: legD, legReach, legSat: legD > legReach + 1e-3,
      targetWrist: wT, targetAnkle: aT, modelWrist: m.snap.RightHand, modelAnkle: m.snap.RightFoot
    });
  }
  out.ik = ikRows;

  /* =================== 5. JOINT_SMOOTH 传递率（实测） =================== */
  const staticPP = Math.abs(idle.snap.RightHand[1] - armUp.snap.RightHand[1]);
  const trans = [];
  for (const k of [1, 2, 4, 8, 16, 32]) {
    const r = await page.evaluate(({ a, b, k, cycles }) => {
      const M = window.MotionAvatar;
      for (let i = 0; i < 60; i++) M.updateFromSkeleton(a);
      const ys = [];
      for (let c = 0; c < cycles; c++) {
        for (let i = 0; i < k; i++) M.updateFromSkeleton(a);
        const wa = M.__boneWorld("RightHand"); ys.push(wa ? wa.y : null);
        for (let i = 0; i < k; i++) M.updateFromSkeleton(b);
        const wb = M.__boneWorld("RightHand"); ys.push(wb ? wb.y : null);
      }
      const use = ys.slice(10).filter(x => x != null);
      const mn = Math.min.apply(null, use), mx = Math.max.apply(null, use);
      return { pp: mx - mn };
    }, { a: ARM_DOWN, b: ARM_UP, k, cycles: 40 });
    // 理论传递率（一阶 EMA，方波基频 ω=π/k）
    const alpha = 0.45, w = Math.PI / k;
    const th = alpha / Math.sqrt(1 - 2 * (1 - alpha) * Math.cos(w) + (1 - alpha) * (1 - alpha));
    trans.push({ k, framesPerHalfCycle: k, dynamicPP: r.pp, staticPP, transfer: r.pp / staticPP, theoryEMA: th });
  }
  out.smoothing = { JOINT_SMOOTH: 0.45, staticPP, trans };

  /* ---- 每帧各关节 jointTarget 调用次数（静态推导，供交叉核对） ---- */
  out.smoothing.perJointLerpsPerFrame = {
    neck: 8, hipMid: 4, head: 2, ankleL: 2, ankleR: 2, wristL: 2, wristR: 2,
    elbowL: 2, elbowR: 2, toeL: 1, toeR: 1, kneeL: 1, kneeR: 1,
    shoulderL: 1, shoulderR: 1, hipL: 1, hipR: 1, handL: 1, handR: 1
  };

  /* =================== 7. 与最早版本（纯几何人偶）解析对比 =================== */
  // 旧版 coord: x=(0.5-x)*1.5, y=(0.5-y)*1.5；骨段直接摆到两关节之间（长度=关节距）。
  const oldW = (p) => [(0.5 - p.x) * 1.5, (0.5 - p.y) * 1.5];
  const oldBodyH = span * 1.5;
  const oldSeg = {
    upperArm: human.upperArm * 1.5, foreArm: human.foreArm * 1.5,
    thigh: human.thigh * 1.5, shin: human.shin * 1.5, foot: human.foot * 1.5
  };
  const oldFrac = {}; Object.keys(oldSeg).forEach(k => oldFrac[k] = oldSeg[k] / oldBodyH);
  const oldRatio = {}; Object.keys(oldFrac).forEach(k => oldRatio[k] = oldFrac[k] / humanFrac[k]);
  const oldAmp = [
    { label: "手臂 下垂→侧平举", bone: "wristL", disp: Math.hypot(oldW(ARM_T.wristL)[0] - oldW(ARM_DOWN.wristL)[0], oldW(ARM_T.wristL)[1] - oldW(ARM_DOWN.wristL)[1]) },
    { label: "手臂 下垂→上举", bone: "wristL", disp: Math.hypot(oldW(ARM_UP.wristL)[0] - oldW(ARM_DOWN.wristL)[0], oldW(ARM_UP.wristL)[1] - oldW(ARM_DOWN.wristL)[1]) },
    { label: "腿 并腿→分开", bone: "ankleL", disp: Math.hypot(oldW(LEGS_APART.ankleL)[0] - oldW(LEGS_TOGETHER.ankleL)[0], oldW(LEGS_APART.ankleL)[1] - oldW(LEGS_TOGETHER.ankleL)[1]) },
    { label: "膝 直→屈膝抬脚", bone: "ankleL", disp: Math.hypot(oldW(KNEE_BENT.ankleL)[0] - oldW(KNEE_STRAIGHT.ankleL)[0], oldW(KNEE_BENT.ankleL)[1] - oldW(KNEE_STRAIGHT.ankleL)[1]) }
  ];
  oldAmp.forEach(r => r.frac = r.disp / oldBodyH);
  out.oldVersion = { oldBodyH, oldFrac, oldRatio, oldAmp, oldSeg };

  /* =================== 打印 =================== */
  const f4 = v => (Number.isFinite(v) ? v.toFixed(4) : "-");
  const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : "-");
  console.log("\n=================== 0. 元数据 ===================");
  console.log("布局: H=" + f4(LAY.H) + " footY=" + f4(LAY.footY) + " top=" + f4(LAY.top));
  console.log("模型骨长(世界单位): 上臂=" + f3(linkLen["RightUpperArm"]) + " 前臂=" + f3(linkLen["RightLowerArm"]) +
    " 大腿=" + f3(linkLen["RightUpperLeg"]) + " 小腿=" + f3(linkLen["RightLowerLeg"]) + " 脚=" + f3(linkLen["RightFoot"]));
  console.log("手臂可达=" + f3(out.armReach.modelUpperArmPlusForearm) + " 腿可达=" + f3(out.armReach.modelThighPlusShin));

  console.log("\n=================== 1. 幅度量化（世界位移 + 占模型身高比） ===================");
  console.log("动作".padEnd(22) + "骨骼".padEnd(16) + "位移(世界)".padStart(10) + "占身高".padStart(9));
  amp.forEach(r => console.log(r.label.padEnd(22) + r.bone.padEnd(16) + f4(r.disp).padStart(10) + (r.frac * 100).toFixed(1).padStart(8) + "%"));

  console.log("\n=================== 2. 人体 vs 模型 段长比 ===================");
  console.log("段".padEnd(12) + "人体(占身高)".padStart(12) + "模型(占身高)".padStart(12) + "模型/人体".padStart(10));
  ["upperArm", "foreArm", "thigh", "shin", "foot"].forEach(k => {
    console.log(k.padEnd(12) + (humanFrac[k] * 100).toFixed(1).padStart(11) + "%" + (modelFrac[k] * 100).toFixed(1).padStart(11) + "%" + ratio[k].toFixed(2).padStart(10));
  });
  console.log("（人体身高 span=" + f3(span) + "；模型身高 H=" + f3(H) + "）");

  console.log("\n=================== 3. bodySpan(k2 动态缩放) 影响 ===================");
  console.log("缩放f".padStart(6) + "真实span".padStart(9) + "用span".padStart(8) + "clamp?".padStart(7) + "k2".padStart(8) + "手位移".padStart(9) + "目标位移".padStart(9) + "跟随率".padStart(8) + "占身高".padStart(9));
  spanRes.forEach(r => console.log(String(r.f).padStart(6) + f3(r.spanTrue).padStart(9) + f3(r.spanUsed).padStart(8) + (r.clamped ? "是" : "否").padStart(6) + f3(r.k2).padStart(8) + f4(r.handDisp).padStart(9) + f4(r.targetDisp).padStart(9) + (r.track * 100).toFixed(0).padStart(7) + "%" + (r.fracOfH * 100).toFixed(1).padStart(8) + "%"));

  console.log("\n=================== 4. IK 误差 / 饱和 ===================");
  console.log("姿态".padEnd(16) + "| 腕误差".padStart(9) + "肘误差".padStart(9) + "踝误差".padStart(9) + "膝误差".padStart(9) + " | 肩→腕目标".padStart(11) + "臂可达".padStart(8) + "髋→踝目标".padStart(11) + "腿可达".padStart(8) + " 饱和");
  ikRows.forEach(r => {
    const e = r.err || {};
    const sat = [r.armSat ? "臂" : "", r.legSat ? "腿" : ""].join("") || "否";
    console.log(r.name.padEnd(16) +
      "|" + f4(e.wristL).padStart(9) + f4(e.elbowL).padStart(9) + f4(e.ankleL).padStart(9) + f4(e.kneeL).padStart(9) +
      " |" + f3(r.armRootToTarget).padStart(11) + f3(r.armReach).padStart(8) + f3(r.legRootToTarget).padStart(11) + f3(r.legReach).padStart(8) +
      "  " + sat);
  });

  console.log("\n=================== 5. JOINT_SMOOTH 传递率 ===================");
  console.log("静止峰峰=" + f4(staticPP) + "（下垂↔上举手部 y 差）");
  console.log("半周期帧".padStart(10) + "动态峰峰".padStart(10) + "实测传递".padStart(10) + "理论EMA".padStart(10));
  trans.forEach(r => console.log(String(r.k).padStart(10) + f4(r.dynamicPP).padStart(10) + (r.transfer * 100).toFixed(1).padStart(9) + "%" + (r.theoryEMA * 100).toFixed(1).padStart(9) + "%"));

  console.log("\n=================== 7. 最早版本（纯几何人偶）解析对比 ===================");
  console.log("段".padEnd(12) + "旧版(占身高)".padStart(12) + "旧版/人体".padStart(12) + "新版(占身高)".padStart(12) + "新版/人体".padStart(12));
  ["upperArm", "foreArm", "thigh", "shin", "foot"].forEach(k => {
    console.log(k.padEnd(12) + (oldFrac[k] * 100).toFixed(1).padStart(11) + "%" + oldRatio[k].toFixed(2).padStart(12) +
      (modelFrac[k] * 100).toFixed(1).padStart(11) + "%" + ratio[k].toFixed(2).padStart(12));
  });
  console.log("\n动作".padEnd(22) + "旧版位移".padStart(10) + "旧版占身高".padStart(12) + "新版位移".padStart(10) + "新版占身高".padStart(12));
  const newAmpMap = { "手臂 下垂→侧平举": "RightHand", "手臂 下垂→上举": "RightHand", "腿 并腿→分开": "RightFoot", "膝 直→屈膝抬脚": "RightFoot" };
  oldAmp.forEach(r => {
    const nw = amp.find(a => a.label === r.label && a.bone === newAmpMap[r.label]);
    console.log(r.label.padEnd(22) + f4(r.disp).padStart(10) + (r.frac * 100).toFixed(1).padStart(11) + "%" +
      (nw ? f4(nw.disp).padStart(10) + (nw.frac * 100).toFixed(1).padStart(11) + "%" : "".padStart(21)));
  });
  console.log("（旧版身高=" + f3(oldBodyH) + " 世界单位，缩放固定 1.5；新版身高=H=" + f3(H) + "）");

  fs.writeFileSync(path.join(__dirname, "_diag-cat-amplitude.json"), JSON.stringify(out, null, 2), "utf8");
  console.log("\nJSON → build/_diag-cat-amplitude.json");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
