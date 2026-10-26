// 真实浏览器验证：看图编故事的配图是否真的加载并显示
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  // 「每日任务」是拓展模块，受门禁拦截：必须先完成当天「每日必写」才进得去。
  // 而 lazy 图在 display:none 的视图里**永远不会加载**（naturalWidth 恒为 0），
  // 不种子就会把「视图没切过去」误报成「210 张全破图」。
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
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await new Promise(r => setTimeout(r, 700));

  // 先过「模块选择页」，否则写作模块的导航项根本不可见
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="write"]')?.click());
  await new Promise(r => setTimeout(r, 500));

  // 进入「每日任务」
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(e => e.dataset.view === "dailyTask").click());
  await new Promise(r => setTimeout(r, 400));
  // 自证视图真的切过去了（否则后面全是假失败）
  const inTask = await page.$eval("#dailyTask", el => el.classList.contains("active"));
  console.log("已进入「每日任务」视图:", inTask, inTask ? "" : "（门禁未放行，后续结果不可信）");
  // 切到「看图编故事」
  const ok = await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".task-tab")].find(b => b.dataset.taskType === "picture");
    if (!tab) return false;
    tab.click();
    return true;
  });
  console.log("切到看图编故事页签:", ok);
  await new Promise(r => setTimeout(r, 1200));

  // 配图是 loading="lazy"：等它真的加载完再判定，否则会把"还在加载"误报成"破图"
  await page.evaluate(() => {
    const img = document.querySelector("#taskMaterial .picture-prompt-img");
    if (img) img.setAttribute("loading", "eager");
  });
  const waitLoaded = async () => {
    await page.waitForFunction(() => {
      const img = document.querySelector("#taskMaterial .picture-prompt-img");
      if (!img) return true;                       // 回退成占位了，也算"已定"
      return img.complete;
    }, { timeout: 8000 }).catch(() => {});
  };
  await waitLoaded();

  const first = await page.evaluate(() => {
    const img = document.querySelector("#taskMaterial .picture-prompt-img");
    return img ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight,
                   complete: img.complete, cap: (document.querySelector(".picture-caption") || {}).textContent } : null;
  });
  console.log("首屏配图:", JSON.stringify(first));

  // 连续换题 25 次，统计图片加载成功率
  let loaded = 0, broken = 0, missing = 0;
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => document.querySelector("[data-action='reroll-task']")?.click());
    await new Promise(r => setTimeout(r, 420));
    // 换题后新图同样要等加载完（并且要等它真的换了 src）
    await page.evaluate(() => {
      const img = document.querySelector("#taskMaterial .picture-prompt-img");
      if (img) img.setAttribute("loading", "eager");
    });
    await waitLoaded();
    const st = await page.evaluate(() => {
      const fig = document.querySelector("#taskMaterial .picture-prompt");
      if (!fig) return "none";
      if (fig.classList.contains("is-missing")) return "missing";
      const img = fig.querySelector("img");
      if (!img) return "missing";
      return (img.complete && img.naturalWidth > 0) ? "ok" : "broken";
    });
    if (st === "ok") loaded++; else if (st === "broken") broken++; else missing++;
  }
  console.log(`抽样 25 题 -> 正常 ${loaded} / 破图 ${broken} / 占位回退 ${missing}`);

  await page.screenshot({ path: path.join(SHOT, "picture-task.png") });

  // 进入写作页确认配图同样出现
  await page.evaluate(() => document.querySelector("[data-action='start-task-writing']")?.click());
  await new Promise(r => setTimeout(r, 900));
  const inWrite = await page.evaluate(() => {
    const img = document.querySelector("#activeMaterialCard .picture-prompt-img");
    return img ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  console.log("写作页配图:", JSON.stringify(inWrite));
  await page.screenshot({ path: path.join(SHOT, "picture-writing.png") });

  // 全量解码检查：把 210 张全部加载一遍
  const decode = await page.evaluate(async () => {
    const bad = [];
    for (let i = 1; i <= 210; i++) {
      const id = "pic" + String(i).padStart(3, "0");
      const ok = await new Promise(res => {
        const im = new Image();
        im.onload = () => res(im.naturalWidth > 0);
        im.onerror = () => res(false);
        im.src = "assets/pictures/" + id + ".jpg";
      });
      if (!ok) bad.push(id);
    }
    return bad;
  });
  console.log("全量 210 张无法解码:", decode.length ? decode.join(",") : "无（全部正常）");

  console.log("控制台报错:", errors.length ? errors.join(" | ") : "无");
  await browser.close();
})();
