/* IK 效果验证：手脚**实际位置**与引擎目标的偏差，IK 开 vs 关。
 *
 * 背景：孩子反馈"新模型腿部感应不如之前，看不到膝下动作、手臂僵硬"。
 * 已查明**不是数据缺失**（真实 MediaPipe 关键点腿部可见率 100%），
 * 而是 **aim-only 的固有限制**：只对齐方向、骨长固定 → 膝/肘落在
 * "起点+骨长×方向"上，与目标位置有偏差且逐段累积 → 脚/手到不了位。
 * 旧模型用 `mesh.scale.y = 长度` 直接摆到两个关节之间，所以精确到位。
 *
 * 本脚本量的是**误差本身**（不是"有没有动"，那个之前量过都没问题）：
 *   err = |骨骼末端实际世界位置 − 引擎给出的目标关节位置|
 * 用真实的 MediaPipe 关键点序列（build/_tmp/_lm.json）逐帧喂，统计误差分位数。
 *
 * 用法：NODE_PATH=... node build/_dbg-cat-ik.js
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

/* MediaPipe 33 点索引 → 引擎关节名。
 * ⚠️ 沿用 pose-vision.js 的**交叉**映射（引擎 L = 图像 x 较小侧）。 */
const MP2ENG = {
  kneeL: 26, kneeR: 25,      // 交叉
  ankleL: 28, ankleR: 27,
  toeL: 32, toeR: 31,
  hipL: 24, hipR: 23,
  shoulderL: 12, shoulderR: 11,
  elbowL: 14, elbowR: 13,
  wristL: 16, wristR: 15,
  head: 0, neck: 11
};

const L = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

/* 把一帧 33 点转成引擎关节字典（归一化 0~1，与引擎同一口径） */
function frameToJoints(f) {
  const j = {};
  Object.keys(MP2ENG).forEach(k => {
    const i = MP2ENG[k];
    const p = f[i];
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) j[k] = { x: p[0], y: p[1] };
  });
  if (j.hipL && j.hipR) j.hipMid = { x: (j.hipL.x + j.hipR.x) / 2, y: (j.hipL.y + j.hipR.y) / 2 };
  if (j.shoulderL && j.shoulderR) j.neck = { x: (j.shoulderL.x + j.shoulderR.x) / 2, y: (j.shoulderL.y + j.shoulderR.y) / 2 };
  // 中间关节（引擎在主链路下会算，这里按定义补上）
  const mid = (a, b) => (j[a] && j[b]) ? { x: (j[a].x + j[b].x) / 2, y: (j[a].y + j[b].y) / 2 } : null;
  const set = (n, v) => { if (v) j[n] = v; };
  set("shinL", mid("kneeL", "ankleL")); set("shinR", mid("kneeR", "ankleR"));
  set("midL", mid("shoulderL", "elbowL")); set("midR", mid("shoulderR", "elbowR"));
  set("foreL", mid("elbowL", "wristL")); set("foreR", mid("elbowR", "wristR"));
  return j;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-catik-" + process.pid + "-" + Date.now());
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

  const ACTS = ["jumpingJacks", "highKnees", "jumpRope", "squat"];
  console.log("用真实 MediaPipe 关键点序列喂猫，量「末端实际位置 − 引擎目标位置」的误差\n");

  for (const act of ACTS) {
    const a = L.acts[act];
    if (!a) continue;
    const frames = (a.frames || a).filter(f => f && f.length);
    // 取 40 帧均匀采样（每帧都要跑页面内 50 次收敛太慢）
    const step = Math.max(1, Math.floor(frames.length / 40));
    const jointsList = [];
    for (let i = 0; i < frames.length; i += step) {
      const j = frameToJoints(frames[i]);
      if (j.kneeL || j.kneeR) jointsList.push(j);
    }

    const res = await page.evaluate((list) => {
      const M = window.MotionAvatar;
      // 目标位置：用猫自己的坐标换算（和 __boneWorld 同一空间）——
      // 直接比较"骨骼末端"与"该关节应到的世界位置"需要同一套换算，
      // 所以这里让页面把目标位置也吐出来（复用产品里的换算 = jointTarget）。
      const samples = [];
      for (const j of list) {
        for (let k = 0; k < 30; k++) M.updateFromSkeleton(j);
        M.__renderNow();
        const probe = M.__ikError ? M.__ikError() : null;
        if (probe) samples.push(probe);
      }
      return samples;
    }, jointsList);

    if (!res || !res.length || res[0] == null) {
      console.log(act.padEnd(14) + "  （还没接 __ikError 探针）");
      continue;
    }
    const keys = Object.keys(res[0]);
    const stat = {};
    keys.forEach(k => {
      const v = res.map(s => s[k]).filter(x => Number.isFinite(x));
      v.sort((x, y) => x - y);
      stat[k] = { p50: v[Math.floor(v.length * 0.5)] || 0, p90: v[Math.floor(v.length * 0.9)] || 0, max: v[v.length - 1] || 0 };
    });
    console.log(act + "  (" + res.length + " 帧)");
    keys.forEach(k => console.log("    " + k.padEnd(12) + " 中位=" + stat[k].p50.toFixed(4) + "  p90=" + stat[k].p90.toFixed(4) + "  最大=" + stat[k].max.toFixed(4)));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
