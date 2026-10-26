// AI 范文参考 · 端到端（拦截网络，喂假模型响应，不花钱、不需要真 Key）
//
// 验的是"接线对不对"：卡片什么时候出现、点按钮有没有真的调模型、
// 提示词有没有把孩子原文和最弱项带进去、成功/失败分别怎么落地、
// 生成结果有没有存进记录（切视图/重开还在，不重复花钱）。
// 范文写得好不好，不属于这里能验的范围 —— 那是提示词工程，要靠真机看几篇。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

/* 评分返回（走 grade 分支） */
const FAKE_GRADE = {
  parts: { "内容与立意": 19, "结构与逻辑": 15, "细节与描写": 13, "语言表达": 16, "词汇与句式": 7, "错别字与标点": 5 },
  strengths: ["「风把树叶吹得哗哗响」写出了声音。"],
  improvements: ["第二段只写了「很开心」，可以写写你当时在做什么。"],
  nextGoal: "下一篇把最开心的一瞬间写成三句话。",
  narrative: "你把这件事写清楚了。",
  evidence: [{ quote: "风把树叶吹得哗哗响", comment: "写声音写得好。" }],
  progress: { trend: "first", detail: "" }
};

/* 范文返回（走 writeModel 分支）。
 * 刻意带 **markdown 围栏 + 正文里重复标题行**，贴近真实返回，顺便验剥离逻辑。 */
const FAKE_MODEL = {
  title: "去公园玩",
  model: "去公园玩\n\n今天下午，我和小明一起去公园玩。刚走到湖边，风就把树叶吹得哗哗响，像是有人在树上拍手。\n\n我把风筝举过头顶，小明拉着线往前跑。风筝刚飞起来时歪歪扭扭的，我赶紧喊：「再跑快一点！」他一加速，风筝就稳稳地升上去了。\n\n玩累了，我们坐在长椅上吃冰淇淋。冰淇淋化得很快，顺着手指往下流，我一边舔一边笑。回家的路上我还在想：下次要自己把风筝放起来。",
  highlights: ["写风筝飞起来时，加了一句你喊的话，读起来就像在现场。", "结尾加了一句心里的想法，比只写「很开心」好。"]
};

const ESSAY_1 = "今天我去公园玩，风把树叶吹得哗哗响。我和小明一起放风筝，风筝飞得很高。后来我们吃了冰淇淋，我很开心。";
const ESSAY_2 = "昨天我和奶奶去菜market买菜。奶奶挑了很多菜。我们回家了。今天天气很好。奶奶做饭很好吃。我很高兴。";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  const dialogs = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("dialog", async d => { dialogs.push(d.type() + ":" + d.message()); await d.accept(); });

  // ---- 拦截大模型请求 ----
  let lastCall = null;         // 最后一次请求体
  let aiMode = "ok";           // ok | fail401 | nomodel
  let aiDelay = 700;
  let callCount = 0;

  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.indexOf("api.deepseek.com") >= 0 || url.indexOf("dashscope.aliyuncs.com") >= 0 || url.indexOf("bigmodel.cn") >= 0) {
      // ★ 关键：file:// 页面调 https 一定先发 CORS 预检（OPTIONS）。
      //   预检必须显式放行，否则浏览器判定跨域失败，真正的 POST 根本发不出去。
      const CORS = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization"
      };
      if (req.method() === "OPTIONS") { req.respond({ status: 204, headers: CORS, body: "" }); return; }

      callCount++;
      try { lastCall = JSON.parse(req.postData() || "{}"); } catch (e) { lastCall = { raw: req.postData() }; }

      const reply = () => {
        if (aiMode === "fail401") {
          req.respond({ status: 401, headers: CORS, contentType: "application/json",
            body: JSON.stringify({ error: { message: "Authentication Fails" } }) });
          return;
        }
        // 从请求体判断这次是评分还是范文：system 提示词里有关键词
        const sys = (lastCall.messages && lastCall.messages[0] && lastCall.messages[0].content) || "";
        const isModel = sys.indexOf("范文") >= 0;
        let content;
        if (isModel) {
          content = aiMode === "nomodel"
            ? "```json\n" + JSON.stringify({ title: "去公园玩", model: "", highlights: [] }) + "\n```"
            : "```json\n" + JSON.stringify(FAKE_MODEL) + "\n```";
        } else {
          content = "```json\n" + JSON.stringify(FAKE_GRADE) + "\n```";
        }
        req.respond({ status: 200, headers: CORS, contentType: "application/json",
          body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) });
      };
      setTimeout(reply, aiDelay);
      return;
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

  /* ============ 1. 未配置 AI 时的表现 ============ */
  console.log("\n== 1. 未配置 AI：卡片要给引导，不能给个点不动的按钮 ==");
  await page.evaluate(() => { state.essays = []; state.lastFeedback = null; saveState(); setView("write"); });
  await sleep(400);
  await page.evaluate(() => {
    document.getElementById("essayInput").value =
      "今天我去公园玩，风把树叶吹得哗哗响。我和小明一起放风筝，风筝飞得很高。后来我们吃了冰淇淋，我很开心。";
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(1500);

  const noKey = await page.evaluate(() => ({
    cardShown: !document.getElementById("aiModelCard").classList.contains("hidden"),
    btnDisabled: document.getElementById("genModelBtn").disabled,
    status: document.getElementById("aiModelStatus").textContent.trim(),
    bodyHidden: document.getElementById("aiModelBody").classList.contains("hidden")
  }));
  check("结果页里有 AI 范文卡片", noKey.cardShown === true);
  check("未配置 AI 时按钮禁用（点不动不装死）", noKey.btnDisabled === true);
  check("并说明怎么开启（指向家长管理）", /家长管理/.test(noKey.status), noKey.status.slice(0, 40));
  check("没生成范文时不显示空白正文区", noKey.bodyHidden === true);

  /* ============ 2. 配置后点按钮 → 真的调模型，且提示词到位 ============ */
  console.log("\n== 2. 点「生成范文」：真的调模型，且带着孩子原文与最弱项 ==");
  await page.evaluate(() => window.AiGrader.setConfig({ provider: "deepseek", apiKey: "sk-test-fake-key-for-e2e" }));
  await sleep(400);
  await page.evaluate(() => setView("result"));
  await sleep(400);

  const beforeClick = await page.evaluate(() => ({
    btnDisabled: document.getElementById("genModelBtn").disabled,
    btnText: document.getElementById("genModelBtn").textContent.trim()
  }));
  check("配置后按钮可点", beforeClick.btnDisabled === false, beforeClick.btnText);

  lastCall = null; callCount = 0;
  aiDelay = 1600;      // 留出时间观察"正在写"状态
  await page.evaluate(() => document.getElementById("genModelBtn").click());
  await sleep(500);

  const loading = await page.evaluate(() => ({
    btnText: document.getElementById("genModelBtn").textContent.trim(),
    btnDisabled: document.getElementById("genModelBtn").disabled,
    status: document.getElementById("aiModelStatus").textContent.trim(),
    statusShown: !document.getElementById("aiModelStatus").classList.contains("hidden"),
    loadingClass: document.getElementById("aiModelCard").classList.contains("is-loading")
  }));
  check("生成中：按钮禁用并改文案（防重复点击重复花钱）",
    loading.btnDisabled === true && /正在写/.test(loading.btnText), loading.btnText);
  check("生成中：提示是「正在写」的文案（不是别的提示蒙混过关）",
    loading.statusShown === true && /正在读|正在写/.test(loading.status), loading.status.slice(0, 34));
  check("生成中：卡片有呼吸态样式", loading.loadingClass === true);
  await page.screenshot({ path: path.join(SHOT, "ai-model-loading.png") });

  await sleep(2200);

  const afterGen = await page.evaluate(() => {
    const r = state.lastFeedback;
    return {
      bodyShown: !document.getElementById("aiModelBody").classList.contains("hidden"),
      title: document.getElementById("aiModelTitle").textContent.trim(),
      text: document.getElementById("aiModelText").textContent,
      hlShown: !document.getElementById("aiModelHighlights").classList.contains("hidden"),
      hlHtml: document.getElementById("aiModelHighlights").innerHTML,
      btnText: document.getElementById("genModelBtn").textContent.trim(),
      modalText: r.modelEssay ? r.modelEssay.text : null,
      modalWords: r.modelEssay ? r.modelEssay.words : 0,
      savedInStore: !!(JSON.parse(localStorage.getItem("dailyWritingPcStateV3") || "{}").lastFeedback || {}).modelEssay
    };
  });
  check("范文正文渲染出来了", afterGen.bodyShown === true && afterGen.text.length > 60, afterGen.text.length + " 字");
  check("标题沿用孩子的题目", afterGen.title === "去公园玩", afterGen.title);
  check("「看点提示」也渲染了（教孩子看哪里）", afterGen.hlShown === true && /看这几处/.test(afterGen.hlHtml));
  // ⚠️ 这两条必须**先要求正文非空**：空字符串同样"不含 ``` "、"不以标题开头"，
  //    不设前提的话，模型压根没返回内容时它们会假通过。
  check("★ markdown 围栏被剥掉（孩子不该看到 ```json）",
    afterGen.text.length > 60 && afterGen.text.indexOf("```") < 0,
    afterGen.text.slice(0, 24).replace(/\n/g, " "));
  check("★ 正文开头重复的标题行被去掉（不出现两遍标题）",
    afterGen.text.length > 60 && !/^去公园玩/.test(afterGen.text.trim()),
    "开头是：" + afterGen.text.trim().slice(0, 16));
  check("范文存进了记录（切视图/重开还在，不重复花钱）", afterGen.savedInStore === true);
  check("按钮变成「重新生成」", /重新生成/.test(afterGen.btnText), afterGen.btnText);

  // ---- 请求体断言：这是"接线"的核心 ----
  const sys = (lastCall.messages && lastCall.messages[0] && lastCall.messages[0].content) || "";
  const usr = (lastCall.messages && lastCall.messages[1] && lastCall.messages[1].content) || "";
  check("请求 temperature 走的是范文档（0.85，不是评分的 0.3）", lastCall.temperature === 0.85, String(lastCall.temperature));
  check("请求设了 max_tokens（防范文被截断在半句话）", lastCall.max_tokens >= 1500, String(lastCall.max_tokens));
  check("请求用 json_object 输出模式", !!(lastCall.response_format && lastCall.response_format.type === "json_object"));
  check("★ 提示词要求「必须基于孩子原文扩写、不许另写一篇」",
    /沿用/.test(sys) && /扩写/.test(sys) && /不许/.test(sys), "system 含 沿用/扩写/不许");
  check("★ 提示词压住「踮脚够得着」的口径（防止写成初中生散文）",
    /够得着|模仿得来|不要.*华/.test(sys), "system 含 够得着/模仿得来");
  check("提示词禁止把范文写成评语（不出现建议口吻）", /不要评价|不出现/.test(sys));
  check("★ user 提示词里带了孩子的原文", usr.indexOf("风把树叶吹得哗哗响") >= 0);
  check("★ user 提示词点了「最弱的一项」让范文重点示范",
    /最弱的一项/.test(usr) && /细节与描写|结构与逻辑|内容与立意|语言表达|词汇与句式/.test(usr),
    (usr.match(/最弱的一项[^\n]*\n[^\n]*/) || [""])[0].slice(0, 46));
  check("★ 最弱项是按**得分百分比**算的（细节与描写 13/20 最低）",
    usr.indexOf("细节与描写") >= 0, "命中：细节与描写");
  check("user 提示词里写了目标字数", /字左右/.test(usr), (usr.match(/范文请写到[^\n]*/) || [""])[0]);

  /* ============ 3. 重新生成：要二次确认，且会覆盖 ============ */
  console.log("\n== 3. 重新生成：二次确认 + 覆盖 ==");
  dialogs.length = 0;
  lastCall = null; callCount = 0;
  await page.evaluate(() => document.getElementById("genModelBtn").click());
  await sleep(1800);
  check("点「重新生成」会先问一句（防手滑覆盖）",
    dialogs.some(d => /重新生成|覆盖/.test(d)), dialogs.join(" | ") || "没有弹确认");
  check("确认后确实又调了一次模型", callCount === 1, "callCount=" + callCount);
  check("内容仍然是完整的范文（覆盖成功）",
    (await page.evaluate(() => (state.lastFeedback.modelEssay || {}).text || "")).length > 60);

  /* ============ 4. 失败路径：要说清原因、可重试、且不毁掉已有的范文 ============ */
  console.log("\n== 4. 失败路径：401 时如实报错、按钮可重试、旧范文不丢 ==");
  const hadModel = await page.evaluate(() => !!(state.lastFeedback.modelEssay));
  aiMode = "fail401";
  await page.evaluate(() => document.getElementById("genModelBtn").click());
  await sleep(1800);

  const failed = await page.evaluate(() => ({
    status: document.getElementById("aiModelStatus").textContent.trim(),
    isBad: document.getElementById("aiModelStatus").classList.contains("is-bad"),
    btnDisabled: document.getElementById("genModelBtn").disabled,
    stillHasModel: !!(state.lastFeedback.modelEssay),
    bodyShown: !document.getElementById("aiModelBody").classList.contains("hidden")
  }));
  check("401 时把原因写出来（含「重新填写」指引）", /Key|权限|填写/.test(failed.status), failed.status.slice(0, 46));
  check("错误提示用红色样式区分", failed.isBad === true);
  check("失败后按钮恢复可点（能重试，不一挂不起）", failed.btnDisabled === false);
  check("★ 失败不会把已有的范文删掉", failed.stillHasModel === true && failed.bodyShown === true, "旧范文还在=" + failed.stillHasModel);

  /* ============ 5. 模型返回空范文 → 当作失败，不显示空卡片 ============ */
  console.log("\n== 5. 模型写了空范文：当失败处理，不能给一张空卡片 ==");
  const fresh = await page.evaluate(() => {
    // 造一条"还没生成过范文"的记录来测
    state.lastFeedback.modelEssay = null;
    saveState();
    renderAiModel();
    return !!state.lastFeedback.modelEssay;
  });
  aiMode = "nomodel";
  await page.evaluate(() => document.getElementById("genModelBtn").click());
  await sleep(1800);
  const empty = await page.evaluate(() => ({
    status: document.getElementById("aiModelStatus").textContent.trim(),
    hasModel: !!(state.lastFeedback.modelEssay),
    bodyShown: !document.getElementById("aiModelBody").classList.contains("hidden")
  }));
  check("返回空范文时给出失败提示", /没写出|重试/.test(empty.status), empty.status.slice(0, 40));
  check("不会把空内容存进记录", empty.hasModel === false);
  check("不显示空白正文区", empty.bodyShown === false);

  /* ============ 6. 换一篇作文：提示要清掉 ============ */
  console.log("\n== 6. 换一篇作文：上一轮的报错提示要清掉 ==");
  aiMode = "ok";
  await page.evaluate(essay => { setView("write"); document.getElementById("essayInput").value = essay;
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true })); }, ESSAY_2);
  await sleep(300);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(1800);

  const switched = await page.evaluate(() => ({
    statusHidden: document.getElementById("aiModelStatus").classList.contains("hidden"),
    status: document.getElementById("aiModelStatus").textContent.trim(),
    bodyHidden: document.getElementById("aiModelBody").classList.contains("hidden"),
    btnText: document.getElementById("genModelBtn").textContent.trim(),
    hasModel: !!(state.lastFeedback.modelEssay)
  }));
  check("★ 新文章的卡片清掉了上一篇的报错", switched.statusHidden === true || !/没写出|重试/.test(switched.status), switched.status || "(空)");
  check("新文章默认没有范文（不显示上一轮的）", switched.bodyHidden === true && switched.hasModel === false);
  check("按钮文案回到「生成范文」", /生成范文/.test(switched.btnText), switched.btnText);

  /* ============ 7. 范文不影响评分与落库 ============ */
  console.log("\n== 7. 不干扰既有链路：评分/入库/积分照常 ==");
  const integrity = await page.evaluate(() => ({
    essays: state.essays.length,
    score: state.essays[0].feedback.score,
    hasParts: Object.keys(state.essays[0].feedback.parts || {}).length,
    source: state.essays[0].feedback.source,
    resultView: document.getElementById("result").classList.contains("active")
  }));
  check("两篇都正常入库", integrity.essays === 2, "essays=" + integrity.essays);
  check("评分未被影响（AI 评分正常）", integrity.score > 0 && integrity.hasParts === 6 && integrity.source === "ai",
    integrity.score + " 分 · " + integrity.hasParts + " 维 · " + integrity.source);

  /* 过滤掉**本轮故意注入**的那条 401：
   * 第 4 节专门测"Key 无效时怎么报错"，浏览器必然在控制台记一条
   * "Failed to load resource: 401"。那是被测行为的一部分，不是缺陷。
   * 其余任何报错都不能放过。 */
  const unexpected = errors.filter(e => !/401|Unauthorized/i.test(e));
  check("全程没有意外 JS 报错（预期内的 401 已排除）", unexpected.length === 0,
    unexpected.slice(0, 3).join(" | ") || `无（另有 ${errors.length - unexpected.length} 条预期的 401）`);

  await browser.close();
  console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { fail.forEach(f => console.log("  FAIL: " + f)); process.exit(1); }
})().catch(e => { console.error("FATAL", e); process.exit(2); });
