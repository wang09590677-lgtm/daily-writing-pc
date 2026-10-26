/* 探针：**矢状面（前后方向）动作能不能被跟练角色复现** —— 复现孩子报的缺陷。
 *
 * 孩子原话：
 *   「跟练模型只是对正面平面的运动识别比较准，对前后方向动作无法识别，
 *     比如我正对着摄像头跑步、双臂正向举起落下、正对镜头高抬腿」
 *
 * 根因（本探针要证的东西）：
 *   整条链路是**纯 2D** 的，MediaPipe 明明给了 `z`，却一路被丢：
 *     pose-vision.js  `makePt()`      → 只留 {x, y}
 *     motion-engine.js visionGeometry → joints[name] = {x, y}
 *     motion-avatar.js rawWorld()     → _v1.set(..., ..., 0)   ← z 写死 0
 *   于是"肢体指向相机"这件事在数据里**完全不存在**：
 *     · 前平举 90° ⇒ 2D 投影里 肩/肘/腕 **三点重合** ⇒ 引擎拿到长度 ≈0 的链
 *       ⇒ IK 只能把手臂**折成一团**；
 *     · 高抬腿 ⇒ 2D 里膝内角仍 ≈180°（看着是直的）⇒ 腿**不弯**、整条腿被平移上提；
 *     · 正对镜头跑步 ⇒ 只有"腿在上下动"，没有前后摆。
 *
 * 本探针给出三列对照（每个姿势）：
 *   ① 真值：3D 夹具里这条链**本来**有多少前后分量（`_avatar-fixtures3d.js` 造的真值）；
 *   ② 现状：把**2D 投影**喂进角色 ⇒ 角色实际做出多少前后分量；
 *   ③ 反证：把**完整 3D 数据**喂进角色 ⇒ 结果与 ② **完全相同**
 *      （因为 `rawWorld` 把 z 写成 0）—— 这一条直接证明"z 被丢掉"，不需要任何推断。
 *
 * 用法：node build/_probe-sagittal.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");
const F3 = require("./_avatar-fixtures3d.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?poseDepth=1";
const VIEW = { width: 1280, height: 800 };
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 用例：[名字, 3D 姿势]
 * 期望值**不手抄** —— 直接取 3D 夹具本身的真值（`F3.sagittalTruth()`）。 */
const CASES = [
  ["站姿（基准，前后分量应为 0）", F3.STAND3D],
  ["前平举 45°（双臂朝相机抬起半程）", F3.frontRaise(45)],
  ["★ 前平举 90°（双臂水平指向相机）", F3.frontRaise(90)],
  ["★ 高抬腿 L 100°（正对镜头）", F3.highKnee("engineL", 100)],
  ["★ 正对镜头跑步 phase=+1", F3.runStride(1)],
  ["★ 真·3D 深蹲 0.12（膝朝相机前移）", F3.squat3d(0.12)]
];

/* 单位向量的"朝相机分量" ∈ [-1,1]（+1 = 完全指向相机）。
 * 引擎夹具用 MediaPipe 口径（**负 z = 靠近**），角色世界用 **+z 朝相机**，
 * 所以真值要取负号 —— 两套口径在这里**只换算一次**，别在别处再换。 */
function fwdOf(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z || 0) - (a.z || 0);
  const n = Math.hypot(dx, dy, dz);
  return n > 1e-9 ? -dz / n : null;
}

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-sagittal-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport(VIEW);
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  for (let i = 0; i < 40; i++) {
    const sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }

  /* 在页面里跑：喂一个姿势、收敛低通、量角色自己的**前后分量**。
   * 角色世界 +z 朝向相机 ⇒ "朝相机" = z 变大。
   * 交叉映射：引擎 *L ↔ 模型 Right*。 */
  const measure = (pose) => page.evaluate((pose) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(pose);   // 让低通收敛
    M.__renderNow();
    const s = M.__poseSnapshot();
    const g = k => s[k] || null;
    const dz = (a, b) => (a && b) ? (b[2] - a[2]) : null;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const len = v => Math.hypot(v[0], v[1], v[2]);
    const bend = (a, b, c) => {
      if (!a || !b || !c) return null;
      const u = sub(a, b), v = sub(c, b);
      const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v));
      return 180 - Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const err = (boneName, jointKey) => {
      const tgt = M.__rawWorld(pose, jointKey);
      const b = M.__boneWorld(boneName);
      if (!tgt || !b) return null;
      return Math.hypot(b.x - tgt[0], b.y - tgt[1], b.z - tgt[2]);
    };
    /* 骨段方向的"朝相机分量" ∈ [-1,1]（角色世界 +z 朝相机）。
     * 这是与真值**同一口径**的量，所以能直接相减比。 */
    const dirFwd = (a, b) => {
      if (!a || !b) return null;
      const n = len(sub(b, a));
      return n > 1e-9 ? (b[2] - a[2]) / n : null;
    };
    return {
      /* 骨段方向的朝相机分量（与真值同口径，+1 = 指向相机） */
      uaFwdL: dirFwd(g("RightArm"), g("RightForeArm")),   // 引擎 L 上臂 ↔ 模型右上臂
      uaFwdR: dirFwd(g("LeftArm"), g("LeftForeArm")),
      thFwdL: dirFwd(g("RightUpLeg"), g("RightLeg")),     // 引擎 L 大腿 ↔ 模型右大腿
      thFwdR: dirFwd(g("LeftUpLeg"), g("LeftLeg")),
      /* 关节弯曲（角色的实际角度） */
      elbowBendL: bend(g("RightArm"), g("RightForeArm"), g("RightHand")),
      elbowBendR: bend(g("LeftArm"), g("LeftForeArm"), g("LeftHand")),
      kneeBendL: bend(g("RightUpLeg"), g("RightLeg"), g("RightFoot")),
      kneeBendR: bend(g("LeftUpLeg"), g("LeftLeg"), g("LeftFoot")),
      /* 末端误差（手/脚 vs 引擎目标） */
      errHandL: err("RightHand", "wristL"), errHandR: err("LeftHand", "wristR"),
      errFootL: err("RightFoot", "ankleL"), errFootR: err("LeftFoot", "ankleR")
    };
  }, pose);

  const rows = [];
  for (const [name, pose] of CASES) {
    const truth = F3.sagittalTruth(pose);
    const p2 = F3.project2D(pose);          // 当前链路"看得见"的东西
    const m2 = await measure(p2);           // 喂 2D 投影
    const m3 = await measure(pose);         // 喂完整 3D（应当与 m2 逐位相同）
    rows.push({
      name, pose, truth, m2, m3,
      /* 真值：该链的"朝相机分量"与关节弯曲 */
      truthUaFwdL: fwdOf(pose.shoulderL, pose.elbowL),
      truthThFwdL: fwdOf(pose.hipL, pose.kneeL),
      truthElbowBendL: truth.armL.bend,
      truthKneeBendL: truth.legL.bend,
      /* 引擎在 2D 里还剩多少信息（塌缩比） */
      engArmProj: Math.hypot(pose.handL.x - pose.shoulderL.x, pose.handL.y - pose.shoulderL.y),
      engLegProj: Math.hypot(pose.ankleL.x - pose.hipL.x, pose.ankleL.y - pose.hipL.y)
    });
  }

  const f = (v, n) => v == null ? "—" : v.toFixed(n == null ? 3 : n);
  const A = F.MODEL_SEG.upperArm + F.MODEL_SEG.foreArm + F.MODEL_SEG.hand;
  const L = F.MODEL_SEG.thigh + F.MODEL_SEG.shin;

  console.log("\n============ ① 真值 vs ② 喂「2D 投影」（= 没有深度时的退路，**必然红**）============");
  console.log("用例".padEnd(32) + "上臂真值 角色实际 |差|   大腿真值 角色实际 |差|");
  for (const r of rows) {
    console.log(r.name.padEnd(30) + " " +
      f(r.truthUaFwdL).padStart(8) + " " + f(r.m2.uaFwdL).padStart(8) + " " +
      f(Math.abs((r.truthUaFwdL || 0) - (r.m2.uaFwdL || 0)), 2).padStart(5) + "  " +
      f(r.truthThFwdL).padStart(8) + " " + f(r.m2.thFwdL).padStart(8) + " " +
      f(Math.abs((r.truthThFwdL || 0) - (r.m2.thFwdL || 0)), 2).padStart(5));
  }
  console.log("用例".padEnd(32) + "肘弯真值 角色实际  膝弯真值 角色实际");
  for (const r of rows) {
    console.log(r.name.padEnd(30) + " " +
      f(r.truthElbowBendL, 1).padStart(8) + " " + f(r.m2.elbowBendL, 1).padStart(8) + "  " +
      f(r.truthKneeBendL, 1).padStart(8) + " " + f(r.m2.kneeBendL, 1).padStart(8));
  }

  console.log("\n============ ② 真值 vs 喂「完整 3D」（= 深度接通后，**这才是验收**）============");
  console.log("用例".padEnd(32) + "上臂真值 角色实际 |差|   大腿真值 角色实际 |差|");
  for (const r of rows) {
    console.log(r.name.padEnd(30) + " " +
      f(r.truthUaFwdL).padStart(8) + " " + f(r.m3.uaFwdL).padStart(8) + " " +
      f(Math.abs((r.truthUaFwdL || 0) - (r.m3.uaFwdL || 0)), 2).padStart(5) + "  " +
      f(r.truthThFwdL).padStart(8) + " " + f(r.m3.thFwdL).padStart(8) + " " +
      f(Math.abs((r.truthThFwdL || 0) - (r.m3.thFwdL || 0)), 2).padStart(5));
  }
  console.log("用例".padEnd(32) + "肘弯真值 角色实际  膝弯真值 角色实际");
  for (const r of rows) {
    console.log(r.name.padEnd(30) + " " +
      f(r.truthElbowBendL, 1).padStart(8) + " " + f(r.m3.elbowBendL, 1).padStart(8) + "  " +
      f(r.truthKneeBendL, 1).padStart(8) + " " + f(r.m3.kneeBendL, 1).padStart(8));
  }

  console.log("\n============ ③ 反证：喂「完整 3D」与喂「2D 投影」是否**逐位相同** ============");
  console.log("（全部相同 ⇒ z 仍被丢掉；出现差异 ⇒ z 已经接通）");
  let sameAll = true;
  for (const r of rows) {
    const keys = ["uaFwdL", "uaFwdR", "thFwdL", "thFwdR", "elbowBendL", "kneeBendL"];
    const diffs = keys.filter(k => Math.abs((r.m2[k] || 0) - (r.m3[k] || 0)) > 1e-9);
    if (diffs.length) sameAll = false;
    console.log("  " + r.name.padEnd(30) + (diffs.length === 0
      ? "逐位相同（z 被忽略）" : "有差异 ✓ z 已接通: " + diffs.join(",")));
  }

  console.log("\n============ ④ 末端误差（手/脚 vs 引擎目标）与 2D 塌缩 ============");
  console.log("用例".padEnd(32) + "手误差L 脚误差L  肩→手投影 塌缩比  髋→踝投影 塌缩比");
  for (const r of rows) {
    console.log(r.name.padEnd(30) + " " +
      f(r.m3.errHandL, 4).padStart(7) + " " + f(r.m3.errFootL, 4).padStart(7) + "  " +
      f(r.engArmProj, 4).padStart(9) + " " + f(r.engArmProj / A, 3).padStart(6) + "  " +
      f(r.engLegProj, 4).padStart(9) + " " + f(r.engLegProj / L, 3).padStart(6));
  }

  /* ---- 判定：**喂 3D 时**角色必须复现真值（这是"深度接通后"的验收）。
   *      喂 2D 必然红 —— 那是"没有深度可用"的已知退路，单独在 ① 里报，不进判定。 ---- */
  const TOL_FWD = 0.25;      // 朝相机分量的容差
  const TOL_BEND = 20;       // 关节弯曲的容差（度）
  const bad = [];
  if (!rows.length) bad.push("没有用例结果（页面没起来？）");
  for (const r of rows) {
    const checks = [
      ["上臂朝相机", r.truthUaFwdL, r.m3.uaFwdL, TOL_FWD],
      ["大腿朝相机", r.truthThFwdL, r.m3.thFwdL, TOL_FWD],
      ["肘弯", r.truthElbowBendL, r.m3.elbowBendL, TOL_BEND],
      ["膝弯", r.truthKneeBendL, r.m3.kneeBendL, TOL_BEND]
    ];
    for (const [what, tv, av, tol] of checks) {
      if (tv == null || av == null) { bad.push(`${r.name} ${what} 量不到`); continue; }
      if (Math.abs(tv - av) > tol) {
        bad.push(`${r.name} ${what}: 真值 ${tv.toFixed(2)} vs 角色 ${av.toFixed(2)}（差 ${Math.abs(tv - av).toFixed(2)}）`);
      }
    }
  }
  if (sameAll) bad.push("喂 3D 与喂 2D 结果逐位相同 —— z 仍被丢掉，回查 rawWorld / visionGeometry");

  console.log("\n============ 判定（以「喂 3D」为准）============");
  if (bad.length === 0) {
    console.log("PASS  深度接通后，角色在矢状面姿势上与真值一致（前后方向能复现了）");
  } else {
    console.log("FAIL  角色复现不了前后方向的动作 —— " + bad.length + " 项不符：");
    bad.slice(0, 12).forEach(s => console.log("   · " + s));
    if (bad.length > 12) console.log("   · …还有 " + (bad.length - 12) + " 项");
  }

  /* 截图（R7）：三个孩子点名的姿势，**各渲两张** —— 喂 2D（现状）/ 喂 3D（接通深度后） */
  for (const [slug, pose] of [
    ["sagittal-front-raise-90", F3.frontRaise(90)],
    ["sagittal-high-knee", F3.highKnee("engineL", 100)],
    ["sagittal-run-stride", F3.runStride(1)]
  ]) {
    for (const [tag, p] of [["2d", F3.project2D(pose)], ["3d", pose]]) {
      await page.evaluate((pp) => {
        for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(pp);
        window.MotionAvatar.__renderNow();
      }, p);
      await page.screenshot({ path: path.join(SHOTS, slug + "-" + tag + ".png") });
    }
  }
  console.log("\n截图: build/shots/sagittal-*-2d.png（现状） / sagittal-*-3d.png（接通深度后）");

  await browser.close();
  process.exit(bad.length === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
