/* 只读探针：「AI 范文参考」卡片在**真实一屏**里到底看不看得见。
 *
 * 背景：老李要求"在每日一写模块里再加一个 AI 重写范文的功能"，
 * 但这个功能**已经存在**（app.js 的 generateAiModel + 结果页 #aiModelCard）。
 * 所以先要回答的是"它是不是被埋在看不到的地方"，而不是重复造一个。
 *
 * 做法：不调网络、不动任何产品代码 —— 在页面里塞一份**本地规则**算出的 feedback
 * （`evaluateEssay`）+ 一篇**假范文**，然后量：
 *   · 卡片距页面顶端多少 px、视口多高、要滚多少才看得到；
 *   · 截两张图：① 不滚动的真实一屏（"孩子第一眼看到什么"）② 卡片本体。
 *
 * 用法：NODE_PATH=... node build/_probe-ai-model-card.js
 */
"use strict";
const path = require("path");
const os = require("os");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEW = { width: 1440, height: 900 };

/* 一篇有"扩写空间"的孩子作文（细节少、句子短），用来触发范文卡片的正常态 */
const ESSAY = [
  "第一次学做饭",
  "",
  "今天我要学做饭。我先洗了米，然后把米放进锅里。",
  "妈妈说要放水。我放了水。后来饭熟了，我很开心。",
  "我觉得做饭很好玩。"
].join("\n");

const MOCK_MODEL = {
  source: "ai",
  title: "第一次学做饭",
  text: [
    "今天我要学做饭。我先把米倒进盆里，手伸进去一搅，水马上变得白白的、浑浑的，像牛奶一样。",
    "",
    "我把米捞起来，一粒一粒都粘在手指上，甩了半天才甩掉。",
    "",
    "妈妈站在旁边说：「水要放到手指头第一节能没过米。」我就照着做，手指戳进去，水面刚好到那一节。",
    "",
    "后来锅盖边上开始冒白气，一股香香的、甜甜的味道钻出来。我掀开盖子一看，饭粒鼓鼓的，一颗挨着一颗。",
    "",
    "妈妈尝了一口，说：「还行！」我心里像有个小气球，一下子就飘起来了。原来做饭一点都不难，只要认真听、认真做。"
  ].join("\n"),
  highlights: [
    "写淘米时加了一句「水变得白白的、浑浑的」，让读者能看见",
    "写妈妈教的时候，把她说的原话写了出来",
    "结尾把「开心」换成了「心里像有个小气球」，感觉更真"
  ]
};

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-aimodel-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  await page.setViewport(VIEW);
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));

  await page.goto(INDEX, { waitUntil: "load", timeout: 45000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  /* ---------- 场景一：还没生成范文（孩子第一次看到的样子） ---------- */
  const info1 = await page.evaluate((essay) => {
    state.module = "write";
    const fb = evaluateEssay(essay);
    state.lastFeedback = {
      id: "probe-noModel", title: "第一次学做饭", type: "故事补全",
      text: essay, feedback: fb
    };
    applyModule(); setView("result"); renderResult();
    const card = document.getElementById("aiModelCard");
    const btn = document.getElementById("genModelBtn");
    const cr = card.getBoundingClientRect();
    return {
      hidden: card.classList.contains("hidden"),
      cardTopDoc: Math.round(cr.top + window.scrollY),
      cardH: Math.round(cr.height),
      viewH: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      btnText: btn.textContent,
      btnDisabled: btn.disabled,
      hint: document.getElementById("aiModelHint").textContent.slice(0, 40),
      status: document.getElementById("aiModelStatus").textContent.slice(0, 60)
    };
  }, ESSAY);

  console.log("\n===== 场景一：还没生成范文 =====");
  console.log("  卡片可见(hidden=false)? " + (!info1.hidden));
  console.log("  卡片距页面顶端 " + info1.cardTopDoc + "px；视口高 " + info1.viewH + "px；整页高 " + info1.scrollH + "px");
  console.log("  按钮文案「" + info1.btnText + "」  禁用=" + info1.btnDisabled);
  console.log("  提示：" + info1.hint);
  console.log("  状态行：" + (info1.status || "（空）"));

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, "aimodel-1-fold.png") });
  await page.screenshot({ path: path.join(SHOTS, "aimodel-1-full.png"), fullPage: true });
  console.log("  截图：aimodel-1-fold.png（真实一屏） / aimodel-1-full.png（全页）");

  /* ---------- 场景二：已经生成好范文（卡片展开态） ---------- */
  const info2 = await page.evaluate((essay, model) => {
    state.module = "write";
    const fb = evaluateEssay(essay);
    state.lastFeedback = {
      id: "probe-hasModel", title: "第一次学做饭", type: "故事补全",
      text: essay, feedback: fb, modelEssay: model
    };
    applyModule(); setView("result"); renderResult();
    const card = document.getElementById("aiModelCard");
    const btn = document.getElementById("genModelBtn");
    const body = document.getElementById("aiModelBody");
    const cr = card.getBoundingClientRect();
    return {
      bodyShown: !body.classList.contains("hidden"),
      btnText: btn.textContent,
      cardTopDoc: Math.round(cr.top + window.scrollY),
      cardH: Math.round(cr.height),
      title: document.getElementById("aiModelTitle").textContent,
      textLen: document.getElementById("aiModelText").textContent.length,
      hlCount: document.querySelectorAll("#aiModelHighlights li").length
    };
  }, ESSAY, MOCK_MODEL);

  console.log("\n===== 场景二：已生成范文 =====");
  console.log("  正文显示=" + info2.bodyShown + "  按钮「" + info2.btnText + "」");
  console.log("  标题「" + info2.title + "」正文 " + info2.textLen + " 字；看点 " + info2.hlCount + " 条");
  console.log("  卡片距页面顶端 " + info2.cardTopDoc + "px（整页高 " + info2.scrollH + "px）");

  const el = await page.$("#aiModelCard");
  await el.screenshot({ path: path.join(SHOTS, "aimodel-2-card.png") });
  await page.evaluate(() => {
    const c = document.getElementById("aiModelCard");
    window.scrollTo(0, c.getBoundingClientRect().top + window.scrollY - 40);
  });
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, "aimodel-2-scrolled.png") });
  console.log("  截图：aimodel-2-card.png（卡片本体） / aimodel-2-scrolled.png（滚到卡片）");

  if (errs.length) console.log("\nJS 报错：" + errs.slice(0, 3).join(" | "));
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error("探针异常：", e); process.exit(3); });
