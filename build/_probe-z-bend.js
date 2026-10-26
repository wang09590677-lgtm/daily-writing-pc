/* 量化「深度 z 误差 → 引擎关节内角**假弯曲**」的敏感度。
 *
 * 为什么要有这条判据
 * ------------------
 * 2026-10-11 真机反馈（老李）：「跟练模型会**突然缩成一团**、动作不如上一次准确」。
 * 定位结论：`motion-avatar.js` 的 `solveTwoBoneIK` 里，弯曲角不是由「世界距离」给的，
 * 而是由**引擎关节的三维内角**给的 ——
 *     `interiorAngle(engRoot, pole, target)`
 * 这三个点都来自 `jointTarget()`（= `rawWorld()`，**含 z**）。
 * 于是：**z 一旦有误差，肘/膝就会报出「假弯曲」**，IK 老老实实照着弯 ⇒ 四肢往躯干折。
 *
 * 本探针不测「深度准不准」（那要真人 + 真相机，见 `_probe-real-depthz.js`），
 * 只测**敏感度**：给定一点点 z 误差，引擎会报出多少度假弯曲。
 * 它回答的是「这条链路到底有没有救」—— 如果 1cm 误差就报 20°，那噪声几十毫米的
 * 深度**必然**让模型抽搐，方案要改；如果 1cm 只报 0.5°，那才值得去修深度质量。
 *
 * ⚠️ 用的是**真的 `interiorAngle`**（`MotionAvatar.__interiorAngle`，本文件为它新加的
 *    量测口），不在测试里复刻余弦定理 —— 复刻版迟早和实现漂移，也就验不出真问题。
 *
 * 用法：NODE_PATH=... node build/_probe-z-bend.js
 *   不需要深度桥、不需要摄像头、不需要真机。
 */
"use strict";
const path = require("path");
const os = require("os");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const BASE = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 项目自己的换算（与 motion-engine.js 的 applyDepthZ 同源）：
 *   z_world = ΔD(mm) × span / H_BODY_MM × (layout.H / span) = ΔD(mm) × layout.H / 1350
 * `span` 在这里约掉 ⇒ **毫米误差 → 世界 z** 只跟 layout.H 有关，与站多远无关。
 * 所以下面报「等价毫米误差」是**严格**的，不是估算。 */
const H_BODY_MM = 1350;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  → " + detail : ""));
  ok ? pass++ : fail++;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-zbend-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  await page.setViewport({ width: 1280, height: 800 });
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));

  /* ---------- ① 总开关默认必须是关的（这是本轮 P0 止血，必须有断言守着） ---------- */
  await page.goto(BASE, { waitUntil: "load", timeout: 45000 });
  await sleep(800);
  const onDefault = await page.evaluate(() => {
    return (typeof MotionAvatar !== "undefined" && MotionAvatar.__depthZOn)
      ? MotionAvatar.__depthZOn() : "NO_API";
  });
  check("★ 深度 z 默认**关**（不带 URL 参数时 __depthZOn() 为 false）",
    onDefault === false, "实际 = " + JSON.stringify(onDefault));

  await page.goto(BASE + "?depthZ=1", { waitUntil: "load", timeout: 45000 });
  await sleep(800);
  const onParam = await page.evaluate(() => {
    return (typeof MotionAvatar !== "undefined" && MotionAvatar.__depthZOn)
      ? MotionAvatar.__depthZOn() : "NO_API";
  });
  check("带 ?depthZ=1 时 __depthZOn() 为 true（诊断路径可用）",
    onParam === true, "实际 = " + JSON.stringify(onParam));

  /* ---------- ② 把跟练角色**显式拉起来**（它是懒加载，不 show() 就没有模型），
   *              再拿真实骨长与布局 ---------- */
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 60; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  if (!sk || !sk.ready) {
    console.log("[X] 模型没就绪（ready=" + (sk && sk.ready) + " failed=" + (sk && sk.failed) + "）");
    await browser.close(); process.exit(1);
  }
  console.log("模型就绪：" + JSON.stringify({ bones: sk.boneCount, fallback: sk.usingFallback }));

  let metrics = null;
  for (let i = 0; i < 40; i++) {
    metrics = await page.evaluate(() => {
      if (typeof MotionAvatar === "undefined" || !MotionAvatar.__modelMetrics) return null;
      const m = MotionAvatar.__modelMetrics();
      if (!m || !m.armChain) return null;
      const lay = MotionAvatar.__layout();
      return { arm: m.armChain, H: lay.H };
    });
    if (metrics) break;
    await sleep(300);
  }
  if (!metrics) { console.log("[X] 拿不到 armChain / layout"); await browser.close(); process.exit(1); }
  const L1 = metrics.arm.upperArm, L2 = metrics.arm.foreArm;
  const layoutH = metrics.H;
  console.log("\n模型实测：上臂 " + L1.toFixed(4) + " / 前臂 " + L2.toFixed(4) +
    "（世界单位）；layout.H = " + layoutH.toFixed(4));
  console.log("换算：1mm 深度误差 → 世界 z = " + (layoutH / H_BODY_MM).toFixed(6) +
    "（约 " + (H_BODY_MM / layoutH).toFixed(0) + "mm 换 1.0 世界单位）\n");

  /* ---------- ③ 敏感度表：一条**绝对伸直**的手臂，只给肘加 z 误差 ---------- */
  const rows = await page.evaluate((L1, L2, layoutH) => {
    const out = [];
    const dzs = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30];
    dzs.forEach(dz => {
      /* 肩在原点，手臂**竖直向下**（最常见、也最容易看出折叠的姿态） */
      const S = [0, 0, 0];
      const E = [0, -L1, dz];
      const W = [0, -(L1 + L2), 0];
      const th = MotionAvatar.__interiorAngle(S, E, W);
      out.push({
        dz: dz,
        deg: th == null ? null : th * 180 / Math.PI,
        mmErr: dz * 1350 / layoutH
      });
    });
    return out;
  }, L1, L2, layoutH);

  console.log("  肘 z 误差(世界)   等价深度误差(mm)   引擎报的内角(deg)   假弯曲(deg)");
  let prevBend = -1, mono = true;
  rows.forEach(r => {
    const bend = 180 - r.deg;
    if (bend < prevBend - 1e-9) mono = false;
    prevBend = bend;
    console.log("  " + r.dz.toFixed(3).padStart(12) + "   " +
      r.mmErr.toFixed(1).padStart(14) + "   " +
      r.deg.toFixed(3).padStart(16) + "   " + bend.toFixed(2).padStart(9));
  });

  const zero = rows.find(r => r.dz === 0);
  check("① 零误差时引擎报「伸直」（内角 180 度）",
    Math.abs(180 - zero.deg) < 1e-6, "实际 " + zero.deg.toFixed(6) + " 度");
  check("② 假弯曲随 z 误差**单调**增大（说明是确定的几何效应，不是数值噪声）", mono);

  /* ③ 关键结论：多小的误差就能造成肉眼可见的假弯曲 */
  const near = (target) => rows.reduce((a, b) =>
    Math.abs(b.mmErr - target) < Math.abs(a.mmErr - target) ? b : a);
  const at80 = near(80), at150 = near(150);
  check("★★ 约 80mm 的深度误差就让「绝对伸直」的手臂报出 >=15 度假弯曲",
    (180 - at80.deg) >= 15,
    at80.mmErr.toFixed(0) + "mm -> " + (180 - at80.deg).toFixed(1) + " 度");
  check("★★★ 约 150mm 的深度误差 => 假弯曲 >=30 度（肉眼就是「折起来了」）",
    (180 - at150.deg) >= 30,
    at150.mmErr.toFixed(0) + "mm -> " + (180 - at150.deg).toFixed(1) + " 度");

  /* ---------- ④ 结论：三维内角对深度误差**极度敏感**，所以不能拿它驱动 IK ---------- */
  console.log("\n判定口径：Astra 在**细肢体**（肘/腕/膝）上的深度误差 + D2C 对齐残差。");
  console.log("  已实测（probe-d2c-effect.py）：帧间噪声底 ~22mm、未对齐时公共区平均差 250mm。");
  const tolerable = rows.filter(r => (180 - r.deg) < 3).map(r => r.mmErr);
  const tolMax = tolerable.length ? Math.max.apply(null, tolerable) : 0;
  console.log("  => 要保证假弯曲 < 3 度，深度误差必须 < 约 " + tolMax.toFixed(0) + "mm。");
  check("★★ 三维内角对深度误差**不可用**（容差 < 20mm；实测容差 " +
    tolMax.toFixed(0) + "mm）—— 这就是「缩成一团」的根因",
    tolMax < 20, "实测容差 " + tolMax.toFixed(0) + "mm");

  /* ---------- ⑤ ★ 端到端守卫：IK **不能**吃深度噪声 ----------
   * 直接编码老李那条反馈：「手臂伸直时，模型不能因为 z 噪声折起来」。
   * 喂**同一条伸直的手臂**，一份 z=0、一份在肘/腕上给 0.08（≈121mm 深度误差），
   * 量模型肘部的**真实世界内角**。修好后两者必须几乎一样。 */
  const bendOf = (joints) => page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: p[k].z || 0 }; });
    Object.defineProperty(j, "__depthZ", { value: true, enumerable: false, configurable: true });
    for (let i = 0; i < 60; i++) M.updateFromSkeleton(j);   // 低通收敛
    /* ⚠️ 交叉映射：引擎的 R 侧驱动**模型**的 Left 骨（见 BONE_SEG），所以量 Left。
     * `__boneWorld` 返回骨 origin ⇒ RightArm=肩、RightForeArm=肘、RightHand=腕。 */
    const a = M.__boneWorld("LeftArm"), b = M.__boneWorld("LeftForeArm"), c = M.__boneWorld("LeftHand");
    if (!a || !b || !c) return null;
    const v1 = [a.x - b.x, a.y - b.y, a.z - b.z], v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
    const n1 = Math.hypot(v1[0], v1[1], v1[2]), n2 = Math.hypot(v2[0], v2[1], v2[2]);
    if (!(n1 > 1e-6) || !(n2 > 1e-6)) return null;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }, joints);

  const bendClean = await bendOf(F.STAND);
  const noisyJoints = F.clone(F.STAND);
  ["elbowR", "foreR", "wristR"].forEach(k => { noisyJoints[k].z = 0.08; });   // ≈121mm
  const bendNoisy = await bendOf(noisyJoints);
  const dFold = Math.abs(bendNoisy - bendClean);
  console.log("\n  伸直手臂 · 肘部世界内角：z=0 → " + bendClean.toFixed(2) +
    " 度；肘/腕 z=0.08(≈121mm) → " + bendNoisy.toFixed(2) + " 度（差 " + dFold.toFixed(2) + " 度）");
  check("★★★ 端到端：肘部 z 给 121mm 误差，模型肘**不折**（角度变化 < 3 度）",
    dFold < 3, "变化 " + dFold.toFixed(2) + " 度（若走三维内角，这一步会折 >60 度）");

  /* ---------- ⑥ z 仍然影响"指向哪"（修复不能把前后方向一起砍掉） ---------- */
  const reach = await page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: p[k].z || 0 }; });
    Object.defineProperty(j, "__depthZ", { value: true, enumerable: false, configurable: true });
    for (let i = 0; i < 60; i++) M.updateFromSkeleton(j);
    const w = M.__boneWorld("LeftHand");            // 引擎 R → 模型 Left
    return w ? { x: +w.x.toFixed(4), y: +w.y.toFixed(4), z: +w.z.toFixed(4) } : null;
  }, (() => { const q = F.clone(F.STAND); ["handR", "wristR", "foreR", "elbowR"].forEach(k => { q[k].z = -0.30; }); return q; })());
  const reachBase = await page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: p[k].z || 0 }; });
    Object.defineProperty(j, "__depthZ", { value: true, enumerable: false, configurable: true });
    for (let i = 0; i < 60; i++) M.updateFromSkeleton(j);
    const w = M.__boneWorld("LeftHand");
    return w ? { x: +w.x.toFixed(4), y: +w.y.toFixed(4), z: +w.z.toFixed(4) } : null;
  }, F.STAND);
  const dz = reach && reachBase ? Math.abs(reach.z - reachBase.z) : 0;
  check("★★ 修复没有砍掉前后方向：手朝相机靠近 0.30 ⇒ 模型手的世界 z 确实变了",
    dz > 0.10, "ΔworldZ = " + dz.toFixed(4));

  console.log("\n===== " + pass + "/" + (pass + fail) + " 通过 =====");
  if (errs.length) console.log("JS 报错：" + errs.slice(0, 3).join(" | "));
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("探针异常：", e); process.exit(3); });
