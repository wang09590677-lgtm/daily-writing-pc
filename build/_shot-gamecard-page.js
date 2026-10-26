// 一次性出图：模块选择页（首页）「每日一写 / 每日一练」大卡下方的游戏卡 + 奖金池整页上下文截图
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 与 points-browser-test 场景 7 同一套种子：5 个训练天 + 5 篇 70 分作文 → 三张全彩
const seed = `(() => {
  const iso = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).toISOString();
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const back = (now.getDay() + 1) % 7;
  const start = new Date(now); start.setDate(now.getDate() - back);
  const dayAt = i => { const d = new Date(start); d.setDate(start.getDate() + i); return d; };
  const essays = [1, 2, 3, 4, 5].map(off => ({
    id: "shot-e" + off, date: iso(dayAt(off), 10), topicId: "shot" + off, type: "每日必写",
    title: "截图验证", goal: "", skillFocus: "语言表达", material: "",
    text: "这是用于验证游戏卡整页效果的测试作文。".repeat(3),
    feedback: { score: 88, parts: {}, strengths: [], improvements: [], nextGoal: "" }
  }));
  const sessions = [0, 1, 2, 3, 4].map(off => ({
    id: "shot-s" + off, date: iso(dayAt(off), 19), dayId: "shot-day" + off, dayName: "训练日",
    week: 1, completion: 100, doneCount: 6, totalCount: 6, medal: "gold", coins: 5, durationSec: 600
  }));
  localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
    module: "write",
    profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
    essays, fitness: { sessions }
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
  // 游戏卡已挪到模块选择页（首页）：点「⇄ 切换模块」回去
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(500);
  // 滚到游戏卡所在处，拍一张视口截图
  await page.evaluate(() => {
    const box = document.getElementById("gameCards").closest("article.card");
    box.scrollIntoView({ block: "center" });
  });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "gamecard-04-page-context.png") });
  await browser.close();
  console.log("✓ 已出图 build/shots/gamecard-04-page-context.png");
})().catch(e => { console.error("失败:", e); process.exit(1); });
