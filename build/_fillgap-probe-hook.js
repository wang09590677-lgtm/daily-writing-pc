/* ===== 文章补写：测试钩子（只在 ?test=fillgap 时挂载） =====
 *
 * 设计原则：**只抽两根线，其余全走真代码**
 *   ① 门禁（每日必写没做完不让进拓展模块）
 *   ② 网络（调大模型 = 花钱 + 不稳定）
 * 提交走真 startFillWriting() + 真 submitEssay()，结果页走真 renderResult()，
 * 计分走真 dayDetail()。
 *
 * ★ 为什么不用"自己造一份 record 塞进 state.essays"：
 *   那就等于把 submitEssay/finish 里的接线（payload、record.fillGap、
 *   feedback.originalGap、dayDetail 口径）全部绕过——而这些恰恰是本轮
 *   最容易接错的地方（加分并进 score 后 essayPoints 会不会重复加）。
 *   反过来，如果只验这些内部函数，又会漏掉"界面到底画没画"。
 *
 * ⚠️ 没有 ?test=fillgap 时一行都不执行，正常使用零影响。
 */
(function installFillGapProbe() {
  const params = (window.location.search || "").replace(/^\?/, "").split("&");
  let isTest = false;
  for (let i = 0; i < params.length; i++) {
    if (params[i] === "test=fillgap") { isTest = true; break; }
  }
  if (!isTest) return;

  /* ---------- 被替换掉的两根线 ---------- */

  // ① 门禁：探针里当作"今天的每日必写已经完成"
  const realGate = ensureGate;
  ensureGate = function () { return true; };

  /* ② 网络：gradeFill 换成本地预制结果（形状由真 normalizeFillGrade 生成）
   *
   * ★ 只换 gradeFill **不够** —— submitEssay 里先有一道
   *   `if (!AiGrader.isConfigured()) { 走本地规则; return; }`，
   *   没配 Key 的机器上一辈子走不到 gradeCall 那行。
   *   所以要把 isConfigured 也一起打桩成 true（这等价于"家长已经配了 Key"）。
   *   ⚠️ 踩过：第一版只换了 gradeFill，结果探针拿到的 feedback 是本地兜底评的
   *   （score=87、没有 baseScore/extraBonus），而探针只报"加分没生效"，
   *   看起来像 app.js 的接线断了、其实是根本没进那条路。 */
  const realIsConfigured = window.AiGrader.isConfigured;   // 真函数，验"未配 Key"那条用例时要还原它
  const realGradeFill = window.AiGrader.gradeFill;
  let fakeGrade = null;

  window.AiGrader.isConfigured = function () { return true; };
  window.AiGrader.gradeFill = function () {
    if (fakeGrade) return Promise.resolve({ ok: true, feedback: fakeGrade });
    return Promise.resolve({ ok: false, message: "探针未装夹具" });
  };
  void realGradeFill;

  /* 统计：直接对真素材库逐篇算，不做第二份数据 */
  function stats() {
    const list = FILL_ARTICLES || [];
    const SKILL_KEYS = Object.keys(defaultState.skills);
    let gapSum = 0, minGap = Infinity, maxChars = 0, firstStartsAtFirst = false, anyGapAtTail = false;
    const cats = [], badSkills = [], bucket = { lt280: 0, mid: 0, gt600: 0 };
    list.forEach(a => {
      gapSum += a.gapChars;
      if (a.gapChars < minGap) minGap = a.gapChars;
      if (a.chars > maxChars) maxChars = a.chars;
      if (a.gapStart === 0) firstStartsAtFirst = true;
      if (a.gapStart + a.gapCount >= a.paragraphs.length) anyGapAtTail = true;
      if (cats.indexOf(a.category) < 0) cats.push(a.category);
      (a.skills || []).forEach(s => { if (SKILL_KEYS.indexOf(s) < 0) badSkills.push(a.id + ":" + s); });
      if (a.gapChars < 280) bucket.lt280++;
      else if (a.gapChars > 600) bucket.gt600++;
      else bucket.mid++;
    });
    const sorted = list.map(a => a.gapChars).sort((x, y) => x - y);
    return {
      count: list.length,
      avgGap: list.length ? Math.round(gapSum / list.length) : 0,
      medianGap: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      minGap: minGap === Infinity ? 0 : minGap,
      maxGap: sorted.length ? sorted[sorted.length - 1] : 0,
      maxChars,
      cats,
      badSkills,
      firstStartsAtFirst,
      anyGapAtTail,
      bucket,
      catsOrdered: FILL_CATEGORIES.map(x => x[0]),
      catsCount: FILL_CATEGORIES.map(x => x[1])
    };
  }

  const current = () => getCurrentFillArticle();

  /* 当前视图：state 里**没有** view 字段（setView 只动 DOM），
   * 所以只能读 .view.active。曾经写 state.view，取回来永远是 undefined，
   * 探针就误报"提交后没跳结果页"——而页面其实跳了。 */
  function currentView() {
    const el = document.querySelector(".view.active");
    return el ? el.id : null;
  }

  /* 答案在不在这台机器的内存里 —— 证明"答案只在 activeWriting，没进 DOM" */
  function activeAnswer() {
    const aw = state.activeWriting;
    if (!aw || !aw.fillGap) return false;
    const g = aw.fillGap;
    return !!(g.originalGap && g.originalGap.length && g.paragraphs && g.paragraphs.length);
  }

  /* 进补写：走真 startFillWriting（含 renderWritingPanel） */
  function startForTest() {
    const art = current();
    if (!art) return { ok: false, why: "no-article" };
    startFillWriting();
    const aw = state.activeWriting;
    return { ok: !!(aw && aw.kind === "fillgap"), view: currentView(), paragraphs: art.paragraphs.length };
  }

  /* 制一份"结构合法"的 feedback：
   * 走真 normalizeFillGrade，保证渲染层拿到的形状与线上 100% 一致。
   * （夹具忠实于真实契约，见规则 R9：改夹具不改断言）
   * ★ 字段名必须跟 buildFillGradeSystemPrompt 里要求模型输出的**完全一致**：
   *   parts / strengths / improvements / nextGoal / narrative / evidence /
   *   compare / betterThan[{quote,why}] / bonusTier。
   *   曾经写成 dimensions + betterThanOriginal.items + tier —— 那是"我以为的格式"，
   *   结果 normalize 全部走兜底，score 掉到 3 分、bonus 恒为 0，而探针只报"加分没生效"，
   *   看起来像接线坏了、其实是夹具坏了。 */
  function makeFeedback(art, tier) {
    const gapParas = art.gapParas || [];
    const quote = i => (gapParas[i] || gapParas[0] || "我补写的那一句").slice(0, 28);
    /* 六个维度必须**加起来等于 100 以内**，normalize 直接求和当总分；
     * 而且"错别字与标点"有 3 分地板（normalize 里的既有规则），这里给 5 分不受影响。 */
    return window.AiGrader.__normalizeFillGrade({
      parts: { "内容与立意": 22, "结构与逻辑": 17, "细节与描写": 16, "语言表达": 17, "词汇与句式": 8, "错别字与标点": 5 },
      strengths: [
        "孩子写「" + quote(0) + "」，比他平时写的空话具体得多",
        "把等待写成了一个能看见的动作"
      ],
      improvements: ["结尾那句可以直接收在动作上，不必再加一句总结", "有一处句子偏长，可以断开"],
      nextGoal: "练习用动作收尾，不写总结句。",
      narrative: "整体接得顺，细节也具体。",
      evidence: [{ quote: quote(0), comment: "有画面，不是抽象地说心情" }],
      compare: [{ child: quote(0), original: (art.paragraphs[art.gapStart] || "").slice(0, 20), better: "child", comment: "孩子的更具体" }],
      betterThan: [
        { quote: quote(0), why: "原文这里只写了一句交代，孩子把身体反应写出来了" },
        { quote: quote(1), why: "情绪转折更自然，接得上前面" }
      ],
      bonusTier: tier || "clear",
      // 反向断言：模型若自报一个分数，必须被无视（normalizeFillGrade 只认档位）
      bonus: 999
    }, { originalGap: gapParas, paragraphs: art.paragraphs || [], charCount: 320 });
  }

  /* 提交：真 submitEssay —— 后者的 Promise 链会走一帧才回调，
   * 所以这里是 async，等 state.lastFeedback 落到本次记录再从 DOM 读结果。 */
  async function simulateSubmit(tier) {
    const art = current();
    if (!state.activeWriting || state.activeWriting.kind !== "fillgap") {
      return { submitted: false, why: "no-active-fill" };
    }
    const gapParas = art.gapParas || [];
    /* 字数一旦不够，submitEssay 会 alert 然后 return —— 在无头浏览器里
     * alert 会把 evaluate 挂住。所以先自己算清楚、补够，再把 alert 打桩。 */
    const minChars = Math.max(60, Math.round((art.gapChars || 300) * 0.4));
    /* ★ 孩子写的东西**必须和原文不一样**，否则对照区左右两栏一字不差，
     *   截图看起来像"根本没挖空"，而这一点最容易掩盖渲染 bug（抄一份当然是全对）。
     *   这里刻意用"明显不同、但仍然接得上"的口吻来写，模拟真实补写。 */
    const filler = "我没有说话，只是把手里的东西又攥紧了一点，指节都发白了。";
    let childText = "";
    const rounds = Math.max(1, gapParas.length);
    for (let i = 0; i < rounds; i++) {
      childText += "他站在那里，风从背后推了他一下，他没有动。" + filler + "过了一会儿，他才小声说了一句什么，声音很轻，很快就散了。" + String.fromCharCode(10);
    }
    while (countChineseChars(childText) < minChars + 20) childText += filler + String.fromCharCode(10);

    const alerts = [];
    const realAlert = window.alert;
    window.alert = m => alerts.push(String(m));

    const before = state.essays.length;
    fakeGrade = makeFeedback(art, tier || "clear");
    document.getElementById("essayInput").value = childText;
    submitEssay();

    /* 等 finish() 真的跑完（essays 多一条 & lastFeedback 换成新记录） */
    const deadline = Date.now() + 5000;
    while (state.essays.length !== before + 1 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 60)); // 让 renderAll 的样式落定

    window.alert = realAlert;

    const rec = state.lastFeedback || {};
    const fb = rec.feedback || {};
    const card = document.getElementById("fillCompareCard");
    const list = document.getElementById("fillCompareList");
    const bonusBox = document.getElementById("fillBonusBox");
    const badge = bonusBox ? bonusBox.querySelector(".fill-bonus-badge") : null;

    const key = todayKey();
    const day = dayDetail(key);
    /* ★ 补写**不是**「每日必写」：它的 record.type 是「文章补写」，
     *   dailyEssentialDone() 只认 DAILY_ESSENTIAL_TYPE 或 kind==="daily"。
     *   所以"补写完成后当日必写算不算完成"= **不算**（这是既有口径，没改）。
     *   探针要验的是"这篇的分会不会进当日总分"——那取决于**当天有没有做完每日必写**。
     *   这里如实报告两个口径，断言放在探针里按"先补一篇每日必写"的方式验，
     *   不能靠改 app.js 把补写当成每日必写（那会让门禁形同虚设）。 */
    const dailyDone = dailyEssentialDone(key);

    const base = typeof fb.baseScore === "number" ? fb.baseScore : null;
    const bonus = typeof fb.extraBonus === "number" ? fb.extraBonus : 0;
    const score = typeof fb.score === "number" ? fb.score : 0;

    return {
      submitted: state.essays.length === before + 1,
      alerts,
      view: currentView(),
      kind: fb.kind,
      score, base, bonus,
      bonusInScore: base !== null && bonus > 0 && score === base + bonus,
      dayScore: day.score,
      dayDone: day.done,
      dailyDone,
      scoreInDayTotal: day.done && day.score >= score,
      recordHasFillGap: !!(rec.fillGap && rec.fillGap.paragraphs && rec.fillGap.originalGap),
      recordGapParagraphs: rec.fillGap ? rec.fillGap.paragraphs.length : 0,
      compareVisible: !!(card && !card.classList.contains("hidden")),
      compareRows: list ? list.querySelectorAll(".fill-compare-row").length : 0,
      compareChildCols: list ? list.querySelectorAll(".fill-compare-col.is-child").length : 0,
      compareOrigCols: list ? list.querySelectorAll(".fill-compare-col.is-original").length : 0,
      compareText: list ? list.innerText.slice(0, 400) : "",
      bonusVisible: !!(bonusBox && !bonusBox.classList.contains("hidden")),
      bonusBadge: badge ? badge.textContent.trim() : ""
    };
  }

  /* 普通作文（无补写结构）走一遍结果页：对照卡必须收起 */
  function simulatePlainResult() {
    const fb = window.AiGrader.__normalize({
      parts: { "内容与立意": 22, "结构与逻辑": 17, "细节与描写": 16, "语言表达": 17, "词汇与句式": 8, "错别字与标点": 5 },
      strengths: ["写得清楚"],
      improvements: ["可以再多一点细节"],
      narrative: "不错。"
    }, { charCount: 30 });
    state.essays.unshift({
      id: "plain-probe-" + Date.now(),
      date: new Date().toISOString(),
      topicId: "plain-probe",
      type: DAILY_ESSENTIAL_TYPE,
      title: "普通作文",
      goal: "",
      skillFocus: "语言表达",
      material: "",
      text: "这是一篇普通作文，用来验证非补写记录不显示对照卡。",
      feedback: fb
    });
    state.lastFeedback = state.essays[0];
    renderAll();
    setView("result");
    const card = document.getElementById("fillCompareCard");
    return { compareHidden: !card || card.classList.contains("hidden") };
  }

  function aiGate() {
    const btn = document.getElementById("fillAiBtn");
    const cfg = window.AiGrader.getConfig ? window.AiGrader.getConfig() : null;
    return {
      buttonText: btn ? btn.textContent.trim() : "",
      // 这里要报**真实的**配置状态，不是被打桩后的 true
      configured: !!(cfg && cfg.apiKey)
    };
  }

  /* 验"没配 Key 点 AI 生成会明确提示"：必须先把 isConfigured 恢复成真函数，
   * 否则钩子把它打桩成 true 了，点下去反而真的去发请求 —— 测的就不是这个分支。 */
  function clickAiWithoutKey() {
    const hadKey = !!(window.AiGrader.getConfig && window.AiGrader.getConfig().apiKey);
    if (hadKey) return { skipped: true, reason: "已配置 Key，本机无法模拟未配置" };

    window.AiGrader.isConfigured = realIsConfigured;
    const bar = document.getElementById("toastBar");
    if (bar) bar.textContent = "";
    const before = bar ? bar.textContent : "";
    const btn = document.getElementById("fillAiBtn");
    if (btn) btn.click();
    const el = document.getElementById("toastBar");
    const msg = el ? el.textContent : "";
    // 验完立刻恢复打桩，后面还要用
    window.AiGrader.isConfigured = function () { return true; };
    return { toasted: !!msg && msg !== before, text: msg, before };
  }

  /* 先补一篇「每日必写」，让当日总分真的开始累计 ——
   * 不这么做的话 dayDetail().score 恒为 0（dailyEssentialDone 是总分的开闸条件），
   * 探针就会把"还没开闸"误读成"补写的分没进总分"。 */
  function seedDailyEssay() {
    const fb = window.AiGrader.__normalize({
      parts: { "内容与立意": 20, "结构与逻辑": 15, "细节与描写": 15, "语言表达": 16, "词汇与句式": 7, "错别字与标点": 4 },
      strengths: ["今天这篇写完整了"],
      improvements: ["再具体一点"],
      narrative: "完成的每日必写。"
    }, { charCount: 120 });
    state.essays.unshift({
      id: "daily-seed-" + Date.now(),
      date: new Date().toISOString(),
      topicId: "daily-seed",
      type: DAILY_ESSENTIAL_TYPE,
      kind: "daily",
      title: "每日必写（探针预置）",
      goal: "",
      skillFocus: "语言表达",
      material: "",
      text: "探针预置的一篇每日必写，只为把当日总分的闸打开，不代表任何评分行为。",
      feedback: fb
    });
    saveState();
    renderAll();
    return { seeded: true, dayDone: dailyEssentialDone(todayKey()) };
  }

  /* ★ 切视图**必须先进入写作模块**：
   * 首屏是"今天想先做哪一件事"的模块选择页（state.module === ""），
   * 这时 #appShell 整个是 hidden，里面的 #fillgap 量出来宽高全是 0。
   * 探针第一次跑就踩了这个：断言一直报"主卡片宽度 0px"，
   * 看起来像 CSS 坏了，其实页面根本没进模块。
   * 显式 setModule("write") 才是真人点「进入写作 →」之后的等价状态。 */
  function showView(v) {
    /* ⚠️ 顺序不能反：setModule() 内部会 applyModule() → setView(meta.home)，
     *   把上一步切的视图**覆盖掉**。所以先 ensure 模块，再切视图。 */
    if (!state.module) setModule("write");
    setView(v);
    return currentView();
  }

  /* 不依赖 state.module 的兜底：直接进写作模块并落到指定视图。
   * ★★ setView 里有一道**产品门禁**：LOCKED_VIEWS（含 fillgap）在
   *   canStartExtraWriting() 为假时会把 viewId 改成 "write"。
   *   所以进补写页之前，当天必须先有一篇「每日必写」——
   *   这不是"探针要走后门"，而是**真人也要先做每日必写才能进补写**。
   *   探针第一版没预置，于是 enterWriteModule("fillgap") 一直返回 "write"、
   *   量到的宽高全是 0，而报错看起来像"CSS 坏了"。 */
  function enterWriteModule(viewId) {
    if (state.module !== "write") {
      state.module = "write";
      saveState();
      applyModule();      // 这里会 setView(meta.home)
    }
    const target = viewId || "fillgap";
    if (LOCKED_VIEWS[target] && !canStartExtraWriting()) seedDailyEssay();
    setView(target);
    return currentView();
  }

  window.__fillgap = {
    stats, current, currentView, enterWriteModule, activeAnswer, startForTest, simulateSubmit,
    simulatePlainResult, aiGate, clickAiWithoutKey, showView, seedDailyEssay,
    reset: () => { state.essays = []; saveState(); renderAll(); }
  };
})();
