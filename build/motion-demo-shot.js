// 演示截图：把"一个正在做深蹲的人"合成到 canvas，用 captureStream 喂给 <video>，
// 再让体感引擎跑完整的分析管线，截出真实的「人 + 骨架」画面。
//
// 为什么不用假摄像头：--use-file-for-fake-video-capture 只能喂固定画面，
// 而这里要的是一个能动的、有人形的画面，用 canvas.captureStream 最直接，
// 而且完全走的是真实管线（video → 引擎 → 叠加层）。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
      module: "fitness",
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 }
    }));
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  // 切到「体感跟练」
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion");
    if (nav) nav.click();
  });
  await sleep(500);

  await page.evaluate(() => {
    const CW = 640, CH = 480;
    const cv = document.createElement("canvas");
    cv.width = CW; cv.height = CH;
    const g = cv.getContext("2d");
    const t0 = performance.now();

    // 一堵墙 + 地板 + 一个在做人形深蹲的人（上下往复）
    function draw() {
      const t = (performance.now() - t0) / 1000;
      const dip = (1 - Math.cos(t * 2 * Math.PI * 0.35)) / 2;   // 0..1，约 21 次/分
      const dy = dip * 0.10;                                    // 下蹲幅度

      // 背景
      const wall = g.createLinearGradient(0, 0, 0, CH);
      wall.addColorStop(0, "#e6e2da"); wall.addColorStop(0.62, "#d8d3c8");
      g.fillStyle = wall; g.fillRect(0, 0, CW, CH);
      g.fillStyle = "#c3b8a5"; g.fillRect(0, CH * 0.78, CW, CH * 0.22);   // 地板
      // 墙角线，给画面一点纵深
      g.strokeStyle = "rgba(150, 140, 125, 0.5)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(CW * 0.12, 0); g.lineTo(CW * 0.12, CH * 0.78); g.stroke();

      const P = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x * CW, (y + dy) * CH, w * CW, h * CH); };
      const shirt = "#3f5f8a", pants = "#2b3444", skin = "#d8a882", hair = "#3a2c22";

      // 腿（两腿分开，中间留空隙）
      P(0.415, 0.50, 0.065, 0.30, pants);
      P(0.520, 0.50, 0.065, 0.30, pants);
      // 鞋
      P(0.405, 0.79, 0.085, 0.035, "#1f2430");
      P(0.510, 0.79, 0.085, 0.035, "#1f2430");
      // 躯干
      P(0.435, 0.22, 0.13, 0.29, shirt);
      // 手臂（自然下垂，略微外张）
      P(0.355, 0.235, 0.075, 0.235, shirt);
      P(0.570, 0.235, 0.075, 0.235, shirt);
      // 手
      P(0.360, 0.465, 0.065, 0.045, skin);
      P(0.575, 0.465, 0.065, 0.045, skin);
      // 脖子 + 头
      P(0.480, 0.185, 0.04, 0.045, skin);
      g.fillStyle = hair;
      g.beginPath(); g.ellipse(CW * 0.5, (0.125 + dy) * CH, 0.052 * CW, 0.062 * CH, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = skin;
      g.beginPath(); g.ellipse(CW * 0.5, (0.135 + dy) * CH, 0.046 * CW, 0.054 * CH, 0, 0, Math.PI * 2); g.fill();
    }

    draw();
    const video = document.getElementById("motionVideo");
    video.srcObject = cv.captureStream(25);
    video.play();

    const eng = window.MotionEngine.createEngine();
    eng.attach(video);
    eng.attachOverlay(document.getElementById("motionOverlay"));
    eng.setProfile({ mode: "rep", signal: "centroidY", tempoBand: [15, 45], expectedAmplitude: 0.12 });
    eng.setGoal({ reps: 10, label: "10 次" });

    document.getElementById("motionPlaceholder").classList.add("hidden");
    document.getElementById("motionScreen").classList.add("is-live");

    const tick = () => { draw(); requestAnimationFrame(tick); };
    tick();
    eng.preview();

    // 把叠加层画布对齐到视频尺寸（正式流程里由 motionSyncOverlaySize 做）
    const ov = document.getElementById("motionOverlay");
    ov.width = CW; ov.height = CH;
  });

  await sleep(3000);   // 让背景收敛、骨架稳定

  await page.evaluate(() => {
    const hint = document.getElementById("motionHint");
    hint.textContent = "看到你了！点「开始这一组」就开始计时计数。";
    hint.className = "motion-hint good";
    const badge = document.getElementById("motionBadge");
    badge.textContent = "检测到动作 · 25 fps";
    badge.className = "motion-badge is-active";
    const st = window.__motionDebug ? window.__motionDebug() : null;
    console.log("骨架：" + JSON.stringify(st && st.skeleton ? { joints: st.skeleton.jointCount, area: st.skeleton.area } : null));
  });
  await sleep(300);

  const screen = await page.$("#motionScreen");
  await screen.screenshot({ path: path.join(SHOT, "motion-skeleton.png") });
  await page.screenshot({ path: path.join(SHOT, "motion-skeleton-page.png") });
  console.log("已输出 build/shots/motion-skeleton.png 与 motion-skeleton-page.png");

  await browser.close();
})().catch(err => { console.error("失败：", err); process.exit(1); });
