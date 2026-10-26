/* 诊断：**伸直输入 → 模型是不是也伸直**？
 *
 * 用户真机反馈（原话）：
 *   「我手臂与腿是直的时候他的动作是弯的，也就是说我双臂平举时他虽然也是举起双臂，
 *     但是双臂都向下弯折；腿也是我直着站立，它腿向外弯」
 *
 * 本脚本把两种可能分开：
 *   (A) 产品 IK 有 bug（喂**几何上严格伸直**的输入也会弯）
 *   (B) 输入有偏差（引擎给的关节几何与模型骨架不匹配 → IK 只好弯着去够）
 *
 * 重点量一个**现有断言从没量过的量**：
 *   IK 的根用的是**模型自己的肩/髋关节**（`RightArm` / `RightUpLeg` 的世界位置），
 *   而 `__ikError()` 只核对**肘/腕、膝/踝**，从不核对**肩/髋**。
 *   一旦模型肩关节与引擎给的肩目标错位，d = |腕目标 − 模型肩| 就不等于引擎臂长，
 *   IK 只能靠**弯肘**去补 —— 而这条路径**没有任何断言覆盖**。
 *
 * 用法：node build/_diag-straight.js
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

/* ---------- 夹具：几何上**严格伸直**的输入 ---------- */
const U = 0.1265, FA = 0.1288, HND = 0.0874;      // 归一化骨长（= 模型实测）
const TH = 0.2017, SH = 0.2019;

/* 双臂**严格水平共线**平举（肩-肘-腕-手 全在一条水平线上，长度 = 模型骨长）。
 * k = 整体缩放：<1 表示"引擎给的臂比模型短"（关键点偏差的等效形式）。
 * drop = 肘关键点在图像里额外下移（归一化，y 向下为正）。 */
function straightArms(k, drop) {
  const o = F.clone(F.STAND);
  k = (k == null) ? 1 : k; drop = drop || 0;
  [["engineL", "shoulderL", -1], ["engineR", "shoulderR", 1]].forEach(([side, shKey, s]) => {
    const sh = o[shKey];
    const e = { x: sh.x + s * U * k, y: sh.y + drop };
    const w = { x: e.x + s * FA * k, y: e.y };
    const h = { x: w.x + s * HND * k, y: w.y };
    const kk = F.ARM_KEYS[side];
    o[kk[1]] = { x: (sh.x + e.x) / 2, y: (sh.y + e.y) / 2 };
    o[kk[2]] = e;
    o[kk[3]] = { x: (e.x + w.x) / 2, y: (e.y + w.y) / 2 };
    o[kk[4]] = w;
    o[kk[5]] = h;
  });
  return o;
}

/* 双腿**严格竖直共线**（髋-膝-踝 一条竖线）。k = 缩放；out = 膝关键点额外外移。 */
function straightLegs(k, out) {
  const o = F.clone(F.STAND);
  k = (k == null) ? 1 : k; out = out || 0;
  [["engineL", -1], ["engineR", 1]].forEach(([side, s]) => {
    const kk = F.LEG_KEYS[side];
    const hip = o[kk[0]];
    const kn = { x: hip.x + s * out, y: hip.y + TH * k };
    const an = { x: kn.x, y: kn.y + SH * k };
    o[kk[1]] = kn;
    o[kk[2]] = { x: kn.x, y: (kn.y + an.y) / 2 };
    o[kk[3]] = an;
    o[kk[4]] = { x: an.x, y: an.y + 0.04 };
  });
  return o;
}

const CASES = [
  ["STAND（= IDLE，手臂下垂 / 腿本来就是直的）", null],
  ["平举 严格共线 k=1.00", straightArms(1.00, 0)],
  ["平举 共线但短 5%  k=0.95", straightArms(0.95, 0)],
  ["平举 共线但短 10% k=0.90", straightArms(0.90, 0)],
  ["平举 共线但长 5%  k=1.05", straightArms(1.05, 0)],
  ["平举 肘关键点下移 0.02", straightArms(1.00, 0.02)],
  ["平举 肘关键点下移 0.05", straightArms(1.00, 0.05)],
  ["直腿 严格竖直 k=1.00", straightLegs(1.00, 0)],
  ["直腿 竖直但短 5%  k=0.95", straightLegs(0.95, 0)],
  ["直腿 竖直但短 10% k=0.90", straightLegs(0.90, 0)],
  ["直腿 膝关键点外移 0.02", straightLegs(1.00, 0.02)],
  ["直腿 膝关键点外移 0.05", straightLegs(1.00, 0.05)]
];

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-diag-" + process.pid + "-" + Date.now());
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
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    /* 内角（度）：a-b-c 在 b 处的夹角。伸直 = 180° */
    const interior = (a, b, c) => {
      const u = sub(a, b), v = sub(c, b);
      const d = dot(u, v) / (len(u) * len(v));
      return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const out = [];
    for (const [name, pose] of cases) {
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(pose);
      M.__renderNow();
      const s = M.__poseSnapshot();
      const j = pose;
      const raw = k => (j ? M.__rawWorld(j, k) : M.__rawWorld(null, k));
      const bone = k => { const v = M.__boneWorld(k); return v ? [v.x, v.y, v.z] : null; };

      const r = {
        name,
        // —— 手臂 ——
        elbowInt: interior(s.RightArm, s.RightForeArm, s.RightHand),
        armD: null, armL: null,
        shTarget: raw("shoulderL"), shModel: bone("RightArm"),
        wrTarget: raw("wristL"),
        elbowPole: raw("elbowL"),
        // —— 腿 ——
        kneeInt: interior(s.RightUpLeg, s.RightLeg, s.RightFoot),
        hipTarget: raw("hipL"), hipModel: bone("RightUpLeg"),
        anTarget: raw("ankleL"),
        kneePole: raw("kneeL"),
        // —— 引擎自报误差（不含肩/髋！）——
        ikErr: M.__ikError(),
        span: null
      };
      // d vs 模型骨长
      if (s.RightArm && s.RightForeArm && s.RightHand) {
        r.armL = len(sub(s.RightArm, s.RightForeArm)) + len(sub(s.RightForeArm, s.RightHand));
        if (r.wrTarget) r.armD = len(sub(r.wrTarget, s.RightArm));
      }
      if (s.RightUpLeg && s.RightLeg && s.RightFoot) {
        r.legL = len(sub(s.RightUpLeg, s.RightLeg)) + len(sub(s.RightLeg, s.RightFoot));
        if (r.anTarget) r.legD = len(sub(r.anTarget, s.RightUpLeg));
      }
      out.push(r);
    }
    return out;
  }, CASES.map(c => [c[0], c[1]]));

  const f = (v, n) => v == null ? "—" : v.toFixed(n == null ? 4 : n);
  const v3 = v => v == null ? "—" : "(" + v.map(x => x.toFixed(3)).join(",") + ")";
  const bend = a => (180 - a);

  console.log("\n================ 手臂（伸直 ⇒ 弯曲角 0°）================");
  console.log("用例".padEnd(34) + "肘弯曲°  d/(L1+L2)  肩目标→模型肩偏移");
  for (const r of rows) {
    const off = (r.shTarget && r.shModel) ? v3([r.shTarget[0] - r.shModel[0], r.shTarget[1] - r.shModel[1], r.shTarget[2] - r.shModel[2]]) : "—";
    const ratio = (r.armD && r.armL) ? (r.armD / r.armL).toFixed(4) : "—";
    console.log(r.name.padEnd(32) + " " + f(bend(r.elbowInt), 1).padStart(6) + "   " + ratio.padStart(9) + "   " + off);
  }

  console.log("\n================ 腿（伸直 ⇒ 弯曲角 0°）================");
  console.log("用例".padEnd(34) + "膝弯曲°  d/(L1+L2)  髋目标→模型髋偏移");
  for (const r of rows) {
    const off = (r.hipTarget && r.hipModel) ? v3([r.hipTarget[0] - r.hipModel[0], r.hipTarget[1] - r.hipModel[1], r.hipTarget[2] - r.hipModel[2]]) : "—";
    const ratio = (r.legD && r.legL) ? (r.legD / r.legL).toFixed(4) : "—";
    console.log(r.name.padEnd(32) + " " + f(bend(r.kneeInt), 1).padStart(6) + "   " + ratio.padStart(9) + "   " + off);
  }

  console.log("\n================ pole 与 u 的夹角（≈0° ⇒ 退化分支）================");
  for (const r of rows) {
    const ang = (root, pole, tgt) => {
      if (!root || !pole || !tgt) return null;
      const u = [tgt[0] - root[0], tgt[1] - root[1], tgt[2] - root[2]];
      const p = [pole[0] - root[0], pole[1] - root[1], pole[2] - root[2]];
      const lu = Math.hypot(...u), lp = Math.hypot(...p);
      if (!lu || !lp) return null;
      const d = (u[0] * p[0] + u[1] * p[1] + u[2] * p[2]) / (lu * lp);
      return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    };
    const a1 = ang(r.shModel, r.elbowPole, r.wrTarget);
    const a2 = ang(r.hipModel, r.kneePole, r.anTarget);
    console.log(r.name.padEnd(32) + " 肘 " + (a1 == null ? "—" : a1.toFixed(1).padStart(5)) +
      "°   膝 " + (a2 == null ? "—" : a2.toFixed(1).padStart(5)) + "°");
  }

  /* 截图：严格共线平举 + 严格竖直直腿 —— R7，必须真的看一眼。
   * ⚠️ 全身图里角色只有 300px 高，3° 的差别**看不出来**，所以再出**局部放大**：
   *    把 viewport 的 deviceScaleFactor 提到 3 再 clip —— 输出就是 3 倍分辨率的局部图。 */
  await page.setViewport({ width: VIEW.width, height: VIEW.height, deviceScaleFactor: 3 });
  for (const [tag, pose, clip] of [
    ["straight-arm", straightArms(1, 0), { x: 380, y: 310, width: 520, height: 140 }],
    ["straight-leg", straightLegs(1, 0), { x: 460, y: 350, width: 360, height: 260 }]
  ]) {
    await page.evaluate((p) => {
      for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(p);
      window.MotionAvatar.__renderNow();
    }, pose);
    await page.screenshot({ path: path.join(SHOTS, "diag-" + tag + ".png") });
    await page.screenshot({ path: path.join(SHOTS, "zoom-" + tag + ".png"), clip });
  }
  await page.setViewport(VIEW);
  console.log("\n截图: build/shots/diag-straight-*.png（全身）+ zoom-straight-*.png（局部放大 3x）");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
