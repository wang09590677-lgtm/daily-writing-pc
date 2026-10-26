/* 【游戏卡解锁规则探针】2026-10-22
 *
 * 老李原话：「在积分榜中增加一个是否可以游戏的判断，有三张可变色的游戏卡」，
 * 规则：一周内（上一周周六开始到本周周五的 7 天内）——
 *   卡1 完成今日训练 ≥3 天 且 70 分作文 ≥3 篇
 *   卡2 完成今日训练 ≥5 天 且 70 分作文 ≥3 篇
 *   卡3 完成今日训练 ≥5 天 且 70 分作文 ≥5 篇
 *
 * 本探针从 app.js 原文抠出 todayKey / dateFromKey / addDays / essayPoints
 * 和整块游戏卡逻辑（gameWeekKeys / gameWeekTrainDays / gameWeekGoodEssays /
 * gameCardStatus），用与产品一致的夹具（本地 19:00 → ISO，跟 submitFitness、
 * finish(record) 的存法逐字一致）验证：
 *   1. 周窗口：周三/周五/周六/周日/周一五种"今天"都落在正确的周六→周五 7 天周期
 *   2. 训练按天去重：同一天两次提交只算 1 天
 *   3. 窗口外记录（上周五、下周六）一律不计
 *   4. "超过 70"不含 70 本身；无 feedback.score 的作文不计
 *   5. 三张卡阈值边界：3+3 / 5+3 / 5+5 及各自差一天、差一篇的对照
 *   6. 卡3 全亮时卡1、卡2 必然也亮（规则自洽）
 *
 * 用法：node build/_probe-gamecard.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 30));
  return SRC.slice(i, j);
}
const parts = {
  todayKey: grab("function todayKey(date = new Date()) {", "function dateFromKey(key) {"),
  dateFromKey: grab("function dateFromKey(key) {", "// 周一为一周的第一天"),
  addDays: grab("function addDays(key, delta) {", "/* ---------- 积分 / 奖励体系"),
  essayPoints: grab("function essayPoints(item) {", "function dayScore(key) {"),
  gamecard: grab("/* ---------- 游戏卡", "function renderScoreboard() {")
};

/* 组装成工厂：state 由外部注入，与产品里"全局 state + 实时推导"的用法一致 */
const FACTORY = `
return function makeGame(stateIn) {
  let state = stateIn;
${parts.todayKey}
${parts.dateFromKey}
${parts.addDays}
${parts.essayPoints}
${parts.gamecard}
  return { gameWeekKeys, gameWeekTrainDays, gameWeekGoodEssays, gameCardStatus };
};
`;
let makeGame;
try {
  makeGame = new Function(FACTORY)();
} catch (e) {
  console.error("✗ 组装失败：", e.message);
  process.exit(1);
}
console.log("✓ 已从 app.js 抠出 todayKey / dateFromKey / addDays / essayPoints / 游戏卡块并组装");
console.log("  游戏卡块长度 =", parts.gamecard.length, "字符（原文）\n");

/* ---------- 夹具（忠实于真实契约字段） ---------- */
// 产品里 session.date = new Date(本地19:00).toISOString()，essay.date = new Date().toISOString()
const iso = (y, m, d, hour = 19) => new Date(y, m - 1, d, hour, 0, 0, 0).toISOString();
let seq = 0;
const essay = (y, m, d, score, hour = 10) => ({
  id: "seed-e" + (++seq), date: iso(y, m, d, hour), type: "每日必写",
  feedback: score === null ? {} : { score }
});
const session = (y, m, d, hour = 19) => ({
  id: "seed-s" + (++seq), date: iso(y, m, d, hour), completion: 100, medal: "gold", coins: 5
});
const blank = () => ({ essays: [], fitness: { sessions: [] } });
// 固定"今天"：2026-10-21 是周三（真实产品里取 new Date()，这里为了可复现传死日期）
const WED = new Date(2026, 9, 21, 20, 0, 0, 0); // 2026-10-21 周三
const unlocked = s => s.cards.map(c => (c.unlocked ? "1" : "0")).join("");

const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

/* ---------- 1. 周窗口 ---------- */
console.log("== 1. 周窗口（周六 → 周五 7 天）==");
{
  const g = makeGame(blank());
  const cases = [
    [new Date(2026, 9, 21, 20), "2026-10-17", "2026-10-23", "周三"],  // 周三 → 上周六~本周五
    [new Date(2026, 9, 23, 20), "2026-10-17", "2026-10-23", "周五"],  // 周五 → 上周六~今天
    [new Date(2026, 9, 24, 20), "2026-10-24", "2026-10-30", "周六"],  // 周六 → 从今天开始（不冻结）
    [new Date(2026, 9, 25, 20), "2026-10-24", "2026-10-30", "周日"],  // 周日 → 从昨天开始
    [new Date(2026, 9, 26, 8),  "2026-10-24", "2026-10-30", "周一"]   // 周一 → 上周六~本周五
  ];
  cases.forEach(([today, first, last, label]) => {
    const keys = g.gameWeekKeys(today);
    check(`${label}：窗口 = ${first} ~ ${last}`, keys.length === 7 && keys[0] === first && keys[6] === last,
      keys.length === 7 ? `${keys[0]} ~ ${keys[6]}` : `长度 ${keys.length}`);
  });
  // 7 天必须连续（中间不能跳日）
  const keys = g.gameWeekKeys(WED);
  let continuous = true;
  for (let i = 1; i < keys.length; i++) {
    const prev = new Date(keys[i - 1].slice(0, 4), keys[i - 1].slice(5, 7) - 1, keys[i - 1].slice(8, 10));
    prev.setDate(prev.getDate() + 1);
    if (g.gameWeekKeys(WED)[i] !== `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`) continuous = false;
  }
  check("窗口 7 天连续无跳日", continuous);
}

/* ---------- 2. 训练天数：按天去重 + 窗口边界 ---------- */
console.log("\n== 2. 训练天数（周三今天，窗口 10-17 ~ 10-23）==");
{
  const g = makeGame({ essays: [], fitness: { sessions: [
    session(2026, 10, 17), session(2026, 10, 18), session(2026, 10, 19),
    session(2026, 10, 20), session(2026, 10, 20, 21) // 同一天第二次提交
  ] } });
  check("同一天两次提交只算 1 天（5 条记录 → 4 天）", g.gameWeekTrainDays(WED) === 4, String(g.gameWeekTrainDays(WED)));

  const outside = makeGame({ essays: [], fitness: { sessions: [
    session(2026, 10, 16),              // 上周五：窗口外
    session(2026, 10, 17), session(2026, 10, 19),
    session(2026, 10, 24)               // 下周六：窗口外
  ] } });
  check("窗口外记录不计（3 条 → 2 天）", outside.gameWeekTrainDays(WED) === 2, String(outside.gameWeekTrainDays(WED)));

  const empty = makeGame(blank());
  check("无记录 = 0 天", empty.gameWeekTrainDays(WED) === 0);
}

/* ---------- 3. 70 分作文篇数 ---------- */
console.log("\n== 3. 70 分作文篇数 ==");
{
  const g = makeGame({ fitness: { sessions: [] }, essays: [
    essay(2026, 10, 18, 85), essay(2026, 10, 19, 71), essay(2026, 10, 20, 70), // 70 不算"超过 70"
    essay(2026, 10, 21, 90), essay(2026, 10, 21, 12),                            // 低分不算
    essay(2026, 10, 16, 95),                                                    // 窗口外
    essay(2026, 10, 24, 99),                                                    // 窗口外
    essay(2026, 10, 22, null)                                                   // 无 score 不计
  ] });
  check("只计窗口内 >70 的作文（8 篇 → 3 篇）", g.gameWeekGoodEssays(WED) === 3, String(g.gameWeekGoodEssays(WED)));
}

/* ---------- 4. 三张卡阈值 ---------- */
console.log("\n== 4. 三张卡阈值边界 ==");
{
  const mk = (days, scores) => makeGame({
    essays: scores.map((s, i) => essay(2026, 10, 18 + i, s)),
    fitness: { sessions: days.map(d => session(2026, 10, d)) }
  });

  const scenarios = [
    ["全空（初始全灰）", 0, [], "000"],
    ["训练 2 天 + 5 篇（训练不够）", 2, [85, 85, 85, 85, 85], "000"],
    ["训练 3 天 + 2 篇（作文不够）", 3, [85, 85], "000"],
    ["训练 3 天 + 3 篇（卡1 刚好）", 3, [85, 85, 85], "100"],
    ["训练 4 天 + 3 篇（仍只卡1）", 4, [85, 85, 85], "100"],
    ["训练 5 天 + 3 篇（卡1、卡2）", 5, [85, 85, 85], "110"],
    ["训练 5 天 + 4 篇（卡3 差一篇）", 5, [85, 85, 85, 85], "110"],
    ["训练 5 天 + 5 篇（全彩）", 5, [85, 85, 85, 85, 85], "111"],
    ["训练 6 天 + 5 篇（超出也全彩）", 6, [85, 85, 85, 85, 85], "111"]
  ];
  scenarios.forEach(([name, dayCount, scores, want]) => {
    const days = Array.from({ length: dayCount }, (_, i) => 17 + i); // 10-17 起连续天
    const s = mk(days, scores);
    check(`${name} → ${want}`, unlocked(s.gameCardStatus(WED)) === want, unlocked(s.gameCardStatus(WED)));
  });

  // 训练天数和作文数可以分别来自不同日期（不要求同一天）
  const mixed = makeGame({
    essays: [essay(2026, 10, 17, 80), essay(2026, 10, 22, 80)],
    fitness: { sessions: [session(2026, 10, 17), session(2026, 10, 18), session(2026, 10, 19), session(2026, 10, 20), session(2026, 10, 21)] }
  });
  check("训练与作文可来自不同天（5 天 + 2 篇 → 全灰）", unlocked(mixed.gameCardStatus(WED)) === "000", unlocked(mixed.gameCardStatus(WED)));
}

/* ---------- 5. 展示字段（renderScoreboard 要用） ---------- */
console.log("\n== 5. gameCardStatus 展示字段 ==");
{
  const g = makeGame({ essays: [essay(2026, 10, 19, 85)], fitness: { sessions: [session(2026, 10, 18)] } });
  const s = g.gameCardStatus(WED);
  check("keys 覆盖 7 天且含今天", s.keys.length === 7 && s.keys.includes("2026-10-21"), s.keys.join(","));
  check("trainDays / goodEssays 正确暴露", s.trainDays === 1 && s.goodEssays === 1, `${s.trainDays} 天 / ${s.goodEssays} 篇`);
  check("每张卡带出所需条件", s.cards.every(c => c.needTrain > 0 && c.needEssays > 0),
    s.cards.map(c => `${c.needTrain}天+${c.needEssays}篇`).join(" | "));
  check("卡1 条件 = 3 天 + 3 篇，卡2 = 5 + 3，卡3 = 5 + 5",
    s.cards[0].needTrain === 3 && s.cards[0].needEssays === 3 &&
    s.cards[1].needTrain === 5 && s.cards[1].needEssays === 3 &&
    s.cards[2].needTrain === 5 && s.cards[2].needEssays === 5);
}

console.log(`\n结果：${pass.length} 通过 / ${fail.length} 失败`);
if (fail.length) { console.log("失败项：\n - " + fail.join("\n - ")); process.exit(1); }
console.log("✓ 游戏卡解锁规则全部符合老李定的三条规则");
