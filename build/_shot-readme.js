// README 截图：生成 docs/screenshot-home.png（首页 / 模块选择页）
// 用注入种子数据的方式让游戏卡与奖金池显示为非空状态，避免首图全是灰卡。
// 用法：NODE_PATH=<workspace>/node_modules node build/_shot-readme.js
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 与 _shot-gamecard-page.js 同一套种子（5 个训练日 + 5 篇 88 分作文 → 三张卡全彩）
const seed = `(() => {
  const iso = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).toISOString();
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const back = (now.getDay() + 1) % 7;
  const start = new Date(now); start.setDate(now.getDate() - back);
  const dayAt = i => { const d = new Date(start); d.setDate(start.getDate() + i); return d; };
  const essays = [1, 2, 3, 4, 5].map(off => ({
    id: "doc-e" + off, date: iso(dayAt(off), 10), topicId: "doc" + off, type: "每日必写",
    title: "我的周末", goal: "", skillFocus: "语言表达", material: "",
    text: "这是示例作文正文。".repeat(6),
    feedback: { score: 88, parts: {}, strengths: [], improvements: [], nextGoal: "" }
  }));
  const sessions = [0, 1, 2, 3, 4].map(off => ({
    id: "doc-s" + off, date: iso(dayAt(off), 19), dayId: "doc-day" + off, dayName: "训练日",
    week: 1, completion: 100, doneCount: 6, totalCount: 6, medal: "gold", coins: 5, durationSec: 600
  }));
  localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
    module: "write",
    profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
    essays, fitness: { sessions }
  }));
})();`;

// 优先用环境变量或常见位置找到 Chrome
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return cands.find(p => fs.existsSync(p));
}

(async () => {
  const exe = findChrome();
  if (!exe) throw new Error("找不到 Chrome / Edge，请设置 CHROME_PATH");
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.evaluateOnNewDocument(seed);
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(1200);
  // 回到选择页（首页）
  await page.evaluate(() => {
    const b = document.getElementById("moduleSwitchBtn");
    if (b) b.click();
  });
  await sleep(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);

  const out1 = path.join(OUT, "screenshot-home.png");
  await page.screenshot({ path: out1 });
  console.log("✓ " + path.relative(ROOT, out1));

  // 第二张：滚到奖励区（游戏卡 + 奖金池）
  await page.evaluate(() => {
    const el = document.getElementById("gameCards");
    if (el) el.closest("article.card").scrollIntoView({ block: "center" });
  });
  await sleep(500);
  const out2 = path.join(OUT, "screenshot-rewards.png");
  await page.screenshot({ path: out2 });
  console.log("✓ " + path.relative(ROOT, out2));

  await browser.close();
})().catch(e => { console.error("失败:", e); process.exit(1); });
