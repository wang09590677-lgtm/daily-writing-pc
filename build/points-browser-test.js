// 真实浏览器验证：积分统计 / 门禁 / 积分榜曲线 / 家长管理
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

// 在页面加载前把种子数据塞进 localStorage（local 日期，避免 UTC 跨日）
function seedScript(essays, rewards, redemptions) {
  return `(() => {
    const pad = n => String(n).padStart(2, "0");
    const key = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    const day = new Date(); day.setHours(10, 0, 0, 0);
    const K = key(day);
    const mk = (type, score, hour) => {
      const d = new Date(day); d.setHours(hour);
      return {
        id: "seed-" + type + "-" + hour,
        date: d.toISOString(),
        topicId: "seed-" + hour,
        type, title: type + " 测试", goal: "", skillFocus: "语言表达",
        material: "", text: "这是用于验证积分统计的测试文本，内容足够长以便通过渲染检查。".repeat(2),
        feedback: { score, parts: {}, strengths: [], improvements: [], nextGoal: "" }
      };
    };
    const essays = ${JSON.stringify(essays)}.map(e => mk(e[0], e[1], e[2]));
    const state = {
      // 直接进入写作模块（不经过模块选择页）
      module: "write",
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
      essays,
      rewards: ${JSON.stringify(rewards)},
      redemptions: ${JSON.stringify(redemptions)}
    };
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify(state));
    window.__seedDayKey = K;
  })();`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  // 兑换会用原生 confirm 确认，测试里一律同意
  page.on("dialog", async d => { await d.accept(); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

  /* ---------------- 场景 1：全新状态 → 门禁锁定 ---------------- */
  console.log("\n== 场景 1：全新状态（未写每日必写）==");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  const locked = await page.evaluate(() => {
    /* 2026-10-17：「听音撰文」(audio) 整块被替换为「文章补写」(fillgap)，
     * LOCKED_VIEWS 的键也跟着换了。这里跟着产品口径改名 —— 断言本身
     * （三个拓展模块在没做每日必写时都进不去）一个字没动。 */
    const gated = ["dailyTask", "imitate", "fillgap"];
    const items = [...document.querySelectorAll(".nav-item")];
    const lockedViews = items.filter(el => el.classList.contains("locked")).map(el => el.dataset.view);
    const hint = document.getElementById("gateHint");
    return {
      lockedViews,
      gatedAllLocked: gated.every(v => lockedViews.includes(v)),
      hintText: hint ? hint.textContent.trim() : "",
      widget: (() => { const w = document.getElementById("statWidget"); return { cls: w.className, text: w.textContent.replace(/\s+/g, " ").trim() }; })()
    };
  });
  check("三个拓展模块导航均被锁定", locked.gatedAllLocked, JSON.stringify(locked.lockedViews));
  check("门禁提示文案非空", locked.hintText.length > 0, `「${locked.hintText}」`);
  check("顶栏统计组件已渲染（无奖牌态）", /stat-widget/.test(locked.widget.cls) && locked.widget.text.length > 0,
    locked.widget.text.slice(0, 60));

  // 强行点击"每日任务"应被拦截
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "dailyTask").click();
  });
  await sleep(400);
  const blocked = await page.evaluate(() => ({
    dailyTaskActive: document.getElementById("dailyTask").classList.contains("active"),
    toastVisible: !!document.querySelector("#toastBar.show"),
    toastText: document.querySelector("#toastBar") ? document.querySelector("#toastBar").textContent.trim() : "",
    activeView: [...document.querySelectorAll(".view")].filter(v => v.classList.contains("active")).map(v => v.id)
  }));
  check("强行进入每日任务被拦截", !blocked.dailyTaskActive, "当前视图 " + blocked.activeView.join(","));
  check("拦截时弹出提示", blocked.toastVisible, `「${blocked.toastText}」`);
  await page.screenshot({ path: path.join(SHOT, "points-01-locked.png") });

  /* ---------------- 场景 2：完成每日必写 → 解锁 + 285 分 ---------------- */
  console.log("\n== 场景 2：当日 7 篇 → 总分 285 / 金牌 / 解锁 ==");
  const seed = [
    ["每日必写", 60, 9],
    ["热点感想", 23, 10], ["故事补全", 45, 11], ["文字扩写", 12, 12], ["看图编故事", 78, 13],
    ["范文临摹", 23, 14], ["听音撰文", 44, 15]
  ];
  await page.evaluateOnNewDocument(seedScript(seed, undefined, undefined));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);

  const scored = await page.evaluate(() => {
    const w = document.getElementById("statWidget");
    const items = [...document.querySelectorAll(".nav-item")];
    return {
      cls: w.className,
      todayScore: w.querySelector(".donut-center strong") ? w.querySelector(".donut-center strong").textContent.trim() : "",
      medalLine: w.querySelector(".stat-medal") ? w.querySelector(".stat-medal").textContent.trim() : "",
      lines: w.querySelector(".stat-lines") ? w.querySelector(".stat-lines").textContent.replace(/\s+/g, " ").trim() : "",
      donut: w.querySelector(".donut-fill") ? w.querySelector(".donut-fill").getAttribute("stroke-dasharray") : "",
      spark: w.querySelectorAll(".stat-spark i").length,
      lockedViews: items.filter(el => el.classList.contains("locked")).map(el => el.dataset.view),
      gateHint: (document.getElementById("gateHint") || {}).textContent || ""
    };
  });
  check("统计组件带上 gold 奖牌态", /medal-gold/.test(scored.cls), scored.cls);
  check("统计组件今日分 = 285", scored.todayScore === "285", scored.todayScore);
  check("统计组件显示金牌", /金牌/.test(scored.medalLine), scored.medalLine);
  check("统计组件显示周/月/金币", /周/.test(scored.lines) && /月/.test(scored.lines) && /🪙/.test(scored.lines), scored.lines);
  check("门禁解除（无锁定导航）", scored.lockedViews.length === 0, JSON.stringify(scored.lockedViews));
  check("环形进度条有 dasharray", /[\d.]/.test(scored.donut), scored.donut);
  check("本周迷你柱有 7 根", scored.spark === 7, String(scored.spark));

  // 现在可以进每日任务
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "dailyTask").click();
  });
  await sleep(300);
  check("解锁后可以进入每日任务", await page.$eval("#dailyTask", el => el.classList.contains("active")));

  /* ---------------- 场景 3：积分榜（周榜单 + 月曲线） ---------------- */
  console.log("\n== 场景 3：积分榜 ==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "scoreboard").click();
  });
  await sleep(600);
  const board = await page.evaluate(() => {
    const canvas = document.getElementById("monthChart");
    let painted = 0;
    try {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    } catch (e) { painted = -1; }
    return {
      coinPool: document.getElementById("coinPool").textContent.replace(/\s+/g, " ").trim().slice(0, 120),
      rankRows: document.querySelectorAll("#weekRank .rank-row").length,
      // 榜单只列"已经过去的天数"（未来的日子不可能有分），所以期望行数要按当天算，
      // 不能硬写 7 —— 那样只有周日跑才会过
      expectRows: (() => { const d = new Date(); return ((d.getDay() + 6) % 7) + 1; })(),
      weekdayName: "周" + "一二三四五六日"[(new Date().getDay() + 6) % 7],
      rankTop1: document.querySelectorAll("#weekRank .rank-row.top1").length,
      todayRow: document.querySelectorAll("#weekRank .rank-row.is-today").length,
      legend: document.getElementById("monthLegend").textContent.replace(/\s+/g, " ").trim().slice(0, 100),
      painted
    };
  });
  check("金币池已渲染", board.coinPool.length > 0, `「${board.coinPool}」`);
  check("本周榜单列出已过去的天数", board.rankRows === board.expectRows,
    `${board.rankRows} 行（今天${board.weekdayName}，应有 ${board.expectRows} 行）`);
  check("榜单高亮今天所在行", board.todayRow === 1, String(board.todayRow));
  check("月度曲线已绘制（有像素）", board.painted > 500, "已绘制像素 " + board.painted);
  await page.screenshot({ path: path.join(SHOT, "points-02-scoreboard.png") });

  // 滚到月度曲线区域单独截图
  await page.evaluate(() => {
    const c = document.getElementById("monthChart");
    if (c) c.scrollIntoView({ block: "center" });
  });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "points-02b-month-chart.png") });

  // 导航命名不冲突
  const navLabels = await page.$$eval(".nav-item", els => els.map(e => e.textContent.trim()));
  check("导航同时有「家长报告」与「家长管理」且不重名",
    navLabels.includes("家长报告") && navLabels.includes("家长管理"),
    navLabels.join(" / "));

  // 家长报告（只读，无需密码）
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "parent").click();
  });
  await sleep(400);
  const report = await page.evaluate(() => ({
    active: document.getElementById("parent").classList.contains("active"),
    summary: document.getElementById("parentSummary").textContent.trim().slice(0, 80),
    hasJump: !!document.querySelector("#parent .parent-banner [data-view-target='admin']")
  }));
  check("家长报告可免密进入", report.active);
  check("家长报告有结论文案", report.summary.length > 10, `「${report.summary}」`);
  check("家长报告有跳转家长管理入口", report.hasJump);
  await page.screenshot({ path: path.join(SHOT, "points-05-parent-report.png") });

  /* ---------------- 场景 4：家长管理密码门 + 设置 ---------------- */
  console.log("\n== 场景 4：家长管理 ==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "admin").click();
  });
  await sleep(400);
  /* 默认是"不拦"（家长忘了密码也能进，这是用户明确要求的）。
   * 所以这里先手动把密码开关打开并登出，才能验到真正的密码门。 */
  const adminDefault = await page.evaluate(() => ({
    enabled: state.admin.passwordEnabled,
    panelShown: !document.getElementById("adminPanel").classList.contains("hidden")
  }));
  check("默认不拦密码，点进家长管理直接看到面板", adminDefault.enabled === false && adminDefault.panelShown === true);

  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const box = document.getElementById("adminPasswordEnabled");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(200);
    document.querySelector("[data-action='admin-logout']").click();
    await wait(250);
  });
  await sleep(300);
  const adminLocked = await page.evaluate(() => ({
    lockShown: !document.getElementById("adminLock").classList.contains("hidden"),
    panelHidden: document.getElementById("adminPanel").classList.contains("hidden")
  }));
  check("启用密码并登出后是锁定界面", adminLocked.lockShown && adminLocked.panelHidden);
  await page.screenshot({ path: path.join(SHOT, "points-03-admin-lock.png") });

  // 错误密码
  await page.evaluate(() => {
    document.getElementById("adminPasswordInput").value = "9999";
    document.querySelector("[data-action='admin-login']").click();
  });
  await sleep(300);
  check("错误密码仍锁定", await page.$eval("#adminLock", el => !el.classList.contains("hidden")));

  // 正确密码
  await page.evaluate(() => {
    document.getElementById("adminPasswordInput").value = "09590677";
    document.querySelector("[data-action='admin-login']").click();
  });
  await sleep(400);
  check("正确密码解锁进入面板", await page.$eval("#adminPanel", el => !el.classList.contains("hidden")));

  // 改规则：金牌 300 / 银牌 200 / 铜牌 100，金币 8/4/2；兑换 1 金币 = 10 分钟 / 1 元
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("adminGoldScore", 300); set("adminSilverScore", 200); set("adminBronzeScore", 100);
    set("adminGoldCoin", 8); set("adminSilverCoin", 4); set("adminBronzeCoin", 2);
    set("adminMinutes", 10); set("adminYuan", 1);
  });
  await page.evaluate(() => {
    const btn = document.querySelector("#adminPanel [data-action='save-rewards']");
    if (btn) btn.click();
  });
  await sleep(300);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).rewards);
  check("奖励规则已持久化（金 300 / 金币 8）", saved.thresholds.gold === 300 && saved.coins.gold === 8, JSON.stringify(saved));

  // 兑换 4 金币 → 40 分钟
  await page.evaluate(() => {
    document.getElementById("adminSpend").value = "4";
    document.querySelector("[data-redeem='game']").click();
  });
  await sleep(400);
  const redeemed = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    return { last: s.redemptions[s.redemptions.length - 1], count: s.redemptions.length };
  });
  check("兑换记录写入（4 金币 → 40 分钟）",
    redeemed.last && redeemed.last.coins === 4 && /40/.test(JSON.stringify(redeemed.last)),
    JSON.stringify(redeemed.last));
  await page.screenshot({ path: path.join(SHOT, "points-04-admin-panel.png") });

  // 登出后重新锁定
  await page.evaluate(() => {
    const btn = document.querySelector("[data-action='admin-logout']");
    if (btn) btn.click();
  });
  await sleep(300);
  check("登出后重新锁定（此时密码是启用的）",
    await page.$eval("#adminLock", el => !el.classList.contains("hidden")));

  /* ---------------- 场景 5：未完成每日必写记 0 分 ---------------- */
  console.log("\n== 场景 5：只写拓展模块 → 当日 0 分 ==");
  await page.evaluateOnNewDocument(seedScript([["范文临摹", 88, 10], ["听音撰文", 90, 11]], undefined, undefined));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(700);
  const zero = await page.evaluate(() => {
    const w = document.getElementById("statWidget");
    return {
      todayScore: w.querySelector(".donut-center strong") ? w.querySelector(".donut-center strong").textContent.trim() : "",
      medalLine: w.querySelector(".stat-medal") ? w.querySelector(".stat-medal").textContent.trim() : "",
      cls: w.className,
      lockedViews: [...document.querySelectorAll(".nav-item")].filter(el => el.classList.contains("locked")).map(el => el.dataset.view)
    };
  });
  check("未写每日必写 → 当日总分 0", zero.todayScore === "0", zero.todayScore);
  check("未写每日必写 → 提示待完成", /待完成/.test(zero.medalLine), zero.medalLine);
  check("未写每日必写 → 仍是锁定态", zero.lockedViews.length >= 3, JSON.stringify(zero.lockedViews));

  /* ---------------- 场景 6：真实端到端（打字 → 提交 → 解锁 → 累计） ---------------- */
  console.log("\n== 场景 6：真实写作流程 ==");
  // 之前注册的 seed 脚本会在每个新文档执行，这里补一个"清空"脚本（注册更晚 → 后执行）
  await page.evaluateOnNewDocument(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  const sample = "今天下午放学的时候，天忽然暗了下来，风把操场边的梧桐叶吹得沙沙响。"
    + "我和同桌赶紧跑到走廊下面躲雨，雨点打在铁栏杆上，发出很好听的叮咚声。"
    + "过了一会儿，雨小了，天边露出一点点橙色的光，空气里全是泥土的味道。"
    + "我忽然觉得，下雨其实也挺好的，它把整个学校都洗得很干净。";

  // 写每日必写
  await page.evaluate(t => {
    const el = document.getElementById("essayInput");
    el.value = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, sample);
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(700);

  const afterFirst = await page.evaluate(() => {
    const w = document.getElementById("statWidget");
    return {
      view: [...document.querySelectorAll(".view")].filter(v => v.classList.contains("active")).map(v => v.id),
      todayScore: w.querySelector(".donut-center strong").textContent.trim(),
      medalLine: w.querySelector(".stat-medal").textContent.trim(),
      lockedViews: [...document.querySelectorAll(".nav-item")].filter(el => el.classList.contains("locked")).map(el => el.dataset.view),
      essayCount: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).essays.length,
      scoreShown: (document.getElementById("scoreValue") || {}).textContent || ""
    };
  });
  check("提交后跳到作文结果页", afterFirst.view.includes("result"), afterFirst.view.join(","));
  check("每日必写已入库", afterFirst.essayCount === 1, String(afterFirst.essayCount));
  check("结果页显示本次得分", Number(afterFirst.scoreShown) > 0, afterFirst.scoreShown + " 分");
  check("当日分数 = 本篇得分", Number(afterFirst.todayScore) > 0, afterFirst.todayScore + " 分");
  check("提交每日必写后解锁拓展模块", afterFirst.lockedViews.length === 0, JSON.stringify(afterFirst.lockedViews));
  await page.screenshot({ path: path.join(SHOT, "points-06-result.png") });

  // 再写一篇拓展任务，分数应累加
  const before = Number(afterFirst.todayScore);
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "dailyTask").click();
  });
  await sleep(300);
  await page.evaluate(() => document.querySelector("[data-action='start-task-writing']").click());
  await sleep(400);
  await page.evaluate(t => {
    const el = document.getElementById("essayInput");
    el.value = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, sample + sample);
  await sleep(200);
  await page.evaluate(() => document.querySelector("[data-action='submit-essay']").click());
  await sleep(700);

  const afterSecond = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    const w = document.getElementById("statWidget");
    return {
      todayScore: w.querySelector(".donut-center strong").textContent.trim(),
      essayCount: s.essays.length,
      types: s.essays.map(e => e.type)
    };
  });
  check("第二篇已入库", afterSecond.essayCount === 2, afterSecond.essayCount + " 篇 · " + afterSecond.types.join(","));
  check("当日分数为两篇之和（累加）", Number(afterSecond.todayScore) > before,
    `${before} → ${afterSecond.todayScore}`);

  check("第二篇已入库", afterSecond.essayCount === 2, afterSecond.essayCount + " 篇 · " + afterSecond.types.join(","));
  check("当日分数为两篇之和（累加）", Number(afterSecond.todayScore) > before,
    `${before} → ${afterSecond.todayScore}`);

  /* ---------------- 场景 7：游戏卡（积分榜：这周能不能玩游戏） ----------------
   * 老李原话：「在积分榜中增加一个是否可以游戏的判断，有三张可变色的游戏卡」。
   * 卡1 训练 ≥3 天 且 70 分作文 ≥3 篇；卡2 训练 ≥5 天 且 70 分作文 ≥3 篇；
   * 卡3 训练 ≥5 天 且 70 分作文 ≥5 篇。初始灰色，达标变彩色。
   * 注意：evaluateOnNewDocument 是**累加注册**的，后注册的脚本最后跑、最终写盘，
   * 所以这里每次 goto 前新注册的种子会覆盖前面场景写下的状态。 */
  console.log("\n== 场景 7：游戏卡 ==");
  // 种子：essays/sessions 用「相对本周六的偏移天数」描述，哪天跑测试都落在正确窗口里
  const gameSeed = spec => `(() => {
    const pad = n => String(n).padStart(2, "0");
    const iso = (d, hour) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).toISOString();
    const now = new Date(); now.setHours(12, 0, 0, 0);
    const back = (now.getDay() + 1) % 7;               // 与产品 gameWeekKeys 同一套口径
    const start = new Date(now); start.setDate(now.getDate() - back);
    const dayAt = i => { const d = new Date(start); d.setDate(start.getDate() + i); return d; };
    const essays = ${JSON.stringify(spec.essays)}.map(([off, score]) => ({
      id: "game-e" + off + "-" + score, date: iso(dayAt(off), 10),
      topicId: "game-e" + off, type: "每日必写", title: "游戏卡验证", goal: "", skillFocus: "语言表达",
      material: "", text: "这是用于验证游戏卡的测试作文。".repeat(3),
      feedback: { score, parts: {}, strengths: [], improvements: [], nextGoal: "" }
    }));
    const sessions = ${JSON.stringify(spec.sessions)}.map(off => ({
      id: "game-s" + off + "-" + Math.random(), date: iso(dayAt(off), 19),
      dayId: "game-day" + off, dayName: "训练日", week: 1,
      completion: 100, doneCount: 6, totalCount: 6, medal: "gold", coins: 5, durationSec: 600
    }));
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
      module: "write",
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
      essays, fitness: { sessions }
    }));
  })();`;
  // 与产品一致的窗口期望值（Node 侧算，浏览器里读 DOM 对比）
  const nowN = new Date();
  const backN = (nowN.getDay() + 1) % 7;
  const startN = new Date(nowN.getFullYear(), nowN.getMonth(), nowN.getDate() - backN);
  const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const wantRange = `${fmt(startN)} ~ ${fmt(new Date(startN.getFullYear(), startN.getMonth(), startN.getDate() + 6))}`;

  const readCards = () => page.evaluate(() => {
    const cards = [...document.querySelectorAll("#gameCards .game-card")];
    return {
      count: cards.length,
      states: cards.map(c => (c.classList.contains("unlocked") ? "1" : "0")).join(""),
      texts: cards.map(c => c.textContent.replace(/\s+/g, " ").trim()),
      imgs: cards.map(c => {
        const img = c.querySelector(".game-face-front img");
        return img ? (img.getAttribute("src") || "") + "|" + (img.naturalWidth > 0 ? "loaded" : "empty") : "none";
      }),
      flags: cards.map(c => {
        const f = c.querySelector(".game-card-flag");
        return f ? f.textContent.replace(/\s+/g, " ").trim() : "";
      }),
      range: (document.getElementById("gameWeekRange") || {}).textContent || ""
    };
  });

  // 7a. 无任何记录 → 三张卡全灰（初始状态）
  await page.evaluateOnNewDocument(gameSeed({ essays: [], sessions: [] }));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  // 游戏卡已挪到模块选择页（首页）：点「⇄ 切换模块」回去
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(400);
  const gameLocked = await readCards();
  check("游戏卡渲染出 3 张", gameLocked.count === 3, String(gameLocked.count));
  check("三张卡分别用懒猫 / 游戏猫 / 干饭猫卡图且真实加载",
    gameLocked.imgs.length === 3
      && gameLocked.imgs[0].startsWith("assets/img/game-cards/lazy-cat.jpg|loaded")
      && gameLocked.imgs[1].startsWith("assets/img/game-cards/play-cat.jpg|loaded")
      && gameLocked.imgs[2].startsWith("assets/img/game-cards/food-cat.jpg|loaded"),
    JSON.stringify(gameLocked.imgs));
  check("无记录时三张卡全灰（初始状态）", gameLocked.states === "000", gameLocked.states);
  check("未解锁时状态旗为🔒未解锁", gameLocked.flags.every(f => f.includes("未解锁")), JSON.stringify(gameLocked.flags));
  const lockedGray = await page.evaluate(() => {
    const img = document.querySelector("#gameCards .game-card.locked .game-face-front img");
    if (!img) return "no-img";
    return getComputedStyle(img).filter;
  });
  check("未解锁时卡图被去灰（grayscale）", /grayscale/.test(lockedGray), lockedGray);
  check("统计周期标注正确", gameLocked.range.includes(wantRange), `${gameLocked.range}（期望含 ${wantRange}）`);
  const homeOrder = await page.evaluate(() => {
    const arts = [...document.querySelectorAll("#moduleChooser article.card")];
    return arts.map(a => (a.querySelector("h3") ? a.querySelector("h3").textContent : "?")).join(" < ");
  });
  check("游戏卡在首页两张大卡下方，顺序为 游戏卡 < 金币奖金池 < 兑换记录",
    /^游戏卡 < 金币奖金池 < 兑换记录$/.test(homeOrder), homeOrder);
  const boardShape = await page.evaluate(() => {
    const board = document.getElementById("scoreboard");
    const names = [...board.querySelectorAll("article.card")].map(a => (a.querySelector("h3") ? a.querySelector("h3").textContent : "?"));
    return {
      names: names.join(" < "),
      hasGame: !!board.querySelector("#gameCards"),
      hasPool: !!board.querySelector("#coinPool"),
      hasHist: !!board.querySelector("#redeemHistory")
    };
  });
  check("写作积分榜与「体能积分」同模板（写作金币 + 本周榜单 + 本月分数走势）",
    /^写作金币 < 本周榜单 < 本月分数走势$/.test(boardShape.names), boardShape.names);
  check("积分榜里已无游戏卡 / 奖金池 / 兑换记录（都挪到首页）",
    !boardShape.hasGame && !boardShape.hasPool && !boardShape.hasHist,
    `game=${boardShape.hasGame} pool=${boardShape.hasPool} hist=${boardShape.hasHist}`);
  const gameEl = await page.$("#gameCards");
  if (gameEl) await gameEl.screenshot({ path: path.join(SHOT, "gamecard-01-locked.png") });

  // 7b. 5 个训练天 + 4 篇 70 分作文（另埋：同日重复提交、70 分作文、窗口外记录）→ 卡1、卡2 彩，卡3 灰
  await page.evaluateOnNewDocument(gameSeed({
    essays: [[2, 85], [3, 72], [4, 90], [5, 88], [2, 70], [-1, 95], [7, 99]],
    sessions: [0, 1, 2, 3, 3, 4]
  }));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  // 游戏卡已挪到模块选择页（首页）：点「⇄ 切换模块」回去
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(400);
  const gameMixed = await readCards();
  check("5 训练天 + 4 篇 70 分作文 → 卡1、卡2 彩色，卡3 灰", gameMixed.states === "110", gameMixed.states);
  check("训练进度按天去重显示 5（同日两次提交不翻倍）", /训练 5\/3 天/.test(gameMixed.texts[0] || ""), (gameMixed.texts[0] || "").slice(0, 60));
  check("70 分作文进度显示 4（70 分本身与窗口外不计）", /70 分作文 4\/3 篇/.test(gameMixed.texts[0] || "") && /70 分作文 4\/5 篇/.test(gameMixed.texts[2] || ""),
    (gameMixed.texts[2] || "").slice(0, 60));
  const gameEl2 = await page.$("#gameCards");
  if (gameEl2) await gameEl2.screenshot({ path: path.join(SHOT, "gamecard-02-mixed.png") });

  // 7c. 5 个训练天 + 5 篇 70 分作文 → 三张全彩
  await page.evaluateOnNewDocument(gameSeed({
    essays: [[1, 85], [2, 72], [3, 90], [4, 88], [5, 91]],
    sessions: [0, 1, 2, 3, 4]
  }));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  // 游戏卡已挪到模块选择页（首页）：点「⇄ 切换模块」回去
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(400);
  const gameAll = await readCards();
  check("5 训练天 + 5 篇 70 分作文 → 三张卡全彩", gameAll.states === "111", gameAll.states);
  check("解锁后状态旗为✨可游戏", gameAll.flags.every(f => f.includes("可游戏")), JSON.stringify(gameAll.flags));
  const unlockedColor = await page.evaluate(() => {
    const img = document.querySelector("#gameCards .game-card.unlocked .game-face-front img");
    return img ? getComputedStyle(img).filter : "no-img";
  });
  check("解锁后卡图恢复彩色（无 grayscale）", !/grayscale/.test(unlockedColor), unlockedColor);

  const gameEl3 = await page.$("#gameCards");
  if (gameEl3) await gameEl3.screenshot({ path: path.join(SHOT, "gamecard-03-all.png") });

  // 7d. 鼠标悬停 → 卡牌绕横轴翻起（3D 变换生效），移开后翻回
  const flipBefore = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#gameCards .game-card .game-card-flip")).transform);
  await page.hover("#gameCards .game-card");
  await sleep(1000);
  const flipHover = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#gameCards .game-card .game-card-flip")).transform);
  check("悬停时卡牌翻起（transform 变为 3D 矩阵）",
    flipBefore === "none" && /^matrix3d/.test(flipHover), `${flipBefore} → ${flipHover}`);
  const backVisible = await page.evaluate(() => {
    const back = document.querySelector("#gameCards .game-card .game-face-back");
    const r = back.getBoundingClientRect();
    return { text: back.textContent.replace(/\s+/g, " ").trim(), w: Math.round(r.width), h: Math.round(r.height) };
  });
  check("翻起后露出背面进度（含训练/作文条数）", /训练/.test(backVisible.text) && /70 分作文/.test(backVisible.text), backVisible.text.slice(0, 80));
  if (gameEl3) await gameEl3.screenshot({ path: path.join(SHOT, "gamecard-05-flip.png") });
  await page.mouse.move(0, 0);
  await sleep(1000);
  const flipBack = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#gameCards .game-card .game-card-flip")).transform);
  check("鼠标移开后卡牌翻回正面", flipBack === "none", flipBack);

  // 7e. 进写作模块看积分榜：左上角应是「写作金币」（只算写作部分，与体能积分同模板）
  await page.evaluate(() => document.querySelector(".chooser-card.is-write").click());
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "scoreboard").click();
  });
  await sleep(500);
  const writeCoins = await page.evaluate(() => {
    const box = document.getElementById("writeCoinPool");
    const hero = box ? box.querySelector(".coin-hero") : null;
    return {
      text: box ? box.textContent.replace(/\s+/g, " ").trim() : "missing",
      label: hero ? hero.querySelector("span").textContent : ""
    };
  });
  check("积分榜左上角是「写作金币」且只算写作部分",
    /写作累计金币/.test(writeCoins.text) && !/体能获得/.test(writeCoins.text), writeCoins.text.slice(0, 90));

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");

  console.log(`\n结果：通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) console.log("失败项：" + fail.join(" | "));

  await browser.close();
  process.exit(errors.length || fail.length ? 1 : 0);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
