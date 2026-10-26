// 体感 3D 跟练角色自检（Mixamo 人形 GLB 版）
//
// ⚠️ 本文件被**整体改写**过两次，每次都是"换掉被测对象 → 改写断言"，不是放宽：
//    ① 2026-10-06：程序化拼几何的猫 → GLB 蒙皮猫（数耳朵/胡须/尾巴那套断言的对象消失了）
//    ② 2026-10-09：GLB 蒙皮猫 → Mixamo 人形 65 骨骼
//    该守的通用行为没变：真模型确实加载了、骨骼真的跟着关节动、渲染得出东西、
//    姿势崩坏（NaN）能被挡住、app.js 的调用契约没变。
//
// 「造型好不好看」不由本文件判定 —— 那要看 build/avatar-portrait.js 出的截图。
// 「跟得准不准」也不由本文件判定 —— 那看 build/accept-human-glb.js 的绝对几何判据。
// 本文件管的是**契约与健壮性**。
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules",
  "puppeteer-core"
));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? "  → " + detail : ""}`);
}

const STAND = F.STAND;
const SPREAD = F.armSpread();

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-humantest-" + process.pid + "-" + Date.now());
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
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); });
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);

  const apiOk = await page.evaluate(() =>
    typeof MotionAvatar === "object" &&
    ["show", "hide", "isVisible", "updateFromSkeleton", "setProgress", "setStatus"]
      .every(k => typeof MotionAvatar[k] === "function"));
  check("对外接口完整（app.js 零改动的前提）", apiOk,
    "show/hide/isVisible/updateFromSkeleton/setProgress/setStatus");

  await page.evaluate(() => MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }

  console.log("\n-- 模型与骨架 --");
  check("真模型加载成功（没退回兜底人形）", sk.ready === true && sk.usingFallback === false, "reason=" + (sk.reason || "无"));
  check("骨架 65 根骨骼（Mixamo 标准人形）", sk.boneCount === 65, "boneCount=" + sk.boneCount);
  check("2 个蒙皮网格（Beta_Joints / Beta_Surface）", sk.skinnedCount === 2, "skinnedCount=" + sk.skinnedCount);
  /* ⚠️ 别看 `sk.tail` —— 它是 `TAIL_BONES.filter(...)`，而 TAIL_BONES 被写成了 `[]`
   * （人形确实没尾巴），所以它**恒等于 0**、跟模型一点关系没有。
   * 这就是一条"恒真断言"（同类：旧脚本的 `膝盖夹角 < 170`），永远不会红。
   * 真正该验的是**模型自己的骨名里有没有 tail**。 */
  const tailLike = (sk.boneNames || []).filter(n => /tail/i.test(n));
  check("模型骨名里没有尾巴骨骼（按**真实骨名**查；sk.tail 恒 0，不作判据）",
    tailLike.length === 0, tailLike.length ? tailLike.join(",") : `65 根骨名中无 tail（sk.tail=${sk.tail} 是配置项）`);
  check("自顶向下顺序覆盖全部骨骼（aim 依赖它）", sk.topDownLen >= sk.boneCount, sk.topDownLen + " vs " + sk.boneCount);

  /* ---- 夹具骨段长度必须与**模型实测**一致 ----
   * `build/_avatar-fixtures-check.js` 里那条是**自证的**：它拿夹具去比 `MODEL_SEG`，
   * 而 MODEL_SEG 就写在夹具文件里 —— 两边一起错，它照样全绿。
   * 这里补上"对真模型"的核对：读 `__modelMetrics().restLen`（模型实测骨长）。
   *
   * ⚠️ 为什么用**比值**而不是绝对值：实测发现 `restLen` 与 `measured.height` **不在同一空间**
   *    （同一根骨，restLen 比"按 measured.height 归一"的结果小一半，系数 ≈ 2.019；
   *    已用 4 根骨交叉确认是**均匀**倍数）。所以绝对值核对需要这个换算常数，
   *    而模块目前**没有**把它作为可信契约暴露出来 —— 硬编码一个 2.019 就是埋雷。
   *    比值把未知系数约掉了，而"夹具比例错"正是当初那个 bug 的形态
   *    （旧夹具上臂写短成 0.1005、其余不变 ⇒ thigh/upperArm 偏 20.6%，**抓得到**）。 */
  const mm = await page.evaluate(() => window.MotionAvatar.__modelMetrics());
  const restLen = (mm && mm.restLen) || {};
  const pick = n => restLen["mixamorig" + n] != null ? restLen["mixamorig" + n]
    : restLen["mixamorig:" + n] != null ? restLen["mixamorig:" + n] : restLen[n];
  const boneOf = { upperArm: "RightArm", foreArm: "RightForeArm", thigh: "RightUpLeg", shin: "RightLeg" };
  const raw = {};
  Object.keys(boneOf).forEach(k => { raw[k] = pick(boneOf[k]); });
  /* ★ `hand` 单独从 `armChain` 取：`restLen` 给不出"腕→指尖"。
   * `restLen` 的定义是"到**第一个子骨骼**的距离"，而手骨的第一个子骨骼是**拇指**
   * （腕→拇指只有 0.0397，真·腕→中指尖 0.1913）。这正是"手长写错 236% 却没人发现"
   * 的原因 —— 唯一能锚它的量在这个接口里**不存在**。现在 `armChain` 用
   * `fingertipName()`（腕子树里最远的骨）把它算出来，与 restLen 同一世界空间。 */
  const ac = mm && mm.armChain;
  if (ac) raw.hand = ac.hand;
  const missing = Object.keys(raw).filter(k => raw[k] == null);
  /* ★ `hand` 也进比值表：它是**唯一**被写错过 236% 的骨段（0.026 vs 0.0874），
   * 而"写短"不会让 IK 饱和、也不会让任何相对判据变红 —— 只有长度比值拦得住。
   * 用两条比（对手、对前臂）而不是一条：单条比在分子分母同时错时会互相抵消。 */
  const RATIO_PAIRS = [["thigh", "upperArm"], ["foreArm", "upperArm"], ["shin", "foreArm"],
    ["thigh", "shin"], ["hand", "foreArm"], ["hand", "upperArm"]];
  const ratioBad = [], ratioTxt = [];
  if (missing.length) {
    ratioBad.push("取不到骨长: " + missing.join(","));
  } else {
    RATIO_PAIRS.forEach(([a, b]) => {
      const m = raw[a] / raw[b], f = F.MODEL_SEG[a] / F.MODEL_SEG[b];
      ratioTxt.push(`${a}/${b} 模型${m.toFixed(3)}/夹具${f.toFixed(3)}`);
      if (Math.abs(m - f) / f >= 0.06) ratioBad.push(`${a}/${b}: 模型 ${m.toFixed(3)} vs 夹具 ${f.toFixed(3)}`);
    });
  }
  check("夹具骨段**比例**与模型实测一致（±6%；夹具自检是自证的，这条才是对真模型）",
    ratioBad.length === 0, ratioBad.join("; ") || ratioTxt.join("  "));

  /* ★ 比值查不出"**等比缩放**"（所有骨段一起乘 1.2，比值全不变）。
   * 补一条**绝对尺度**核对：把夹具声称的归一化骨长换算成世界长度（× H/0.827，见 rawWorld 的 k2），
   * 与模型实测的世界骨长比。
   *
   * 这条以前做不了 —— 当时的注释说 `restLen` 与 `measured.height` **不在同一空间**、
   * 差一个"未知系数 ≈ 2.019"，而模块没把它作为契约暴露出来。**那个系数其实就是
   * `modelScale() = H / rawH`**（restLen 是世界长度、measured.height 是模型局部长度）：
   * 1 / (0.8914/1.8092) = 2.03 ≈ 2.019。现在 `__layout().H` 与 `__modelMetrics().rawH`
   * 都是公开的，所以"未知系数"变成了可算的量 —— 盲区可以堵上了。 */
  const lay2 = await page.evaluate(() => window.MotionAvatar.__layout());
  const k2 = lay2.H / 0.827;                       // 归一化 → 世界
  const scaleBad = [];
  Object.keys(boneOf).concat("hand").forEach(key => {
    if (raw[key] == null) return;
    const want = F.MODEL_SEG[key] * k2;
    const dev = Math.abs(raw[key] - want) / want;
    if (dev >= 0.05) {
      scaleBad.push(`${key}: 模型实测 ${raw[key].toFixed(4)} vs 夹具换算 ${want.toFixed(4)}（偏 ${(dev * 100).toFixed(1)}%）`);
    }
  });
  check("夹具骨段**绝对尺度**与模型吻合（±5%；堵住「等比缩放」这个比值查不出的盲区）",
    scaleBad.length === 0, scaleBad.join("; ") ||
      `k2=${k2.toFixed(4)}（H=${lay2.H.toFixed(4)}）5 段全部吻合`);

  /* ★ 夹具的 STAND 必须与产品的 IDLE_JOINTS **逐值一致**。
   * 这两个表是同一个契约的**两个副本**（一个给产品当"没识别到人"的姿势，一个给测试当输入），
   * 历史上它们同时把 `handL/handR` 写成 0.026 而谁也没发现 —— 因为它们**一致地错**。
   * 这条只能防"将来两边漂移"，防不了"一起错"；防"一起错"的是上面那条对真模型的比值核对
   * 与 `accept-human-glb.js` ⑧ 的指尖判据。两条都要有。 */
  const idleTable = await page.evaluate(() => window.MotionAvatar.__idleJoints());
  const idleDiff = Object.keys(F.STAND).filter(k => {
    const a = F.STAND[k], b = idleTable[k];
    if (!b) return true;
    return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6;
  });
  check("夹具 STAND 与产品 IDLE_JOINTS 逐值一致（同一个契约的两个副本，不许漂移）",
    idleDiff.length === 0,
    idleDiff.length ? idleDiff.map(k => `${k}: 夹具(${F.STAND[k].x},${F.STAND[k].y}) vs 产品(${idleTable[k] && idleTable[k].x},${idleTable[k] && idleTable[k].y})`).join("; ")
      : Object.keys(F.STAND).length + " 个关节全部一致");

  /* ★ 真·指尖必须存在、且**明显高于腕** —— 这是"⑧ 量的是腕不是指尖"那类错误的守门人。
   * 若哪天 `fingertipName()` 失效（骨名变了、子树没了），它会退回 null，这里立刻红。 */
  const tipCheck = await page.evaluate(() => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 20; i++) M.updateFromSkeleton(null);
    const s = M.__poseSnapshot();
    const mm2 = M.__modelMetrics();
    return {
      tip: mm2 && mm2.fingertip,
      handY: s.RightHand ? s.RightHand[1] : null,
      tipY: s.RightFingertip ? s.RightFingertip[1] : null,
      leftTipY: s.LeftFingertip ? s.LeftFingertip[1] : null,
      leftHandY: s.LeftHand ? s.LeftHand[1] : null,
      shoulderFrac: mm2 && mm2.shoulderFrac,
      armChain: mm2 && mm2.armChain
    };
  });
  const tipGap = (tipCheck.handY != null && tipCheck.tipY != null) ? tipCheck.handY - tipCheck.tipY : null;
  check("真·指尖骨被**发现**出来了（不是硬编码；骨名变了要立刻红）",
    !!tipCheck.tip && tipCheck.tipY != null, "指尖骨=" + tipCheck.tip + "  腕→指尖落差=" +
      (tipGap == null ? "-" : tipGap.toFixed(4)));
  check("站姿时真·指尖明显低于腕（腕→指尖 ≈ 身高的 4.8%；若为 0 说明又量到腕了）",
    tipGap != null && tipGap > 0.06 && tipGap < 0.16, "落差=" + (tipGap == null ? "-" : tipGap.toFixed(4)) + " 世界单位");
  /* 左右**对称**：两只手的指尖骨应当同型（只是 L/R 前缀不同），落差也应当相等。
   * 这条能抓到"骨骼树不对称 / 某只手选错了骨"，而单看一只手看不出来。 */
  const symOk = tipCheck.tip && tipCheck.leftTipY != null &&
    Math.abs((tipCheck.handY - tipCheck.tipY) - (tipCheck.leftHandY - tipCheck.leftTipY)) < 0.002;
  check("左右两只手的指尖骨同型、落差相等（抓骨骼树不对称/某侧选错骨）",
    symOk, "右落差=" + (tipGap == null ? "-" : tipGap.toFixed(4)) +
      " 左落差=" + (tipCheck.leftHandY != null && tipCheck.leftTipY != null
        ? (tipCheck.leftHandY - tipCheck.leftTipY).toFixed(4) : "-"));
  /* 肩离地比例必须落在合理区间（0.75~0.83）。它同时被"构图上界"判据使用，
   * 取不到就会让那条判据退回只用引擎锚点（偏乐观 0.43%），所以这里钉一下。 */
  check("肩离地比例从模型实测出来了（0.75~0.83；取不到时构图上界会偏乐观）",
    tipCheck.shoulderFrac != null && tipCheck.shoulderFrac > 0.75 && tipCheck.shoulderFrac < 0.83,
    "shoulderFrac=" + tipCheck.shoulderFrac);

  console.log("\n-- 渲染 --");
  const pix = await page.evaluate(() => {
    MotionAvatar.updateFromSkeleton(null);
    MotionAvatar.__renderNow();
    const gl = document.querySelector("#motionAvatar canvas");
    if (!gl) return null;
    const W = 200, H = 140;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.drawImage(gl, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let lit = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 70) {
        lit++;
        const px = (i / 4) % W, py = Math.floor((i / 4) / W);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    return {
      ratio: lit / (W * H), lit, w: W, h: H,
      bbox: maxX < 0 ? null : { x: minX / W, w: (maxX - minX) / W, y: minY / H, h: (maxY - minY) / H }
    };
  });
  /* 阈值从 3% 调到 2%：**不是**为了让测试变绿，是因为角色真的变小了 ——
   * 布局改成按"脚底→指尖"分配空间（motion-avatar.js 的 REACH_UP），
   * 尺寸缩到原来的 ~88.5%，像素面积随之 ×0.78（3.1% → 2.4%）。
   * 这条断言的**目的**是"不是黑屏"，2.4%（≈770 像素）离黑屏很远；
   * 真正钉尺寸的是 accept-human-glb ⑧ 那条"最高伸展占安全区 85%~100%"。 */
  check("角色可渲染且有实体像素（>2%，不是黑屏）", pix && pix.ratio > 0.02, pix ? "占比=" + (pix.ratio * 100).toFixed(1) + "%" : "取不到画布");
  check("渲染曝光正常（实体像素 <90%，不是一片白）", pix && pix.ratio < 0.90, pix ? "占比=" + (pix.ratio * 100).toFixed(1) + "%" : "-");
  check("整体居中（剪影水平中心 0.30~0.70）",
    !!(pix && pix.bbox) && (pix.bbox.x + pix.bbox.w / 2) > 0.30 && (pix.bbox.x + pix.bbox.w / 2) < 0.70,
    pix && pix.bbox ? "中心=" + (pix.bbox.x + pix.bbox.w / 2).toFixed(3) : "-");

  console.log("\n-- 跟随动作 --");
  const idle = await page.evaluate(() => {
    for (let i = 0; i < 40; i++) MotionAvatar.updateFromSkeleton(null);
    MotionAvatar.__renderNow(); return MotionAvatar.__poseSnapshot();
  });
  const spread = await page.evaluate(p => {
    for (let i = 0; i < 40; i++) MotionAvatar.updateFromSkeleton(p);
    MotionAvatar.__renderNow(); return MotionAvatar.__poseSnapshot();
  }, SPREAD);
  check("张臂时双手横向张开（跟随动作）",
    Math.abs(spread.LeftHand[0]) > Math.abs(idle.LeftHand[0]) + 0.05 &&
    Math.abs(spread.RightHand[0]) > Math.abs(idle.RightHand[0]) + 0.05,
    "左手 x: " + idle.LeftHand[0] + " → " + spread.LeftHand[0]);
  check("张臂时双手抬高",
    spread.LeftHand[1] > idle.LeftHand[1] + 0.05 && spread.RightHand[1] > idle.RightHand[1] + 0.05,
    "左手 y: " + idle.LeftHand[1] + " → " + spread.LeftHand[1]);
  check("左右镜像对称（同一姿势两侧应当一致）",
    Math.abs(Math.abs(spread.LeftHand[0]) - Math.abs(spread.RightHand[0])) < 0.05 &&
    Math.abs(spread.LeftHand[1] - spread.RightHand[1]) < 0.05,
    "L=" + JSON.stringify(spread.LeftHand) + " R=" + JSON.stringify(spread.RightHand));
  /* 站姿必须"腿直、脚平"：这是换人形后**唯一**靠肉眼才发现的塌陷
   * （IDLE 表髋位偏低 → 微蹲 + 踮脚，而"手在髋下""左右对称"照样通过）。
   * 阈值与依据见 accept-human-glb.js 第 3 节。 */
  const leg = await page.evaluate(() => {
    const s = MotionAvatar.__poseSnapshot();
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const ang = (u, v) => {
      const nu = Math.hypot(...u), nv = Math.hypot(...v);
      if (nu < 1e-9 || nv < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
    };
    return {
      thigh: ang(sub(s.RightLeg, s.RightUpLeg), [0, -1, 0]),
      shin: ang(sub(s.RightFoot, s.RightLeg), [0, -1, 0]),
      ankleToe: s.RightFoot[1] - s.RightToe_End[1]
    };
  });
  check("站姿腿是直的、脚是平的（大腿/小腿 <8° 偏离竖直，踝比趾高 0.03~0.07）",
    leg.thigh < 8 && leg.shin < 8 && leg.ankleToe > 0.03 && leg.ankleToe < 0.07,
    `大腿 ${leg.thigh.toFixed(1)}° 小腿 ${leg.shin.toFixed(1)}° 踝-趾 ${leg.ankleToe.toFixed(4)}`);

  console.log("\n-- 健壮性 --");
  const nanCheck = await page.evaluate(p => {
    const finite = o => Object.keys(o).every(k => Array.isArray(o[k]) && o[k].every(v => Number.isFinite(v)));
    // 只给上半身（下半身缺失）
    const half = {};
    ["head", "neck", "shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR", "hipMid"].forEach(k => half[k] = p[k]);
    for (let i = 0; i < 30; i++) MotionAvatar.updateFromSkeleton(half);
    const a = MotionAvatar.__poseSnapshot();
    // 关节数值跳变（模拟误检）
    const jump = JSON.parse(JSON.stringify(p));
    jump.wristL = { x: 0.95, y: 0.05 }; jump.ankleR = { x: 0.05, y: 0.98 };
    for (let i = 0; i < 30; i++) MotionAvatar.updateFromSkeleton(jump);
    const b = MotionAvatar.__poseSnapshot();
    // 全空
    for (let i = 0; i < 30; i++) MotionAvatar.updateFromSkeleton(null);
    const c = MotionAvatar.__poseSnapshot();
    return { halfOk: finite(a), jumpOk: finite(b), nullOk: finite(c), nullPose: c, keys: Object.keys(c) };
  }, STAND);
  check("只给上半身关节时不崩、不出 NaN", nanCheck.halfOk === true, "所有骨骼坐标为有限值");
  check("关节数值跳变时不崩、不出 NaN", nanCheck.jumpOk === true, "所有骨骼坐标为有限值");
  check("无姿势时仍显示站姿（不空白、不出 NaN）",
    nanCheck.nullOk === true && !!nanCheck.nullPose.Hips &&
    Math.abs(nanCheck.nullPose.LeftHand[1] - nanCheck.nullPose.RightHand[1]) < 0.02,
    "Hips=" + JSON.stringify(nanCheck.nullPose.Hips));

  console.log("\n-- app.js 契约 --");
  /* ⚠️ 这里**不能**用 STAND 当"要喂进去的姿势"：本项目的 STAND 就是模型自然站姿，
   * 而 `updateFromSkeleton(null)` 走的也是同一张 IDLE 表 → 喂 STAND 等于没喂，
   * 骨骼一个都不动，"移动的骨骼数 = 0"会**假失败**（夹具与产品收敛后的副作用）。
   * 所以换一个与站姿明显不同的姿势（深蹲：躯干整体下沉）。 */
  const cb = await page.evaluate(p => {
    // app.js 的渲染回调路径：引擎 onTick → MotionAvatar.updateFromSkeleton(sk.joints)
    for (let i = 0; i < 5; i++) MotionAvatar.updateFromSkeleton(null);
    const before = MotionAvatar.__poseSnapshot();
    for (let i = 0; i < 5; i++) MotionAvatar.updateFromSkeleton(p);
    MotionAvatar.__renderNow();
    const after = MotionAvatar.__poseSnapshot();
    let moved = 0;
    Object.keys(after).forEach(k => { if (before[k] && Math.abs(after[k][1] - before[k][1]) > 1e-4) moved++; });
    return { moved, visible: MotionAvatar.isVisible() };
  }, F.squat());
  check("app.js 的渲染回调能驱动角色（不是只有测试能驱动）", cb.moved >= 3, "移动的骨骼数=" + cb.moved);

  const statusOk = await page.evaluate(() => {
    MotionAvatar.setStatus("测试状态文字");
    const el = document.getElementById("motionAvatarStatus");
    return el ? el.textContent : null;
  });
  check("app.js 会更新角色的状态文字", statusOk === "测试状态文字", '"' + statusOk + '"');

  const progOk = await page.evaluate(() => {
    MotionAvatar.setProgress({ name: "开合跳", current: 7, target: 20, unit: "次", percent: 35, seqIndex: 1, seqTotal: 3 });
    const n = document.getElementById("motionAvatarProgressNum");
    const nm = document.getElementById("motionAvatarProgressName");
    const f = document.getElementById("motionAvatarProgressFill");
    return { num: n ? n.textContent : null, name: nm ? nm.textContent : null, width: f ? f.style.width : null };
  });
  check("全屏进度面板可用（孩子站远处唯一看得见的读数）",
    progOk.num === "7 / 20 次" && progOk.name === "开合跳" && progOk.width === "35%", JSON.stringify(progOk));

  check("页面无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

  await browser.close();
  console.log("\n===== " + pass + "/" + (pass + fail) + " 通过 =====");
  if (fail) process.exit(1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
