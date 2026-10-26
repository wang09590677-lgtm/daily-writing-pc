// 验证两件事：
//   1. 结果页布局（AI 老师打分）在多个视口宽度下都是"横向铺满"
//   2. 家长密码已强制改成 09590677，且旧数据 1234 会被迁移掉
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const SHOT = path.join(__dirname, "shots");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}

const FEEDBACK = {
  score: 88, source: "ai",
  narrative: "这篇作文把事情的过程写清楚了，从洗米到下锅的步骤都交代到了，读起来像真的发生过一样。特别是你在旁边看火的那一段，能看出你既紧张又期待。",
  strengths: [
    "事情的经过写得完整，有开始也有结果，读者不用猜",
    "用上了「手心全是汗」这样的细节，把紧张写出来了",
    "句子之间有先后顺序，用了「先……然后……最后」，读起来顺"
  ],
  improvements: [
    "开头的场景可以再多写一句，让读者知道这是在哪里发生的",
    "结尾有点急，可以补一句自己吃到饭时的心情",
    "「很好吃」这类词比较笼统，换成具体的感觉会更有味道"
  ],
  nextGoal: "写一件事的时候，至少补两处看得见或听得见的细节。",
  progress: { trend: "up", detail: "比上一篇高了 6 分，主要体现在细节描写上。" },
  evidence: [{ quote: "锅里的水咕嘟咕嘟地响，我的心也跟着一跳一跳。", comment: "这句话把声音和心情连在一起写，很有画面感。" }],
  parts: { "内容与立意": 22, "结构与逻辑": 17, "细节与描写": 18, "语言表达": 17, "词汇与句式": 8, "错别字与标点": 4 }
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  // ============ 1. 结果页布局：多个视口都要横向铺满 ============
  console.log("\n== 1. AI 老师打分结果页：横向铺满（不再挤左边）==");
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(INDEX, { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await new Promise(r => setTimeout(r, 900));

  for (const w of [1600, 1440, 1280]) {
    await page.setViewport({ width: w, height: 1000 });
    await new Promise(r => setTimeout(r, 250));
    const m = await page.evaluate((fb) => {
      state.module = "write";
      state.lastFeedback = { title: "第一次学做饭", type: "故事补全", text: "今天我要学做饭。", feedback: fb };
      applyModule(); setView("result"); renderResult();
      const layout = document.getElementById("resultContent");
      const ai = document.getElementById("aiFeedbackCard");
      const score = layout.querySelector(".score-card");
      const cols = ai.querySelector(".feedback-columns");
      const ul = ai.querySelector("#strengthList");
      const lr = layout.getBoundingClientRect();
      const ar = ai.getBoundingClientRect();
      return {
        layoutW: Math.round(lr.width), layoutX: Math.round(lr.left),
        aiW: Math.round(ar.width), aiX: Math.round(ar.left),
        aiH: Math.round(ar.height),
        scoreW: Math.round(score.getBoundingClientRect().width),
        colsW: Math.round(cols.getBoundingClientRect().width),
        ulW: Math.round(ul.getBoundingClientRect().width),
        // AI 卡右边缘是否贴到结果区右边缘（允许 2px 误差）
        rightGap: Math.round(lr.right - ar.right),
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    }, FEEDBACK);
    const fillRatio = m.aiW / m.layoutW;
    check(`${w}px 视口：AI 反馈卡横向占满首行剩余宽度（不再挤在 260px 窄列）`,
      m.aiW > 500 && m.rightGap <= 2 && fillRatio > 0.55,
      `卡宽 ${m.aiW}px（占结果区 ${Math.round(fillRatio * 100)}%）右边缘间距 ${m.rightGap}px`);
    check(`${w}px 视口：反馈两列各自足够宽（能正常阅读，不再是一字一行）`,
      m.ulW > 200, `每列列表宽约 ${m.ulW}px（修复前只有 98px）`);
    check(`${w}px 视口：页面无横向滚动`, m.overflowX === false);
  }

  // 首行两卡是否等高（视觉对齐）
  const firstRow = await page.evaluate(() => {
    const layout = document.getElementById("resultContent");
    const score = layout.querySelector(".score-card").getBoundingClientRect();
    const ai = document.getElementById("aiFeedbackCard").getBoundingClientRect();
    return { scoreH: Math.round(score.height), aiH: Math.round(ai.height), sameTop: Math.abs(score.top - ai.top) < 2 };
  });
  check("得分卡与 AI 反馈卡并排在同一行、顶部对齐",
    firstRow.sameTop === true, `得分卡高 ${firstRow.scoreH} / 反馈卡高 ${firstRow.aiH}`);

  await page.screenshot({ path: path.join(SHOT, "result-after-1440.png"), fullPage: true });

  // 窄屏（单列）不能把 AI 卡挤到右边看不见
  await page.setViewport({ width: 900, height: 1200 });
  await new Promise(r => setTimeout(r, 350));
  const narrow = await page.evaluate(() => {
    const layout = document.getElementById("resultContent");
    const aiEl = document.getElementById("aiFeedbackCard");
    const ai = aiEl.getBoundingClientRect();
    const lr = layout.getBoundingClientRect();
    return {
      aiX: Math.round(ai.left), aiW: Math.round(ai.width), layoutX: Math.round(lr.left), layoutW: Math.round(lr.width),
      cols: getComputedStyle(aiEl.querySelector(".feedback-columns")).gridTemplateColumns,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  });
  check("窄屏（900px）单列时 AI 卡回到左边、铺满整宽（不会被推到第 2 列消失）",
    Math.abs(narrow.aiX - narrow.layoutX) < 3 && Math.abs(narrow.aiW - narrow.layoutW) < 3 && narrow.overflowX === false,
    `卡 x=${narrow.aiX} 宽=${narrow.aiW}（结果区 x=${narrow.layoutX} 宽=${narrow.layoutW}）`);
  await page.screenshot({ path: path.join(SHOT, "result-after-900.png"), fullPage: true });

  // ============ 2. 家长密码：强制改成 09590677 ============
  console.log("\n== 2. 家长密码强制改成 09590677 ==");
  await page.setViewport({ width: 1440, height: 1000 });

  // 2a. 全新用户（localStorage 清空）
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await new Promise(r => setTimeout(r, 800));
  const fresh = await page.evaluate(() => ({
    pw: state.admin.password,
    enabled: state.admin.passwordEnabled,
    migrated: !!state.admin.passwordMigratedTo09590677,
    lockHint: (document.querySelector("#adminLock .hint") || {}).textContent || ""
  }));
  check("全新安装：默认密码就是 09590677", fresh.pw === "09590677", fresh.pw);
  check("全新安装仍然默认免密（不推翻上轮「别把家长锁在门外」的诉求）",
    fresh.enabled === false, String(fresh.enabled));

  // 2b. 老用户：localStorage 里存着旧密码 1234 + 免密
  const migrated = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("dailyWritingPcStateV3") || "{}");
    raw.admin = { password: "1234", passwordEnabled: false, unlockedAt: 0, passwordHistory: [], passwordChangedAt: "" };
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify(raw));
    const restored = loadState();
    return { rawPw: raw.admin.password };
  });
  await page.reload({ waitUntil: "load" });
  await new Promise(r => setTimeout(r, 800));
  const afterMigrate = await page.evaluate(() => ({
    pw: state.admin.password,
    enabled: state.admin.passwordEnabled,
    migrated: !!state.admin.passwordMigratedTo09590677,
    history: state.admin.passwordHistory || [],
    stored: JSON.parse(localStorage.getItem("dailyWritingPcStateV3") || "{}").admin
  }));
  check("★ 老数据里的旧密码 1234 被强制迁移成 09590677", afterMigrate.pw === "09590677", afterMigrate.pw);
  check("★ 迁移的同时把密码保护打开（真的拦得住，不是改了却仍免密）",
    afterMigrate.enabled === true, String(afterMigrate.enabled));
  check("迁移只做一次（打了标记位，家长以后自己改密码不会被覆盖回默认）",
    afterMigrate.migrated === true && afterMigrate.stored.passwordMigratedTo09590677 === true);
  check("迁移留下了痕迹（from 1234 → to 09590677，家长看得到）",
    afterMigrate.history.some(h => h.from === "1234" && h.to === "09590677"),
    JSON.stringify(afterMigrate.history.slice(-1)));

  // 2c. 迁移后旧密码不能再用、新密码能进
  const login = await page.evaluate(() => {
    adminLogout();
    renderAdmin();
    const tryLogin = (pw) => {
      document.getElementById("adminPasswordInput").value = pw;
      adminLogin();
      return adminUnlocked();
    };
    const oldOk = tryLogin("1234");
    adminLogout();
    const newOk = tryLogin("09590677");
    return { oldOk, newOk };
  });
  check("旧密码 1234 已经进不去了", login.oldOk === false);
  check("★ 新密码 09590677 能正常登录", login.newOk === true);

  // 2d. 迁移后家长自己改密码，不能被再次覆盖
  const respect = await page.evaluate(() => {
    state.admin.password = "8888";
    state.admin.passwordEnabled = true;
    saveState();
    const reloaded = loadState();
    return { pw: reloaded.admin.password };
  });
  check("迁移之后家长自己改的密码会被尊重（不会被再次强行改回 09590677）",
    respect.pw === "8888", respect.pw);

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { failed.forEach(f => console.log("  FAIL:", f.name, f.detail || "")); process.exit(1); }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
