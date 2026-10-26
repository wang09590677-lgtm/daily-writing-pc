// 一次性出图：写作积分榜新模板（与「体能积分」同款：写作金币 + 本周榜单 + 本月走势）
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 种子：本周前几天各写一篇，分数有高有低，让本周榜单和金币都有内容
const seed = `(() => {
  const pad = n => String(n).padStart(2, "0");
  const iso = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).toISOString();
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const back = (now.getDay() + 1) % 7;
  const start = new Date(now); start.setDate(now.getDate() - back);
  const dayAt = i => { const d = new Date(start); d.setDate(start.getDate() + i); return d; };
  const scores = [92, 78, 0, 85, 96, 71];
  const essays = scores.map((score, i) => ({
    id: "board-e" + i, date: iso(dayAt(i), 10), topicId: "board" + i, type: "每日必写",
    title: "积分榜模板验证", goal: "", skillFocus: "语言表达", material: "",
    text: "这是用于验证写作积分榜新模板的测试作文。".repeat(3),
    feedback: { score, parts: {}, strengths: [], improvements: [], nextGoal: "" }
  })).filter(e => e.feedback.score > 0);
  localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
    module: "write",
    profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
    essays
  }));
})();`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.evaluateOnNewDocument(seed);
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(900);
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "scoreboard").click();
  });
  await sleep(700);
  await page.evaluate(() => {
    document.getElementById("scoreboard").scrollIntoView({ block: "start" });
  });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "writeboard-01-new-template.png") });
  await browser.close();
  console.log("✓ 已出图 build/shots/writeboard-01-new-template.png");
})().catch(e => { console.error(e); process.exit(1); });
