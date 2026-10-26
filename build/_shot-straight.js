/* 肉眼核对截图（R7）：把用户报的两个姿势 + 已知盲区 + 对照各渲一张。
 *
 * 为什么单独有这个脚本：`accept-human-glb` ⑨ 的断言是**数字**（肘/膝弯曲角 < 2°），
 * 而"看起来是不是直的"只有看图才算数（R7：「涉及界面的改动必须真的看一眼截图」）。
 *
 * 用法：node build/_shot-straight.js      → build/shots/straight-*.png
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const OUT = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CASES = [
  ["arms-straight", "双臂水平共线平举（用户报的姿势①）", () => F.armsStraight()],
  ["legs-straight", "双腿严格竖直（用户报的姿势②）", () => F.legsStraight()],
  ["squat-blind", "正面下蹲（已知盲区：腿会伸直、脚下沉）", () => F.squat()],
  ["deep-knee", "对照：2D 里真的弯的深蹲", () => F.deepKnee()]
];

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-shot-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  for (let i = 0; i < 40; i++) {
    const sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  for (const [slug, label, make] of CASES) {
    const pose = make();
    await page.evaluate((p) => {
      for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(p);
      window.MotionAvatar.__renderNow();
    }, pose);
    const f = path.join(OUT, "straight-" + slug + ".png");
    await page.screenshot({ path: f });
    console.log("已存 " + f + "   ← " + label);
  }
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
