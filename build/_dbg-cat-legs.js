/* 实测：腿部与手臂骨骼到底有没有被驱动？（用户报"膝盖之下看不到动作、手臂僵硬"）
 *
 * 用户原话：
 *   「新的人形猫咪模型腿部感应不如之前的，做跑、跳的动作时基本看不到膝盖之下的动作，
 *     手臂也很僵硬不如之前那个模型动作流畅模拟到位」
 *
 * 要区分三件事：
 *   A. 引擎**掩码链路**不产 kneeL/ankleL/toeL（只有 MediaPipe 姿态链路才全）
 *      → 若真机走掩码链路，整条腿都没数据
 *   B. 即使有关节，我 segDir() 拿不到端点就返回 null → 该骨整根不驱动
 *   C. 新模型是 **aim-only（只对齐方向、不管骨长）**，旧模型是把骨段**直接摆到
 *      两个真实关节之间**（位置精确）→ 手/脚落不到目标位 → 看着"僵硬、不到位"
 *
 * 测量口径（重要，第一版测错过）：
 *   不能量"骨骼起点位置" —— 起点由父级链条决定，旋转一根骨头**不改自己的起点**。
 *   第一版就因此得出"几乎没动"的结论，其实是我姿势设计得太保守 + 量错了量。
 *   这里改成量**世界朝向**（子骨骼位置 − 自身位置，归一化）+ **末端位置**。
 *
 * 用法：NODE_PATH=... node build/_dbg-cat-legs.js
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

/* 大幅"高抬腿跑"：左膝抬到比髋还高、右腿后蹬，双臂大幅摆动。
 * 刻意做得夸张 —— 为了把"能不能动"和"动得对不对"分开：
 * 幅度太小的话两种实现都看不出差别。 */
const RUN = {
  head: { x: 0.50, y: 0.10 }, neck: { x: 0.50, y: 0.22 },
  shoulderL: { x: 0.43, y: 0.27 }, shoulderR: { x: 0.57, y: 0.27 },
  midL: { x: 0.44, y: 0.33 }, midR: { x: 0.56, y: 0.31 },
  elbowL: { x: 0.45, y: 0.39 }, elbowR: { x: 0.55, y: 0.35 },
  foreL: { x: 0.46, y: 0.43 }, foreR: { x: 0.56, y: 0.34 },
  wristL: { x: 0.47, y: 0.47 }, wristR: { x: 0.58, y: 0.31 },
  handL: { x: 0.48, y: 0.50 }, handR: { x: 0.59, y: 0.29 },
  hipMid: { x: 0.50, y: 0.56 }, hipL: { x: 0.46, y: 0.56 }, hipR: { x: 0.54, y: 0.56 },
  // 左腿：膝抬到比髋还高（0.50 < 0.56 表示更高），踝在膝下方
  kneeL: { x: 0.44, y: 0.50 }, ankleL: { x: 0.43, y: 0.62 }, toeL: { x: 0.43, y: 0.66 },
  // 右腿：后蹬，膝在髋下方、踝更靠后
  kneeR: { x: 0.57, y: 0.72 }, ankleR: { x: 0.60, y: 0.90 }, toeR: { x: 0.62, y: 0.94 }
};

/* 掩码链路：只有上半身 + 髋（没有 knee/ankle/toe） */
function stripLegs(o) {
  const c = JSON.parse(JSON.stringify(o));
  ["kneeL", "kneeR", "shinL", "shinR", "ankleL", "ankleR", "toeL", "toeR"].forEach(k => delete c[k]);
  return c;
}
/* 有膝、缺踝/趾（模拟 MediaPipe 对脚部 visibility 低被过滤） */
function stripFeet(o) {
  const c = JSON.parse(JSON.stringify(o));
  ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => delete c[k]);
  return c;
}

/* 页面内取"骨骼世界朝向"：用子骨骼位置 − 自身位置。
 * 没有子骨骼的末端骨骼（*Hand / *Foot）退化为"父→自身"。 */
const SNAP = `(function(names){
  const out = {};
  const b = window.MotionAvatar;
  names.forEach(n => {
    const w = b.__boneWorld(n);
    if (!w) { out[n] = null; return; }
    out[n] = { p: [+w.x.toFixed(4), +w.y.toFixed(4)], self: n };
  });
  return out;
})`;

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-catleg-" + process.pid + "-" + Date.now());
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
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (s && (s.ready || s.failed)) break;
    await sleep(400);
  }

  /* 在页面里直接算"每根骨骼的世界朝向 + 末端位置"，避免在 Node 侧拼数据出错 */
  const sample = joints => page.evaluate(j => {
    for (let i = 0; i < 50; i++) window.MotionAvatar.updateFromSkeleton(j);
    window.MotionAvatar.__renderNow();
    const PAIRS = {
      // 腿：每根骨骼 + 它的子端（用来算朝向）
      RightUpperLeg: "RightLowerLeg", RightLowerLeg: "RightFoot", RightFoot: null,
      LeftUpperLeg: "LeftLowerLeg", LeftLowerLeg: "LeftFoot", LeftFoot: null,
      RightUpperArm: "RightLowerArm", RightLowerArm: "RightHand", RightHand: null,
      LeftUpperArm: "LeftLowerArm", LeftLowerArm: "LeftHand", LeftHand: null
    };
    const out = {};
    Object.keys(PAIRS).forEach(n => {
      const a = window.MotionAvatar.__boneWorld(n);
      if (!a) { out[n] = null; return; }
      const kidName = PAIRS[n];
      const k = kidName ? window.MotionAvatar.__boneWorld(kidName) : null;
      let dir = null;
      if (k) {
        const dx = k.x - a.x, dy = k.y - a.y, len = Math.hypot(dx, dy);
        dir = len > 1e-6 ? [+(dx / len).toFixed(3), +(dy / len).toFixed(3)] : [0, 0];
      }
      out[n] = { x: +a.x.toFixed(4), y: +a.y.toFixed(4), dir, kid: kidName };
    });
    return out;
  }, joints);

  const IDLE = null;
  const idle = await sample(IDLE);
  const run = await sample(RUN);
  const noLegs = await sample(stripLegs(RUN));
  const noFeet = await sample(stripFeet(RUN));

  const angle = (d1, d2) => {
    if (!d1 || !d2) return null;
    const dot = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
    return +(Math.acos(dot) * 180 / Math.PI).toFixed(1);
  };
  const posDelta = (a, b) => (!a || !b) ? null : +Math.hypot(a.x - b.x, a.y - b.y).toFixed(4);

  function report(title, base, cur) {
    console.log("\n--- " + title + " ---");
    console.log("骨骼".padEnd(16) + "朝向变化(°)".padStart(12) + "位置位移".padStart(10) + "  末端");
    Object.keys(cur).forEach(n => {
      const a = angle(base[n] && base[n].dir, cur[n] && cur[n].dir);
      const d = posDelta(base[n], cur[n]);
      console.log(n.padEnd(16) + String(a == null ? "-" : a).padStart(12) + String(d == null ? "-" : d).padStart(10) +
        "  " + (cur[n] && cur[n].kid ? "→" + cur[n].kid : "（末端）"));
    });
  }

  console.log("================= 跑步（高抬腿）对比站姿 =================");
  report("腿部", idle, run);
  report("臂部", idle, run);

  console.log("\n================= 关节缺失时的退化行为 =================");
  report("掩码链路（无膝/踝/趾）", idle, noLegs);
  report("有膝但缺踝/趾", idle, noFeet);

  console.log("\n================= 判定 =================");
  const legKeys = ["RightLowerLeg", "LeftLowerLeg", "RightFoot", "LeftFoot"];
  const legAng = legKeys.map(k => angle(idle[k] && idle[k].dir, run[k] && run[k].dir)).filter(v => v != null);
  const legPos = legKeys.map(k => posDelta(idle[k], run[k])).filter(v => v != null);
  console.log("小腿/脚 朝向变化: " + legAng.join("° , ") + "°");
  console.log("小腿/脚 位置位移: " + legPos.join(" , "));
  console.log("");

  // 掩码链路下：大腿是否也完全不动？
  const upperAng = ["RightUpperLeg", "LeftUpperLeg"].map(k => angle(idle[k] && idle[k].dir, noLegs[k] && noLegs[k].dir));
  console.log("掩码链路下 大腿朝向变化: " + upperAng.join("° , ") + "°  ← 若为 0 说明**整条腿都不动**");
  const lowerAngAll = ["RightLowerLeg", "LeftLowerLeg", "RightFoot", "LeftFoot"].map(k => angle(idle[k] && idle[k].dir, noLegs[k] && noLegs[k].dir));
  console.log("掩码链路下 小腿/脚朝向变化: " + lowerAngAll.join("° , ") + "°");

  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
