// 快速 sanity：真实动作帧里能不能检出人体 + 几何量级大概多少
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FR = path.join(__dirname, "_frames2");
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  for (const act of ["jumpingJacks", "squat", "jumpRope", "highKnees", "burpee"]) {
    const dir = path.join(FR, act);
    const files = fs.readdirSync(dir).filter(f => /^f\d+\.jpg$/.test(f)).sort();
    // 取若干代表帧
    const pick = [0, Math.floor(files.length / 4), Math.floor(files.length / 2), Math.floor(files.length * 3 / 4)];
    const urls = pick.map(i => "file:///" + path.join(dir, files[i]).replace(/\\/g, "/"));
    const r = await page.evaluate(async (urls) => {
      const cv = document.createElement("canvas"); const g = cv.getContext("2d");
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let cur = null; pose.onResults(res => { cur = (res && res.poseLandmarks) ? res.poseLandmarks : null; });
      const out = [];
      for (const u of urls) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
        cv.width = img.naturalWidth; cv.height = img.naturalHeight; g.drawImage(img, 0, 0);
        cur = null; await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 0));
        if (cur) { const m = window.PoseVision.mapLandmarks(cur);
          out.push({ lm: cur.length, ok: m.ok, w: m.ok ? +m.width.toFixed(3) : null, h: m.ok ? +m.height.toFixed(3) : null,
            cy: m.ok ? +m.centroidY.toFixed(3) : null, reason: m.reason || "" }); }
        else out.push({ lm: 0 });
      }
      return out;
    }, urls).catch(e => [{ err: String(e && e.message) }]);
    console.log(act, JSON.stringify(r));
  }
  await browser.close();
})().catch(e => { console.error("崩溃", e); process.exit(2); });
