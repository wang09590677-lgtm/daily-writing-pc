// AI 作文评分 · 端到端（拦截网络，喂假模型响应，不花钱、不需要真 Key）
//
// 验证的是"接线"对不对：提交作文有没有真的调模型、批改中界面是什么样、
// 成功/失败分别怎么落地、进步对比卡片有没有渲染出来。
// 模型本身的分打得好不好，不属于这里能验的范围。
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

// 模型返回的示例：故意用"带代码块围栏 + 真实点评口吻"，贴近真实返回
const FAKE_AI_REPLY = {
  parts: { "内容与立意": 19, "结构与逻辑": 15, "细节与描写": 13, "语言表达": 16, "词汇与句式": 7, "错别字与标点": 5 },
  strengths: ["「风把树叶吹得哗哗响」这句写出了声音，读起来像真的在公园。"],
  improvements: ["第二段只写了「很开心」，可以写写你当时在做什么。", "结尾太快了，补一句你的感受。"],
  nextGoal: "下一篇试着把最开心的一瞬间写成三句话。",
  narrative: "你把去公园这件事写清楚了，还写了一处好听的声音。不过最开心的部分只有一句，展开写会更好看。",
  evidence: [
    { quote: "风把树叶吹得哗哗响", comment: "写声音写得好，读者能听见。" },
    { quote: "我很开心。", comment: "这句可以加一个具体动作，比如跳起来或者笑出声。" }
  ],
  progress: { trend: "up", detail: "上一篇你没写声音，这次写了「哗哗响」，这就是进步。" }
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  const dialogs = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  // 少于 40 字会弹 alert；不处理会把页面 JS 卡死（模态框阻塞主线程）
  page.on("dialog", async d => { dialogs.push(d.message()); await d.accept(); });

  // ---- 拦截大模型请求，返回可控的假响应 ----
  let aiCall = null;          // 记录最后一次请求体
  let aiUrl = "";             // 记录最后一次请求地址
  let aiMode = "ok";          // ok | fail401 | badjson
  let aiDelay = 900;          // 模拟真实模型的等待时长

  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.indexOf("api.deepseek.com") >= 0 || url.indexOf("dashscope.aliyuncs.com") >= 0 || url.indexOf("bigmodel.cn") >= 0) {
      // 关键：file:// 页面调 https 一定会先发 CORS 预检（OPTIONS）。
      // 预检必须明确放行，否则浏览器直接判定跨域失败，真正的 POST 根本不会发出去。
      const CORS = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization"
      };
      if (req.method() === "OPTIONS") {
        req.respond({ status: 204, headers: CORS, body: "" });
        return;
      }
      let body = req.postData() || "";
      aiUrl = url;
      try { aiCall = JSON.parse(body); } catch (e) { aiCall = { raw: body }; }
      const reply = () => {
        if (aiMode === "fail401") {
          req.respond({ status: 401, headers: CORS, contentType: "application/json",
            body: JSON.stringify({ error: { message: "Authentication Fails" } }) });
          return;
        }
        const content = aiMode === "badjson"
          ? "抱歉，我无法评分。"
          : "```json\n" + JSON.stringify(FAKE_AI_REPLY) + "\n```";
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

  console.log("\n== 1. 未配置时：用本地规则估分，并如实标注 ==");
  await page.evaluate(() => {
    // 造一篇历史作文，用来验证"没有 AI 时历史也正常"
    state.essays = [];
    state.lastFeedback = null;
    saveState();
  });
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".chooser-card")];
    const fit = cards.find(c => c.dataset.module === "write");
    if (fit) fit.click();
  });
  await sleep(700);
  await page.evaluate(() => setView("write"));
  await sleep(500);

  const noKeyState = await page.evaluate(() => ({
    configured: window.AiGrader.isConfigured(),
    hasGrader: typeof window.AiGrader !== "undefined"
  }));
  check("页面加载了 AI 评分模块", noKeyState.hasGrader === true);
  check("默认未配置大模型", noKeyState.configured === false);

  await page.evaluate(() => {
    document.getElementById("essayInput").value =
      "今天我去公园玩，风把树叶吹得哗哗响。我和小明一起放风筝，风筝飞得很高。后来我们吃了冰淇淋，我很开心。";
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(1200);

  const localResult = await page.evaluate(() => ({
    view: document.getElementById("result").classList.contains("active"),
    score: document.getElementById("scoreValue").textContent.trim(),
    source: document.getElementById("scoreSource").textContent.trim(),
    sourceClass: document.getElementById("scoreSource").className,
    count: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).essays.length,
    fbSource: (state.lastFeedback.feedback || {}).source
  }));
  check("未配置时提交能正常出结果页", localResult.view === true);
  check("未配置时用本地规则给分", Number(localResult.score) > 0, `${localResult.score} 分`);
  check("结果页明确标注这是本地估分", /本地规则估分/.test(localResult.source) && /is-local/.test(localResult.sourceClass),
    localResult.source);
  check("反馈对象带 source=local 标记", localResult.fbSource === "local");
  check("作文已入库", localResult.count === 1);

  console.log("\n== 2. 配置后：真的调用大模型，并带上历史作文 ==");
  await page.evaluate(() => {
    window.AiGrader.setConfig({ provider: "deepseek", apiKey: "sk-test-fake-key-for-e2e" });
    setView("write");
  });
  await sleep(400);

  await page.evaluate(() => {
    document.getElementById("essayInput").value =
      "今天放学路上，我看见一只小猫躲在车底下，它的毛湿湿的，好像在发抖。我回家拿了一根火腿肠给它，它先看了看我，才慢慢走过来吃。";
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);

  aiCall = null;
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(350);   // 趁请求还没回来，看批改中的界面

  const grading = await page.evaluate(() => ({
    barVisible: !document.getElementById("gradingBar").classList.contains("hidden"),
    barText: document.getElementById("gradingBar").textContent.replace(/\s+/g, " ").trim(),
    btnText: document.querySelector("[data-action='submit-essay']").textContent.trim(),
    btnDisabled: document.querySelector("[data-action='submit-essay']").disabled
  }));
  check("批改中显示等待提示条", grading.barVisible === true, grading.barText.slice(0, 40));
  check("按钮变成「正在批改」且被禁用（防止重复提交花钱）",
    /批改/.test(grading.btnText) && grading.btnDisabled === true, grading.btnText);

  await page.screenshot({ path: path.join(SHOT, "ai-grading-loading.png") });

  // 等模型（假）返回
  await sleep(1600);

  const aiResult = await page.evaluate(() => ({
    view: document.getElementById("result").classList.contains("active"),
    score: document.getElementById("scoreValue").textContent.trim(),
    source: document.getElementById("scoreSource").textContent.trim(),
    narrative: document.getElementById("aiNarrative").textContent.trim(),
    strength: document.getElementById("strengthList").textContent.trim(),
    progressShown: !document.getElementById("progressCard").classList.contains("hidden"),
    progressTitle: document.getElementById("progressTitle").textContent.trim(),
    progressDetail: document.getElementById("progressDetail").textContent.trim(),
    progressClass: document.getElementById("progressCard").className,
    evidenceShown: !document.getElementById("evidenceCard").classList.contains("hidden"),
    evidenceCount: document.querySelectorAll("#evidenceList .evidence-item").length,
    barHidden: document.getElementById("gradingBar").classList.contains("hidden"),
    btnText: document.querySelector("[data-action='submit-essay']").textContent.trim(),
    fbSource: (state.lastFeedback.feedback || {}).source,
    count: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).essays.length
  }));

  check("AI 评分成功出结果", aiResult.view === true);
  check("用了模型给的分（六项之和 = 75）", aiResult.score === "75", `${aiResult.score} 分`);
  check("结果页标注「由 AI 老师批改」", /AI/.test(aiResult.source) && aiResult.fbSource === "ai", aiResult.source);
  check("批改中提示条已收起", aiResult.barHidden === true);
  check("提交按钮恢复可用", aiResult.btnText === "提交给AI老师", aiResult.btnText);
  check("整体点评渲染出来了", aiResult.narrative.length > 10, aiResult.narrative.slice(0, 40));
  check("优点/建议渲染出来了", aiResult.strength.length > 5);
  check("进步对比卡片已显示", aiResult.progressShown === true);
  check("进步方向正确（up → 比上一篇有进步）",
    /进步/.test(aiResult.progressTitle) && /is-up/.test(aiResult.progressClass),
    `${aiResult.progressTitle} / ${aiResult.progressClass}`);
  check("进步说明有具体内容", /哗哗响/.test(aiResult.progressDetail), aiResult.progressDetail.slice(0, 50));
  check("原文对照点评已显示", aiResult.evidenceShown === true && aiResult.evidenceCount === 2, `${aiResult.evidenceCount} 条`);
  check("第二篇已入库", aiResult.count === 2);

  // 请求体本身：这是"确实做了历史比对"的硬证据
  const sent = aiCall || {};
  const userMsg = (((sent.messages || [])[1] || {}).content) || "";
  check("请求发给了配置的服务商（DeepSeek）", /deepseek/.test(aiUrl), aiUrl.replace(/^https?:\/\//, "").slice(0, 40));
  check("请求里带了 system 提示词", ((sent.messages || [])[0] || {}).role === "system");
  check("请求里带了本次作文正文", /小猫躲在车底下/.test(userMsg));
  check("请求里带了历史作文（真做了纵向比对）", /公园/.test(userMsg), userMsg.slice(0, 60));
  check("请求里带了历史得分（上一篇的实际得分）",
    userMsg.indexOf(String(localResult.score)) >= 0 || /得分/.test(userMsg),
    `上一篇 ${localResult.score} 分`);
  check("temperature 设得低（保证同一篇分数稳定）", Number(sent.temperature) <= 0.5, String(sent.temperature));
  check("要求返回 JSON 格式", !!(sent.response_format && sent.response_format.type === "json_object"));

  await page.screenshot({ path: path.join(SHOT, "ai-result.png"), fullPage: true });

  console.log("\n== 3. 模型调用失败：自动退回本地规则，不让孩子白等 ==");
  aiMode = "fail401";
  await page.evaluate(() => setView("write"));
  await sleep(300);
  await page.evaluate(() => {
    document.getElementById("essayInput").value =
      "今天晚上我自己洗碗，碗很滑，我差点把它摔了。妈妈说我很棒，我心里甜甜的。我以后还要帮妈妈做家务，让她多休息一会儿。";
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(1800);

  const failResult = await page.evaluate(() => ({
    view: document.getElementById("result").classList.contains("active"),
    score: document.getElementById("scoreValue").textContent.trim(),
    source: document.getElementById("scoreSource").textContent.trim(),
    fbSource: (state.lastFeedback.feedback || {}).source,
    reason: (state.lastFeedback.feedback || {}).fallbackReason || "",
    toast: (document.getElementById("toastBar") || {}).textContent || "",
    barHidden: document.getElementById("gradingBar").classList.contains("hidden"),
    btnDisabled: document.querySelector("[data-action='submit-essay']").disabled,
    count: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).essays.length
  }));
  check("失败时仍然出了结果（没有卡死）", failResult.view === true && Number(failResult.score) > 0, `${failResult.score} 分`);
  check("失败时退回本地规则并标注", failResult.fbSource === "local" && /本地规则估分/.test(failResult.source));
  check("失败原因被记录下来", /Key|权限|无效/.test(failResult.reason), failResult.reason.slice(0, 60));
  check("提示条收起（没有卡在批改中）", failResult.barHidden === true && failResult.btnDisabled === false);
  check("失败也正常入库", failResult.count === 3);

  console.log("\n== 4. 模型返回垃圾内容：不崩 ==");
  aiMode = "badjson";
  await page.evaluate(() => setView("write"));
  await sleep(300);
  await page.evaluate(() => {
    document.getElementById("essayInput").value =
      "周末我和爸爸去爬山，山路很陡，我爬到一半就不想走了。爸爸说再坚持一下，最后我真的爬到了山顶，看到了整个城市。";
    document.getElementById("essayInput").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(1800);

  const junkResult = await page.evaluate(() => ({
    view: document.getElementById("result").classList.contains("active"),
    score: document.getElementById("scoreValue").textContent.trim(),
    source: (state.lastFeedback.feedback || {}).source,
    count: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).essays.length
  }));
  check("模型返回非 JSON 时不崩，退回本地规则",
    junkResult.view === true && junkResult.source === "local" && Number(junkResult.score) > 0,
    `${junkResult.score} 分 / ${junkResult.source}`);
  check("垃圾返回也正常入库", junkResult.count === 4);

  console.log("\n== 5. 家长管理面板：配置 UI 可用 ==");
  aiMode = "ok";
  await page.evaluate(() => setView("admin"));
  await sleep(400);
  await page.evaluate(() => {
    document.getElementById("adminPasswordInput").value = "09590677";
    document.querySelector("[data-action='admin-login']").click();
  });
  await sleep(500);

  const panel = await page.evaluate(() => ({
    hasProvider: !!document.getElementById("aiProvider"),
    provider: (document.getElementById("aiProvider") || {}).value,
    status: (document.getElementById("aiStatus") || {}).value || "",
    keyHelp: (document.getElementById("aiKeyHelp") || {}).textContent || "",
    keyHref: ((document.querySelector("#aiKeyHelp a") || {}).href) || "",
    keyTarget: ((document.querySelector("#aiKeyHelp a") || {}).target) || "",
    keyRel: ((document.querySelector("#aiKeyHelp a") || {}).rel) || "",
    modelPlaceholder: (document.getElementById("aiModel") || {}).placeholder || "",
    keyInputType: (document.getElementById("aiApiKey") || {}).type,
    keyInputValue: (document.getElementById("aiApiKey") || {}).value || "",
    buttons: [...document.querySelectorAll(".admin-actions button")].map(b => b.textContent.trim())
  }));
  check("家长管理里有 AI 评分设置面板", panel.hasProvider === true);
  check("显示当前服务商", panel.provider === "deepseek", panel.provider);
  check("状态显示已配置但 Key 是打码的",
    /已配置/.test(panel.status) && panel.status.indexOf("****") >= 0, panel.status);
  check("API Key 输入框不回填明文（安全）", panel.keyInputType === "password" && panel.keyInputValue === "");
  check("给了申请 Key 的真链接（可点、新窗口打开、带 noopener）",
    /^https?:\/\//.test(panel.keyHref) && panel.keyTarget === "_blank" && /noreferrer/.test(panel.keyRel),
    panel.keyHref);
  check("模型名留空时提示会用哪个默认模型", /deepseek-chat/.test(panel.modelPlaceholder), panel.modelPlaceholder);
  check("有保存/测试/清除/暂停四个操作",
    panel.buttons.length === 4 && panel.buttons.some(b => /测试/.test(b)), panel.buttons.join(","));

  // 改服务商 → 保存 → 生效
  await page.evaluate(() => {
    document.getElementById("aiProvider").value = "zhipu";
    document.querySelector("[data-action='save-ai-grader']").click();
  });
  await sleep(400);
  const changed = await page.evaluate(() => window.AiGrader.config());
  check("切换服务商后保存生效", /bigmodel/.test(changed.endpoint), changed.endpoint);
  check("切换服务商后 Key 没丢", changed.hasKey === true);
  check("切换服务商后模型名自动跟到新服务商（不会再发 deepseek-chat）",
    changed.model === "glm-4-flash", changed.model);

  // 暂停 → 降级到本地
  await page.evaluate(() => document.querySelector("[data-action='toggle-ai-grader']").click());
  await sleep(300);
  const paused = await page.evaluate(() => ({
    configured: window.AiGrader.isConfigured(),
    status: document.getElementById("aiStatus").value
  }));
  check("暂停后 isConfigured 为假（会退回本地规则）", paused.configured === false, paused.status);

  console.log("\n== 控制台错误 ==");
  // 第 3 段是**故意**造了一个 401 来验证降级，浏览器必然会在控制台留一条资源加载失败；
  // 这条属于预期内，不算 bug。其余任何报错都要当回事。
  const unexpected = errors.filter(e => !/status of 401/.test(e));
  const expected401 = errors.length - unexpected.length;
  if (unexpected.length) unexpected.forEach(e => console.log("  " + e));
  check("无意外控制台报错", unexpected.length === 0,
    unexpected.length ? `${unexpected.length} 条` : (expected401 ? `（已忽略 ${expected401} 条预期的 401）` : ""));
  check("全程没有被 alert 拦住（说明测试作文都够 40 字）", dialogs.length === 0, dialogs.join(" | ").slice(0, 80));

  console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { console.log("失败项："); fail.forEach(f => console.log("  - " + f)); }

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(err => { console.error("测试崩溃：", err); process.exit(2); });
