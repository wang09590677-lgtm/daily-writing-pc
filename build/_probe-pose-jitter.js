/* ==================================================================
 * _probe-pose-jitter.js — 姿态链路「静止也计数吗？」对照实验
 *
 * 为什么必须做
 *   幅度闸门是为**掩码链路**标定的。姿态链路（MediaPipe）的噪声性质完全不同：
 *   它不是背景差的像素量化噪声，而是**关键点抖动**（landmark jitter），
 *   且 bbox 取 33 点的 min/max，抖动会累积。
 *   如果静止人形的关键点抖动在 3.5s 窗内超过门限，孩子**站着不动也会被计数** ——
 *   这与"孩子跳了却不计数"是同一枚硬币的两面，都必须排除。
 *
 * 做法
 *   取一段真实动作视频的第一帧（真人、静止姿态）反复重放（画面完全不变），
 *   把该帧的 33 关键点反复喂给真实 PoseVision，给坐标叠加确定性抖动 j，
 *   跑真实 motion-engine.js 的姿态主链路，读 reps。
 *   扫描 j = 0 / 0.001 / 0.002 / 0.004 / 0.008 / 0.016（归一化坐标），
 *   看门限在多大的关键点抖动下仍能把静止挡成 0 次。
 *
 * 参照：MediaPipe Pose 的逐帧关键点抖动经验值约 0.002~0.006（归一化）。
 *
 * 只读生产代码。运行：node build/_probe-pose-jitter.js
 * ================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FR = path.join(__dirname, "_frames2");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 用真实动作视频里的一帧（真人姿态）作静止场景
const ACT = "jumpingJacks";
// 测两条 profile：大幅（开合跳 width ea=0.18）与**最小幅**（跳绳 width ea=0.045）
// 小幅度动作门限最低（0.045×0.5≈0.0225），是"抖动漏计数"最危险的那一端。
const PROFILES = {
  开合跳: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 },
  跳绳:   { mode: "rep", signal: "width", tempoBand: [20, 55], minRepGap: 0.7, expectedAmplitude: 0.045 }
};
const JS = [0, 0.001, 0.002, 0.004, 0.008, 0.016];

function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

(async () => {
  const files = fs.readdirSync(path.join(FR, ACT)).filter(f => /^f\d+\.jpg$/.test(f)).sort();
  const url = "file:///" + path.join(FR, ACT, files[0]).replace(/\\/g, "/");

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR", e.message));
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(600);

  // 拿一帧真人的 33 关键点
  const lm0 = await page.evaluate(async (url) => {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
    const cv = document.createElement("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    cv.getContext("2d").drawImage(im, 0, 0);
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
      smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    let cur = null; pose.onResults(r => { cur = (r && r.poseLandmarks) ? r.poseLandmarks : null; });
    await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 50));
    window.__IM = im;
    return cur ? cur.map(p => [p.x, p.y, (p.visibility === undefined || p.visibility === null) ? 1 : p.visibility]) : null;
  }, url).catch(e => { console.log("取关键点失败", e.message); return null; });

  if (!lm0) { console.log("未取到关键点，退出"); await browser.close(); return; }
  console.log("静止场景：真实帧", files[0], "关键点", lm0.length, "个");

  console.log("\n=== 姿态链路静止对照：给固定真人姿态叠加关键点抖动 j，读引擎计数 ===");
  const rows = [];
  for (const pname of Object.keys(PROFILES)) {
    const PROFILE = PROFILES[pname];
    console.log(`\n【${pname} · signal=${PROFILE.signal} · expectedAmplitude=${PROFILE.expectedAmplitude}】`);
    console.log(pad("j(归一化)", 12) + pad("计数/7s", 10) + pad("width 3.5s窗峰峰", 20) + pad("门限", 10) + pad("被挡帧", 12) + "结论");
    console.log("-".repeat(80));
    for (const j of JS) {
      const r = await page.evaluate(async (url, lm0, j, profile) => {
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
      const cv = document.createElement("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const g = cv.getContext("2d"); g.drawImage(im, 0, 0);

      // 确定性伪随机（每次 sweep 用不同种子，但同一次运行可复现）
      let seed = 1234567 + Math.round(j * 1e6);
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

      const eng = window.MotionEngine.createEngine();
      eng.attach(cv); eng.setProfile(profile);
      const pv = window.PoseVision.createPoseVision({ modelComplexity: 0, holdMs: 700 });
      eng.attachVision(pv);
      const samples = [];
      eng.onTick(st => samples.push({ w: st.live.width, cy: st.live.centroidY, src: st.live.visionSource,
        gate: st.repGate, spread: st.repSpread, reps: st.reps }));
      eng.start();
      const t0 = performance.now();
      const timer = setInterval(() => {
        // 画面恒定不变，只有关键点带抖动 → 完全隔离"关键点抖动"这一个变量
        g.drawImage(im, 0, 0, cv.width, cv.height);
        const lm = lm0.map(p => ({ x: p[0] + (rnd() - 0.5) * 2 * j, y: p[1] + (rnd() - 0.5) * 2 * j, visibility: p[2] }));
        pv.pushLandmarks(lm);
      }, 1000 / 24);
      await new Promise(r => setTimeout(r, 7000));
      clearInterval(timer); eng.stop();
      const st = eng.getState();
      const own = samples.filter(s => s.src === "pose" && isFinite(s.w) && s.w > 0);
      const ws = own.map(s => s.w);
      // 3.5s 窗（近似：60fps 引擎帧数）
      const winF = Math.round(60 * 3.5);
      let spreads = [];
      for (let i = winF - 1; i < ws.length; i++) { const seg = ws.slice(i - winF + 1, i + 1); spreads.push(Math.max(...seg) - Math.min(...seg)); }
      const spreadMed = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;
      const gs = own.filter(s => s.gate > 0);
      const gated = gs.filter(s => s.spread < s.gate).length;
      return { reps: st.reps, spreadMed: +spreadMed.toFixed(4),
        gate: gs.length ? +gs[gs.length - 1].gate.toFixed(4) : null, gated, total: gs.length,
        ownN: own.length, widthRange: ws.length ? +(Math.max(...ws) - Math.min(...ws)).toFixed(4) : 0 };
    }, url, lm0, j, PROFILE).catch(e => ({ err: String(e && e.message) }));

      rows.push({ profile: pname, j, ...r });
      console.log(pad(j, 12) + pad(r.reps, 10) + pad(`${r.spreadMed} (整段${r.widthRange})`, 20) +
        pad(r.gate, 10) + pad(`${r.gated}/${r.total}`, 12) + (r.reps === 0 ? "✓ 挡住（正确）" : "✗ 静止被计数！"));
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "_probe-pose-jitter.json"), JSON.stringify(rows, null, 2));
  console.log("\n结果已写入 build/_probe-pose-jitter.json");
})().catch(e => { console.error("崩溃", e); process.exit(2); });
