/* 探针：**前后方向（朝向相机）的缩短**会不会被 IK 吃掉 —— 也就是"下蹲时脚会不会穿地"。
 *
 * ★ 本脚本现在是**盲区量化器**，不是修复验证器。
 *   它记录的是 motion-avatar.js 文件头第 16 条那个**已知、有界**的局限：
 *   纯角度法看不到"朝相机方向的缩短"。
 *
 * 背景：
 *   引擎是**纯 2D** 的（`rawWorld()` 里 `_v1.set(..., ..., 0)`，z 恒为 0）。
 *   一个真人**正面**下蹲时，膝盖是往**相机方向**走的 —— 在 2D 投影里膝盖仍然落在
 *   "髋→踝"连线上，于是引擎报出来的**关节内角 ≈ 180°（看着是直的）**，
 *   可"髋→踝"的**投影距离**却明显变短了。
 *
 *   这正是"纯角度法"（见 motion-avatar.js 文件头第 15 条）的盲区：
 *     · 旧写法 `d = |目标 − 模型根|`（位置法）能看出"变短了" ⇒ 膝盖会弯，脚不穿地；
 *     · 纯角度法在内角 180° 时给 d = L1+L2 ⇒ **腿伸直**，而模型的髋跟着引擎的髋
 *       下沉了 0.10 ⇒ **脚比目标低 0.10**（穿到地面线以下）。
 *
 *   ⚠️ 但"变短"**单帧分不开**两种原因：
 *     (a) 前后方向的缩短（下蹲/抬腿）—— 该弯；
 *     (b) 这孩子本来就比 Mixamo 模型矮一截 —— **不该弯**（那正是要修的 bug）。
 *
 *   ★ 曾按"时间"的思路修过一版（`IK_REF`），合成夹具上完全成功，但**在真实数据上
 *     被否决**（见 `build/_probe-real-jitter.js`：抖动让一张绝对伸直的真人照片
 *     报出最多 24.0° 的幻影弯曲）。整段已回退，本脚本保留下来**量化这个盲区**，
 *     作为"已知、有界局限"的证据。
 *
 * 判定标准与 `accept-human-glb.js` ⑦ 一致：**末端误差**（脚 vs 引擎踝目标）。
 *   · 竖直/2D 里真的弯的姿势 ⇒ 误差必须 ≈ 0（角度法管得住）；
 *   · 前后方向缩短的姿势（squat）⇒ 误差 ≈ 沉髋量 × (1 − off/span)，**已知会穿地**。
 *
 * 用法：node build/_probe-squat-foreshorten.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const VIEW = { width: 1280, height: 800 };
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 把一条腿的"髋→膝→踝→趾"整体按 k 缩放（相对髋），用来造"腿比模型短 k 倍的孩子"。
 * 真人腿长不随姿势变，所以这个缩放是**整条链一致**的 —— 它模拟的是"比例差"，
 * 不是"姿势不同"。
 * ★ 这组用例是**回归护栏**：纯角度法**必须**让它们保持 0° 弯 —— 一旦哪天有人又
 *   把"绝对距离"塞回 IK，腿短的孩子一站直就会弯（就是用户报的那个 bug）。 */
function scaleLegs(pose, k) {
  const o = F.clone(pose);
  [["L", "hipL"], ["R", "hipR"]].forEach(([s, hipKey]) => {
    const hip = o[hipKey];
    ["knee" + s, "shin" + s, "ankle" + s, "toe" + s].forEach(key => {
      if (!o[key]) return;
      o[key] = { x: hip.x + (o[key].x - hip.x) * k, y: hip.y + (o[key].y - hip.y) * k };
    });
  });
  return o;
}

/* 用例：[名字, 期望, 被测姿势]
 * 期望：straight = 必须 0° 弯（角度法的"能管住"区）；
 *       bend    = 必须真的弯（2D 里就能看出来）；
 *       blind   = **已知盲区**（前后方向缩短，角度法看不到 ⇒ 会伸直穿地）。 */
const CASES = [
  ["STAND 站姿（基准）", "straight", F.STAND],
  ["直腿 严格竖直（角度法必须 0° 弯）", "straight", F.legsStraight()],
  ["deepKnee 2D 里**真的弯**（角度法必须真的弯）", "bend", F.deepKnee()],
  ["★ squat 前后方向缩短（**已知盲区**：会伸直穿地）", "blind", F.squat()],
  ["★ 腿短 15% 的孩子：站直（必须 0° 弯）", "straight", scaleLegs(F.legsStraight(), 0.85)],
  ["★ 腿短 15% 的孩子：下蹲（同属盲区）", "blind", scaleLegs(F.squat(), 0.85)],
  ["★ 腿短 30% 的孩子：站直（必须 0° 弯）", "straight", scaleLegs(F.legsStraight(), 0.70)]
];

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-squat-" + process.pid + "-" + Date.now());
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

  const rows = await page.evaluate((cases) => {
    const M = window.MotionAvatar;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const len = v => Math.hypot(v[0], v[1], v[2]);
    const interior3 = (a, b, c) => {
      const u = sub(a, b), v = sub(c, b);
      const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v));
      return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const interior2 = (a, b, c) => {                 // 引擎侧（归一化 2D）
      if (!a || !b || !c) return null;
      const u = [a.x - b.x, a.y - b.y], v = [c.x - b.x, c.y - b.y];
      const lu = Math.hypot(...u), lv = Math.hypot(...v);
      if (!(lu > 1e-9) || !(lv > 1e-9)) return null;
      return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180 / Math.PI;
    };
    const seg2 = (a, b) => (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    const out = [];
    for (const [name, expect, pose] of cases) {
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(pose);
      M.__renderNow();
      const s = M.__poseSnapshot();
      const raw = k => M.__rawWorld(pose, k);
      const eng = k => pose[k];
      const r = { name, expect };
      /* —— 引擎侧 —— */
      r.engKneeIntL = interior2(eng("hipL"), eng("kneeL"), eng("ankleL"));
      r.engHipAnkleL = seg2(eng("hipL"), eng("ankleL"));
      /* —— 模型侧（⚠️ 交叉映射：引擎 *L ↔ 模型 Right*）—— */
      r.kneeBend = 180 - interior3(s.RightUpLeg, s.RightLeg, s.RightFoot);
      /* —— 末端误差（脚 vs 引擎踝目标）——
       * ⚠️ 世界 y **向上**，所以"脚比目标低"= `foot.y − tgt.y` 是**负**值。
       *   这里直接报**下沉量**（正 = 脚低于目标 = 穿地），免得符号把人绕晕。 */
      const tgt = raw("ankleL");
      const foot = s.RightFoot;
      r.sinkY = (tgt && foot) ? (tgt[1] - foot[1]) : null;
      r.ankleErr = (tgt && foot) ? len(sub(foot, tgt)) : null;
      out.push(r);
    }
    return out;
  }, CASES.map(([n, e, p]) => [n, e, p]));

  const f = (v, n) => v == null ? "—" : v.toFixed(n == null ? 4 : n);
  console.log("\n================ 引擎侧 vs 模型侧（腿，引擎 L 链 ↔ 模型右腿）================");
  console.log("用例".padEnd(44) + "引擎膝内角L 髋→踝(2D)  模型膝弯°");
  for (const r of rows) {
    console.log(r.name.padEnd(42) + " " +
      f(r.engKneeIntL, 1).padStart(10) + " " + f(r.engHipAnkleL, 4).padStart(9) + " " +
      f(r.kneeBend, 1).padStart(9));
  }
  console.log("\n================ ★ 末端误差（脚 vs 引擎踝目标）================");
  console.log("用例".padEnd(44) + "下沉量(正=穿地)  |Δ|(世界)");
  for (const r of rows) {
    console.log(r.name.padEnd(42) + " " +
      f(r.sinkY, 4).padStart(14) + " " + f(r.ankleErr, 4).padStart(9));
  }

  /* 判定：straight ⇒ 膝弯 ≈0°；bend ⇒ 膝弯明显 >0；blind ⇒ 已知会伸直穿地
   * ⚠️ `null`（骨骼取不到）**必须算失败** —— 否则 `null > 2` 为假、`null < 30` 也为假，
   *    整个用例静默通过（本项目栽过多次的"假 PASS"）。 */
  let bad = [];
  if (!rows.length) bad.push("没有任何用例结果（页面没起来？）");
  for (const r of rows) {
    if (r.kneeBend == null) { bad.push(`${r.name} 量不到膝弯（骨骼缺失）`); continue; }
    if (r.expect === "straight" && r.kneeBend > 2) bad.push(`${r.name} 期望伸直却弯 ${r.kneeBend.toFixed(1)}°`);
    if (r.expect === "bend" && r.kneeBend < 30) bad.push(`${r.name} 期望真弯却只 ${r.kneeBend.toFixed(1)}°`);
    /* 盲区用例要**真的量到下沉** —— 否则"已知盲区"这个说法本身就失效了
     * （说明夹具/链路变了，得回来重新看这一条）。 */
    if (r.expect === "blind" && !(r.sinkY > 0.02)) {
      bad.push(`${r.name} 标为盲区却没量到明显下沉（sinkY=${r.sinkY}）—— 盲区描述已失效，回来核对`);
    }
  }
  console.log("\n================ 判定 ================");
  console.log(bad.length === 0
    ? "PASS  角度法在「能管住」的姿势上全部达标；前后缩短的姿势按**已知盲区**处理（会伸直穿地）"
    : "FAIL  " + bad.join(" | "));

  /* 截图（R7：必须真的看一眼脚有没有踩到地面线以下） */
  await page.evaluate((p) => {
    for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(p);
    window.MotionAvatar.__renderNow();
  }, F.squat());
  await page.screenshot({ path: path.join(SHOTS, "squat-blindspot.png") });
  console.log("\n截图: build/shots/squat-blindspot.png  （盲区现场：脚会落到地面线以下）");

  await browser.close();
  process.exit(bad.length === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
