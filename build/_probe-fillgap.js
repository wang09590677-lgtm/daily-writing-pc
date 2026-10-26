#!/usr/bin/env node
/* 文章补写：浏览器端到端验收（真 Chrome + 真 DOM，不 mock）。
 *
 * 为什么不能只靠 Node 里的离线断言：
 *   · 「挖空的位置孩子看不出来」是**渲染层**的性质 —— Node 里 normalize 全绿，
 *     但 renderFillArticle 一不小心把 paragraphs 全画出来，答案就白送了。
 *   · 「额外加分进不进当日总分」也一样：ai-grader 里 score 加对了，
 *     但 dayDetail 不读它就白做 —— 必须走真的 state/essays/renderAll。
 *
 * 因此这个探针里所有断言都读**真实的浏览器状态**：
 *   window.__fillgap* 是 app.js 末尾挂的测试钩子（只在 ?test=fillgap 时可用）。
 *
 * 用法：node build/_probe-fillgap.js [--headful]
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules";

let puppeteer;
try {
  puppeteer = require(path.join(NODE_MODULES, "puppeteer-core"));
} catch (e) {
  try { puppeteer = require("puppeteer-core"); }
  catch (e2) {
    console.error("找不到 puppeteer-core，请检查 NODE_MODULES 路径");
    process.exit(2);
  }
}

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?test=fillgap";
const VIEW = { width: 1440, height: 960 };
const HEADFUL = process.argv.includes("--headful");

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra !== undefined ? "  → " + extra : ""}`); }
}
function section(t) { console.log(`\n── ${t}`); }

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-fillgap-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir]
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.setViewport(VIEW);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  page.on("console", m => { if (m.type() === "error") errors.push("[console] " + m.text()); });
  page.on("dialog", d => d.accept());

  await page.goto(INDEX, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(1200);

  /* ---------- 0｜基线：页面没炸、素材库读到了 ---------- */
  section("0｜加载基线");
  // 探针要按真实流程"提交"，得先把门禁拆掉（钩子里会替换 ensureGate），
  // 但页面加载时还不能动 state —— 先清空历史，避免上次跑的残留记录干扰
  await page.evaluate(() => { try { window.__fillgap.reset(); } catch (e) {} });

  const boot = await page.evaluate(() => ({
    ok: !!(window.__fillgap && window.__fillgap.stats),
    stats: window.__fillgap ? window.__fillgap.stats() : null,
    hasAudioView: !!document.getElementById("audio"),
    hasFillView: !!document.getElementById("fillgap"),
    loadErrors: []
  }));
  ok(errors.length === 0, "页面加载无 JS 报错", errors.slice(0, 3).join(" | "));
  ok(boot.hasFillView, "#fillgap 视图存在");
  ok(!boot.hasAudioView, "旧的 #audio 视图已移除");
  ok(boot.ok, "测试钩子 __fillgap 可用");

  /* 首屏是模块选择页 —— 先"进入写作"，否则后面所有构图量测都会是 0 */
  const entered = await page.evaluate(() => {
    window.__fillgap.enterWriteModule("fillgap");
    const shell = document.getElementById("appShell");
    const chooser = document.getElementById("moduleChooser");
    return {
      module: state_module_probe(),
      shellVisible: shell ? !shell.classList.contains("hidden") : false,
      chooserHidden: chooser ? chooser.classList.contains("hidden") : true
    };
    function state_module_probe() { return document.body.className.indexOf("module-fitness") >= 0 ? "fitness" : "write"; }
  });
  ok(entered.shellVisible && entered.chooserHidden, "已进入写作模块（模块选择页收起）");

  if (boot.stats) {
    const s = boot.stats;
    console.log(`     素材库：${s.count} 篇 / 挖空 中位 ${s.medianGap} 字（${s.minGap}~${s.maxGap}）/ 全文最长 ${s.maxChars} 字`);
    console.log(`     分类：${s.catsOrdered.map((c, i) => c + s.catsCount[i]).join(" ")}`);
    /* ★ 2026-10-18 规格变更：原来是「≥200 篇」，那是按民国散文库（210 篇）定的。
     *   用户看过旧库后明确要求「先不追求凑够 200 篇」，改以难度达标为唯一门槛 ——
     *   旧库 210 篇里合适率只有 33/210，新库 80 篇里合适率 72/80。
     *   所以门槛改成「≥60 篇」：够孩子每天抽一篇、两个月不重样即可。
     *   ⚠️ 这条不达标**不代表功能坏了**，只代表库存少。 */
    ok(s.count >= 60, `素材库 ≥60 篇（实际 ${s.count}）`);
    ok(s.minGap >= 280, `★ 最小挖空 ≥280 字（实际 ${s.minGap}）`);
    ok(s.medianGap >= 300, `中位挖空 ≥300 字（实际 ${s.medianGap}）`);
    ok(s.maxChars <= 3000, `最长文章 ≤3000 字（实际 ${s.maxChars}）`);
    ok(s.catsOrdered.length >= 3, `题材 ≥3 类（实际 ${s.catsOrdered.join("/")}）`);
    ok(s.catsOrdered[0] === "记事", "分类顺序固定从「记事」开始", s.catsOrdered.join("/"));
    ok(s.badSkills.length === 0, "所有文章的训练能力都在 8 个技能键里", s.badSkills.join("/"));
    ok(s.firstStartsAtFirst === false, "★ 没有任何一篇挖到第一段");
    ok(s.anyGapAtTail === false, "★ 没有任何一篇挖到最后一段");
  }

  /* ---------- 1｜选题页：预览区不能泄露答案 ---------- */
  section("1｜选题页渲染与防泄题");
  await page.click('[data-view="fillgap"]').catch(() => {});
  await sleep(400);

  const preview = await page.evaluate(() => {
    const body = document.getElementById("fillBody");
    const api = window.__fillgap;
    const art = api.current();
    const text = body ? body.innerText : "";
    // 拿出"被挖掉那几段的原文"，逐段看有没有出现在预览区
    const leaked = art ? art.gapParas.filter(p => p && p.length > 12 && text.indexOf(p.slice(0, 12)) >= 0) : [];
    return {
      title: (document.getElementById("fillTitle") || {}).textContent || "",
      meta: (document.getElementById("fillMeta") || {}).textContent || "",
      holes: body ? body.querySelectorAll(".fill-gap-hole").length : 0,
      leaked: leaked.length,
      leakedSample: leaked[0] ? leaked[0].slice(0, 20) : "",
      rawInDom: text.indexOf("第" + (art ? art.gapStart + 1 : 0) + "段") // 夹具无关，真数据用不到
    };
  });
  ok(preview.holes >= 1, "预览区画出了挖空占位块");
  ok(preview.leaked === 0, "★ 预览区没有泄露被挖掉的原文", preview.leakedSample);
  ok(preview.meta.indexOf("挖掉") >= 0, "元信息里写明了挖空段落数与字数", preview.meta);

  /* ---------- 2｜开始补写：写作页也不能泄露 ---------- */
  section("2｜写作页渲染与防泄题");
  // 补写要过门禁（每日必写）→ 直接调钩子跳过门禁那一步，只验渲染
  const writeRender = await page.evaluate(() => {
    const api = window.__fillgap;
    const started = api.startForTest();
    const card = document.getElementById("activeMaterialCard");
    const text = card ? card.innerText : "";
    const art = api.current();
    const leaked = art ? art.gapParas.filter(p => p && p.length > 12 && text.indexOf(p.slice(0, 12)) >= 0) : [];
    return {
      started,
      view: api.showView ? null : null,
      hidden: card ? card.classList.contains("hidden") : true,
      holes: card ? card.querySelectorAll(".fill-gap-hole").length : 0,
      paras: card ? card.querySelectorAll(".fill-para").length : 0,
      leaked: leaked.length,
      leakedSample: leaked[0] ? leaked[0].slice(0, 24) : "",
      totalParas: art ? art.paragraphs.length : 0,
      gapCount: art ? art.gapCount : 0,
      answerInActive: !!api.activeAnswer()
    };
  });
  ok(writeRender.started.ok, "开始补写成功（走了真 startFillWriting）", writeRender.started.why);
  ok(!writeRender.hidden, "写作页正文卡片显示出来了");
  ok(writeRender.holes === 1, "连续多段只画一个占位块（不重复画空框）", writeRender.holes);
  ok(writeRender.paras === writeRender.totalParas - writeRender.gapCount,
    "★ 正文只画了没被挖掉的段落", `${writeRender.paras} vs ${writeRender.totalParas}-${writeRender.gapCount}`);
  ok(writeRender.leaked === 0, "★ 写作页 DOM 里没有被挖掉的原文", writeRender.leakedSample);
  ok(writeRender.answerInActive, "答案仍在 activeWriting 里（提交时才用得到）");

  // 抓一份浏览器里真实的可见文本，交给 Node 侧独立复核（不信任页面自报的 leaked）
  const domText = await page.evaluate(() => {
    const a = document.getElementById("activeMaterialCard");
    return a ? a.innerText : "";
  });
  const gapParas = await page.evaluate(() => window.__fillgap.current().gapParas);
  const leakedByNode = gapParas.filter(p => p && p.length > 12 && domText.indexOf(p.slice(0, 12)) >= 0);
  ok(leakedByNode.length === 0, "★（Node 侧独立复核）DOM 全文里搜不到任何被挖段落", leakedByNode[0] && leakedByNode[0].slice(0, 20));

  /* ---------- 3｜提交一份"比原文好"的补写，走完整评分链路 ---------- */
  section("3｜提交 → 对照渲染 → 加分进当日总分");
  // 当日总分的闸 = 「每日必写」做完了。没做完时 dayScore 恒为 0（既有口径），
  // 所以先预置一篇每日必写，否则验不出"补写的分有没有进总分"。
  const seeded = await page.evaluate(() => window.__fillgap.seedDailyEssay());
  ok(seeded.dayDone, "预置每日必写后，当日总分闸门已打开");

  const result = await page.evaluate(async () => {
    // gradeFill 已在钩子里换成本地预制结果（形状由真 normalizeFillGrade 生成），
    // 其余全程真代码：submitEssay → finish → essays → renderAll → setView("result")
    return window.__fillgap.simulateSubmit("clear");
  });
  ok(result.alerts.length === 0, "提交时没有被字数门槛拦下", result.alerts.join(" | "));
  ok(result.submitted, "补写记录已落库", JSON.stringify(result).slice(0, 200));
  ok(result.kind === "fillgap", "feedback 带 kind=fillgap 标记（历史渲染据此选分支）", result.kind);
  ok(result.recordHasFillGap, "记录里留住了完整原文 + 被挖段落", result.recordGapParagraphs);
  ok(result.view === "result", "提交后自动跳到结果页", result.view);
  ok(result.compareVisible, "结果页的「你补的 vs 原文」卡片显示出来了");
  ok(result.compareRows >= 1, "对照区至少一行", result.compareRows);
  ok(result.compareChildCols >= 1, "对照区有「你补写的」栏", result.compareChildCols);
  ok(result.compareOrigCols >= 1, "★ 对照区有「原文」栏（并列展示是核心需求）", result.compareOrigCols);
  ok(result.bonusVisible, "额外加分区显示出来了");
  ok(/\+/.test(result.bonusBadge), "加分徽章带 + 号", result.bonusBadge);
  ok(result.bonus > 0 && result.bonus <= 10, "加分在 0~10 的硬上限内", result.bonus);
  ok(result.bonusInScore, "★ 额外加分并进了 feedback.score", `${result.base} + ${result.bonus} = ${result.score}`);
  ok(result.dailyDone, "当日必写状态正确（补写不顶替每日必写）", String(result.dailyDone));
  ok(result.scoreInDayTotal, "★ 本次得分（含加分）进了当日总分", `day=${result.dayScore} score=${result.score}`);

  /* ---------- 3b｜"写得更好"这段话必须真的指向孩子原文，不是套话 ---------- */
  section("3b｜表扬区指向具体段落");
  const bonusDetail = await page.evaluate(() => {
    const box = document.getElementById("fillBonusBox");
    const items = box ? [...box.querySelectorAll("li")].map(li => li.innerText) : [];
    return { count: items.length, items: items.slice(0, 3), text: box ? box.innerText.slice(0, 300) : "" };
  });
  ok(bonusDetail.count >= 2, "表扬区列出了至少 2 条具体优势", bonusDetail.count);
  ok(bonusDetail.text.length > 20, "表扬区不是空壳", bonusDetail.text.slice(0, 60));

  /* ---------- 4｜普通作文的记录不该显示对照区 ---------- */
  section("4｜非补写记录不显示对照卡");
  const plain = await page.evaluate(() => window.__fillgap.simulatePlainResult());
  ok(plain.compareHidden, "普通作文的结果页里对照卡是收起的");

  /* ---------- 5｜AI 生成的门禁 ---------- */
  section("5｜AI 生成的门禁与失败提示");
  const gate = await page.evaluate(() => {
    window.__fillgap.enterWriteModule("fillgap");
    return window.__fillgap.aiGate();
  });
  ok(/AI 生成/.test(gate.buttonText), "AI 按钮文案正确", gate.buttonText);
  ok(typeof gate.configured === "boolean", "能读到 AI 是否已配置", String(gate.configured));
  if (!gate.configured) {
    const r = await page.evaluate(() => window.__fillgap.clickAiWithoutKey());
    ok(r.toasted && /API Key|配置/.test(r.text), "★ 没配 Key 时点 AI 生成会明确提示，而不是静默失败", r.text);
  }

  /* ---------- 6｜构图截图（R7：必须真的看一眼） ---------- */
  section("6｜构图");
  /* 第 5 项点过「AI 生成」，toast 的显示期是 2.6 秒 —— 不主动收掉，
   * 它就会横在正文中间被拍进截图，看起来像"文字被一条横条盖住"。
   * （第一版截图真踩到了：我一度以为是层叠 bug，查了半天 DOM 才发现是 toast。） */
  await page.evaluate(() => {
    const t = document.getElementById("toastBar");
    if (t) { t.classList.remove("show"); t.textContent = ""; }
  });
  await sleep(300);
  /* 回到"还没开始补写"的状态再截图：选题页 + 挖空预览都要在画面里 */
  const viewNow = await page.evaluate(() => {
    window.__fillgap.enterWriteModule("fillgap");
    window.scrollTo(0, 0);
    return window.__fillgap.currentView();
  });
  await sleep(600);
  ok(viewNow === "fillgap", "切回文章补写页", viewNow);

  const shotDir = path.join(ROOT, "build", "_shots");
  fs.mkdirSync(shotDir, { recursive: true });
  const shotFill = path.join(shotDir, "fillgap-view.png");
  await page.screenshot({ path: shotFill, fullPage: true });
  const layout = await page.evaluate(() => {
    const view = document.getElementById("fillgap");
    const card = view ? view.querySelector(".fill-card") : null;
    const body = document.getElementById("fillBody");
    const r = card ? card.getBoundingClientRect() : null;
    const rect = view ? view.getBoundingClientRect() : null;
    return {
      viewActive: view ? view.classList.contains("active") : false,
      cardFound: !!card,
      cardW: r ? Math.round(r.width) : 0,
      cardTop: r ? Math.round(r.top) : 0,
      overflowX: body ? body.scrollWidth - body.clientWidth : 0,
      viewH: rect ? Math.round(rect.height) : 0,
      // 页面级横向溢出：最常见的"卡片被撑宽"症状
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  ok(layout.viewActive, "视图处于激活状态（否则量到的都是 0px）");
  ok(layout.cardFound, "主卡片存在");
  ok(layout.cardW > 600, `主卡片宽度正常（${layout.cardW}px）`);
  ok(layout.overflowX <= 2, "正文区没有横向溢出", String(layout.overflowX));
  ok(layout.docOverflowX <= 2, "整页没有横向滚动条", String(layout.docOverflowX));

  /* 结果页截图：用 great 档，把"表扬 + 满分加分"的样子拍下来 */
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await window.__fillgap.simulateSubmit("great");
    window.scrollTo(0, 0);
  });
  await sleep(600);
  const shotResult = path.join(shotDir, "fillgap-result.png");
  await page.screenshot({ path: shotResult, fullPage: true });

  /* 结果页的对照卡必须在首屏可见范围之内（否则孩子根本看不到"原文长什么样"） */
  const cardPos = await page.evaluate(() => {
    const el = document.getElementById("fillCompareCard");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      h: Math.round(r.height),
      visible: !el.classList.contains("hidden")
    };
  });
  if (cardPos) {
    console.log(`     对照卡：顶 ${cardPos.top}px / 高 ${cardPos.h}px / 可见 ${cardPos.visible}`);
    ok(cardPos.h > 80, "对照卡高度正常（不是被压扁的空壳）", cardPos.h);
    ok(cardPos.visible, "对照卡在结果页是展开的");
  } else {
    ok(false, "结果页找不到对照卡");
  }

  ok(errors.length === 0, "全程无 JS 报错", errors.slice(0, 4).join(" | "));

  await browser.close();
  console.log(`\n截图：\n  ${shotFill}\n  ${shotResult}`);
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass}/${pass + fail}`);
  if (fail) { console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => {
  console.error("探针异常：", e);
  process.exit(2);
});
