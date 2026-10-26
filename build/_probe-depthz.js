/* 探针：**深度 → 关节 z** 这条新链路的密闭验收（不需要真人、不需要真桥）。
 *
 * 为什么要密闭（R9）
 * -----------------
 * 这条链路最终能不能用，取决于"深度帧的 (x,y) 与彩色画面的 (x,y) 对齐"（D2C），
 * 而这件事**只能真人上场验**（R2）。但下面三件事必须在密闭环境里先验清楚，
 * 否则真机出问题时根本分不清是"公式错"还是"相机没对齐"：
 *   ① 单位换算对不对（300mm 的前后位移，换算成归一化 z 是不是 300×span/1350）
 *   ② 方向对不对（手比髋近 ⇒ z 为负；角色世界 z 朝相机为正）
 *   ③ **安全闸门**在不在（registered=false 时一律不给 z —— 未对齐的深度
 *      按 (x,y) 采样取到的是别的物理位置，给了 z 反而比没有更糟）
 *
 * 密闭的做法：**只替换外部设备，不替换内部模块**
 *   · Node 起一个真的 WebSocket 服务，按 openni-bridge.py 的协议发
 *     hello + 二进制帧（`registered` 字段可切换）
 *   · 页面里用**真的** `DepthLink.createLink()` 连它 —— 降采样、`sampleMM()`
 *     全部走真代码
 *   · 真的 `MotionEngine` + 真的 `MotionAvatar`
 *   · 只有"骨架源"是替身（真 MediaPipe 要真摄像头，且与本步无关）
 *
 * 用法：node build/_probe-depthz.js
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const WebSocket = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "ws"));
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
/* ⚠️ 必须带 `?depthZ=1`：2026-10-11 起深度 z 的**消费**被 `DEPTH_Z` 总开关默认关掉了
 * （真机反馈「缩成一团」，见 motion-avatar.js 里 DEPTH_Z 常量处的推导）。
 * 本探针要验的正是"深度算出的 z 真的到了角色身上"，所以要显式打开这条生产路径。
 * 反过来，"默认关"本身由 `build/_probe-z-bend.js` 断言守着。 */
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?depthZ=1";
const PORT = 47833;
const VIEW = { width: 1280, height: 800 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FW = 640, FH = 480;          // 源帧尺寸（与真桥一致）
const WALL_MM = 5000;
const BODY_MM = 2400;              // 躯干/腿的深度
const H_BODY_MM = 1350;            // 必须与 motion-engine.js 的常量一致

/* 合成姿势（归一化图像坐标，x 向右、y 向下）。
 * 关节名与 pose-vision.js 的输出一致；**左右按图像 x 分**（*L = 图像左侧）。 */
const POSE = {
  head: [0.50, 0.13], neck: [0.50, 0.22], torsoTop: [0.50, 0.28],
  shoulderL: [0.44, 0.25], shoulderR: [0.56, 0.25],
  midL: [0.405, 0.28], midR: [0.595, 0.28],
  elbowL: [0.37, 0.31], elbowR: [0.63, 0.31],
  foreL: [0.335, 0.31], foreR: [0.665, 0.31],
  wristL: [0.30, 0.31], wristR: [0.70, 0.31],
  handL: [0.27, 0.31], handR: [0.73, 0.31],
  hipMid: [0.50, 0.50], hipL: [0.46, 0.50], hipR: [0.54, 0.50],
  kneeL: [0.465, 0.72], kneeR: [0.535, 0.72],
  shinL: [0.465, 0.82], shinR: [0.535, 0.82],
  ankleL: [0.465, 0.92], ankleR: [0.535, 0.92],
  toeL: [0.465, 0.96], toeR: [0.535, 0.96]
};
/* 每个关节在深度图里占的圆盘半径（源像素）。躯干粗、四肢细。 */
const R_DISC = {
  head: 30, neck: 40, torsoTop: 42, shoulderL: 40, shoulderR: 40,
  hipMid: 45, hipL: 45, hipR: 45, kneeL: 38, kneeR: 38,
  shinL: 34, shinR: 34, ankleL: 30, ankleR: 30, toeL: 22, toeR: 22,
  midL: 26, midR: 26, elbowL: 26, elbowR: 26,
  foreL: 24, foreR: 24, wristL: 24, wristR: 24, handL: 22, handR: 22
};
/* 左右手臂的关节（这两个在深度图上会被单独刷成"手有多深"）。 */
const ARM_L = ["midL", "elbowL", "foreL", "wristL", "handL"];
const ARM_R = ["midR", "elbowR", "foreR", "wristR", "handR"];

let armLmm = BODY_MM;      // 左手链深度（被测对象）
let armRmm = BODY_MM;      // 右手链深度（对照组）
let registered = true;

/* 把"姿势 + 两条手臂的深度"画成 640×480 的 uint16 深度图。
 * 先铺墙，再刷躯干，最后刷两条手臂（后刷的覆盖先刷的）。 */
function buildFrame() {
  const buf = new Uint16Array(FW * FH).fill(WALL_MM);
  const disc = (x, y, r, mm) => {
    const cx = Math.round(x * FW), cy = Math.round(y * FH);
    const x0 = Math.max(0, cx - r), x1 = Math.min(FW - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(FH - 1, cy + r);
    const r2 = r * r;
    for (let yy = y0; yy <= y1; yy++) {
      const dy = yy - cy;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - cx;
        if (dx * dx + dy * dy <= r2) buf[yy * FW + xx] = mm;
      }
    }
  };
  // ① 躯干 + 腿（不含手臂）
  Object.keys(POSE).forEach(nm => {
    if (ARM_L.indexOf(nm) >= 0 || ARM_R.indexOf(nm) >= 0) return;
    disc(POSE[nm][0], POSE[nm][1], R_DISC[nm] || 30, BODY_MM);
  });
  // ② 两条手臂
  ARM_L.forEach(nm => disc(POSE[nm][0], POSE[nm][1], R_DISC[nm], armLmm));
  ARM_R.forEach(nm => disc(POSE[nm][0], POSE[nm][1], R_DISC[nm], armRmm));
  return buf;
}

/* openni-bridge.py 的二进制帧格式：6×uint32 头 + uint16 数据（小端） */
let frameIdx = 0;
function packFrame(buf) {
  const head = Buffer.alloc(24);
  let valid = 0, mn = 0, mx = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v > 0) { valid++; if (!mn || v < mn) mn = v; if (v > mx) mx = v; }
  }
  head.writeUInt32LE(FW, 0); head.writeUInt32LE(FH, 4);
  head.writeUInt32LE(++frameIdx, 8); head.writeUInt32LE(valid, 12);
  head.writeUInt32LE(mn, 16); head.writeUInt32LE(mx, 20);
  return Buffer.concat([head, Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)]);
}

/* 页面里的骨架源替身（契约与 pose-vision.js 的 poll() 一致）。 */
const VISION_FAKE = `(function(){
  const P = ${JSON.stringify(POSE)};
  const joints = {};
  Object.keys(P).forEach(k => { joints[k] = { x: P[k][0], y: P[k][1] }; });
  const bbox = { x: 0.236, y: 0.063, w: 0.528, h: 0.919 };
  return {
    poll: function () {
      return {
        ok: true, joints: joints, energy: {},
        bbox: bbox, area: bbox.w * bbox.h,
        centroidX: 0.5, centroidY: 0.5,
        width: bbox.w, height: bbox.h,
        top: bbox.y, bottom: bbox.y + bbox.h,
        bottomL: 0.96, bottomR: 0.96,
        visible: Object.keys(P).length
      };
    },
    stats: function () { return { ok: true }; }
  };
})()`;

const checks = [];
function check(name, ok, detail) {
  checks.push([name, !!ok]);
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  → " + detail : ""));
}

(async () => {
  // ---------- 1. 起协议层替身服务 ----------
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  const clients = [];
  let pushTimer = null;
  wss.on("connection", ws => {
    clients.push(ws);
    ws.on("close", () => { const i = clients.indexOf(ws); if (i >= 0) clients.splice(i, 1); });
    // hello：registered 字段就是要被测的"安全闸门"开关
    ws.send(JSON.stringify({
      type: "hello", device: "FakeAstra", serial: "TEST", width: FW, height: FH,
      fps: 15, registered: registered, note: "密闭测试"
    }));
  });
  function startPush() {
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = setInterval(() => {
      if (!clients.length) return;
      const pkt = packFrame(buildFrame());
      clients.forEach(ws => { if (ws.readyState === 1) ws.send(pkt); });
    }, 66);
  }
  startPush();
  await sleep(300);
  console.log("协议层替身已监听 ws://127.0.0.1:" + PORT);

  // ---------- 2. 开页面 ----------
  const profileDir = path.join(os.tmpdir(), "wbc-depthz-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport(VIEW);
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1000);

  // ---------- 3. 在页面里接线 ----------
  const wired = await page.evaluate((port, visionFake) => {
    const out = { ok: false, why: "" };
    if (!window.DepthLink) { out.why = "没有 DepthLink"; return out; }
    if (!window.MOTION_ENGINE_FOR_TEST && !window.MotionEngine) { /* 下面用 createEngine */ }
    const ME = window.MotionEngine;
    if (!ME) { out.why = "没有 MotionEngine"; return out; }

    // 画面源：静止画布（内容无关，骨架来自替身）
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, 640, 480);

    // ★ 真的 DepthLink，只是连到测试服务
    const link = window.DepthLink.createLink({
      url: "ws://127.0.0.1:" + port, width: 96, height: 72, autoReconnect: false
    });
    link.connect();
    window.__testLink = link;

    const eng = ME.createEngine();
    eng.attach(cv);
    eng.attachDepth(link);
    // eslint-disable-next-line no-eval
    eng.attachVision(eval(visionFake));
    eng.preview();
    window.__testEngine = eng;
    out.ok = true;
    return out;
  }, PORT, VISION_FAKE);
  if (!wired.ok) { console.log("接线失败：" + wired.why); await browser.close(); wss.close(); process.exit(1); }

  // 等深度真的连上并有帧
  let linkOk = false;
  for (let i = 0; i < 40; i++) {
    linkOk = await page.evaluate(() => {
      const s = window.__testLink.stats();
      return s.status === "open" && s.frameIndex > 2 && s.registered === true;
    });
    if (linkOk) break;
    await sleep(250);
  }
  const st = await page.evaluate(() => window.__testLink.stats());
  console.log("DepthLink 状态：" + JSON.stringify(st));
  check("真的 DepthLink 连上测试服务并收到帧", linkOk, "frameIndex=" + st.frameIndex);
  check("hello 的 registered=true 被 DepthLink 读进来", st.registered === true);

  // 等引擎分析过若干帧
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => (window.__testEngine.visionStats().frames || 0));
    if (n > 6) break;
    await sleep(200);
  }

  /* ---------- 4. 量一次：给定两条手臂深度，读关节 z + 角色世界 z ---------- */
  const measure = () => page.evaluate(() => {
    const eng = window.__testEngine;
    const vs = eng.visionStats();
    const sk = eng.getSkeleton();
    const j = sk.joints || {};
    const g = k => (j[k] && typeof j[k].z === "number") ? +j[k].z.toFixed(4) : null;
    const M = window.MotionAvatar;
    const rw = k => (M && M.__rawWorld) ? M.__rawWorld(j, k) : null;
    const wl = rw("wristL"), wr = rw("wristR");
    return {
      depthZ: !!vs.depthZ, has: !!sk.has,
      zWristL: g("wristL"), zWristR: g("wristR"), zHipMid: g("hipMid"),
      zElbowL: g("elbowL"), zAnkleL: g("ankleL"),
      worldWristL: wl, worldWristR: wr,
      jointCount: Object.keys(j).length
    };
  });

  const setArm = (l, r) => { armLmm = l; armRmm = r; };

  // span = bbox.h = 0.919（替身固定），换算系数 k = span / H_BODY_MM
  const SPAN = 0.919;
  const kZ = SPAN / H_BODY_MM;
  const expZ = dMM => dMM * kZ;      // 期望的归一化 z

  // ---- 场景 A：左手比躯干近 300mm ----
  setArm(BODY_MM - 300, BODY_MM);
  await sleep(900);
  let m = await measure();
  console.log("\n[场景 A] 左手近 300mm：" + JSON.stringify(m));
  check("引擎报 depthZ=true（z 是深度算出来的）", m.depthZ === true);
  check("关节表非空", m.jointCount >= 10, "count=" + m.jointCount);
  const aExp = expZ(-300);
  check("左手 z 为负（MediaPipe 口径：负 = 靠近）",
    m.zWristL !== null && m.zWristL < 0, "z=" + m.zWristL);
  check("左手 z 的**大小**符合 ΔD×span/H_BODY（期望 " + aExp.toFixed(4) + "）",
    m.zWristL !== null && Math.abs(m.zWristL - aExp) < 0.03,
    "实测 " + m.zWristL + " vs 期望 " + aExp.toFixed(4));
  check("对照组右手 z ≈ 0（同深度）",
    m.zWristR !== null && Math.abs(m.zWristR) < 0.01, "z=" + m.zWristR);
  check("角色的左手**朝相机**（世界 +z 变大）",
    m.worldWristL && m.worldWristL[2] > 0, "world z=" + (m.worldWristL && m.worldWristL[2]));

  // ---- 场景 B：左手比躯干远 300mm（方向必须反过来）----
  setArm(BODY_MM + 300, BODY_MM);
  await sleep(900);
  m = await measure();
  console.log("\n[场景 B] 左手远 300mm：" + JSON.stringify(m));
  const bExp = expZ(300);
  check("左手 z 变正（远离相机）", m.zWristL !== null && m.zWristL > 0, "z=" + m.zWristL);
  check("左手 z 的大小仍符合换算（期望 " + bExp.toFixed(4) + "）",
    m.zWristL !== null && Math.abs(m.zWristL - bExp) < 0.03,
    "实测 " + m.zWristL + " vs 期望 " + bExp.toFixed(4));
  check("角色的左手**远离相机**（世界 z 变负）",
    m.worldWristL && m.worldWristL[2] < 0, "world z=" + (m.worldWristL && m.worldWristL[2]));

  // ---- 场景 C：安全闸门 —— registered=false ----
  registered = false;
  const wsAll = clients.slice();
  wsAll.forEach(ws => { try { ws.close(); } catch (e) { /* ignore */ } });
  clients.length = 0;
  await sleep(1200);
  m = await measure();
  console.log("\n[场景 C] registered=false（未对齐）：" + JSON.stringify(m));
  check("★ 安全闸门：未对齐时 depthZ=false", m.depthZ === false);
  const allZero = ["zWristL", "zWristR", "zHipMid", "zElbowL", "zAnkleL"]
    .every(k => m[k] === 0 || m[k] === null);
  check("★ 未对齐时关节 z 全为 0（宁可退回纯 2D，也不用错位的深度）",
    allZero, JSON.stringify({ wl: m.zWristL, wr: m.zWristR, hip: m.zHipMid }));
  check("未对齐时角色世界 z 也回到 0",
    !m.worldWristL || m.worldWristL[2] === 0, "world z=" + (m.worldWristL && m.worldWristL[2]));

  // ---- 场景 D：恢复 registered=true，应重新给出 z ----
  registered = true;
  const wsNew = new WebSocket("ws://127.0.0.1:" + PORT);
  await new Promise(r => wsNew.on("open", r));
  // 让页面用新链接（旧的已关）
  await page.evaluate((port) => {
    const link = window.DepthLink.createLink({
      url: "ws://127.0.0.1:" + port, width: 96, height: 72, autoReconnect: false
    });
    link.connect();
    window.__testLink = link;
    window.__testEngine.attachDepth(link);
  }, PORT);
  setArm(BODY_MM - 300, BODY_MM);
  await sleep(1500);
  m = await measure();
  console.log("\n[场景 D] 恢复 registered=true：" + JSON.stringify(m));
  check("重新对齐后 depthZ 恢复为 true", m.depthZ === true);
  check("重新对齐后左手 z 又为负", m.zWristL !== null && m.zWristL < 0, "z=" + m.zWristL);

  // ---- 场景 E：深度断开 ⇒ 立刻退回纯 2D，不能崩 ----
  await page.evaluate(() => { window.__testLink.close(); window.__testEngine.attachDepth(null); });
  await sleep(700);
  m = await measure();
  console.log("\n[场景 E] 深度断开：" + JSON.stringify(m));
  check("断开后 depthZ=false", m.depthZ === false);
  check("断开后关节 z 全 0", m.zWristL === 0 && m.zWristR === 0);

  check("全程没有 JS 报错", errs.length === 0, errs.slice(0, 2).join(" | "));

  await browser.close();
  clearInterval(pushTimer);
  wss.close();
  try { wsNew.close(); } catch (e) { /* ignore */ }

  const pass = checks.filter(c => c[1]).length;
  console.log("\n===== " + pass + "/" + checks.length + " 通过 =====");
  checks.filter(c => !c[1]).forEach(c => console.log("  FAIL: " + c[0]));
  process.exit(pass === checks.length ? 0 : 1);
})().catch(e => { console.error("探针异常：", e); process.exit(2); });
