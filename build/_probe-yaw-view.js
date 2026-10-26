/* 探针：**3/4 斜视角**到底有没有解决"前后方向的动作看不见"（老李的原话）。
 *
 * 为什么必须有这条判据
 * -------------------
 * 深度打通之后关节有了 z，但**正对镜头的视角下 z 只表现为"变大变小"**，
 * 屏幕上几乎没有位移 —— 孩子做原地跑/前平举/高抬腿时自己看着"没动"。
 * 所以"改成 3/4 视角"这件事的**唯一有效判据**是：
 *   **世界 z 上的位移，在屏幕上变成了可观的横向位移。**
 * 光断言"相机转了 30°"是没用的 —— 相机转了但投影算错、或者 z 根本没进模型，
 * 那条断言照样绿（本项目已经吃过好几次"断言测的是实现而不是效果"的亏）。
 *
 * 做法：同一个姿势喂两遍，只把某一个关节的 z 从 0 改到"靠近相机"，
 * 然后用**真的 three 相机**（`MotionAvatar.__project`）把骨骼世界坐标投到屏幕像素，
 * 量横向位移。yaw=0 时这个位移必然 ≈ 0（这就是当初的问题），yaw=30° 时应当可观。
 *
 * ⚠️ 只量"横向位移够不够大"，**不写死方向**：方向的符号由相机 yaw 的正负与
 *    镜像共同决定，属于实现细节；把它写进断言会让以后调整视角变成"改断言"。
 *    真正要保护的方向不变量只有一条：**镜像之后，模型自身右侧仍在屏幕右半**
 *    （孩子抬右手时，视频与角色的手必须在同一侧）—— 单独一条断言管它。
 *
 * 用法：NODE_PATH=... node build/_probe-yaw-view.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
/* ⚠️ 必须带 `?depthZ=1`：2026-10-11 起深度 z 的消费被 `DEPTH_Z` 总开关**默认关掉**了
 * （真机反馈"缩成一团"，见 motion-avatar.js 里 DEPTH_Z 常量处的推导）。
 * 本探针要验的正是"z 真的进了模型"，所以要显式打开。 */
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/") + "?depthZ=1";
const W = 1280, H = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 期望的相机摆位（与 motion-avatar.js 的常量一致；不一致就是有人偷偷改了视角） */
const YAW_DEG = 30, DIST = 3;
const YAW = YAW_DEG * Math.PI / 180;
const EXP_POS = [DIST * Math.sin(YAW), 0, DIST * Math.cos(YAW)];

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  → " + d : ""));
  ok ? pass++ : fail++;
};

/* 横向位移的最小可感知量（像素，1280 宽下）。
 * 取 40px 的依据：屏幕上角色身高约 380px，40px ≈ 身高的 10% —— 孩子一眼能看出来。
 * 别往上调：真的把 yaw 调小（比如 15°）时，sin15/sin30 = 0.52，
 * 位移会掉到 ~50%，这条阈值就成了"视角不能小于 20°"的隐形约束。 */
const MIN_DX_PX = 40;

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-yaw-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: W, height: H },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir,
      "--autoplay-policy=no-user-gesture-required"]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => { errs.push(e.message); console.log("PAGEERROR:", e.message); });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => window.MotionAvatar.show());

  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  if (!sk || !sk.ready) {
    console.log("模型没就绪（ready=" + (sk && sk.ready) + " failed=" + (sk && sk.failed) + "）—— 后面的量测无意义");
    await browser.close();
    process.exit(2);
  }
  console.log("模型就绪：" + JSON.stringify({ bones: sk.boneCount, fallback: sk.usingFallback }));

  /* ---------- 1. 相机确实按 3/4 摆位 ---------- */
  const cam = await page.evaluate(() => window.MotionAvatar.__camera());
  const dPos = Math.max(...EXP_POS.map((v, i) => Math.abs(v - cam.position[i])));
  check("相机按 3/4 视角摆位（position ≈ (3sin30°, 0, 3cos30°)）",
    dPos < 1e-4 && cam.yawDeg === YAW_DEG && cam.dist === DIST,
    JSON.stringify(cam.position.map(v => +v.toFixed(4))) + " 期望 " +
    JSON.stringify(EXP_POS.map(v => +v.toFixed(4))));

  /* ---------- 2. y 投影不受 yaw 影响（构图安全区/所有 screenY 断言的前提） ---------- */
  const yProj = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const out = [];
    [0.5, 0, -0.5, -0.8].forEach(y => {
      // 同一个 y，换 x/z 应当得到同样的 ndcY
      const a = M.__project(0, y, 0), b = M.__project(0.4, y, 0.6), c = M.__project(-0.4, y, -0.6);
      out.push({ y, a: a.ndcY, b: b.ndcY, c: c.ndcY, want: y / 0.9 });
    });
    return out;
  });
  const yBad = yProj.filter(r =>
    Math.abs(r.a - r.want) > 1e-9 || Math.abs(r.b - r.want) > 1e-9 || Math.abs(r.c - r.want) > 1e-9);
  check("y 投影只由 y 决定（ndcY = y/0.9，与 x/z 无关）—— screenY 那套换算在斜视角下依然成立",
    yBad.length === 0, yBad.length ? JSON.stringify(yBad[0]) : "4 组 y 值全部吻合");

  /* ---------- 3. ★ 核心：世界 z 的位移 → 屏幕横向位移 ---------- */
  /* 基础姿势：双臂上举（手离身体远，z 位移不会被躯干挡住，横向位移看得最清楚）。 */
  const BASE = F.armsOverhead();

  /* 喂一个姿势，返回若干骨骼的世界坐标 + 镜像后的屏幕像素。
   * ⚠️ `__depthZ` 是引擎给的"这份 z 可信"标记（见 motion-engine.js 的 applyDepthZ）；
   *    rawWorld 只在它（或 POSE_DEPTH）为真时才用 z —— 所以这里必须挂上，
   *    否则量到的是"z 被忽略"，会得出"3/4 视角没用"的错误结论。 */
  const feed = (joints) => page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: p[k].z || 0 }; });
    Object.defineProperty(j, "__depthZ", { value: true, enumerable: false, configurable: true });
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(j);   // 低通收敛
    /* ⚠️ 骨名要用**模型侧**的，而引擎关节名是**图像侧**的，两边是交叉映射：
     *    BONE_SEG 里 `LeftHand: ["wristR","handR",…]` —— 引擎的 R 驱动模型的 Left。
     *    量错了会得出"z 没进模型"的假结论。 */
    const names = ["LeftHand", "RightHand", "LeftToe_End", "RightToe_End"];
    const out = { world: {}, ndc: {} };
    names.forEach(n => {
      const w = M.__boneWorld(n);          // 注意：返回 {x,y,z} 对象，不是数组
      if (!w) { out.world[n] = null; return; }
      out.world[n] = { x: w.x, y: w.y, z: w.z };
      out.ndc[n] = M.__project(w.x, w.y, w.z);
    });
    return out;
  }, joints);

  /* 像素换算：NDC → 屏幕像素。**镜像**（CSS scaleX(-1)）在最后一步翻一下。 */
  const pxOf = (ndc) => {
    const raw = (ndc.ndcX * 0.5 + 0.5) * W;
    return { raw: raw, mirrored: W - raw };
  };

  const base = await feed(BASE);

  /* 3a. 右手朝相机靠近（引擎里 z 为负 = 靠近相机，见 pose-vision.js 的约定）
   * ⚠️ 引擎的 R 侧驱动**模型**的 Left 骨（交叉映射），所以下面量 `LeftHand`。 */
  const handNear = F.clone(BASE);
  ["handR", "wristR", "foreR", "elbowR"].forEach(k => { handNear[k].z = -0.30; });
  const hn = await feed(handNear);
  const dzHand = hn.world.LeftHand.z - base.world.LeftHand.z;
  const dxHand = Math.abs(pxOf(hn.ndc.LeftHand).mirrored - pxOf(base.ndc.LeftHand).mirrored);
  const dyHand = Math.abs(hn.ndc.LeftHand.ndcY - base.ndc.LeftHand.ndcY) * 0.5 * H;
  check("① 关节 z 真的进了模型（手的世界 z 变了）",
    Math.abs(dzHand) > 0.15, "ΔworldZ=" + dzHand.toFixed(4));
  check("① ★ 手在前后方向动 0.30 → 屏幕上产生 ≥ " + MIN_DX_PX + "px 的**横向**位移（3/4 视角的意义所在）",
    dxHand >= MIN_DX_PX,
    "横向位移=" + dxHand.toFixed(1) + "px（同一次改动带来的纵向位移只有 " + dyHand.toFixed(1) + "px）");

  /* 3b. 膝盖朝相机靠近（高抬腿那条需求） */
  const kneeNear = F.clone(BASE);
  ["kneeR", "shinR", "ankleR", "toeR"].forEach(k => { kneeNear[k].z = -0.25; });
  const kn = await feed(kneeNear);
  const dzKnee = kn.world.LeftToe_End.z - base.world.LeftToe_End.z;
  const dxKnee = Math.abs(pxOf(kn.ndc.LeftToe_End).mirrored - pxOf(base.ndc.LeftToe_End).mirrored);
  check("② 腿的 z 也进了模型（脚尖的世界 z 变了）",
    Math.abs(dzKnee) > 0.12, "ΔworldZ=" + dzKnee.toFixed(4));
  check("② ★ 腿在前后方向动 0.25 → 屏幕上产生 ≥ " + Math.round(MIN_DX_PX * 0.75) + "px 的横向位移",
    dxKnee >= MIN_DX_PX * 0.75, "横向位移=" + dxKnee.toFixed(1) + "px");

  /* ---------- 4. 镜像不变量：模型自身右侧仍在屏幕右半 ----------
   * 孩子抬右手时，镜像后的视频里手在屏幕右侧；角色必须也在右侧，
   * 否则看着"左右相反"（这是当初加 scaleX(-1) 要解决的问题，不能被视角改动破坏）。 */
  const mir = await page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: 0 }; });
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(j);
    const r = M.__boneWorld("RightHand"), l = M.__boneWorld("LeftHand");
    return {
      right: M.__project(r.x, r.y, r.z), left: M.__project(l.x, l.y, l.z),
      rightX: r.x, leftX: l.x
    };
  }, F.armsOverhead());
  const rM = pxOf(mir.right).mirrored, lM = pxOf(mir.left).mirrored;
  check("④ 模型自身右侧（−X）在**镜像后**的屏幕上仍落在右半（孩子抬右手时两侧一致）",
    mir.rightX < 0 && rM > W / 2 && lM < W / 2,
    "RightHand worldX=" + mir.rightX.toFixed(3) + " 镜像后 " + rM.toFixed(0) + "px / " +
    "LeftHand " + lM.toFixed(0) + "px（画布宽 " + W + "）");

  /* ---------- 5. 斜视角下角色不会出画（横向压缩 + z 偏移后仍要装得下） ---------- */
  const extreme = await page.evaluate((p) => {
    const M = window.MotionAvatar;
    const j = {};
    Object.keys(p).forEach(k => { j[k] = { x: p[k].x, y: p[k].y, z: 0 }; });
    Object.defineProperty(j, "__depthZ", { value: true, enumerable: false, configurable: true });
    /* 最坏情况：手举到最高 + 整个人朝相机前移（z 负）一大截 */
    ["handL", "wristL", "foreL", "handR", "wristR", "foreR",
      "hipMid", "hipL", "hipR", "head", "neck"].forEach(k => { j[k].z = -0.5; });
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(j);
    let maxAbs = 0;
    ["RightHand", "LeftHand", "RightToe_End", "LeftToe_End", "Hips", "HeadTop_End"].forEach(n => {
      const w = M.__boneWorld(n);
      if (!w) return;
      const nd = M.__project(w.x, w.y, w.z);
      maxAbs = Math.max(maxAbs, Math.abs(nd.ndcX));
    });
    return { maxAbs: +maxAbs.toFixed(4) };
  }, F.armsOverhead());
  check("⑤ 斜视角 + 最大前后位移下角色仍不出画（|ndcX| ≤ 1）",
    extreme.maxAbs <= 1.0, "max|ndcX|=" + extreme.maxAbs);

  check("全程没有 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | ") || "无");

  await browser.close();
  console.log("\n===== " + pass + "/" + (pass + fail) + " 通过 =====");
  if (fail) process.exit(1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
