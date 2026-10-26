// 侦察探针：确认 app.js 的体感函数在 window 上的可见性、动作下拉内容、
// 以及「自动下一项」相关状态字段是否齐全。只读，不改任何生产文件。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "-allow-file-access-from-files", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });

  // 冻结日期到周二（腿部力量日：没有开合跳 → 它会落到"自由加练"，目标=12 次）
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    const FIXED = new RealDate(2026, 8, 29, 10, 30, 0).getTime();
    class MockDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
      static now() { return FIXED; }
    }
    window.Date = MockDate;
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  // 进体能模块 → 体感跟练
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(400);

  const recon = await page.evaluate(() => {
    const t = n => typeof window[n];
    const names = ["motionAutoComplete", "motionNextChoice", "motionRestSeconds", "motionStartRest",
      "motionAutoAdvance", "motionAutoNextAbort", "motionStartSet", "motionStartSetNow",
      "motionChoices", "motionGoalFor", "motionProgressOf", "motionSequencePos", "motionFinishSet",
      "motionSayDone", "motionAutoNextDisabled", "motionPrepDisabled", "__motionDebug"];
    const out = {};
    names.forEach(n => { out[n] = t(n); });
    const sel = document.getElementById("motionExSelect");
    const opts = [...sel.options].map((o, i) => `${i}:${o.textContent.trim()}`);
    return {
      fnTypes: out,
      optionCount: opts.length,
      options: opts,
      jjIndex: opts.findIndex(s => s.includes("开合跳")),
      ringEl: !!document.getElementById("motionRing"),
      goalProgressEl: !!document.getElementById("motionGoalProgress"),
      goalProgressHidden: document.getElementById("motionGoalProgress").classList.contains("hidden"),
      avatarElExists: !!document.getElementById("motionAvatar"),
      avatarProgressExists: !!document.getElementById("motionAvatarProgress"),
      posePrepZ: (() => { const e = document.getElementById("posePrep"); return e ? getComputedStyle(e).zIndex : "no-el"; })()
    };
  });
  console.log(JSON.stringify(recon, null, 2));

  await browser.close();
})().catch(e => { console.error("崩溃", e); process.exit(2); });
