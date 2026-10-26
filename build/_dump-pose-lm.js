/* ==================================================================
 * _dump-pose-lm.js — 一次性把「真实动作视频帧 → 真实 MediaPipe Pose」的
 * 33 关键点落盘到 build/_tmp/_lm.json，供后续**纯 Node** 复算使用。
 *
 * 为什么这么绕：
 *   1) 真机走的是 MediaPipe 姿态主链路，只有这条链路才能回答
 *      "新门限挡不挡真人"；掩码链路在宣传视频上会饱和（见
 *      _exp-realvideo-offline.js），不是证据。
 *   2) 团队里别人在用 Chrome 做固定装置扫描，Chrome 必须串行。
 *      所以把"必须开浏览器的部分"（MediaPipe 推理）压缩成**一次性 dump**，
 *      之后的参数扫描全部在 Node 里跑，不再抢 Chrome。
 *   3) mapLandmarks() 是纯函数（pose-vision.js 里自己写了"不依赖 MediaPipe
 *      运行时，所以能在 Node 里直接单测"），所以 dump 出关键点后，
 *      pose-vision 的映射 / 引擎的计次都能在 Node 里逐字节复现。
 *
 * 只读产品文件。运行：node build/_dump-pose-lm.js
 * ================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FR = path.join(__dirname, "_frames2");
const OUT = path.join(__dirname, "_tmp", "_lm.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CN = { jumpingJacks: "开合跳", squat: "徒手深蹲", jumpRope: "跳绳", highKnees: "原地高抬腿跑", burpee: "波比跳" };
const ACTIONS = Object.keys(CN);

const frameDirs = {};
for (const a of ACTIONS) {
  const d = path.join(FR, a);
  if (fs.existsSync(d)) frameDirs[a] = fs.readdirSync(d).filter(f => /^f\d+\.jpg$/.test(f)).sort()
    .map(f => "file:///" + path.join(d, f).replace(/\\/g, "/"));
}

(async () => {
  if (!fs.existsSync(FR)) { console.error("缺少抽帧目录：" + FR); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling"]
  });
  const page = await browser.newPage();
  const perrs = [];
  page.on("pageerror", e => perrs.push(String(e && e.message)));
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(600);

  const dump = { meta: { generatedAt: new Date().toISOString(), model: "pose_landmark_lite", complexity: 0 }, acts: {} };

  for (const act of ACTIONS) {
    if (!frameDirs[act]) { console.log("跳过（无帧）", act); continue; }
    const urls = frameDirs[act];
    const r = await page.evaluate(async (act, urls) => {
      const cv = document.createElement("canvas"); const g = cv.getContext("2d");
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let cur = null; pose.onResults(res => { cur = (res && res.poseLandmarks) ? res.poseLandmarks : null; });
      const frames = [], okFlags = [];
      let detected = 0, mapped = 0;
      for (const u of urls) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
        cv.width = img.naturalWidth; cv.height = img.naturalHeight; g.drawImage(img, 0, 0);
        const W = cv.width, H = cv.height;
        cur = null; await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 0));
        if (cur) {
          detected++;
          const m = window.PoseVision.mapLandmarks(cur);
          if (m.ok) {
            mapped++;
            frames.push(cur.map(p => [+p.x.toFixed(5), +p.y.toFixed(5), +(((p.visibility === undefined || p.visibility === null) ? 1 : p.visibility)).toFixed(3)]));
            okFlags.push(true);
          } else { frames.push(null); okFlags.push(false); }
        } else { frames.push(null); okFlags.push(false); }
      }
      return { total: urls.length, detected, mapped, w: cv.width, h: cv.height, frames, okFlags };
    }, act, urls).catch(e => ({ err: String(e && e.message) }));

    if (r.err) { console.log(CN[act] + " 失败:", r.err); continue; }
    dump.acts[act] = { cn: CN[act], srcW: r.w, srcH: r.h, total: r.total, detected: r.detected, mapped: r.mapped, okFlags: r.okFlags, frames: r.frames };
    console.log(`${CN[act]}: 帧 ${r.total} 检出 ${r.detected} 映射 ${r.mapped}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(dump));
  console.log("\n关键点已写入 " + OUT);
  console.log("页面异常:", perrs.length ? perrs.join(" | ") : "无");
  await browser.close();
})();
