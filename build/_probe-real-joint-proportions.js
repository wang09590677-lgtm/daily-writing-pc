/* 从真实照片走**真链路**（MediaPipe → PoseVision.mapLandmarks）拿到引擎关节，
   量出真人各关节相对"头→趾 span"的比例 —— 用来给测试夹具定"人形忠实"的数值。
   用法：node build/_probe-real-joint-proportions.js */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  const profileDir = path.join(os.tmpdir(), "wbc-props-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    defaultViewport: { width: 900, height: 700 },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);

  const out = await page.evaluate(async (b) => {
    const PV = window.PoseVision;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b; });
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({
      modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false,
      smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5
    });
    let lm = null;
    pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
    await pose.send({ image: cv });
    await new Promise(r => setTimeout(r, 300));
    if (!lm) return { err: "MediaPipe 没返回关键点" };
    const m = PV.mapLandmarks(lm);
    return { imgW: cv.width, imgH: cv.height, ok: m.ok, reason: m.reason, joints: m.joints, bbox: m.bbox };
  }, b64).catch(e => ({ err: String(e && e.message) }));

  if (out.err) { console.log("失败:", out.err); await browser.close(); return; }
  console.log("图片 " + out.imgW + "x" + out.imgH + "  mapLandmarks ok=" + out.ok + " " + (out.reason || ""));
  const j = out.joints;
  const names = Object.keys(j);
  console.log("\n=== 引擎关节（归一化画面坐标）===");
  names.forEach(n => console.log("  " + n.padEnd(10) + " x=" + j[n].x.toFixed(4) + " y=" + j[n].y.toFixed(4)));

  // span 与各关节相对比例
  const top = j.head.y;
  let bot = -Infinity;
  ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => { if (j[k]) bot = Math.max(bot, j[k].y); });
  const span = bot - top;
  console.log("\nspan(头→最低踝/趾) = " + span.toFixed(4) + "   head.y=" + top.toFixed(4) + "  bot.y=" + bot.toFixed(4));
  const f = k => (j[k] ? ((bot - j[k].y) / span).toFixed(4) : "-");
  console.log("\n=== 相对比例 f = (最低点 − 关节y) / span（0=地面，1=头）===");
  ["toeL", "ankleL", "shinL", "kneeL", "hipL", "hipMid", "neck", "shoulderL", "elbowL", "wristL", "handL", "head"]
    .forEach(k => console.log("  " + k.padEnd(10) + " f = " + f(k)));
  const xf = k => (j[k] ? ((j[k].x - 0.5) / span).toFixed(4) : "-");
  console.log("\n=== 横向 x（相对 span，0=中线）===");
  ["shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR", "hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR"]
    .forEach(k => console.log("  " + k.padEnd(10) + " x/sp = " + xf(k)));
  console.log("\nbbox = " + JSON.stringify(out.bbox));
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
