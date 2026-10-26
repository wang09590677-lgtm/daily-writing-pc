// 端到端验收：走**真实 app 流程**（点开启摄像头 → 空房扫描 → 请进场 → 认人）。
// 与 accept-real-room.js 的区别：那个直接调引擎 API；这个走 UI 按钮和状态机，
// 验证 app 集成（扫描卡片、进度条、状态切换、语音、跳过）真的接对了。
//
// 做法：在页面脚本执行前注入一个假的 window.DepthLink，
// 这样 app 的 motionDepthLink() 会拿到我们控制的 grid，app 会以为接了真深度相机。
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const person = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));
const bg = person.bg, bg2 = person.bg2;

let pass = 0, fail = 0;
function chk(ok, label, detail) {
  if (ok) { pass++; console.log("  ✔ " + label + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  ✘ " + label + "   " + (detail || "")); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "e2e-" + process.pid + "-" + Date.now()),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1280,860"]
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", e => { pageErrors.push(e.message); console.log("PAGEERROR:", e.message); });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);

  // ① 注入假深度桥（必须在 app 调 motionDepthLink 之前）
  await page.evaluate(() => {
    window.__grid = new Float32Array(96 * 72);
    window.DepthLink = {
      DEFAULT_URL: "ws://127.0.0.1:8181",
      createLink: function () {
        return {
          available: () => true,
          grid: () => window.__grid,
          stats: () => ({ status: "open", fps: 15, validRatio: 0.9, device: "Astra", srcW: 640, srcH: 480, minMM: 600, maxMM: 5000 }),
          onStatus: () => {}, connect: () => {}, close: () => {}
        };
      }
    };
  });

  // ② 假彩色流 + 进体感页
  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });

  async function feed(grids, n) {
    for (let i = 0; i < n; i++) {
      const cells = grids[Math.min(i, grids.length - 1)];
      await page.evaluate((g2) => {
        const g = window.__grid; let k = 0;
        for (let y = 0; y < g2.length; y++) { const row = g2[y];
          for (let x = 0; x < row.length; x++) { g[k++] = row[x] || 0; } }
      }, cells);
      await sleep(150);
    }
  }

  console.log("\n===== 1. 点「开启摄像头」→ 应自动进入空房扫描 =====");
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1800);
  let s1 = await page.evaluate(() => ({
    phase: (typeof roomScan !== "undefined") ? roomScan.phase : "n/a",
    cardHidden: document.getElementById("roomScan").classList.contains("hidden"),
    stepText: (document.getElementById("poseCalibStep") || {}).textContent,
    panelDimmed: !!document.querySelector(".pose-calib-panel.is-dimmed"),
    scanText: (document.getElementById("roomScanTip") || {}).textContent ? "有" : "无"
  }));
  console.log("  " + JSON.stringify(s1));
  chk(s1.phase === "scanning", "进入空房扫描状态", "phase=" + s1.phase);
  chk(s1.cardHidden === false, "扫描卡片已显示");
  chk(s1.panelDimmed === true, "校准评分面板已压暗（避免误导）");
  chk(/先认一认房间|第 0 步/.test(s1.stepText || ""), "步骤文案已切换", s1.stepText);

  console.log("\n===== 2. 喂空房帧 → 扫描完成、卡片收起、文案切回 =====");
  await feed(new Array(10).fill(bg).concat(new Array(10).fill(bg2)), 20);
  await sleep(700);
  let s2 = await page.evaluate(() => {
    const info = motionEngine.roomScanInfo();
    return {
      ready: info.ready, coverage: info.coverage, samples: info.samples, need: info.need,
      phase: (typeof roomScan !== "undefined") ? roomScan.phase : "n/a",
      cardHidden: document.getElementById("roomScan").classList.contains("hidden"),
      stepText: (document.getElementById("poseCalibStep") || {}).textContent,
      titleText: (document.getElementById("poseCalibTitle") || {}).textContent,
      panelDimmed: !!document.querySelector(".pose-calib-panel.is-dimmed")
    };
  });
  console.log("  " + JSON.stringify(s2));
  chk(s2.ready && s2.coverage > 0.8, "结构基线就绪", "coverage=" + (s2.coverage * 100).toFixed(1) + "%");
  chk(s2.phase === "done", "状态切到 done");
  chk(s2.cardHidden === true, "扫描卡片自动收起");
  chk(!s2.panelDimmed, "评分面板恢复");
  chk(/第 1 步/.test(s2.stepText || ""), "步骤文案切回「第 1 步」", s2.stepText);

  console.log("\n===== 3. 喂三个真人姿势 → 应全部识别，张臂显著 =====");
  const widths = {};
  for (const p of person.poses) {
    await feed(p.frames.map(f => f.grid), p.frames.length);
    const s = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const d = motionEngine.depthDebug();
      return { has: sk.has, bbox: sk.bbox || null, structPath: d && d.structPath };
    });
    widths[p.name] = s.bbox ? s.bbox.w : 0;
    console.log("  " + p.name.padEnd(11) + " has=" + s.has +
      " bbox=" + (s.bbox ? s.bbox.w.toFixed(3) : "--") + " structPath=" + s.structPath);
    chk(s.has, p.name + " 识别到人");
    await feed(new Array(5).fill(bg2), 5);
  }
  const ratio = widths.t_pose / widths.arms_down;
  chk(widths.t_pose > 0.35, "T-pose 宽度 > 0.35", "w=" + widths.t_pose.toFixed(3));
  chk(ratio >= 2.0, "张臂倍率 ≥ 2.0x", ratio.toFixed(2) + "x");

  console.log("\n===== 4. 无 JS 报错 =====");
  chk(pageErrors.length === 0, "页面无 JS 异常", pageErrors.length ? pageErrors.join(" | ") : "0 条");

  console.log("\n================ 汇总 ================");
  console.log("  通过 " + pass + " / 失败 " + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
