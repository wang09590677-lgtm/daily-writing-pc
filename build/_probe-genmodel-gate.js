/* 「AI 范文参考」按钮：门禁 + 版式 + 端到端接线的只读探针。
 *
 * 老李的要求（原话）：
 *   「把这个选项按钮做的再大一些，位置放到AI打分按钮旁边，
 *     不过是需要先AI打分完毕，之后这个 AI范文参考 才能生效（未生效时按钮式是灰色）」
 *
 * 要证的三件事，一件都不能省：
 *   ① 版式：写作页两个按钮**同一行**、范文按钮**更大**、门禁说明行有字；
 *   ② 门禁：没评分 / 批改中 / 草稿改过 / 没配 Key ⇒ 灰；
 *          有评分且草稿没改过 ⇒ 亮；
 *   ③ 接线：点它真的跳到结果页、真的发起生成、真的把范文存进记录。
 *
 * ⚠️ 门禁 ② 里"没配 Key ⇒ 灰"这一条，在无网无 Key 的探针里天然成立，
 *    所以要先**把 isConfigured 打桩成 true** 才能测"有评分 ⇒ 亮"。
 *    打桩只改探针进程内的页面，不动产品代码。
 *
 * 用法：NODE_PATH=... node build/_probe-genmodel-gate.js
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

const ESSAY = [
  "第一次学做饭",
  "",
  "今天我要学做饭。我先洗了米，然后把米放进锅里。",
  "妈妈说要放水。我放了水。后来饭熟了，我很开心。"
].join("\n");

const OTHER_DRAFT = "今天我去公园玩了。公园里有很多花，还有一只小狗，我很喜欢它。";

const MOCK_MODEL = {
  source: "ai",
  title: "第一次学做饭",
  text: "今天我要学做饭。我先把米倒进盆里，手伸进去一搅，水马上变得白白的、浑浑的，像牛奶一样。",
  highlights: ["写淘米时加了一句「水变得白白的、浑浑的」，让读者能看见"]
};

let pass = 0, fail = 0;
function ck(name, ok, extra) {
  if (ok) { pass++; console.log("  [PASS] " + name); }
  else { fail++; console.log("  [FAIL] " + name + (extra ? "  → " + extra : "")); }
}

/* 在页面里问一次门禁：直接调产品代码的 canGenerateModelNow()，
 * 不重新实现一份（复刻版会漂移，测不出真问题）。 */
const GATE = `(() => {
  const g = canGenerateModelNow();
  renderGenModelTopBtn();
  const btn = document.getElementById("genModelTopBtn");
  return { ok: g.ok, why: g.why, disabled: btn.disabled, text: btn.textContent,
           hint: document.getElementById("genModelGateHint").textContent };
})()`;

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-genmodel-" + process.pid + "-" + Date.now());
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
  // generateAiModel 在"已有范文"时会 confirm 覆盖，探针里一律同意
  page.on("dialog", d => d.accept());

  await page.goto(INDEX, { waitUntil: "load", timeout: 45000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  /* ================= ① 版式 ================= */
  console.log("\n===== ① 版式（写作页）=====");
  const layout = await page.evaluate((essay) => {
    state.module = "write";
    state.draft = "";
    state.lastFeedback = null;
    applyModule();
    setView("write");
    renderWritingPanel();

    const sub = document.querySelector("[data-action='submit-essay']");
    const top = document.getElementById("genModelTopBtn");
    const hint = document.getElementById("genModelGateHint");
    const footer = document.querySelector(".editor-footer");
    const card = document.querySelector(".writing-panel");
    const sr = sub.getBoundingClientRect(), tr = top.getBoundingClientRect();
    const hr = hint.getBoundingClientRect(), fr = footer.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      exists: !!top,
      sameRow: Math.abs(sr.top - tr.top) < 6,
      subRect: { w: Math.round(sr.width), h: Math.round(sr.height), top: Math.round(sr.top), right: Math.round(sr.right) },
      topRect: { w: Math.round(tr.width), h: Math.round(tr.height), top: Math.round(tr.top), right: Math.round(tr.right) },
      bigger: tr.height > sr.height && tr.width > sr.width,
      hintVisible: hr.height > 0,
      hintText: hint.textContent,
      hintBelowFooter: hr.top >= fr.bottom - 1,
      footerInsideCard: fr.right <= cr.right + 1 && fr.left >= cr.left - 1,
      cardBottom: Math.round(cr.bottom),
      viewH: window.innerHeight,
      btnDisabled: top.disabled,
      btnText: top.textContent
    };
  }, ESSAY);

  ck("写作页存在 #genModelTopBtn", layout.exists);
  ck("和「提交给AI老师」在同一行", layout.sameRow,
    `subTop=${layout.subRect.top} topTop=${layout.topRect.top}`);
  ck("范文按钮更大（高和宽都超过提交按钮）", layout.bigger,
    `sub=${layout.subRect.w}x${layout.subRect.h} top=${layout.topRect.w}x${layout.topRect.h}`);
  ck("范文按钮在提交按钮**右侧**", layout.topRect.right > layout.subRect.right,
    `subRight=${layout.subRect.right} topRight=${layout.topRect.right}`);
  ck("门禁说明行可见且有文字", layout.hintVisible && layout.hintText.length > 6,
    `"${layout.hintText}"`);
  ck("说明行在按钮行**下方**", layout.hintBelowFooter);
  ck("整行没溢出卡片", layout.footerInsideCard,
    `footerRight=${Math.round(layout.footerInsideCard ? 0 : 1)}`);
  ck("初始（没评分）按钮是灰的", layout.btnDisabled === true);
  console.log(`  提交按钮 ${layout.subRect.w}x${layout.subRect.h} / 范文按钮 ${layout.topRect.w}x${layout.topRect.h}`);
  console.log(`  初始说明：「${layout.hintText}」`);

  await page.screenshot({ path: path.join(SHOTS, "genmodel-write-fold.png") });
  const panel = await page.$(".writing-panel");
  await panel.screenshot({ path: path.join(SHOTS, "genmodel-write-panel.png") });
  console.log("  截图：genmodel-write-fold.png / genmodel-write-panel.png");

  /* ================= ①b 类名没和首页撞车 =================
   * 首页早就有一个 `.gate-hint`（虚线框那个"首页门禁提示"）。
   * 新加的说明行如果也叫 `.gate-hint`，两条规则会互相污染：
   *   新的 `text-align:right` 把首页提示顶到右边；旧的虚线框/底色漏到写作页。
   * 这个坑实测踩到过（截图里看到说明行莫名带了个虚线框），所以钉一条断言。 */
  const collide = await page.evaluate(() => {
    const mine = getComputedStyle(document.getElementById("genModelGateHint"));
    const home = document.getElementById("gateHint");
    const hs = home ? getComputedStyle(home) : null;
    return {
      mineBorderStyle: mine.borderTopStyle, mineBorderWidth: mine.borderTopWidth,
      mineAlign: mine.textAlign,
      homeAlign: hs ? hs.textAlign : null,
      homeBorderStyle: hs ? hs.borderTopStyle : null,
      homeExists: !!home
    };
  });
  ck("写作页说明行没有虚线框（没被首页 .gate-hint 污染）",
    collide.mineBorderStyle === "none" && collide.mineBorderWidth === "0px",
    collide.mineBorderStyle + " " + collide.mineBorderWidth);
  ck("首页 .gate-hint 仍不是右对齐（没被新规则污染）",
    collide.homeExists && collide.homeAlign !== "right", String(collide.homeAlign));
  ck("首页 .gate-hint 的虚线框还在", collide.homeBorderStyle === "dashed",
    String(collide.homeBorderStyle));

  /* ================= ② 门禁 ================= */
  console.log("\n===== ② 门禁 =====");

  // 打桩：让 isConfigured 为 true，否则"有评分 ⇒ 亮"这条永远测不到
  await page.evaluate(() => { window.AiGrader.isConfigured = () => true; });

  // 2a 有评分、草稿为空 ⇒ 亮
  const a = await page.evaluate(`(() => {
    state.draft = "";
    state.lastFeedback = { id: "g1", title: "第一次学做饭", type: "故事补全",
      text: ${JSON.stringify(ESSAY)}, feedback: evaluateEssay(${JSON.stringify(ESSAY)}) };
    essayGrading = false; essayModeling = false;
    return ${GATE};
  })()`);
  ck("有评分 + 草稿空 ⇒ 按钮可点", a.ok === true && a.disabled === false, JSON.stringify(a));
  ck("亮的时候说明行不再是「先提交评分」", a.hint.indexOf("提交给AI老师") < 0, `"${a.hint}"`);
  console.log(`  说明：「${a.hint}」`);

  // 2b 草稿改过（新作文还没评）⇒ 灰
  const b = await page.evaluate(`(() => {
    state.draft = ${JSON.stringify(OTHER_DRAFT)};
    return ${GATE};
  })()`);
  ck("草稿改过（还没评）⇒ 按钮灰", b.ok === false && b.disabled === true, JSON.stringify(b));
  ck("灰的原因说明是「还没提交评分」", /提交|评分/.test(b.why), `"${b.why}"`);
  console.log(`  说明：「${b.why}」`);

  // 2c 草稿和已评那篇一模一样（例如从历史里恢复）⇒ 亮
  const c = await page.evaluate(`(() => {
    state.draft = ${JSON.stringify(ESSAY)};
    return ${GATE};
  })()`);
  ck("草稿 == 已评原文 ⇒ 仍然可点", c.ok === true && c.disabled === false, JSON.stringify(c));

  // 2d 正在批改 ⇒ 灰
  const d = await page.evaluate(`(() => {
    state.draft = ""; essayGrading = true;
    const r = ${GATE};
    essayGrading = false;
    return r;
  })()`);
  ck("批改中 ⇒ 按钮灰", d.ok === false && d.disabled === true, JSON.stringify(d));

  // 2e 正在写范文 ⇒ 灰 + 文案变化
  const e = await page.evaluate(`(() => {
    essayModeling = true;
    const r = ${GATE};
    essayModeling = false;
    return r;
  })()`);
  ck("写范文中 ⇒ 按钮灰", e.ok === false && e.disabled === true, JSON.stringify(e));
  ck("写范文中 ⇒ 文案变成「AI 正在写范文…」", e.text.indexOf("正在写") >= 0, `"${e.text}"`);

  // 2f 没配 Key ⇒ 灰（把桩撤掉，回到真实判断）
  const f = await page.evaluate(`(() => {
    window.AiGrader.isConfigured = () => false;
    state.draft = ""; essayGrading = false; essayModeling = false;
    const r = ${GATE};
    return r;
  })()`);
  ck("没配 API Key ⇒ 按钮灰", f.ok === false && f.disabled === true, JSON.stringify(f));
  ck("灰的原因指向「家长管理」", /家长管理|API Key/.test(f.why), `"${f.why}"`);
  console.log(`  说明：「${f.why}」`);

  // 2g 没有 lastFeedback ⇒ 灰
  const g = await page.evaluate(`(() => {
    state.lastFeedback = null;
    return ${GATE};
  })()`);
  ck("没有已评记录 ⇒ 按钮灰", g.ok === false && g.disabled === true, JSON.stringify(g));
  console.log(`  说明：「${g.why}」`);

  // 2h 已有范文 ⇒ 亮，且说明行提示"已经有范文了"
  const h = await page.evaluate(`(() => {
    window.AiGrader.isConfigured = () => true;
    state.draft = "";
    state.lastFeedback = { id: "g2", title: "第一次学做饭", type: "故事补全",
      text: ${JSON.stringify(ESSAY)}, feedback: evaluateEssay(${JSON.stringify(ESSAY)}),
      modelEssay: ${JSON.stringify(MOCK_MODEL)} };
    return ${GATE};
  })()`);
  ck("已有范文 ⇒ 仍可点（=重新生成）", h.ok === true && h.disabled === false, JSON.stringify(h));
  ck("已有范文 ⇒ 说明行提示「已经写好了」", /已经写好/.test(h.hint), `"${h.hint}"`);

  /* 亮起来的样子也要看一眼 —— 灰态和亮态是两种版式，别只看一种（R7） */
  await page.evaluate(`(() => {
    state.draft = "";
    state.lastFeedback = { id: "shot1", title: "第一次学做饭", type: "故事补全",
      text: ${JSON.stringify(ESSAY)}, feedback: evaluateEssay(${JSON.stringify(ESSAY)}) };
    applyModule(); setView("write"); renderWritingPanel();
  })()`);
  await sleep(250);
  const panelOn = await page.$(".writing-panel");
  await panelOn.screenshot({ path: path.join(SHOTS, "genmodel-write-enabled.png") });
  console.log("  截图：genmodel-write-enabled.png（门禁通过 / 按钮亮起）");

  /* ================= ③ 端到端接线 ================= */
  console.log("\n===== ③ 点一下到底发生了什么 =====");
  const e2e = await page.evaluate(async (essay, model) => {
    state.module = "write";
    window.AiGrader.isConfigured = () => true;
    let called = 0, payloadSeen = null;
    window.AiGrader.writeModel = (payload) => {
      called++; payloadSeen = payload;
      return Promise.resolve({ ok: true, model });
    };
    state.draft = "";
    state.lastFeedback = { id: "e2e1", title: "第一次学做饭", type: "故事补全",
      text: essay, feedback: evaluateEssay(essay) };
    applyModule(); setView("write"); renderWritingPanel();
    const btn = document.getElementById("genModelTopBtn");
    const before = { disabled: btn.disabled, view: document.querySelector(".view.active").id };
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    const card = document.getElementById("aiModelCard");
    return {
      beforeDisabled: before.disabled,
      beforeView: before.view,
      called,
      payloadText: payloadSeen ? payloadSeen.text : null,
      afterView: document.querySelector(".view.active").id,
      stored: !!(state.lastFeedback && state.lastFeedback.modelEssay),
      storedTitle: state.lastFeedback && state.lastFeedback.modelEssay
        ? state.lastFeedback.modelEssay.title : null,
      cardShown: card ? !card.classList.contains("hidden") : false,
      bodyShown: !document.getElementById("aiModelBody").classList.contains("hidden")
    };
  }, ESSAY, MOCK_MODEL);

  ck("点之前按钮是亮的", e2e.beforeDisabled === false);
  ck("点之前人在写作页", e2e.beforeView === "write", e2e.beforeView);
  ck("点击后真的调了 AI 生成（1 次）", e2e.called === 1, "called=" + e2e.called);
  ck("生成用的正是那篇已评作文的原文", e2e.payloadText === ESSAY,
    "payload 首 20 字=" + String(e2e.payloadText).slice(0, 20));
  ck("点击后跳到了结果页", e2e.afterView === "result", e2e.afterView);
  ck("范文被存进记录（切页/重开还在）", e2e.stored === true);
  ck("结果页卡片显示出来了", e2e.cardShown && e2e.bodyShown);

  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, "genmodel-result-fold.png") });
  const card2 = await page.$("#aiModelCard");
  if (card2) await card2.screenshot({ path: path.join(SHOTS, "genmodel-result-card.png") });
  console.log("  截图：genmodel-result-fold.png / genmodel-result-card.png");

  /* ================= ④ 回归哨兵 ================= */
  console.log("\n===== ④ 别把老行为改坏 =====");
  const old = await page.evaluate(() => {
    // 「提交给AI老师」按钮的文案/存在性没被动过
    const sub = document.querySelector("[data-action='submit-essay']");
    // 结果页原来的 genModelBtn 还在、还绑着 generateAiModel
    const g = document.getElementById("genModelBtn");
    return {
      subText: sub ? sub.textContent : null,
      subDisabled: sub ? sub.disabled : null,
      genModelExists: !!g,
      genModelClass: g ? g.className : "",
      genModelText: g ? g.textContent : ""
    };
  });
  ck("「提交给AI老师」按钮还在且文案没变", old.subText === "提交给AI老师", String(old.subText));
  ck("结果页 #genModelBtn 还在", old.genModelExists);
  ck("结果页 #genModelBtn 也升级成大按钮", /cta-lg/.test(old.genModelClass), old.genModelClass);

  if (errs.length) {
    console.log("\nJS 报错（" + errs.length + "）：" + errs.slice(0, 3).join(" | "));
    fail++;
  } else {
    ck("整轮无 JS 报错", true);
  }

  console.log(`\n===== 合计 ${pass}/${pass + fail} =====`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("探针异常：", e); process.exit(3); });
