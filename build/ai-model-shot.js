// 出「AI 范文」的实拍效果图：拦截模型返回，走完整流程，截结果页。
// 用途：给老李一张能看清效果（而不是看代码）的图。
// 用法：node build/ai-model-shot.js
"use strict";
const path = require("path"), fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GRADE = {
  parts: { "内容与立意": 19, "结构与逻辑": 15, "细节与描写": 12, "语言表达": 16, "词汇与句式": 7, "错别字与标点": 5 },
  strengths: ["「风把树叶吹得哗哗响」写出了声音，读起来像真的在公园。", "你把放风筝的经过按顺序写清楚了。"],
  improvements: ["写「很开心」的时候，可以写写你当时在做什么动作。", "第二段只有两句话，可以多写一点。", "结尾可以补一句心里想的。"],
  nextGoal: "下一篇试着把最开心的一瞬间写成三句话。",
  narrative: "你把去公园这件事写清楚了，还写了一处好听的声音。不过最开心的部分只有一句，把它展开写会更好看。",
  evidence: [
    { quote: "风把树叶吹得哗哗响", comment: "写声音写得好，读者能听见。" },
    { quote: "我很开心。", comment: "这句可以加一个具体动作，比如跳起来或者笑出声。" }
  ],
  progress: { trend: "first", detail: "" }
};

const MODEL = {
  title: "去公园玩",
  model: "今天下午，我和小明一起去公园玩。刚走到湖边，风就把树叶吹得哗哗响，像是有人在树上轻轻拍手。\n\n我把风筝举过头顶，小明拉着线往前跑。风筝刚飞起来的时候歪歪扭扭的，我赶紧喊：「再跑快一点！」他一加速，风筝就稳稳地升上去了，尾巴一摆一摆的。\n\n跑累了，我们坐在长椅上吃冰淇淋。冰淇淋化得很快，顺着手指往下流，我一边舔一边笑，小明笑我像只花猫。\n\n回家的路上我还在想：下次我要自己把风筝放起来，不用小明帮忙。",
  highlights: [
    "写风筝飞起来时，加了一句你喊的话，读起来就像在现场。",
    "玩累了那段加了冰淇淋化在手上的样子，比只写「吃冰淇淋」具体多了。",
    "结尾加了一句心里想的，比只写「很开心」更让人记得住。"
  ]
};

const ESSAY = "今天我去公园玩，风把树叶吹得哗哗响。我和小明一起放风筝，风筝飞得很高。后来我们吃了冰淇淋，我很开心。";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  page.on("dialog", async d => { await d.accept(); });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  await page.setRequestInterception(true);
  page.on("request", req => {
    const u = req.url();
    if (u.indexOf("api.deepseek.com") >= 0 || u.indexOf("dashscope.aliyuncs.com") >= 0) {
      const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization" };
      if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
      const sys = ((body.messages || [])[0] || {}).content || "";
      const payload = sys.indexOf("范文") >= 0 ? MODEL : GRADE;
      return setTimeout(() => req.respond({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify(payload) + "\n```" } }] }) }), 400);
    }
    req.continue();
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll(".chooser-card")].find(x => x.dataset.module === "write");
    if (c) c.click();
  });
  await sleep(700);
  await page.evaluate(() => window.AiGrader.setConfig({ provider: "deepseek", apiKey: "sk-demo-fake-key" }));
  await page.evaluate(() => setView("write"));
  await sleep(400);
  await page.evaluate(t => {
    document.getElementById("essayInput").value = t;
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  }, ESSAY);
  await sleep(300);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(2000);

  await page.screenshot({ path: path.join(SHOT, "ai-result-scored.png"), fullPage: true });
  console.log("① 评分后的结果页 →", path.join(SHOT, "ai-result-scored.png"));

  // 滚到范文卡片再点生成
  await page.evaluate(() => document.getElementById("aiModelCard").scrollIntoView({ block: "start" }));
  await sleep(300);
  await page.evaluate(() => document.getElementById("genModelBtn").click());
  await sleep(2600);

  await page.evaluate(() => document.getElementById("aiModelCard").scrollIntoView({ block: "start" }));
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "ai-model-ready.png") });
  console.log("② 范文生成后（卡片特写）→", path.join(SHOT, "ai-model-ready.png"));

  const el = await page.$("#aiModelCard");
  if (el) { await el.screenshot({ path: path.join(SHOT, "ai-model-card.png") }); console.log("③ 范文卡片单图 →", path.join(SHOT, "ai-model-card.png")); }

  const info = await page.evaluate(() => ({
    words: (state.lastFeedback.modelEssay || {}).words,
    title: (state.lastFeedback.modelEssay || {}).title
  }));
  console.log("\n范文：" + info.title + " · " + info.words + " 字");
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
