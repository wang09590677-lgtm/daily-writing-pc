// 探针：能不能用「真实人体动作视频」拿到 MediaPipe 33 关键点逐帧序列？
// 若能，就能用**真实动作**而不是合成方块人来标定姿态链路的幅度门限。
// 只读生产代码，不碰任何生产文件。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIDEOS = ["开合跳.mp4", "深蹲.mp4", "跳绳.mp4", "原地高抬腿跑.mp4"];

(async () => {
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

  for (const v of VIDEOS) {
    const vpath = path.join(ROOT, "体能训练动作演示", v).replace(/\\/g, "/");
    const url = "file:///" + vpath;
    const r = await page.evaluate(async (url) => {
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.preload = "auto";
      video.src = url;
      await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error("video load fail")); });
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      const frames = [];
      let cur = null;
      pose.onResults(res => { cur = (res && res.poseLandmarks) ? res.poseLandmarks : null; });
      const cv = document.createElement("canvas");
      await video.play();
      const t0 = performance.now();
      const seq = [];
      while (performance.now() - t0 < (video.duration + 0.4) * 1000) {
        if (video.ended) break;
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        cv.getContext("2d").drawImage(video, 0, 0);
        await pose.send({ image: cv });
        seq.push(cur ? cur.map(p => [p.x, p.y, p.visibility === undefined ? 1 : p.visibility]) : null);
        await new Promise(r => setTimeout(r, 1000 / 24));
      }
      video.pause();
      const det = seq.filter(Boolean).length;
      // 用 mapLandmarks 看 bbox 量级
      let bbox = null, mapped = 0;
      const bs = [];
      for (const s of seq) {
        if (!s) continue;
        const lm = s.map(p => ({ x: p[0], y: p[1], visibility: p[2] }));
        const m = window.PoseVision.mapLandmarks(lm);
        if (m.ok) { mapped++; bs.push({ w: m.width, h: m.height, cy: m.centroidY, top: m.top, bottom: m.bottom }); }
      }
      const stat = k => { const a = bs.map(b => b[k]); if (!a.length) return null;
        return { min: +Math.min(...a).toFixed(4), max: +Math.max(...a).toFixed(4), range: +(Math.max(...a) - Math.min(...a)).toFixed(4) }; };
      return { frames: seq.length, detected: det, mapped,
        dur: +video.duration.toFixed(2), vw: video.videoWidth, vh: video.videoHeight,
        width: stat("w"), height: stat("h"), centroidY: stat("cy") };
    }, url).catch(e => ({ err: String(e && e.message) }));
    console.log(`\n【${v}】`, JSON.stringify(r, null, 1));
  }
  await browser.close();
})().catch(e => { console.error("崩溃", e); process.exit(2); });
