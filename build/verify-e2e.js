// 端到端确认：应用里「看图编故事」的配图能真实显示
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  // 「每日任务」属拓展模块受门禁拦截，先种一篇今天的「每日必写」放行；
  // 否则视图切不过去，lazy 图在 display:none 里永远不会加载。
  await page.evaluateOnNewDocument(() => {
    const pad = n => String(n).padStart(2, "0");
    const d = new Date(); d.setHours(10, 0, 0, 0);
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
      essays: [{
        id: "seed-essential", date: d.toISOString(), topicId: "seed", type: "每日必写",
        title: "每日必写 测试", goal: "", skillFocus: "语言表达", material: "",
        text: "这是用于解锁拓展模块门禁的测试文本，内容足够长。".repeat(2),
        feedback: { score: 70, parts: {}, strengths: [], improvements: [], nextGoal: "" }
      }],
      rewards: {}, redemptions: []
    }));
  });
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="write"]')?.click());
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(e => e.dataset.view === "dailyTask").click());
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => [...document.querySelectorAll(".task-tab")].find(b => b.dataset.taskType === "picture").click());
  await new Promise(r => setTimeout(r, 800));

  // 反复换题，直到遇到一张已生成好的图
  let found = null;
  for (let i = 0; i < 90; i++) {
    await page.evaluate(() => {
      const img = document.querySelector("#taskMaterial .picture-prompt-img");
      if (img) img.setAttribute("loading", "eager");
    });
    await page.waitForFunction(() => {
      const img = document.querySelector("#taskMaterial .picture-prompt-img");
      return !img || img.complete;
    }, { timeout: 8000 }).catch(() => {});
    const st = await page.evaluate(() => {
      const img = document.querySelector("#taskMaterial .picture-prompt-img");
      if (img && img.complete && img.naturalWidth > 0) {
        return { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight,
                 cap: (document.querySelector(".picture-caption") || {}).textContent,
                 title: document.getElementById("taskTitle").textContent };
      }
      return null;
    });
    if (st) { found = st; break; }
    await page.evaluate(() => document.querySelector("[data-action='reroll-task']")?.click());
    await new Promise(r => setTimeout(r, 350));
  }
  console.log("命中已生成配图:", JSON.stringify(found));
  await page.screenshot({ path: path.join(SHOT, "picture-task.png") });

  // 进入写作页，确认配图也出现
  await page.evaluate(() => document.querySelector("[data-action='start-task-writing']")?.click());
  await new Promise(r => setTimeout(r, 900));
  const inWrite = await page.evaluate(() => {
    const img = document.querySelector("#activeMaterialCard .picture-prompt-img");
    return img ? { src: img.getAttribute("src"), w: img.naturalWidth } : null;
  });
  console.log("写作页配图:", JSON.stringify(inWrite));
  await page.screenshot({ path: path.join(SHOT, "picture-writing.png") });

  console.log("控制台报错:", errors.length ? errors.join(" | ") : "无");
  await browser.close();
})();
