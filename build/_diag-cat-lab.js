/* 诊断沙盒：#5 JOINT_SMOOTH A/B + #6 骨骼拉伸(bone.scale.y) 可行性（只读产品文件）。
 *
 * 载入 build/_diag-cat-lab.html（= 产品同款 three/GLTFLoader + 一份加了诊断钩子的
 * motion-avatar 副本），在**运行时**：
 *   · 先切 JOINT_SMOOTH 做 A/B，量快速动作的幅度衰减（在未拉伸的基线态做，避免混淆）
 *   · 再给四肢骨骼设 scale.y 拉伸，验证：骨链是否变长、IK 误差是否下降、网格是否被拉变形
 *
 * 用法：node build/_diag-cat-lab.js [leg|arm|both]
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LAB = "file:///" + path.join(__dirname, "_diag-cat-lab.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODE = process.argv[2] || "both";
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

const ARM_DOWN = {
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
const LEGS_APART = JSON.parse(JSON.stringify(ARM_DOWN));
Object.assign(LEGS_APART, {
  kneeL: { x: 0.40, y: 0.712 }, kneeR: { x: 0.60, y: 0.712 },
  shinL: { x: 0.36, y: 0.80 }, shinR: { x: 0.64, y: 0.80 },
  ankleL: { x: 0.32, y: 0.888 }, ankleR: { x: 0.68, y: 0.888 },
  toeL: { x: 0.31, y: 0.93 }, toeR: { x: 0.69, y: 0.93 }
});
const ARM_UP = JSON.parse(JSON.stringify(ARM_DOWN));
Object.assign(ARM_UP, {
  midL: { x: 0.42, y: 0.19 }, elbowL: { x: 0.41, y: 0.13 }, foreL: { x: 0.405, y: 0.09 },
  wristL: { x: 0.40, y: 0.055 }, handL: { x: 0.40, y: 0.03 },
  midR: { x: 0.58, y: 0.19 }, elbowR: { x: 0.59, y: 0.13 }, foreR: { x: 0.595, y: 0.09 },
  wristR: { x: 0.60, y: 0.055 }, handR: { x: 0.60, y: 0.03 }
});
const SMALL_A = JSON.parse(JSON.stringify(ARM_DOWN)), SMALL_B = JSON.parse(JSON.stringify(ARM_DOWN));
["wristL", "wristR", "foreL", "foreR", "elbowL", "elbowR"].forEach(k => { SMALL_A[k].y -= 0.03; SMALL_B[k].y += 0.03; });

const LEGB = ["RightUpperLeg", "RightLowerLeg", "LeftUpperLeg", "LeftLowerLeg"];
const ARMB = ["RightUpperArm", "RightLowerArm", "LeftUpperArm", "LeftLowerArm"];
/* 只拉伸**近端**骨骼：整条链按同一比例变长（子骨继承父缩放），比例不变形。 */
const LEGUP = ["RightUpperLeg", "LeftUpperLeg"];
const ARMUP = ["RightUpperArm", "LeftUpperArm"];
const targetBones = MODE === "leg" ? LEGB : MODE === "arm" ? ARMB
  : MODE === "legup" ? LEGUP : MODE === "armup" ? ARMUP : LEGB.concat(ARMB);

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-catlab-" + process.pid + "-" + Date.now());
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
  await page.goto(LAB, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("lab skeleton ready=" + sk.ready + " failed=" + sk.failed + " bones=" + sk.boneCount + " skinned=" + sk.skinnedCount + " reason=" + (sk.reason || "-"));
  if (!sk.ready) { await browser.close(); process.exit(2); }

  const SETTLE = 40;
  const pose = (j) => page.evaluate(({ j, n }) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < n; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    const g = k => { const w = M.__boneWorld(k); return w ? [w.x, w.y, w.z] : null; };
    return { ik: M.__ikError(), hand: g("RightHand"), foot: g("RightFoot"), knee: g("RightLowerLeg"), layout: M.__layout() };
  }, { j, n: SETTLE });
  const chains = () => page.evaluate(() => ({
    restArm: window.MotionAvatar.__restLen("RightUpperArm"),
    restFore: window.MotionAvatar.__restLen("RightLowerArm"),
    restThigh: window.MotionAvatar.__restLen("RightUpperLeg"),
    restShin: window.MotionAvatar.__restLen("RightLowerLeg"),
    smooth: window.MotionAvatar.__getSmooth()
  }));
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const transfer = (a, b, smooth) => page.evaluate(({ a, b, smooth }) => {
    const M = window.MotionAvatar;
    M.__setSmooth(smooth);
    const out = {};
    [1, 2, 4, 8, 16].forEach(k => {
      for (let i = 0; i < 60; i++) M.updateFromSkeleton(a);
      const ys = [];
      for (let c = 0; c < 40; c++) {
        for (let i = 0; i < k; i++) M.updateFromSkeleton(a);
        const wa = M.__boneWorld("RightHand"); ys.push(wa ? wa.y : null);
        for (let i = 0; i < k; i++) M.updateFromSkeleton(b);
        const wb = M.__boneWorld("RightHand"); ys.push(wb ? wb.y : null);
      }
      const use = ys.slice(10).filter(x => x != null);
      out[k] = Math.max.apply(null, use) - Math.min.apply(null, use);
    });
    return out;
  }, { a, b, smooth });

  /* =================== A. 基线 =================== */
  console.log("\n=================== A. 基线（未拉伸） ===================");
  const baseChains = await chains();
  console.log("骨长: 上臂=" + baseChains.restArm + " 前臂=" + baseChains.restFore + " 大腿=" + baseChains.restThigh + " 小腿=" + baseChains.restShin + "  JOINT_SMOOTH=" + baseChains.smooth);
  const bStand = await pose(ARM_DOWN), bLegs = await pose(LEGS_APART), bUp = await pose(ARM_UP);
  console.log("站姿 IK误差: " + JSON.stringify(bStand.ik));
  console.log("抬臂 IK误差: " + JSON.stringify(bUp.ik));
  await pose(ARM_DOWN);
  await page.screenshot({ path: path.join(SHOTS, "_diag-cat-before-" + MODE + ".png") });

  /* =================== C. JOINT_SMOOTH A/B（基线态） =================== */
  console.log("\n=================== C. JOINT_SMOOTH A/B（手部 y 峰峰，半周期=帧数） ===================");
  const big045 = await transfer(ARM_DOWN, ARM_UP, 0.45), big100 = await transfer(ARM_DOWN, ARM_UP, 1.0);
  const sm045 = await transfer(SMALL_A, SMALL_B, 0.45), sm100 = await transfer(SMALL_A, SMALL_B, 1.0);
  console.log("【大幅度 下垂↔上举】半周期帧".padEnd(26) + "SMOOTH=0.45".padStart(12) + "SMOOTH=1.0".padStart(12) + "比值".padStart(8));
  [1, 2, 4, 8, 16].forEach(k => console.log("".padEnd(26) + String(k).padStart(11) + big045[k].toFixed(4).padStart(12) + big100[k].toFixed(4).padStart(12) + (big045[k] / big100[k] * 100).toFixed(0).padStart(7) + "%"));
  console.log("【小幅度 手臂±0.03】半周期帧".padEnd(26) + "SMOOTH=0.45".padStart(12) + "SMOOTH=1.0".padStart(12) + "比值".padStart(8));
  [1, 2, 4, 8, 16].forEach(k => console.log("".padEnd(26) + String(k).padStart(11) + sm045[k].toFixed(4).padStart(12) + sm100[k].toFixed(4).padStart(12) + (sm045[k] / sm100[k] * 100).toFixed(0).padStart(7) + "%"));
  await page.evaluate(() => window.MotionAvatar.__setSmooth(0.45));

  /* =================== B. 拉伸 =================== */
  const S = Number(process.argv[3]) || 1.25;
  console.log("\n=================== B. 拉伸 " + MODE + " 骨 scale.y = " + S + " ===================");
  await page.evaluate(({ s, names }) => {
    const M = window.MotionAvatar;
    names.forEach(n => M.__setBoneScaleY(n, s));
    M.__rescaleRest();
    return true;
  }, { s: S, names: targetBones });
  const strChains = await chains();
  console.log("拉伸后骨长: 上臂=" + strChains.restArm + " 前臂=" + strChains.restFore + " 大腿=" + strChains.restThigh + " 小腿=" + strChains.restShin);
  console.log("骨长倍数: 上臂=" + (strChains.restArm / baseChains.restArm).toFixed(3) +
    " 前臂=" + (strChains.restFore / baseChains.restFore).toFixed(3) +
    " 大腿=" + (strChains.restThigh / baseChains.restThigh).toFixed(3) +
    " 小腿=" + (strChains.restShin / baseChains.restShin).toFixed(3));
  const sStand = await pose(ARM_DOWN), sLegs = await pose(LEGS_APART), sUp = await pose(ARM_UP);
  console.log("站姿 IK误差: " + JSON.stringify(sStand.ik));
  console.log("抬臂 IK误差: " + JSON.stringify(sUp.ik));
  await pose(ARM_DOWN);
  await page.screenshot({ path: path.join(SHOTS, "_diag-cat-after-" + MODE + ".png") });
  console.log("幅度对比：手 站→上举 前 " + d(bStand.hand, bUp.hand).toFixed(4) + " 后 " + d(sStand.hand, sUp.hand).toFixed(4) +
    "；脚 并→分 前 " + d(bLegs.foot, bStand.foot).toFixed(4) + " 后 " + d(sLegs.foot, sStand.foot).toFixed(4) +
    "；膝 并→分 前 " + d(bLegs.knee, bStand.knee).toFixed(4) + " 后 " + d(sLegs.knee, sStand.knee).toFixed(4));

  /* =================== D. 蒙皮网格 ↔ 骨骼绑定 =================== */
  console.log("\n=================== D. 蒙皮网格受哪些骨骼驱动（权重>0.05 顶点数） ===================");
  const mb = await page.evaluate(() => window.MotionAvatar.__meshBones());
  mb.forEach(m => console.log(m.mesh.padEnd(22) + (m.bones.length ? m.bones.join(", ") : "（无蒙皮权重）")));
  console.log("\n---- 父链（查耳朵骨挂在谁下面）----");
  const pc = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const o = {};
    ["LeftEar_01", "RightEar_01", "LeftUpperArm", "RightUpperArm", "Tail_01", "Head_1"].forEach(n => o[n] = M.__parentChain(n));
    return o;
  });
  Object.keys(pc).forEach(n => console.log(n.padEnd(15) + " ← " + (pc[n] ? pc[n].join(" ← ") : "?")));

  fs.writeFileSync(path.join(__dirname, "_diag-cat-lab.json"), JSON.stringify({
    mode: MODE, baseChains, strChains, stretchScale: S,
    ik: { base: { stand: bStand.ik, up: bUp.ik }, stretched: { stand: sStand.ik, up: sUp.ik } },
    smooth: { bigAmp: { t045: big045, t100: big100 }, smallAmp: { t045: sm045, t100: sm100 } },
    meshBones: mb
  }, null, 2), "utf8");
  console.log("\nJSON → build/_diag-cat-lab.json；截图 → build/shots/_diag-cat-{before,after}-" + MODE + ".png");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
