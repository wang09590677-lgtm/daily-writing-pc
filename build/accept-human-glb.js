// 体感跟练角色（Mixamo 人形 GLB，65 骨骼）验收 —— 真实 Chrome 里跑。
//
// 2026-10-09 用户要求：「用 体能训练动作演示/体感跟练模型.glb 替换人形猫咪；
// 这是一个人形模型，务必要做到**动作与感应出的玩家一致**」。
//
// ⚠️ 本文件是 `accept-cat-glb.js` 的**改写版**，不是放宽版。猫模型的断言（38 骨 / 54 蒙皮 /
//    6 节尾巴 / `LeftUpperArm` 这类旧骨名）的对象**已经不存在了** ——
//    按本项目定的规矩（"换掉被测对象 ≠ 断言太严"），处理方式是**改写断言**，
//    而不是把阈值调松。核心意图一条没少：
//     ① 真模型真的加载进来了（65 骨骼 / 2 蒙皮网格 / 0 尾巴），不是退回兜底人形
//     ② 喂什么关节 → 骨骼就摆成什么姿势（跟随有效）
//     ③ **左右交叉映射方向正确**（最容易错、肉眼最难发现）
//     ④ 没识别到人时是"自然站姿"（手臂下垂），不是模型自带的 T-pose
//     ⑤ 每帧够快
//     ⑥ **末端真的到位**（绝对几何判据，`__ikError()`）
//     ⑦ **角色落在真实 DOM 量出来的 UI 安全区内**（本轮新增，见第 8 节）
//
// ---- 关于 ③ 左右方向，判据是这样定的（别改错）----
// 引擎的 `shoulderL/wristL` = 图像 x 较小侧 = 屏幕左侧（相机在 +Z 看向原点，世界 -X 在屏幕左）。
// 模型面朝 +Z（面朝镜头），它自己的左半身在 +X（实测左肩 x = +0.0457）→ 屏幕右侧。
// ⇒ 引擎 `wristL`（屏幕左）应当驱动模型 **`RightHand`**（屏幕左）—— 交叉对应。
// 断言：喂 wristL 抬高时模型 RightHand 的 y 显著升高，而 LeftHand **纹丝不动**；反过来再测一次。
//
// 用法：node build/accept-human-glb.js
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const VIEW = { width: 1280, height: 800 };
/* 相机竖直视野 = 1.8（正交 top/bottom = ±0.9），所以像素↔世界的换算是这一条。
 * 别改成本地另算一套 —— 那正是第 8 节要钉的那个缺陷的成因。 */
const VIEW_H = 1.8;
const screenY = (worldY, h) => (0.9 - worldY) * h / VIEW_H;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? "  → " + detail : ""}`);
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-humanglb-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); } }
  };

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport(VIEW);
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") { errors.push("CONSOLE: " + m.text()); console.log("CONSOLE:", m.text()); } });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);

  console.log("\n== 1. 模型加载 ==");
  const hasLoader = await page.evaluate(() => typeof THREE !== "undefined" && typeof THREE.GLTFLoader === "function");
  check("GLTFLoader 已就位（three r150 官方无 UMD 版，靠单独补的 r147 版）", hasLoader === true, "THREE.GLTFLoader=" + hasLoader);

  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("skeleton:", JSON.stringify({ ready: sk.ready, failed: sk.failed, reason: sk.reason, bones: sk.boneCount, skinned: sk.skinnedCount, tail: sk.tail }));
  check("模型加载成功（没退回兜底人形）", sk.ready === true && sk.failed === false, "reason=" + (sk.reason || "无"));
  check("骨骼数 = 65（Mixamo 标准人形）", sk.boneCount === 65, "boneCount=" + sk.boneCount);
  check("蒙皮网格数 = 2（Beta_Joints / Beta_Surface）", sk.skinnedCount === 2, "skinnedCount=" + sk.skinnedCount);
  /* ⚠️ `sk.tail` 是 `TAIL_BONES.filter(...)`，而 TAIL_BONES = []（人形没尾巴）
   * ⇒ **恒等于 0**，与模型无关。这是"恒真断言"（同类：旧脚本的 `膝盖夹角 < 170`）。
   * 改按**真实骨名**查模型自己有没有 tail。 */
  const tailLike = (sk.boneNames || []).filter(n => /tail/i.test(n));
  check("模型骨名里没有尾巴骨骼（按**真实骨名**查；sk.tail 恒 0，不作判据）",
    tailLike.length === 0, tailLike.length ? tailLike.join(",") : `无 tail 骨名（sk.tail=${sk.tail} 是配置项）`);
  check("自顶向下顺序覆盖全部骨骼（aim 依赖它）", sk.topDownLen >= sk.boneCount, `${sk.topDownLen} vs ${sk.boneCount}`);
  check("没用到兜底模型", sk.usingFallback === false, "usingFallback=" + sk.usingFallback);

  /* ---- 1b. 尺寸必须来自**实测**，不能是手抄常量 ---- */
  console.log("\n== 1b. 模型尺寸实测（换模型时最容易静默失效的一项）==");
  const mm = await page.evaluate(() => window.MotionAvatar.__modelMetrics());
  console.log("modelMetrics:", JSON.stringify(mm.measured), "url=" + mm.url);
  check("模型来自用户指定的文件（体能训练动作演示/体感跟练模型.glb）",
    /体感跟练模型\.glb$/.test(mm.url), mm.url);
  check("身高实测 ≈ 1.809（真人尺度；错 100 倍说明用了 Box3.setFromObject 量蒙皮网格）",
    mm.measured && Math.abs(mm.measured.height - 1.809) < 0.05, "height=" + (mm.measured && mm.measured.height));
  check("最低关节是 Toe_End 且贴在网格底（REST_LOWEST ≈ 0）",
    mm.measured && /Toe_End$/.test(mm.measured.lowestJointName) && Math.abs(mm.restLowest) < 0.01,
    "最低关节=" + (mm.measured && mm.measured.lowestJointName) + " restLowest=" + mm.restLowest);
  check("腿骨不拉伸（Mixamo 人形已是真人比例，LEG_STRETCH = 1.0）",
    mm.legStretch === 1, "LEG_STRETCH=" + mm.legStretch);

  /* ---- 2. 跟随 + 交叉映射 ---- */
  console.log("\n== 2. 跟随有效 + 左右交叉映射 ==");
  const grab = async (joints, n) => page.evaluate((j, k) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < k; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    return M.__poseSnapshot();
  }, joints, n || 40);

  const idle = await grab(null);
  const raisedL = await grab(F.raiseOne("engineL"));
  const raisedR = await grab(F.raiseOne("engineR"));

  const dyL_engineL = raisedL.RightHand[1] - idle.RightHand[1];
  const dyR_engineL = raisedL.LeftHand[1] - idle.LeftHand[1];
  const dyL_engineR = raisedR.LeftHand[1] - idle.LeftHand[1];
  const dyR_engineR = raisedR.RightHand[1] - idle.RightHand[1];

  check("② 跟随有效：喂抬臂数据后手部确实抬高（不是僵在原地）",
    Math.abs(dyL_engineL) > 0.05 || Math.abs(dyL_engineR) > 0.05,
    `引擎左→模型右手 Δy=${dyL_engineL.toFixed(3)}，引擎右→模型左手 Δy=${dyL_engineR.toFixed(3)}`);
  check("③ 引擎 wristL（屏幕左）驱动的是**模型右手**（交叉映射，方向没反）",
    dyL_engineL > 0.10, `Δy(RightHand)=${dyL_engineL.toFixed(3)} 应显著为正`);
  check("③ 引擎 wristR（屏幕右）驱动的是**模型左手**",
    dyL_engineR > 0.10, `Δy(LeftHand)=${dyL_engineR.toFixed(3)} 应显著为正`);
  /* 无串扰：夹具**只动了一侧**（另一侧与站姿逐字节相同），所以另一侧的手应当几乎不动。
   * 阈值 0.02 的依据：抬起的腕 Δy≈0.51（世界单位），串扰若存在会是同一量级；
   * 实测另一侧 Δy = 0.000（见下面打印）。留 0.02 只是容忍浮点与平滑残差。 */
  check("③ 抬一侧时另一侧不该跟着动（没有串扰）",
    Math.abs(dyR_engineL) < 0.02 && Math.abs(dyR_engineR) < 0.02,
    `引擎左抬时模型左 Δy=${dyR_engineL.toFixed(4)}；引擎右抬时模型右 Δy=${dyR_engineR.toFixed(4)}`);

  /* ---- 3. 站姿不是 T-pose ---- */
  console.log("\n== 3. 站姿不是 T-pose（没识别到人时不能举着双手）==");
  const armDrop = idle.LeftHand[1] - idle.Hips[1];
  check("③ 站姿时手在髋以下（T-pose 会远高于髋）", armDrop < -0.05,
    `手-髋 高度差=${armDrop.toFixed(3)}（负 = 手在髋下方）`);
  check("③ 站姿时双手对称", Math.abs(idle.LeftHand[1] - idle.RightHand[1]) < 0.02,
    `左手y=${idle.LeftHand[1]} 右手y=${idle.RightHand[1]}`);
  /* 本轮新增：站姿必须"腿直、脚平" —— 旧 IDLE 表比例不对时会微蹲 + 踮脚，
   * 而"手在髋下""双手对称"这两条**照样通过**（它们对手脚之外的塌陷完全无感）。 */
  const footPitch = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const s = M.__poseSnapshot();
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const ang = (u, v) => {
      const nu = Math.hypot(...u), nv = Math.hypot(...v);
      if (nu < 1e-9 || nv < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
    };
    return {
      thighFromDown: ang(sub(s.RightLeg, s.RightUpLeg), [0, -1, 0]),
      shinFromDown: ang(sub(s.RightFoot, s.RightLeg), [0, -1, 0]),
      kneeBend: ang(sub(s.RightLeg, s.RightUpLeg), sub(s.RightFoot, s.RightLeg)),
      ankleY: s.RightFoot[1], toeY: s.RightToe_End[1]
    };
  });
  /* 阈值依据：模型静止骨架的实测值 —— 大腿与小腿都近乎垂直（各自 < 5°）、
   * 膝内角 ≈ 180°、踝比趾高 0.052（世界单位，= 0.048×身高）。
   * 旧 IDLE 表（髋位偏低 0.065 归一化）时实测：大腿 43.6°、小腿 39°、膝内角 82.6°、
   * 踝比趾高 0.121（≈ 静止值的 2.3 倍，视觉上就是踮脚）。 */
  /* ⚠️ **"膝内角"这个量的口径必须先说清**（旧脚本在这里糊过）：
   * 这里量的是"大腿向量(髋→膝)"与"小腿向量(膝→踝)"的**夹角**，不是解剖学上的内角。
   *   · 腿伸直 → 两向量同向 → **夹角 ≈ 0°**
   *   · 深蹲   → 两向量张开 → 夹角变大
   * 所以"伸直"要断言**小于**某值。旧 accept-cat-glb.js 写的是 `bend < 170` 配文案
   * "180° 说明膝盖没弯" —— 按向量夹角算，**腿笔直时是 0°，0 < 170 照样通过**，
   * 也就是说那条断言**恒真、从来没检出过任何东西**（连 IK 弯角恒为 0 的 bug 都放过了）。
   * 阈值依据：人形模型站姿实测 11.8°（模型腿比夹具的髋→踝长 0.7%，必然带一点微弯），
   * 深蹲实测 69.2°；IK 弯角恒为 0 时两段会被拉成一条直线（≈ 0°）。 */
  check("③ 站姿腿是直的（大腿/小腿偏离竖直都 < 8°；旧表实测 43.6° / 39°）",
    footPitch.thighFromDown < 8 && footPitch.shinFromDown < 8,
    `大腿 ${footPitch.thighFromDown.toFixed(1)}°  小腿 ${footPitch.shinFromDown.toFixed(1)}°`);
  check("③ 站姿膝几乎伸直（大腿向量与小腿向量夹角 < 20°；旧表实测 82.6° = 微蹲）",
    footPitch.kneeBend < 20, footPitch.kneeBend.toFixed(1) + "°（伸直 ≈ 0°）");
  check("③ 站姿脚掌是平的（踝比趾高 0.03~0.07；踮脚会到 0.12）",
    footPitch.ankleY - footPitch.toeY > 0.03 && footPitch.ankleY - footPitch.toeY < 0.07,
    (footPitch.ankleY - footPitch.toeY).toFixed(4));

  /* ---- 4. 根骨骼跟随 ---- */
  console.log("\n== 4. 根骨骼跟随（整体下蹲）==");
  const sq = await grab(F.squat());
  const dHip = sq.Hips[1] - idle.Hips[1];
  check("④ 蹲下时 Hips 跟着下降", dHip < -0.03, `Hips Δy=${dHip.toFixed(3)}（应为负=下降）`);

  /* ---- 4b. 驱动表全覆盖 ---- */
  console.log("\n== 4b. 驱动表全覆盖：每根骨骼都要真的被驱动（含 GLTFLoader 改名）==");
  const dbg = await page.evaluate(() => window.MotionAvatar.debug());
  check("④ 驱动表里没有解析失败的骨骼",
    Array.isArray(dbg.unresolved) && dbg.unresolved.length === 0,
    dbg.unresolved && dbg.unresolved.length ? "解析不到: " + dbg.unresolved.join(", ") : "全部解析成功");
  check("④ 存在的别名映射被显式记录（mixamorig 前缀这类）",
    Array.isArray(dbg.aliased) && dbg.aliased.length > 0, JSON.stringify(dbg.aliased.slice(0, 4)) + " 共 " + dbg.aliased.length + " 条");
  check("④ 驱动表每一项都可见（length 合法）",
    dbg.links.length > 0 && dbg.links.every(l => l.visible && l.length > 0.005 && l.length < 0.85),
    dbg.links.filter(l => !l.visible || l.length <= 0.005).map(l => l.name).join(", ") || `${dbg.links.length} 项全部有实长`);

  const headMoved = await page.evaluate(j => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    const a = M.__poseSnapshot();
    for (let i = 0; i < 5; i++) M.updateFromSkeleton(null);
    return { head: a.Head, neck: a.Neck };
  }, F.headTilt());
  check("④ 头骨被真的驱动（喂'头偏左'→ 头骨跟着偏）",
    !!headMoved.head && headMoved.head[0] < -0.02,
    `Head=${JSON.stringify(headMoved.head)}（x 应为负=偏左）`);

  /* ---- 4c. aim 平面正确性 ---- */
  console.log("\n== 4c. aim 正确性：骨链必须留在关节所在平面内 ==");
  const plane = await page.evaluate(j => {
    const M = window.MotionAvatar;
    const grab = n => { const w = M.__boneWorld(n); return w ? [w.x, w.y, w.z] : null; };
    for (let i = 0; i < 50; i++) M.updateFromSkeleton(null);
    const idleHand = grab("LeftHand");
    for (let i = 0; i < 50; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    return {
      idleHand,
      upperArm: grab("LeftArm"), foreArm: grab("LeftForeArm"), hand: grab("LeftHand"),
      rUpperArm: grab("RightArm"), rForeArm: grab("RightForeArm"), rHand: grab("RightHand")
    };
  }, F.armSpread());
  const zs = [plane.upperArm, plane.foreArm, plane.hand, plane.rUpperArm, plane.rForeArm, plane.rHand]
    .map(p => p ? Math.abs(p[2]) : NaN);
  const maxZ = Math.max.apply(null, zs);
  /* 阈值 0.05 依据：所有输入关节都在 z=0 平面，骨链若正确也应留在该平面。
   * aim 四元数写成 `L' = L·q·L`（漏掉 Wp⁻¹·Wp）时实测 |z| ≈ 0.33（四肢甩到身后）。 */
  check("④c 骨链留在关节所在平面内（|z| < 0.05，防「四肢甩到身后」）",
    Number.isFinite(maxZ) && maxZ < 0.05, "最大 |z| = " + maxZ.toFixed(4));
  check("④c 平举时手真的外展到身体外侧（|x| 明显大于站姿）",
    !!plane.hand && !!plane.idleHand && Math.abs(plane.hand[0]) > Math.abs(plane.idleHand[0]) + 0.15,
    "平举 |x|=" + Math.abs(plane.hand[0]).toFixed(3) + " 站姿 |x|=" + Math.abs(plane.idleHand[0]).toFixed(3));
  check("④c 平举时手高于肩（举手的方向没反）",
    !!plane.hand && !!plane.upperArm && plane.hand[1] > plane.upperArm[1],
    "手 y=" + plane.hand[1].toFixed(3) + " 肩 y=" + plane.upperArm[1].toFixed(3));

  /* ---- 5. 流畅度 ---- */
  console.log("\n== 5. 流畅度（每帧耗时）==");
  const perf = await page.evaluate((pa, pb) => {
    const t0 = performance.now();
    const N = 120;
    for (let i = 0; i < N; i++) {
      window.MotionAvatar.updateFromSkeleton(i % 2 ? pb : pa);
      window.MotionAvatar.__renderNow();
    }
    return (performance.now() - t0) / N;
  }, F.armSpread(), F.legsApart());
  check("⑤ 每帧（骨骼驱动 + 渲染）< 8ms", perf < 8, perf.toFixed(2) + "ms/帧");

  /* ---- 6. 画面里真的有东西 ---- */
  console.log("\n== 6. 画面里真的有东西（不是黑屏）==");
  const pixels = await page.evaluate(() => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(null);
    M.__renderNow();
    const gl = document.querySelector("#motionAvatar canvas");
    if (!gl) return null;
    const W = 200, H = 160;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.drawImage(gl, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let lit = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let i = 0; i < d.length; i += 4) {
      // 背景是深蓝渐变（#1b2740~#0d1420）；角色是亮粉/橙，亮度明显更高
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 70) {
        lit++;
        const px = (i / 4) % W, py = Math.floor((i / 4) / W);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    return {
      lit, tot: W * H, ratio: lit / (W * H), w: gl.width, h: gl.height,
      bbox: maxX < 0 ? null : {
        x: minX / W, w: (maxX - minX) / W, y: minY / H, h: (maxY - minY) / H
      }
    };
  });
  /* ⚠️ 别只断言"占比 > 3%" —— 站姿下双臂贴身体，剪影很**窄**（1280px 宽里只占 ~100px），
   * 采样到 200×160 时占比只有 3.3%，离阈值太近会变成假失败。
   * 这里改成量**包围盒**：既要有足够多的实体像素，包围盒也要真的撑开。
   *
   * ★ 高度阈值**不能写死 50%**：它是拿旧尺寸调出来的，而角色大小由 `layoutFor()` 决定 ——
   *   本轮把 REACH_UP 从错误的 0.1306 修正到实测的 0.2125 之后，角色**合法地**小了 7%，
   *   剪影高度从 52% 掉到 48.75%，那条写死 50% 的断言立刻变红，**而画面完全正常**
   *   （这正是"阈值写死 = 迟早误报"的典型）。现在改成**自锚定**：
   *   拿 `__layout().H` 算出"角色身高应当占窗口高度的比例"，两边都要对得上。
   *   这不是放宽 —— 它是**双向**的：既抓"缩成小不点"，也抓"渲染得比布局大"。 */
  const layInfo = await page.evaluate(() => window.MotionAvatar.__layout());
  const expH = layInfo.H / VIEW_H;                        // 角色身高应占窗口高度的比例
  const gotH = pixels && pixels.bbox ? pixels.bbox.h : 0;
  check("⑥ 角色在画面里可见（实体像素数 > 400，不是黑屏）",
    pixels && pixels.lit > 400, pixels ? `实体像素=${pixels.lit}/${pixels.tot}` : "取不到 canvas");
  check("⑥ 渲染剪影高度与**布局高度**吻合（±8%，自锚定；别写死 50%）",
    pixels && pixels.bbox && Math.abs(gotH - expH) <= expH * 0.08,
    `渲染 ${(gotH * 100).toFixed(1)}% vs 布局 ${(expH * 100).toFixed(1)}%（H=${layInfo.H.toFixed(4)}）`);
  check("⑥ 角色剪影不是一条线/一个小点（纵向 ≥ 布局高度的 85%、横向 ≥ 5%）",
    pixels && pixels.bbox && gotH >= expH * 0.85 && pixels.bbox.w > 0.05,
    pixels && pixels.bbox ? `bbox=${JSON.stringify(pixels.bbox)}` : "-");
  check("⑥ 渲染曝光正常（实体像素 < 90%，不是一片白）",
    pixels && pixels.ratio < 0.90, pixels ? `占比=${(pixels.ratio * 100).toFixed(1)}%` : "-");
  check("⑥ 角色水平居中（剪影中心在 0.35~0.65）",
    pixels && pixels.bbox && (pixels.bbox.x + pixels.bbox.w / 2) > 0.35 &&
    (pixels.bbox.x + pixels.bbox.w / 2) < 0.65,
    pixels && pixels.bbox ? "中心=" + (pixels.bbox.x + pixels.bbox.w / 2).toFixed(3) : "-");

  /* ---- 7. 绝对判据 ---- */
  console.log("\n== 7. 绝对判据：末端 IK 误差 / 腿幅度 / 膝盖真的会弯 ==");
  const ikStand = await page.evaluate(j => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    return M.__ikError();
  }, F.STAND);
  const amp = await page.evaluate(({ a, b }) => {
    const M = window.MotionAvatar;
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(a);
    const s1 = M.__poseSnapshot();
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(b);
    const s2 = M.__poseSnapshot();
    const one = n => d(s1[n], s2[n]);
    return { foot: (one("RightFoot") + one("LeftFoot")) / 2, knee: (one("RightLeg") + one("LeftLeg")) / 2 };
  }, { a: F.STAND, b: F.legsApart() });
  const knee = await page.evaluate(j => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 60; i++) M.updateFromSkeleton(j);
    M.__renderNow();
    const s = M.__poseSnapshot();
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const ang = (u, v) => {
      const nu = Math.hypot(...u), nv = Math.hypot(...v);
      if (nu < 1e-9 || nv < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
    };
    return {
      bend: ang(sub(s.RightLeg, s.RightUpLeg), sub(s.RightFoot, s.RightLeg)),
      thigh: s.RightUpLeg, kneeJ: s.RightLeg, ankle: s.RightFoot
    };
  }, F.deepKnee());

  console.log("ik(站姿) = " + JSON.stringify(ikStand));
  console.log("腿幅度   = 脚 " + amp.foot.toFixed(4) + " / 膝 " + amp.knee.toFixed(4));
  console.log("深蹲弯角 = " + knee.bend.toFixed(1) + "°");

  /* 阈值依据（1280×800 实测，本轮换模型后重新实测）：
   *   站姿腕误差：旧猫模型 + clamp 写反时 0.1393 → 修复后 0.0000；人形模型实测 0.0000
   *   站姿踝误差：旧猫模型未拉腿 0.1106 → 拉腿后 0.0677；人形模型（不需拉伸）实测 0.0000
   *   ⇒ 人形模型这两项都**精确到 0**，所以阈值收到 0.01（比旧值 0.03 / 0.09 严得多）。
   *     这不是"调松"，是把尺子校准到新模型后能分辨的量级。 */
  check("⑦ 站姿腕误差 < 0.01（钉住 IK 真的会弯肘；clamp 写反时 0.1393）",
    !!ikStand && ikStand.wristL < 0.01, "腕误差=" + (ikStand ? ikStand.wristL : "null"));
  check("⑦ 站姿踝误差 < 0.01（钉住末端真的落到目标点；旧猫未拉腿 0.1106）",
    !!ikStand && ikStand.ankleL < 0.01, "踝误差=" + (ikStand ? ikStand.ankleL : "null"));
  /* 膝/肘的"极杆误差"**不为 0 是正确的**：极杆是引擎自己的膝/肘关节，而本驱动
   * 保骨长、IK 只能重新分配角度 —— 模型与真人的骨段长度不同，解出来的膝必然偏离目标膝。
   * 真正要守的是**末端**（踝/腕）误差为 0。这里只加一条"别炸掉"的护栏。 */
  check("⑦ 膝/肘极杆误差 < 0.30（保骨长驱动的固有偏差，末端才是验收项）",
    !!ikStand && ikStand.kneeL < 0.30 && ikStand.elbowL < 0.30,
    `膝=${ikStand && ikStand.kneeL} 肘=${ikStand && ikStand.elbowL}`);
  /* 腿幅度阈值**必须从当前布局算出来**，不能写死常数。
   * 夹具把踝外移 0.120 归一化单位；归一化→世界的系数 k2 = layout.H / bodySpan(0.827)
   * ⇒ 期望世界幅度 = 0.120 × k2。
   * 为什么不能写死：本轮为了"举手过顶不被面板切"把角色缩小了 11.5%，
   * 同一个夹具的世界幅度就从 0.1667 掉到 0.1474 —— 写死的阈值会**悄悄变宽/变窄**，
   * 而断言文案还写着旧数字（旧猫时代写的 0.165 就是这么过时的）。 */
  const lay = await page.evaluate(() => window.MotionAvatar.__layout());
  const expectedFoot = 0.120 * lay.H / 0.827;
  check("⑦ 腿幅度（并腿→分开）≥ 指令值的 90%（阈值随布局自动缩放，不写死）",
    amp.foot >= expectedFoot * 0.90,
    `脚幅度=${amp.foot.toFixed(4)} ≥ ${(expectedFoot * 0.90).toFixed(4)}（指令 ${expectedFoot.toFixed(4)}）  膝幅度=${amp.knee.toFixed(4)}`);
  /* 弯角阈值 60° 依据：这个量是"大腿向量 × 小腿向量"的夹角 ——
   *   腿伸直 = 0°、深蹲实测 69.2°、IK 弯角恒为 0（clamp 参数写反）时会被拉成一条直线 ≈ 0°。
   * 所以必须断言**大于** 60°。旧脚本写 `< 170` 并配文案"180° 说明膝盖没弯"，
   * 方向与口径都错了 —— 0 < 170 恒成立，**这条断言从来没检出过任何东西**。 */
  check("⑦ 深蹲时膝盖真的弯了（大腿向量与小腿向量夹角 > 60°；腿伸直时 ≈ 0°）",
    knee.bend > 60, "弯角=" + knee.bend.toFixed(1) + "°（腿伸直 ≈ 0°）");

  /* ---- 8. 构图：角色必须在真实 DOM 量出来的 UI 安全区内 ----
   * 这一节抓的是一个**静默了两天的缺陷**：layoutFor() 里把相机竖直视野当成 2.0，
   * 而正交相机实际是 [-0.9, 0.9] = 1.8 → 角色被放大 11.1% 并整体下移同样的比例，
   * **脚沉进底部控制栏 81px**。所有程序化断言全绿，只有量像素才看得出来。
   * 所以这里**不信任任何常量**：安全区边界直接从 DOM 的 getBoundingClientRect 取，
   * 角色边界从 __boneWorld 取，再用相机换算公式投影到屏幕像素 —— 两边都对得上才算过。 */
  console.log("\n== 8. 构图：角色必须落在 UI 安全区内（真实 DOM + 像素投影）==");
  const fit = await page.evaluate((vh, spreadPose, overheadPose) => {
    const M = window.MotionAvatar;
    const h = window.innerHeight;
    M.setProgress({ name: "开合跳", current: 12, target: 20, unit: "次", percent: 60, seqIndex: 2, seqTotal: 5 });
    const prog = document.querySelector(".motion-avatar-progress");
    const ctrl = document.querySelector(".motion-avatar-controls");
    const safeTopPx = prog ? prog.getBoundingClientRect().bottom : 198;
    const safeBotPx = ctrl ? ctrl.getBoundingClientRect().top : h - 91;
    const proj = y => (0.9 - y) * h / vh;
    const measure = (joints) => {
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(joints);
      M.__renderNow();
      const s = M.__poseSnapshot();
      /* 角色在屏幕上的上下边界：头/手取最高，脚趾取最低。
       * ★ 上边界必须含 `*Fingertip`（= 腕子树里最远的骨）。**不能用 `*Hand`** ——
       *   那是**腕**（骨 origin，也是手臂 IK 的末端，见 IK_TAILS / __ikError()）。
       *   第一版就是拿腕当指尖，于是这条判据**少算一整个手掌**（实测 ~45px），
       *   报"指尖 226.6px > 面板 197.6px"通过，而真指尖其实在 181.7px —— 仍被切 16px。
       *   这就是"两条断言都叫指尖、但一条量的是腕"的典型：光看 PASS 永远发现不了。 */
      let topY = -Infinity, botY = Infinity;
      ["HeadTop_End", "Head", "LeftFingertip", "RightFingertip",
        "LeftHand", "RightHand", "LeftToe_End", "RightToe_End",
        "LeftFoot", "RightFoot"].forEach(k => {
        if (!s[k]) return;
        if (s[k][1] > topY) topY = s[k][1];
        if (s[k][1] < botY) botY = s[k][1];
      });
      return {
        worldTop: topY, worldBot: botY, screenTop: proj(topY), screenBot: proj(botY),
        tipKey: (s.RightFingertip && s.RightFingertip[1] >= topY - 1e-6) ? "RightFingertip"
          : (s.LeftFingertip && s.LeftFingertip[1] >= topY - 1e-6) ? "LeftFingertip" : "(其他)",
        wristTop: proj(Math.max(s.RightHand ? s.RightHand[1] : -9, s.LeftHand ? s.LeftHand[1] : -9))
      };
    };
    /* ---- 与夹具**无关**的解析上界 ----
     * 夹具的"举手过顶"比模型真实最大伸展短约 0.3%（骨长取 IDLE 手写值、手臂带 0.5° 外张），
     * 所以只用它顶边界会**偏乐观一点点**。这里直接拿模型实测的臂链长度，
     * 按"手臂完全竖直向上"算最高指尖，投影到屏幕 —— 这是**任何动作都不可能超过**的上界。 */
    const mm = M.__modelMetrics();
    const lay = M.__layout();
    let maxReach = null;
    if (mm && mm.armChain && lay) {
      /* 肩离地比例取**两者中更高的**：
       *   · 引擎 IDLE 的肩锚点换算 = (0.925 − 0.270) / 0.827 = 0.7920（产品契约）
       *   · 模型 rest 实测 `shoulderFrac` = 0.7963
       * 原来只用前者，于是这个"上界"比模型真实肩高**低了 0.43%（≈1.7px@800）** ——
       * 一个自称"任何动作都不可能超过"的界，其实不是上界。取 max 就真的是上界了。
       * （两者的存在也说明这个判据不是循环论证：IDLE 锚点与 REACH_UP 无因果关系。） */
      const anchorFrac = (0.925 - 0.270) / 0.827;
      const modelFrac = (mm.shoulderFrac != null) ? mm.shoulderFrac : 0;
      const shoulderFrac = Math.max(anchorFrac, modelFrac);
      const chainWorld = mm.armChain.upperArm + mm.armChain.foreArm + mm.armChain.hand;
      const shoulderWorld = lay.footY + shoulderFrac * lay.H;   // H = 网格身高（脚底→头顶）
      const tipWorld = shoulderWorld + chainWorld;
      maxReach = {
        tipWorld: tipWorld, screenTop: proj(tipWorld), chain: mm.armChain,
        reachUp: lay.reachUp, shoulderFrac: shoulderFrac, anchorFrac: anchorFrac, modelFrac: modelFrac
      };
    }
    /* ---- 真·**渲染像素**的上边界 ----
     * 上面两条都还是"骨骼坐标投影"。骨骼是**关节点**，网格可能比关节还高一截
     * （指尖骨 Middle4 是末节指骨的**起点**，指尖网格在它上面）—— 而且这条判据
     * **完全不依赖任何骨骼/夹具**，是"孩子到底看不看得见手"的最直接答案。
     * 注意：进度面板是 DOM、不在 canvas 里，所以这里量到的就是**角色自己**的顶。
     * ⚠️ 这个扫描**必须在最后一次 `measure()` 之后**跑：`measure()` 里才喂姿势 + 重绘，
     *    放在它前面量到的是上一节留下的**旧姿势**（曾经因此报出 333px 这种无意义的数）。 */
    const scanPixelTop = () => {
      const gl = document.querySelector("#motionAvatar canvas");
      if (!gl) return null;
      const W = window.innerWidth, H = h;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const g2 = cv.getContext("2d");
      g2.drawImage(gl, 0, 0, W, H);
      const d = g2.getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          // 背景是深蓝渐变（#1b2740~#0d1420）；角色是亮粉/橙，亮度明显更高
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 70) return y;
        }
      }
      return null;
    };
    const stand = measure(null);
    const spread = measure(spreadPose);
    const overhead = measure(overheadPose);
    const pixTop = scanPixelTop();
    return {
      h, safeTopPx, safeBotPx, maxReach, pixTop, stand, spread, overhead,
      reachUpMeasured: lay && lay.reachUpMeasured
    };
  }, VIEW_H, F.armSpread(), F.armsOverhead());
  const fillOf = m => (m.screenBot - m.screenTop) / (fit.safeBotPx - fit.safeTopPx);
  console.log(`安全区像素: 顶部面板下沿=${fit.safeTopPx.toFixed(1)}  底部控制栏上沿=${fit.safeBotPx.toFixed(1)}  (窗口高 ${fit.h})`);
  console.log(`站姿屏幕范围: ${fit.stand.screenTop.toFixed(1)} ~ ${fit.stand.screenBot.toFixed(1)}`);
  console.log(`张臂屏幕范围: ${fit.spread.screenTop.toFixed(1)} ~ ${fit.spread.screenBot.toFixed(1)}`);
  console.log(`过顶屏幕范围: ${fit.overhead.screenTop.toFixed(1)} ~ ${fit.overhead.screenBot.toFixed(1)}` +
    `   （最高点=${fit.overhead.tipKey}；同一姿势下"腕"在 ${fit.overhead.wristTop.toFixed(1)}px` +
    ` —— 两者差 ${(fit.overhead.wristTop - fit.overhead.screenTop).toFixed(1)}px，就是"腕 vs 指尖"的量）`);
  if (fit.maxReach) {
    console.log(`模型最大伸展(解析): 指尖世界 y=${fit.maxReach.tipWorld.toFixed(3)} → 屏幕 ${fit.maxReach.screenTop.toFixed(1)}px` +
      `  臂链=${(fit.maxReach.chain.upperArm + fit.maxReach.chain.foreArm + fit.maxReach.chain.hand).toFixed(4)}` +
      ` (指尖骨=${fit.maxReach.chain.tipName})  REACH_UP=${fit.maxReach.reachUp}`);
    console.log(`  肩离地比例: 引擎锚点 ${fit.maxReach.anchorFrac.toFixed(4)} / 模型实测 ${fit.maxReach.modelFrac.toFixed(4)}` +
      ` → 取 ${fit.maxReach.shoulderFrac.toFixed(4)}（保证是上界）`);
  }
  check("⑧ 站姿头顶不压顶部面板", fit.stand.screenTop > fit.safeTopPx,
    `头顶 ${fit.stand.screenTop.toFixed(1)}px > 面板下沿 ${fit.safeTopPx.toFixed(1)}px`);
  check("⑧ 站姿脚底不沉进底部控制栏", fit.stand.screenBot < fit.safeBotPx,
    `脚底 ${fit.stand.screenBot.toFixed(1)}px < 控制栏上沿 ${fit.safeBotPx.toFixed(1)}px`);
  check("⑧ 张臂时脚底也不沉进控制栏", fit.spread.screenBot < fit.safeBotPx,
    `脚底 ${fit.spread.screenBot.toFixed(1)}px < ${fit.safeBotPx.toFixed(1)}px`);
  /* ⚠️ 上边界**必须**用真·举手过顶去顶，而且**必须量真·指尖**。
   * 这里先后错过两次（都是"看起来绿了"）：
   *   ① 原来喂 `F.armSpread()`（只抬 30°、手根本不过头）→ 量到的最高点其实是**头顶**，
   *      一条**假判据**；后果是孩子举手时手被面板整个吃掉而断言全绿；
   *   ② 改用 `F.armsOverhead()` 后仍拿 `*Hand` 当指尖 —— 而那是**腕**，
   *      于是少算一整个手掌（~45px），报 226.6px 通过，真指尖其实 181.7px。 */
  check("⑧ 举手过顶时**真·指尖**也不压顶部面板（用 armsOverhead + Fingertip；腕≠指尖）",
    fit.overhead.screenTop > fit.safeTopPx,
    `指尖(${fit.overhead.tipKey}) ${fit.overhead.screenTop.toFixed(1)}px > 面板下沿 ${fit.safeTopPx.toFixed(1)}px`);
  /* ★ 上面那条有个**静默降级**的洞：`__poseSnapshot()` 在 `RightFingertip` 取不到时**不写这个键**，
   * 于是 `measure()` 的候选表自动退回头顶 —— 那条断言就悄悄变成了"量头顶"（又是假判据）。
   * 所以必须单独钉一句：过顶姿势的最高点**就是指尖**。 */
  check("⑧ 过顶姿势的最高点确实是**指尖**（不是头顶、不是腕）—— 防 Fingertip 取不到时静默退回头顶",
    fit.overhead.tipKey === "RightFingertip" || fit.overhead.tipKey === "LeftFingertip",
    "最高点=" + fit.overhead.tipKey + "（应为 *Fingertip）");
  /* 与夹具无关的解析上界：模型手臂完全竖直时的最高指尖也必须让开面板。
   * 这条**不依赖任何夹具**，所以夹具哪天又被画短了也拦得住。 */
  check("⑧ 模型**解析最大伸展**（手臂完全竖直，与夹具无关）也不压顶部面板",
    !fit.maxReach || fit.maxReach.screenTop > fit.safeTopPx,
    fit.maxReach ? `解析指尖 ${fit.maxReach.screenTop.toFixed(1)}px > ${fit.safeTopPx.toFixed(1)}px` : "拿不到 armChain");
  check("⑧ REACH_UP 是**从模型实测**的（≈0.21），不是那个把腕当指尖的 0.1306",
    fit.maxReach && fit.maxReach.reachUp > 0.17 && fit.maxReach.reachUp < 0.26,
    fit.maxReach ? "REACH_UP=" + fit.maxReach.reachUp : "-");
  /* ⚠️ 上面那条**取值范围**在"实测失败、退回兜底 0.2125"时照样通过（兜底值本身就在区间里）。
   * 所以再钉一句"真的是量出来的"—— 这是"静默降级"这一类错误的守门人。 */
  check("⑧ REACH_UP 确实**量出来了**（reachUpMeasured 非 null；退回兜底值时这条会红）",
    fit.reachUpMeasured != null && fit.maxReach != null &&
    Math.abs(fit.reachUpMeasured - fit.maxReach.reachUp) < 1e-6,
    "reachUpMeasured=" + fit.reachUpMeasured + "  生效值=" + (fit.maxReach && fit.maxReach.reachUp));
  check("⑧ 举手过顶时脚底也不沉进控制栏", fit.overhead.screenBot < fit.safeBotPx,
    `脚底 ${fit.overhead.screenBot.toFixed(1)}px < ${fit.safeBotPx.toFixed(1)}px`);
  /* 最硬的一条：直接量**渲染出来的像素**。骨骼投影说"指尖 216.8px"，但网格可能更高；
   * 只有这一条回答"孩子到底看不看得见手"。它不依赖骨骼、不依赖夹具。 */
  check("⑧ 举手过顶时**渲染像素**的顶端也让开顶部面板（最直接的一条，不依赖骨骼）",
    fit.pixTop == null || fit.pixTop > fit.safeTopPx,
    fit.pixTop == null ? "取不到 canvas" :
      `像素顶 ${fit.pixTop}px > 面板下沿 ${fit.safeTopPx.toFixed(1)}px（余量 ${(fit.pixTop - fit.safeTopPx).toFixed(1)}px）`);
  /* 尺寸判据改用**最高伸展**（脚→指尖）而不是站姿高度：
   * 布局现在按"脚底→指尖"分配空间（REACH_UP），站姿必然只占 ~82%，
   * 拿站姿当基准就变成"既要求不溢出、又要求站姿占满"，自相矛盾。
   * 过顶伸展实测 ≈ 94%（= 1 − 2×SAFE_INSET），既能抓"缩成小不点"、也能抓"溢出"。 */
  check("⑧ 角色最高伸展（脚→指尖）占安全区 85%~100%（既没缩成小不点、也没溢出）",
    fillOf(fit.overhead) > 0.85 && fillOf(fit.overhead) <= 1.0,
    "过顶占比=" + (fillOf(fit.overhead) * 100).toFixed(1) + "%  站姿占比=" + (fillOf(fit.stand) * 100).toFixed(1) + "%");

  /* ---------------- 9. 伸直输入 ⇒ 模型必须也伸直（真机反馈引入）----------------
   * 孩子原话：「我手臂与腿是直的时候他的动作是弯的，也就是说我双臂平举时他虽然也是
   * 举起双臂，但是双臂都向下弯折；腿也是我直着站立，它腿向外弯」。
   *
   * ★ 为什么之前 51 条断言全绿却抓不到它：**所有老夹具没有一个是"严格伸直"的** ——
   *   `armUp/armSpread`（抬 30°）、`armsOverhead`（竖直上举）、`deepKnee`/`squat`、
   *   `legsApart`（分腿），全都是"已经弯着"的姿势。而"伸直"恰恰是两段 IK 最容易坏的
   *   状态：近伸直处 A = acos(d/(2L)) 对距离误差是**开平方放大**的（`acos(1−ε) ≈ √(2ε)`），
   *   0.5% 的比例差就能变成 12° 的弯曲。**没有"伸直"的夹具 ⇒ 这条路径从没被验过。**
   *
   * 三条正向断言 + 一条**反向**断言（防「一律伸直」的过修）
   * + 一条**已知局限标记**（`squat` 的脚穿地，见下）。 */
  console.log("\n== 9. 伸直输入 ⇒ 模型必须也伸直（防「我伸直、它弯折」）==");
  const straight = await page.evaluate((armPose, legPose, deepPose, squatPose) => {
    const M = window.MotionAvatar;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const len = v => Math.hypot(v[0], v[1], v[2]);
    const bend = (s, a, b, c) => {
      if (!s[a] || !s[b] || !s[c]) return null;
      const u = sub(s[a], s[b]), v = sub(s[c], s[b]);
      const lu = len(u), lv = len(v);
      if (!(lu > 1e-9) || !(lv > 1e-9)) return null;
      const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
      return 180 - Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const go = pose => {
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(pose);   // 让低通收敛
      M.__renderNow();
      return M.__poseSnapshot();
    };
    const pair = s => ({
      elbowR: bend(s, "RightArm", "RightForeArm", "RightHand"),
      elbowL: bend(s, "LeftArm", "LeftForeArm", "LeftHand"),
      kneeR: bend(s, "RightUpLeg", "RightLeg", "RightFoot"),
      kneeL: bend(s, "LeftUpLeg", "LeftLeg", "LeftFoot")
    });
    /* squat 额外要量**脚相对引擎踝目标沉下去多少**。
     * ⚠️ 世界 y **向上** ⇒ "脚比目标低"是负值；这里直接取**下沉量**（正 = 穿地），
     *    免得符号把诊断带偏。
     * 用 `__rawWorld(pose, "ankleL")` 拿引擎目标（引擎 L 链 ↔ 模型右腿，交叉映射）。 */
    const sqSnap = go(squatPose);
    const sqTgt = M.__rawWorld(squatPose, "ankleL");
    const sqFoot = sqSnap.RightFoot;
    return {
      arm: pair(go(armPose)), leg: pair(go(legPose)), stand: pair(go(null)), deep: pair(go(deepPose)),
      squat: pair(sqSnap),
      squatSink: (sqTgt && sqFoot) ? +(sqTgt[1] - sqFoot[1]).toFixed(4) : null
    };
  }, F.armsStraight(), F.legsStraight(), F.deepKnee(), F.squat());

  const show4 = p => `肘R=${p.elbowR == null ? "—" : p.elbowR.toFixed(1)}° 肘L=${p.elbowL == null ? "—" : p.elbowL.toFixed(1)}° ` +
    `膝R=${p.kneeR == null ? "—" : p.kneeR.toFixed(1)}° 膝L=${p.kneeL == null ? "—" : p.kneeL.toFixed(1)}°`;
  /* ⚠️ `null < 2` 是 **true** —— 所以"量不到"会被当成"达标"。
   * 凡"必须小于某阈值"的判据都要先确认四个量**都拿到了**。 */
  const allUnder = (p, thr) =>
    [p.elbowR, p.elbowL, p.kneeR, p.kneeL].every(v => v != null && v < thr);
  const pairUnder = (p, a, b, thr) =>
    [p[a], p[b]].every(v => v != null && v < thr);
  /* 阈值 2°：残下的只有"骨轴 vs 子关节连线"那 ≤5° 的静态偏差里可忽略的一小部分。
   * 修之前这里是 11.9°（肘）/ 11.8°（膝），一眼就能看出是弯的。 */
  check("⑨ 双臂**严格水平共线**平举 ⇒ 模型肘弯曲 < 2°（「我伸直它却向下弯折」的正向判据）",
    allUnder(straight.arm, 2), show4(straight.arm));
  check("⑨ 双腿**严格竖直共线** ⇒ 模型膝弯曲 < 2°（「我直着站它腿向外弯」的正向判据）",
    allUnder(straight.leg, 2), show4(straight.leg));
  check("⑨ IDLE 站姿（没识别到人时的姿势）四肢也必须伸直",
    allUnder(straight.stand, 2), show4(straight.stand));
  /* ★ 反向断言：防"一律伸直"的过修 —— 深蹲时膝盖**必须真的弯**。
   * 这条比正向三条更重要：把 IK 改成"永远伸直"也能让上面三条变绿，但那是把角色改成了木偶。 */
  check("⑨ 反向：深蹲时膝盖**必须真的弯**（防「一律伸直」的过修）",
    straight.deep.kneeR != null && straight.deep.kneeL != null &&
    straight.deep.kneeR > 20 && straight.deep.kneeL > 20,
    show4(straight.deep));

  /* ★ **已知局限标记**（不是"期望的行为"，是"当前 2D 传感器的能力边界"）——
   *   `squat` 是"膝盖朝相机方向走"的正面下蹲：2D 投影里膝仍落在髋-踝连线上，
   *   引擎报的内角 ≈180° ⇒ 纯角度法给 d = L1+L2 ⇒ 腿伸得笔直，而髋跟着引擎下沉了
   *   ⇒ **脚落到地面线以下**（沉入量 ≈ Δy_hip × (1 − off/span)）。
   *   ⚠️ 曾经用"跨帧伸直参考"(`IK_REF`) 补过这一块，合成夹具上完全成功
   *     （下蹲膝弯 60.3°、踝误差 0.0016），但**真实照片上被否决**：
   *     关键点抖动 σ 最大 0.0052~0.0065，而"取最大值当参考"天然偏高 ⇒ 一张绝对伸直的真人
   *     照片报出最多 **24.0°** 的幻影弯曲 —— 正是本条要修的 bug。
   *     ⇒ 整段回退（见 `motion-avatar.js` 文件头第 16 条）。
   *   这条断言的作用是**把这个盲区钉住**：它现在是"通过"的（膝保持伸直），
   *   但消息里带上了脚沉下去多少 —— 哪天有人真的解决了前后方向缩短，
   *   这条会变红，逼他回来把这里和文件头第 16 条一起改掉，而不是悄悄放过。 */
  check("⑨ 已知局限（非期望行为）：正面下蹲对 2D 引擎不可见 ⇒ 腿保持伸直、脚会下沉",
    pairUnder(straight.squat, "kneeR", "kneeL", 2) && straight.squatSink != null && straight.squatSink > 0.02,
    `膝R=${straight.squat.kneeR == null ? "—" : straight.squat.kneeR.toFixed(1)}° ` +
    `膝L=${straight.squat.kneeL == null ? "—" : straight.squat.kneeL.toFixed(1)}° ` +
    `脚下沉 ${straight.squatSink == null ? "—" : straight.squatSink.toFixed(4)}（正=穿地；这是 2D 传感器的原理性盲区）`);

  check("全程没有 JS 报错", errors.length === 0, errors.join(" | ") || "无");

  await browser.close();
  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(__dirname, "_accept-human-glb.json"),
    JSON.stringify({ total: results.length, failed: failed.length, results, perf, fit }, null, 2), "utf8");
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { failed.forEach(f => console.log("  FAIL:", f.name, f.detail || "")); process.exit(1); }
})().catch(e => { console.error("FATAL", e); process.exit(2); });
