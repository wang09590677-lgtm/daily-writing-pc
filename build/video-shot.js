// 出图：①每日一练里的跟做视频状态 ②教练浮层休息段真的在放 中场休息.mp4
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const OUT = path.join(__dirname, "..", "..", "outputs");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-shot"),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1440,980"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 980 });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  // ① 每日一练：跟做视频状态
  await page.evaluate(() => {
    document.querySelector('.chooser-card[data-module="fitness"]')?.click();
  });
  await sleep(500);
  await page.evaluate(() => { setView("fitnessToday"); renderFitnessToday(); });
  await sleep(400);
  await page.evaluate(() => {
    const el = document.querySelector(".fit-video-bar");
    if (el) el.scrollIntoView({ block: "center" });
  });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, "fitness-video-bars.png") });

  // ② 教练浮层休息段：播放固定的中场休息视频
  await page.evaluate(async () => {
    const rest = state.fitness.restVideoUrl;
    const work = state.fitness.videoMap.jumpingJacks || "";
    window.CoachTimer.open({
      exId: "jumpingJacks", name: "开合跳", emoji: "⭐",
      how: "双臂举过头顶，双脚同时向两侧打开，再跳回并拢。落地要轻。",
      segments: [
        { kind: "work", seconds: 30, exId: "jumpingJacks" },
        { kind: "rest", seconds: 30 }
      ],
      seconds: 60, restUrl: rest, videoUrls: { jumpingJacks: work }
    });
    window.CoachTimer.update(60);     // 运动段
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, "coach-work-video.png") });

  await page.evaluate(() => window.CoachTimer.update(25));   // 休息段
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, "coach-rest-video.png") });

  const info = await page.evaluate(() => {
    const v = document.getElementById("coachVideo");
    return { src: v.getAttribute("src"), playing: !v.paused, t: v.currentTime, w: v.videoWidth, h: v.videoHeight };
  });
  console.log("休息段视频:", JSON.stringify(info));
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
