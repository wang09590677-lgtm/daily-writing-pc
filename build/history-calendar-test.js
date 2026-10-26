// 历史作文「日历视图」端到端验证（真实 Chrome，file://）
//
// 验证目标（对应需求：点某一天显示那天写过的文章，没有则显示「空」，
// 并要能看到这篇的 AI 评语与改进意见）：
//   ① 日历渲染出 7 列（周一到周日）
//   ② 有作文的日子有标记（小圆点 + 当天最高分）
//   ③ 点有作文的日子 → 详情里出现该篇标题 + AI 评语原文 + 改进意见某条
//   ④ 点没作文的日子 → 详情里出现「空」
//   ⑤ 上一月 / 下一月 按钮真的改变了月份标题
//   ⑥ 展开全文能看到正文里的独有字符串
//
// 注意：这个页面在 puppeteer 下被 Chrome 重度节流（performance.now 几乎不走），
// 所以本测试**不依赖任何"等 N 秒自己触发"的时序**，全部是"操作后立刻读 DOM"。
// 也绝不冻结 Date.now()（会让页面里的计时全废）。
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
}

const pad = n => String(n).padStart(2, "0");
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 用**当前月**里的固定日期做种子，保证无论哪天跑，日历默认月份都能看到它们。
// 全用本地时间构造（不是 UTC），跟项目里 todayKey 的口径一致。
const now = new Date();
const Y = now.getFullYear(), M = now.getMonth();
const D_WITH_AI = new Date(Y, M, 5, 10, 30, 0);   // 这天 2 篇（其中一篇带完整 AI 反馈）
const D_ONE = new Date(Y, M, 20, 15, 10, 0);      // 这天 1 篇
const D_EMPTY = new Date(Y, M, 10, 12, 0, 0);     // 这天故意留空
const K_AI = keyOf(D_WITH_AI), K_ONE = keyOf(D_ONE), K_EMPTY = keyOf(D_EMPTY);

const CUR_LABEL = `${Y} 年 ${M + 1} 月`;
const PREV = new Date(Y, M - 1, 1);
const PREV_LABEL = `${PREV.getFullYear()} 年 ${PREV.getMonth() + 1} 月`;
const NEXT = new Date(Y, M + 1, 1);
const NEXT_LABEL = `${NEXT.getFullYear()} 年 ${NEXT.getMonth() + 1} 月`;

// 正文里的"独有标记"故意放在第 120 字之后 —— 不展开全文就看不到，
// 这样"展开"这个断言才有意义（否则摘要里本来就有，断言等于白写）。
const LONG_PAD = "开头先写一段铺垫，把时间地点交代清楚。".repeat(8); // 远超过摘要长度
const TEXT_MARKER = "MARKER_全文独有的结尾句子_只有展开才看得到";
const AI_TEXT = LONG_PAD + TEXT_MARKER;
const NARRATIVE = "NARRATIVE_UNIQUE 这篇把下雨前后的变化写得很有画面感，细节抓得准。";
const IMPROVE_1 = "IMPROVE_UNIQUE_1 结尾可以补一句自己当时的心情。";
const IMPROVE_2 = "IMPROVE_UNIQUE_2 开头再交代一下具体的时间和地点。";
const STRENGTH_1 = "STRENGTH_UNIQUE 用上了声音描写，读起来像在现场。";
const NEXT_GOAL = "NEXTGOAL_UNIQUE 下一篇重点练环境描写。";
const TITLE_AI = "AI版作文_标题甲";
const TITLE_LOCAL = "本地版作文_标题乙";
const TITLE_ONE = "单篇作文_标题丙";

function seedScript() {
  const state = {
    module: "write",
    profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
    essays: [
      {
        id: "seed-ai-1", date: D_WITH_AI.toISOString(), topicId: "t-ai",
        type: "每日必写", title: TITLE_AI, goal: "自由表达", skillFocus: "环境描写",
        material: "", text: AI_TEXT,
        feedback: {
          score: 92, source: "ai",
          narrative: NARRATIVE,
          strengths: [STRENGTH_1],
          improvements: [IMPROVE_1, IMPROVE_2],
          nextGoal: NEXT_GOAL,
          parts: { "细节与描写": 20 }
        }
      },
      {
        id: "seed-local-2", date: new Date(Y, M, 5, 11, 5, 0).toISOString(), topicId: "t-local",
        type: "范文临摹", title: TITLE_LOCAL, goal: "", skillFocus: "语言表达",
        material: "", text: "这是一篇本地兜底估分的作文，内容不长，用来验证没有 AI 评语时的提示。",
        feedback: {
          score: 70, source: "local",
          narrative: "",
          strengths: ["本地版值得肯定项"],
          improvements: ["本地版改进项"],
          nextGoal: "本地版下一篇目标"
        }
      },
      {
        id: "seed-one-3", date: D_ONE.toISOString(), topicId: "t-one",
        type: "听音撰文", title: TITLE_ONE, goal: "", skillFocus: "观察描写",
        material: "", text: "单独一天的一篇作文，用来验证只有一篇时的渲染。",
        feedback: {
          score: 81, source: "ai",
          narrative: "这篇单独一天的评语内容。",
          strengths: ["单篇值得肯定"],
          improvements: ["单篇改进意见"],
          nextGoal: "单篇目标"
        }
      }
    ]
  };
  return `(() => { localStorage.setItem("dailyWritingPcStateV3", ${JSON.stringify(JSON.stringify(state))}); })();`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required", "--no-proxy-server"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

  await page.evaluateOnNewDocument(seedScript());
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);

  // 直接切到历史视图（不走模块选择页），并确保日历已渲染
  await page.evaluate(() => { setView("history"); renderHistory(); });
  await sleep(200);

  const weekdays = await page.$$eval("#historyCalendar .cal-weekdays span", els => els.map(e => e.textContent.trim()));
  check("周标题是「一 二 三 四 五 六 日」（周一开头）",
    weekdays.join(",") === "一,二,三,四,五,六,日", weekdays.join(","));

  const grid = await page.evaluate(() => {
    const gridEl = document.querySelector("#historyCalendar .cal-grid");
    const cells = [...gridEl.children];
    return {
      cols: getComputedStyle(gridEl).gridTemplateColumns.split(" ").length,
      cellCount: cells.length,
      outCount: cells.filter(c => c.classList.contains("is-out")).length,
      title: document.querySelector("#historyCalendar .cal-title").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("月历网格是 7 列", grid.cols === 7, String(grid.cols));
  check("格子数补齐到 7 的整数倍（最后一行不被拉歪）",
    grid.cellCount % 7 === 0 && grid.cellCount >= 28, `${grid.cellCount} 格 / ${grid.outCount} 个补位`);
  check("月份标题是当前月", grid.title.includes(CUR_LABEL), `「${grid.title}」`);

  // ② 有作文的日子有标记 + 当天最高分
  const marks = await page.evaluate(({ kAi, kOne, kEmpty }) => {
    const cellOf = k => document.querySelector(`#historyCalendar [data-day="${k}"]`);
    const aiCell = cellOf(kAi), oneCell = cellOf(kOne), emptyCell = cellOf(kEmpty);
    return {
      hasEssayCells: document.querySelectorAll("#historyCalendar .cal-day.has-essay").length,
      aiHasDot: !!aiCell.querySelector(".cal-dot"),
      aiBest: aiCell.querySelector(".cal-day-mark b") ? aiCell.querySelector(".cal-day-mark b").textContent.trim() : "",
      oneHasDot: !!oneCell.querySelector(".cal-dot"),
      emptyIsClean: !emptyCell.classList.contains("has-essay") && !emptyCell.querySelector(".cal-dot"),
      todayMarked: document.querySelectorAll("#historyCalendar .cal-day.is-today").length
    };
  }, { kAi: K_AI, kOne: K_ONE, kEmpty: K_EMPTY });
  check("有作文的日子带标记（2 天有作文 → 2 个格子）", marks.hasEssayCells === 2, String(marks.hasEssayCells));
  check("多篇的那天显示当天最高分 92", marks.aiHasDot && marks.aiBest === "92", `点=${marks.aiHasDot} 最高分=${marks.aiBest}`);
  check("单篇那天也有标记", marks.oneHasDot);
  check("没作文的那天没有标记", marks.emptyIsClean);
  check("今天在日历里被高亮", marks.todayMarked === 1, String(marks.todayMarked));

  /* ---------------- ③ 点有作文的日子 ---------------- */
  await page.evaluate(k => document.querySelector(`#historyCalendar [data-day="${k}"]`).click(), K_AI);
  await sleep(200);
  const detail = await page.evaluate(() => {
    const box = document.getElementById("historyList");
    return { text: box.textContent, essays: box.querySelectorAll(".history-essay").length };
  });
  check("点有作文的日子 → 详情列出该天 2 篇", detail.essays === 2, String(detail.essays));
  check("详情包含该篇标题", detail.text.includes(TITLE_AI), TITLE_AI);
  check("详情包含 AI 评语原文", detail.text.includes(NARRATIVE), NARRATIVE.slice(0, 18) + "…");
  check("详情包含改进意见某条", detail.text.includes(IMPROVE_1), IMPROVE_1.slice(0, 18) + "…");
  check("详情包含「值得肯定」", detail.text.includes(STRENGTH_1));
  check("详情包含「下一篇目标」", detail.text.includes(NEXT_GOAL));
  // 本地兜底那篇没有 AI 评语，必须给出说明而不是留白
  check("本地兜底版有「没有 AI 评语」的说明", /本地兜底评分，没有 AI 评语/.test(detail.text));
  check("详情标出了分数来源", /AI 批改/.test(detail.text) && /本地估分/.test(detail.text));

  /* ---------------- ⑥ 展开全文 ---------------- */
  const beforeExpand = await page.evaluate(() => document.querySelector(".history-essay .he-excerpt").textContent);
  check("展开前摘要里看不到正文独有标记", !beforeExpand.includes(TEXT_MARKER));
  await page.evaluate(() => document.querySelector('.history-essay [data-action="history-toggle-text"]').click());
  await sleep(200);
  const afterExpand = await page.evaluate(() => ({
    text: document.getElementById("historyList").textContent,
    btn: document.querySelector('.history-essay [data-action="history-toggle-text"]').textContent.trim()
  }));
  check("点「看全文」后能看到正文独有标记", afterExpand.text.includes(TEXT_MARKER), TEXT_MARKER);
  check("展开后按钮变成「收起全文」", afterExpand.btn === "收起全文", afterExpand.btn);

  await page.screenshot({ path: path.join(SHOT, "history-calendar.png") });

  /* ---------------- ④ 点没作文的日子 ---------------- */
  await page.evaluate(k => document.querySelector(`#historyCalendar [data-day="${k}"]`).click(), K_EMPTY);
  await sleep(200);
  const emptyDetail = await page.evaluate(() => ({
    text: document.getElementById("historyList").textContent,
    essays: document.querySelectorAll("#historyList .history-essay").length,
    emptyBox: !!document.querySelector("#historyList .history-empty-day")
  }));
  check("点没作文的日子 → 出现「空」", emptyDetail.emptyBox && /空/.test(emptyDetail.text), emptyDetail.text.trim().slice(0, 40));
  check("空日子不显示任何作文卡片", emptyDetail.essays === 0, String(emptyDetail.essays));

  /* ---------------- ⑤ 翻月 ---------------- */
  await page.evaluate(() => document.querySelector("[data-action='history-prev-month']").click());
  await sleep(200);
  const prevTitle = await page.$eval("#historyCalendar .cal-title", el => el.textContent.replace(/\s+/g, " ").trim());
  check("点「上一月」月份标题变成上个月", prevTitle.includes(PREV_LABEL), `「${prevTitle}」`);

  await page.evaluate(() => document.querySelector("[data-action='history-next-month']").click());
  await sleep(200);
  const backTitle = await page.$eval("#historyCalendar .cal-title", el => el.textContent.replace(/\s+/g, " ").trim());
  check("点「下一月」回到本月", backTitle.includes(CUR_LABEL), `「${backTitle}」`);

  await page.evaluate(() => document.querySelector("[data-action='history-next-month']").click());
  await sleep(200);
  const nextTitle = await page.$eval("#historyCalendar .cal-title", el => el.textContent.replace(/\s+/g, " ").trim());
  check("再点「下一月」到再下个月", nextTitle.includes(NEXT_LABEL), `「${nextTitle}」`);

  await page.evaluate(() => document.querySelector("[data-action='history-this-month']").click());
  await sleep(200);
  const thisTitle = await page.$eval("#historyCalendar .cal-title", el => el.textContent.replace(/\s+/g, " ").trim());
  check("点「回到本月」回到当前月", thisTitle.includes(CUR_LABEL), `「${thisTitle}」`);

  // 窄屏排版（只做健康检查：格子不被压成 0 高）
  await page.setViewport({ width: 420, height: 900 });
  await sleep(250);
  const narrow = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#historyCalendar .cal-day")];
    const heights = cells.map(c => Math.round(c.getBoundingClientRect().height));
    return { min: Math.min(...heights), cols: getComputedStyle(document.querySelector(".cal-grid")).gridTemplateColumns.split(" ").length };
  });
  check("窄屏下 7 列仍在且格子有高度", narrow.cols === 7 && narrow.min >= 40, `最小高度 ${narrow.min}px`);
  await page.screenshot({ path: path.join(SHOT, "history-calendar-narrow.png") });

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");

  console.log(`\nPASS ${pass.length}/${pass.length + fail.length}`);
  if (fail.length) console.log("失败项：" + fail.join(" | "));

  await browser.close();
  process.exit(errors.length || fail.length ? 1 : 0);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
