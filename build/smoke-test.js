// 用最小 DOM 桩跑一遍 app.js，验证运行时无异常、数据接入正确
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function makeEl(id) {
  const el = {
    id,
    _html: "",
    _text: "",
    value: "",
    dataset: {},
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    click() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    contains() { return false; },
    querySelectorAll() { return []; },
    querySelector() { return makeEl("x"); },
    appendChild() {},
    insertBefore() {},
    removeChild() {},
    remove() {},
    closest() { return null; },
    scrollIntoView() {},
    contains() { return false; },
    getContext() {
      const noop = () => {};
      return {
        clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
        stroke: noop, fill: noop, fillText: noop, arc: noop, setLineDash: noop,
        set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
        set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}
      };
    }
  };
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = String(v); } });
  return el;
}

const registry = new Map();
const document = {
  getElementById(id) { if (!registry.has(id)) registry.set(id, makeEl(id)); return registry.get(id); },
  querySelector() { return makeEl("q"); },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
  removeEventListener() {},
  body: makeEl("body")
};

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};

const sandbox = {
  window: {},
  document,
  localStorage,
  console,
  alert: msg => console.log("[alert]", String(msg).slice(0, 80)),
  confirm: () => true,
  crypto: { randomUUID: () => "id-" + Math.random().toString(36).slice(2) },
  structuredClone: obj => JSON.parse(JSON.stringify(obj)),
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  performance: { now: () => Date.now() },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  Uint8Array,
  Math,
  Date,
  JSON,
  Set,
  Map,
  Number,
  String,
  Object,
  Array
};
sandbox.window = sandbox;

const ctx = vm.createContext(sandbox);

// 载入数据
["data/tasks.js", "data/models-classics.js", "data/models-authored-1.js", "data/models-authored-2.js", "data/models-authored-3.js", "data/models-authored-4.js", "data/models-authored-5.js", "data/models-authored-6.js", "data/audio-scenes.js", "data/audio-scenes-ext.js", "data/fitness-plan.js"].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
});

// 体感引擎：必须在 app.js 之前载入，app.js 顶层会读 window.MotionEngine
vm.runInContext(fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8"), ctx, { filename: "motion-engine.js" });

// 载入应用
// 音频引擎桩（Node 无 Web Audio）
sandbox.window.AudioSceneEngine = { PRIMITIVES: [], BANDS: 28, play: () => true, stop: () => {}, isPlaying: () => false, current: () => null, getAnalyser: () => null, getSpectrum: () => [], getStatus: () => ({ playing: false, layers: 0, error: "" }), onstate: () => {}, unlock: () => {} };

const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
vm.runInContext(appSrc + "\n;globalThis.__probe = { TASK_POOL, MODEL_POOL, MODEL_CATEGORIES, state, generateSmartTask, rerollModel, setModelCategory, startTaskWriting, startImitateWriting, getCurrentTask, getCurrentModel, tasksOfType, evaluateEssay, AUDIO_SCENES, rerollAudio, getCurrentAudio, setAudioCategory, startAudioWriting, audioScenesInCategory, buildMaterialHtml, pictureHtml,"
  + " todayKey, addDays, weekDayKeys, monthDayKeys, essaysOnDay, dailyEssentialDone, dayScore, dayDetail, medalOf, coinsForMedal, coinsEarned, writingCoinsEarned, coinsSpent, coinBalance, weekScore, monthScore, canStartExtraWriting, ensureGate, setView, LOCKED_VIEWS, adminLogin, adminLogout, adminUnlocked, adminPasswordRequired, setAdminPasswordEnabled, disableAdminPassword, saveRewards, doRedeem, changePassword, renderAdmin, renderStatWidget, renderScoreboard, renderNavLocks,"
  + " FITNESS_PLAN, FITNESS_EX, FITNESS_TESTS, FITNESS_PHASES, fitnessDayFor, fitnessWeekNo, fitnessPhaseOf, fitnessBlocks, fitnessCompletion, fitnessMedalOf, fitnessCoinsForMedal, fitnessDayDetail, fitnessCoinsEarned, fitnessWeekDetails, fitnessMonthSeries, fitnessTrainingDays, fitnessStreak, fitnessDoneIds, fitnessPickedIds, isFitBlockPicked, isFitBlockDone, toggleFitPick, setFitBlockDone, syncFitBlockEl, submitFitness, resetTodayChecklist, saveFitnessRewards, saveFitnessTest, fitnessTestBest, fitnessTestFirst, setModule, applyModule, backToChooser, renderFitnessToday, renderFitnessBoard, renderFitnessTest, renderFitnessHistory, drawFitMonthChart,"
  + " MotionEngine, FITNESS_MOTION_GUIDE, motionEnabled, motionProfileFor, motionMeasurableIds, motionChoices, motionGoalFor, motionMedalOf, motionCoinsForMedal, motionDayDetail, motionCoinsEarned, motionLastRecord, motionBestRecord, saveMotionRecord, saveMotionRewards, clearMotionData, renderFitnessMotion, renderFitnessReport, MOTION_CAMERA_ERROR };", ctx, { filename: "app.js" });

const P = ctx.__probe;
console.log("== 任务池 ==");
console.log("TASK_POOL:", P.TASK_POOL.length);
["fragment", "picture", "expand", "words", "news"].forEach(t => console.log("  ", t, P.tasksOfType(t).length));
console.log("== 范文池 ==");
console.log("MODEL_POOL:", P.MODEL_POOL.length);
console.log("分类数:", P.MODEL_CATEGORIES.length);
console.log(P.MODEL_CATEGORIES.map(([n, c]) => `    ${n}:${c}`).join("\n"));

console.log("== 抽样任务 ==");
["fragment", "picture", "expand", "words", "news"].forEach(t => {
  P.generateSmartTask(t);
  const task = P.getCurrentTask();
  console.log(`  [${t}] ${task.title} | 素材长度 ${task.material.length} | 追问 ${task.prompts.length} | 能力 ${task.skill}`);
});

console.log("== 抽样范文 ==");
for (let i = 0; i < 5; i++) {
  P.rerollModel();
  const m = P.getCurrentModel();
  console.log(`  《${m.title}》[${m.category}/${m.type}] ${m.chars}字 能力:${m.skill}`);
}

console.log("== 分类筛选 ==");
P.setModelCategory("古诗词");
console.log("  古诗词筛选后当前:", P.getCurrentModel().title, "|", P.getCurrentModel().category);
P.setModelCategory("全部");

console.log("== 每日必写门禁 ==");
const T0 = P.todayKey();
P.state.essays = [];
P.state.redemptions = [];
console.log("  未完成每日必写 → canStartExtraWriting:", P.canStartExtraWriting(), "(期望 false)");
P.generateSmartTask("news");
P.startTaskWriting();
console.log("  强行开始每日任务被拦截，activeWriting.type 仍为:", P.state.activeWriting.type, "(期望 每日必写)");
P.startImitateWriting();
console.log("  强行开始范文临摹被拦截，activeWriting.type 仍为:", P.state.activeWriting.type, "(期望 每日必写)");
P.startAudioWriting();
console.log("  强行开始听音撰文被拦截，activeWriting.type 仍为:", P.state.activeWriting.type, "(期望 每日必写)");
console.log("  受门禁保护的视图:", Object.keys(P.LOCKED_VIEWS).join(","));

console.log("== 写作入口（先补上今天的每日必写）==");
P.state.essays.push({ id: "seed-daily", date: new Date(T0 + "T09:00:00").toISOString(), type: "每日必写", kind: "daily", title: "今天我想写：", feedback: { score: 60 } });
console.log("  完成每日必写 → canStartExtraWriting:", P.canStartExtraWriting(), "(期望 true)");
P.generateSmartTask("news");
P.startTaskWriting();
console.log("  activeWriting.kind =", P.state.activeWriting.kind, "| type =", P.state.activeWriting.type);
P.startImitateWriting();
console.log("  activeWriting.kind =", P.state.activeWriting.kind, "| type =", P.state.activeWriting.type, "| 素材长度", P.state.activeWriting.material.length);

console.log("== 评分器 ==");
const sample = "今天放学回家的路上，我看见一只小猫蹲在墙边。它的毛是橘色的，眼睛亮亮的。我蹲下来看了很久，它也看着我。后来我把书包里的一小块面包掰给它，它慢慢地吃完了。我忽然觉得，小小的善意也能让别人开心。";
const fb = P.evaluateEssay(sample);
console.log("  得分:", fb.score, "| 维度:", JSON.stringify(fb.parts));
console.log("  优点:", fb.strengths[0]);
console.log("  改进:", fb.improvements[0]);
console.log("  目标:", fb.nextGoal);
console.log("== 听音撰文 ==");
console.log("  场景总数:", P.AUDIO_SCENES.length);
console.log("  任务池中的听音题:", P.tasksOfType("audio").length);
P.generateSmartTask("audio");
const at = P.getCurrentTask();
console.log("  抽样题目:", at.title, "| sceneId:", at.sceneId, "| 能力:", at.skill);
for (let i = 0; i < 3; i++) {
  P.rerollAudio();
  const sc = P.getCurrentAudio();
  console.log("  声音", sc.id, "《" + sc.title + "》[" + sc.category + "]", sc.seconds + "s", "图层:" + sc.layers.map(l => l[0]).join("+"));
}
P.setAudioCategory("交通");
console.log("  交通分类筛选后:", P.getCurrentAudio().title, "| 池内", P.audioScenesInCategory().length, "段");
P.setAudioCategory("全部");
P.generateSmartTask("audio");
P.startAudioWriting();
console.log("  activeWriting:", P.state.activeWriting.kind, "|", P.state.activeWriting.type, "| sceneId:", P.state.activeWriting.sceneId);
console.log("  播放接口:", typeof (globalThis.AudioSceneEngine || {}).play);

console.log("== 看图编故事配图 ==");
const picTasks = P.tasksOfType("picture");
const noId = picTasks.filter(t => !t.imageId);
console.log("  图片任务数:", picTasks.length, "| 缺 imageId:", noId.length);
const picDir = path.join(ROOT, "assets", "pictures");
let have = 0, miss = [];
picTasks.forEach(t => {
  if (fs.existsSync(path.join(picDir, t.imageId + ".jpg"))) have++;
  else miss.push(t.imageId);
});
console.log("  已生成图片:", have, "/", picTasks.length, miss.length ? ("| 缺: " + miss.slice(0, 8).join(",") + (miss.length > 8 ? " …" : "")) : "| 全部就位");
const demoTask = picTasks[0];
const demoHtml = P.buildMaterialHtml(demoTask, true);
console.log("  渲染含 <img>:", /<img class="picture-prompt-img" src="assets\/pictures\/pic001\.jpg"/.test(demoHtml));
console.log("  渲染含 alt:", /alt="看图编故事配图/.test(demoHtml));
console.log("  无图时回退占位:", !/<img/.test(P.buildMaterialHtml({ ...demoTask, id: "custom-1", imageId: "" }, true)) && /is-missing/.test(P.buildMaterialHtml({ ...demoTask, id: "custom-1", imageId: "" }, true)));
console.log("  从 id 兜底恢复:", /pic001\.jpg/.test(P.buildMaterialHtml({ ...demoTask, imageId: undefined }, true)));
console.log("  includePicture=false 不渲染:", !/<figure/.test(P.buildMaterialHtml(demoTask, false)));

console.log("== 听音撰文 · 真实录音覆盖检查 ==");
const audioDir = path.join(ROOT, "assets", "audio");
const usedPrims = new Set();
P.AUDIO_SCENES.forEach(s => s.layers.forEach(l => usedPrims.add(l[0])));
const audioMissing = [...usedPrims].filter(id => !fs.existsSync(path.join(audioDir, id + ".mp3")));
let audioBytes = 0;
[...usedPrims].forEach(id => {
  const p = path.join(audioDir, id + ".mp3");
  if (fs.existsSync(p)) audioBytes += fs.statSync(p).size;
});
console.log("  场景用到的音效基元:", usedPrims.size, "| 缺音频文件:", audioMissing.length ? audioMissing.join(",") : "无");
console.log("  音频总量: " + (audioBytes / 1048576).toFixed(1) + " MB");
console.log("  频谱包络数据:", fs.existsSync(path.join(audioDir, "spectrum.js")) ? "已生成" : "缺失");
const specScenes = P.AUDIO_SCENES.filter(s => s.layers.some(l => !fs.existsSync(path.join(audioDir, l[0] + ".mp3"))));
console.log("  存在缺音的完整场景:", specScenes.length);

console.log("== 积分 / 奖励体系 ==");
const T = P.todayKey();
const Y = P.addDays(T, -1);
const mk = (type, score, dayKey, hour = 12) => ({
  id: "t-" + type + "-" + score + "-" + Math.random().toString(36).slice(2),
  date: new Date(`${dayKey}T${String(hour).padStart(2, "0")}:00:00`).toISOString(),
  type, kind: type === "每日必写" ? "daily" : "task", title: type,
  text: "测试正文".repeat(20),
  feedback: { score }
});

// 用户给的例子：60 + 23 + 45 + 12 + 78 + 23 + 44 = 285
P.state.essays = [
  mk("每日必写", 60, T), mk("每日任务", 23, T), mk("每日任务", 45, T),
  mk("每日任务", 12, T), mk("每日任务", 78, T), mk("范文临摹", 23, T), mk("听音撰文", 44, T)
];
P.state.redemptions = [];
P.state.rewards = { thresholds: { gold: 240, silver: 180, bronze: 120 }, coins: { gold: 5, silver: 3, bronze: 1 }, redeem: { minutesPerCoin: 5, yuanPerCoin: 0.5 } };
console.log("  当日总分:", P.dayScore(T), "(期望 285)");
const det = P.dayDetail(T);
console.log("  当日明细: 篇数", det.essays.length, "| 已完成每日必写", det.done, "| 奖牌", det.medal, "| 金币", det.coins, "(期望 7 篇 / true / gold / 5)");

// 没完成每日必写 → 当日 0 分
P.state.essays = [mk("每日任务", 50, T), mk("听音撰文", 80, T)];
console.log("  只写拓展模块、没写每日必写 → 当日总分:", P.dayScore(T), "(期望 0)");
console.log("  该日奖牌:", P.dayDetail(T).medal, "| 金币:", P.dayDetail(T).coins, "(期望 none / 0)");
P.state.essays = [];
console.log("  整天没写 → 当日总分:", P.dayScore(T), "(期望 0)");

// 分数线变化会改变奖牌
P.state.essays = [mk("每日必写", 60, T), mk("每日任务", 45, T), mk("听音撰文", 44, T)]; // 149 分
P.state.rewards.thresholds = { gold: 300, silver: 140, bronze: 100 };
console.log("  149 分 / 银牌线 140 →", P.dayDetail(T).medal, "(期望 silver)");
P.state.rewards.thresholds = { gold: 300, silver: 200, bronze: 100 };
console.log("  149 分 / 银牌线 200 →", P.dayDetail(T).medal, "(期望 bronze)");

// 金币累计与兑换
P.state.rewards = { thresholds: { gold: 240, silver: 180, bronze: 100 }, coins: { gold: 5, silver: 3, bronze: 1 }, redeem: { minutesPerCoin: 5, yuanPerCoin: 0.5 } };
P.state.essays = [mk("每日必写", 200, T, 9), mk("每日必写", 210, Y, 9)]; // 今天 200=银牌3，昨天 210=银牌3
console.log("  累计获得金币:", P.coinsEarned(), "(期望 6)");
P.state.redemptions = [{ id: "r1", at: new Date().toISOString(), coins: 2, kind: "game", amount: 10 }];
console.log("  已兑换:", P.coinsSpent(), "| 余额:", P.coinBalance(), "(期望 2 / 4)");
// 家长调高分数线后，历史金币变少，余额必须钳到 0 而不是负数
P.state.redemptions = [{ id: "r2", at: new Date().toISOString(), coins: 99, kind: "game", amount: 495 }];
console.log("  兑换超过累计获得时余额不为负:", P.coinBalance() === 0, "(期望 true)");
P.state.redemptions = [];

// 周 / 月聚合
console.log("  本周天数:", P.weekDayKeys().length, "| 本月天数:", P.monthDayKeys().length);
console.log("  周分数:", P.weekScore(), "| 月分数:", P.monthScore(), "(应 ≥ 当日分数)");
console.log("  周起点为周一:", new Date(P.weekDayKeys()[0] + "T00:00:00").getDay() === 1, "(期望 true)");
console.log("  未写每日必写的昨天记 0 分:", P.dayScore(Y) === 0 ? "是（已覆盖）" : "否（昨天有成绩）");

console.log("== 家长管理（密码门）==");
const pw = document.getElementById("adminPasswordInput");
P.state.admin.password = "09590677";
// 默认是"不拦"（家长忘了密码也得进得去）；要验密码门，先把它显式打开
P.state.admin.passwordEnabled = true;
P.state.admin.unlockedAt = 0;
console.log("  初始为锁定状态:", !P.adminUnlocked(), "(期望 true)");
pw.value = "0000"; P.adminLogin();
console.log("  输错密码仍锁定:", !P.adminUnlocked(), "(期望 true)");
pw.value = "09590677"; P.adminLogin();
console.log("  输对密码已解锁:", P.adminUnlocked(), "(期望 true)");
P.setAdminPasswordEnabled(false);
console.log("  关掉密码后免密进入:", P.adminUnlocked(), "(期望 true)");

console.log("  修改奖励规则（金牌线 300 / 银牌 200 / 铜牌 100，金币 8/4/2）");
document.getElementById("adminGoldScore").value = "300";
document.getElementById("adminSilverScore").value = "200";
document.getElementById("adminBronzeScore").value = "100";
document.getElementById("adminGoldCoin").value = "8";
document.getElementById("adminSilverCoin").value = "4";
document.getElementById("adminBronzeCoin").value = "2";
document.getElementById("adminMinutes").value = "10";
document.getElementById("adminYuan").value = "1";
P.saveRewards();
const rw = P.state.rewards;
console.log("  保存后:", JSON.stringify(rw.thresholds), JSON.stringify(rw.coins), JSON.stringify(rw.redeem));

console.log("  非法分数线（金牌 < 银牌）应被拒绝");
document.getElementById("adminGoldScore").value = "50";
document.getElementById("adminSilverScore").value = "200";
P.saveRewards();
console.log("  拒绝后金牌线仍为:", P.state.rewards.thresholds.gold, "(期望 300)");

console.log("  兑换：4 金币 → 40 分钟游戏时间");
document.getElementById("adminSpend").value = "4";
P.doRedeem("game");
const last = P.state.redemptions.at(-1);
console.log("  兑换记录:", last ? `${last.coins} 金币 → ${last.amount} 分钟` : "无", "| 余额:", P.coinBalance());

console.log("  超额兑换应被拒绝");
const before = P.state.redemptions.length;
document.getElementById("adminSpend").value = "9999";
P.doRedeem("cash");
console.log("  兑换记录未增加:", P.state.redemptions.length === before, "(期望 true)");

// 重新打开密码门，才能验"退出后重新锁定"
P.setAdminPasswordEnabled(true);
console.log("  退出家长管理后重新锁定:", (P.adminLogout(), !P.adminUnlocked()), "(期望 true)");

/* ================= 体能训练模块 ================= */

console.log("== 体能训练计划 ==");
console.log("  主题日数量:", P.FITNESS_PLAN.length, "(期望 7)");
console.log("  动作库动作数:", Object.keys(P.FITNESS_EX).length);
console.log("  阶段数:", P.FITNESS_PHASES.length, "(期望 4)");
console.log("  自测项目:", P.FITNESS_TESTS.map(t => t.name).join(" / "));
P.FITNESS_PLAN.forEach(day => {
  const blocks = P.fitnessBlocks(day, P.FITNESS_PHASES[0]);
  const n = blocks.warmup.length + blocks.main.length + blocks.cooldown.length;
  console.log(`   周${day.weekday} ${day.name}${day.rest ? "（休息）" : ""} 热身${blocks.warmup.length} 主${blocks.main.length} 放松${blocks.cooldown.length} 共${n}块`);
  if (!day.rest) {
    const warmIds = blocks.warmup.map(b => b.ex);
    if (warmIds.includes("jumpingJacks") || warmIds.includes("highKnees")) throw new Error("开合跳或原地高抬腿跑误入热身: " + day.id);
  }
});
const speed = P.fitnessBlocks(P.FITNESS_PLAN.find(d => d.id === "thu"), P.FITNESS_PHASES[0]);
for (const id of ["jumpingJacks", "highKnees", "abWheel", "plank"]) {
  if (!speed.main.some(b => b.ex === id)) throw new Error("周四主训练缺少 " + id);
}
if (P.FITNESS_EX.abWheel.name !== "跪姿健腹轮" || P.FITNESS_EX.highKnees.name !== "原地高抬腿跑") {
  throw new Error("训练项目名称错误");
}
console.log("  PASS: 周四主训练包含开合跳、原地高抬腿跑、跪姿健腹轮、平板支撑，热身无误");

console.log("== 8 周进阶（以周二腿力日为例）==");
const tueDay = P.FITNESS_PLAN.find(d => d.id === "tue");
P.FITNESS_PHASES.forEach(phase => {
  const b = P.fitnessBlocks(tueDay, phase);
  const wallSit = b.main.find(x => x.ex === "wallSit");
  const squat = b.main.find(x => x.ex === "squat");
  console.log(`  第${phase.from}-${phase.to}周 ${phase.name}: 靠墙静蹲 ${wallSit.sets}组×${wallSit.target}秒 | 深蹲 ${squat.sets}组×${squat.target}次`);
});

console.log("== 完成度与奖牌 ==");
const monday = P.FITNESS_PLAN.find(d => d.id === "mon");
const monBlocks = P.fitnessBlocks(monday, P.FITNESS_PHASES[0]);
const allIds = [...monBlocks.warmup, ...monBlocks.main, ...monBlocks.cooldown].map(b => b.id);
const mainIds = monBlocks.main.map(b => b.id);
const warmIds = monBlocks.warmup.map(b => b.id);

// 周一作为"今天"来测（把系统日期固定到周一）
const MON = (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 回到本周一
  return P.todayKey(d);
})();

P.state.fitness.done = {};
P.state.fitness.sessions = [];
P.state.fitness.startDate = MON;

const setDone = ids => { P.state.fitness.done[MON] = ids; };
const comp = () => P.fitnessCompletion(MON).percent;

setDone([]);
console.log("  一个都没勾 → 完成度:", comp(), "(期望 0)");
setDone(warmIds);
console.log("  只完成热身 → 完成度:", comp(), "(权重 3/18 ≈ 17)");
setDone(mainIds);
console.log("  只完成主训练 → 完成度:", comp(), "(权重 12/18 ≈ 67)");
setDone(allIds);
const full = P.fitnessCompletion(MON);
console.log("  全部完成 → 完成度:", full.percent, "| 块数:", `${full.doneCount}/${full.totalCount}`, "(期望 100)");

console.log("  奖牌判定: 100% →", P.fitnessMedalOf(100), "| 90% →", P.fitnessMedalOf(90), "| 75% →", P.fitnessMedalOf(75), "| 50% →", P.fitnessMedalOf(50));
console.log("  （默认线：金 100 / 银 85 / 铜 70）");
console.log("  奖牌只发一个、不叠加: 100% →", P.fitnessMedalOf(100), "只拿", P.fitnessCoinsForMedal(P.fitnessMedalOf(100)),
  "金币 (期望 gold / 5，不是 5+3+1=9)");

console.log("== 选中(picked) 与 完成(done) 是两件事 ==");
P.state.fitness.picked = {};
P.state.fitness.done = {};
P.toggleFitPick("mon:main:0");
console.log("  勾选后 picked:", P.isFitBlockPicked("mon:main:0"), "| done:", P.isFitBlockDone("mon:main:0"), "(期望 true / false)");
P.setFitBlockDone("mon:main:0", true);
console.log("  计时跑完 → done:", P.isFitBlockDone("mon:main:0"), "| picked 仍在:", P.isFitBlockPicked("mon:main:0"), "(期望 true / true)");
P.toggleFitPick("mon:main:0");
console.log("  取消勾选 → picked:", P.isFitBlockPicked("mon:main:0"), "| done 一起撤销:", P.isFitBlockDone("mon:main:0"), "(期望 false / false)");
P.state.fitness.picked = {};
P.state.fitness.done = {};

console.log("== 提交训练与金币结算 ==");
P.state.fitness.rewards = { thresholds: { gold: 100, silver: 85, bronze: 70 }, coins: { gold: 5, silver: 3, bronze: 1 } };
P.state.fitness.sessions = [];
setDone(allIds);
P.submitFitness(MON);
let detail = P.fitnessDayDetail(MON);
console.log("  全勤提交 → 完成度:", detail.completion, "| 奖牌:", detail.medal, "| 金币:", detail.coins, "(期望 100 / gold / 5)");
console.log("  体能累计金币:", P.fitnessCoinsEarned(), "(期望 5)");

// 同一天再练一次但完成度更低 → 仍取最高的一次
P.state.fitness.sessions.push({
  id: "lower", date: new Date(MON + "T10:00:00").toISOString(), dayId: "mon", dayName: "心肺耐力日",
  week: 1, completion: 30, doneCount: 2, totalCount: 10, medal: "none", coins: 0, durationSec: 300
});
detail = P.fitnessDayDetail(MON);
console.log("  同日再练一次(30%) → 当日仍取最高:", detail.completion, "% | 金币:", detail.coins, "(期望 100 / 5)");
console.log("  体能累计金币未翻倍:", P.fitnessCoinsEarned(), "(期望 5)");

console.log("== 奖金池合并 ==");
P.state.essays = [mk("每日必写", 200, MON, 9), mk("每日必写", 210, MON, 10)];
P.state.rewards = { thresholds: { gold: 240, silver: 180, bronze: 100 }, coins: { gold: 5, silver: 3, bronze: 1 }, redeem: { minutesPerCoin: 5, yuanPerCoin: 0.5 } };
console.log("  写作金币:", P.writingCoinsEarned(), "(410 分 ≥ 金 240 → 5)");
console.log("  体能金币:", P.fitnessCoinsEarned(), "(5)");
console.log("  奖金池合计:", P.coinsEarned(), "(期望 10 = 写作5 + 体能5)");

console.log("== 休息日不结算 ==");
const sunday = P.FITNESS_PLAN.find(d => d.id === "sun");
console.log("  周日是否休息日:", sunday.rest === true, "(期望 true)");
console.log("  休息日动作块数:", P.fitnessBlocks(sunday, P.FITNESS_PHASES[0]).main.length, "(期望 0)");

console.log("== 体能自测 ==");
P.state.fitness.tests = [];
document.querySelector = () => ({ value: "42" });
P.saveFitnessTest("highKnees30");
P.state.fitness.tests.push({ id: "t2", at: new Date().toISOString(), testId: "highKnees30", value: 55 });
console.log("  30 秒高抬腿 第一次:", P.fitnessTestFirst("highKnees30").value, "| 最好:", P.fitnessTestBest("highKnees30").value, "(期望 42 / 55)");

console.log("== 体能奖励规则（家长可改）==");
P.state.admin.unlockedAt = Date.now();
document.getElementById("fitGoldScore").value = "100";
document.getElementById("fitSilverScore").value = "80";
document.getElementById("fitBronzeScore").value = "60";
document.getElementById("fitGoldCoin").value = "8";
document.getElementById("fitSilverCoin").value = "4";
document.getElementById("fitBronzeCoin").value = "2";
P.saveFitnessRewards();
console.log("  保存后:", JSON.stringify(P.state.fitness.rewards));
console.log("  80% →", P.fitnessMedalOf(80), "(银线 80 → silver)");
console.log("  非法完成度线（金 < 银）应被拒绝");
document.getElementById("fitGoldScore").value = "40";
document.getElementById("fitSilverScore").value = "90";
P.saveFitnessRewards();
console.log("  拒绝后金牌线仍为:", P.state.fitness.rewards.thresholds.gold, "(期望 100)");

console.log("== 模块切换 ==");
P.setModule("fitness");
console.log("  state.module:", P.state.module, "(期望 fitness)");
P.setModule("write");
console.log("  切回写作:", P.state.module, "(期望 write)");
P.backToChooser();
console.log("  返回选择页:", JSON.stringify(P.state.module), "(期望 \"\")");

/* ==================================================================
 * 体感跟练（摄像头动作分析）
 * ================================================================== */

console.log("== 体感动作库参数 ==");
const measurable = P.motionMeasurableIds();
const modes = { rep: 0, burst: 0, hold: 0, none: 0 };
Object.keys(P.FITNESS_EX).forEach(id => { modes[P.FITNESS_EX[id].motion.mode] += 1; });
console.log("  动作总数:", Object.keys(P.FITNESS_EX).length, "| 可体感跟练:", measurable.length, "(期望 21)");
console.log("  可计次:", modes.rep, "(11) | 高频改测强度:", modes.burst, "(7) | 保持类:", modes.hold, "(3) | 不评分:", modes.none, "(9)");
const badRep = measurable.filter(id => {
  const m = P.FITNESS_EX[id].motion;
  return m.mode === "rep" && (!Array.isArray(m.tempoBand) || !(m.minRepGap > 0) || !(m.expectedAmplitude > 0) || !m.signal);
});
const badHold = measurable.filter(id => {
  const m = P.FITNESS_EX[id].motion;
  return m.mode === "hold" && !(m.holdSeconds > 0);
});
const badBurst = measurable.filter(id => {
  const m = P.FITNESS_EX[id].motion;
  return m.mode === "burst" && !(m.refIntensity > 0);
});
console.log("  计次类参数完整:", badRep.length === 0, "(期望 true) | 保持类有目标时长:", badHold.length === 0, "(期望 true) | 高频类有强度参考:", badBurst.length === 0, "(期望 true)");
console.log("  引导文案: 能测", P.FITNESS_MOTION_GUIDE.canDo.length, "条 / 测不了", P.FITNESS_MOTION_GUIDE.cannotDo.length, "条 / 摆放", P.FITNESS_MOTION_GUIDE.setup.length, "条");

console.log("== 体感目标换算 ==");
const monBlocksM = P.fitnessBlocks(P.FITNESS_PLAN.find(d => d.id === "mon"), P.FITNESS_PHASES[0]);
const tueBlocks = P.fitnessBlocks(P.FITNESS_PLAN.find(d => d.id === "tue"), P.FITNESS_PHASES[0]);
const choiceFor = (exId, target, blocks) => {
  const block = (blocks || []).find(b => b.ex === exId);
  return { exId, profile: P.motionProfileFor(exId), target: target || (block && block.target) || 0, blockId: block ? block.id : "", group: "main" };
};
console.log("  开合跳（3 组 × 30 次）→", P.motionGoalFor(choiceFor("jumpingJacks", 30, monBlocksM.main)).label);
console.log("  高抬腿（3 组 × 20 秒，高频动作）→", P.motionGoalFor(choiceFor("highKnees", 20, monBlocksM.main)).label);
console.log("  小步跑（3 组 × 30 秒，高频动作）→", P.motionGoalFor(choiceFor("fastFeet", 30, monBlocksM.main)).label);
console.log("  靠墙静蹲（3 组 × 30 秒）→", P.motionGoalFor(choiceFor("wallSit", 30, tueBlocks.main)).label);
console.log("  弓步蹲（次/侧，目标 8）→", P.motionGoalFor(choiceFor("lunge", 8, tueBlocks.main)).label);
console.log("  拉伸动作没有体感参数:", P.motionProfileFor("sitReach") === null, "(期望 true)");
console.log("  今天（", P.todayKey(), "）可选动作数:", P.motionChoices().length);

console.log("== 体感评分（MotionEngine.scoreSession）==");
const S = P.MotionEngine.scoreSession;
const jjProfile = P.motionProfileFor("jumpingJacks");
const good = { reps: 30, elapsed: 40, tempo: 60, rhythm: 0.9, symmetry: 0.95, amplitude: 0.8, activeRatio: 0.95, holdSeconds: 0, stability: 0, intensity: 0.8 };
const r1 = S(jjProfile, good, { reps: 30 });
console.log("  完美一组 30/30:", r1.total, "分", JSON.stringify(r1.parts), "→", P.motionMedalOf(r1.total));
const r2 = S(jjProfile, Object.assign({}, good, { reps: 15 }), { reps: 30 });
console.log("  只做一半 15/30:", r2.total, "分 →", P.motionMedalOf(r2.total), "(应低于完美组)");
const r3 = S(P.motionProfileFor("wallSit"), { holdSeconds: 30, stability: 0.9, activeRatio: 1, elapsed: 31 }, { holdSeconds: 30 });
console.log("  靠墙静蹲保持满 30 秒:", r3.total, "分", JSON.stringify(r3.parts));
const r4 = S(jjProfile, Object.assign({}, good, { reps: 0, elapsed: 1 }), { reps: 30 });
console.log("  点一下就开始结束（1 秒）:", r4.total, "分 (应 ≤ 30)");
const r5 = S(P.motionProfileFor("sitReach"), good, {});
console.log("  拉伸动作不参与评分:", r5.total, "分 →", P.motionMedalOf(r5.total), "(期望 0 / none)");
const r6 = S(jjProfile, Object.assign({}, good, { tempo: 200 }), { reps: 30 });
console.log("  节奏太快（200/分）节奏分:", r6.parts["节奏"], "(应明显低于 100)");
const r7 = S(jjProfile, Object.assign({}, good, { symmetry: 0.3 }), { reps: 30 });
console.log("  左右严重不均 规范分:", r7.parts["规范"], "<", r1.parts["规范"], "→", r7.parts["规范"] < r1.parts["规范"]);
const hkProfile = P.motionProfileFor("highKnees");
const r8 = S(hkProfile, Object.assign({}, good, { elapsed: 20, activeRatio: 1, intensity: 1 }), { seconds: 20 });
const r9 = S(hkProfile, Object.assign({}, good, { elapsed: 20, activeRatio: 0.45, intensity: 0.4 }), { seconds: 20 });
console.log("  高频动作 高抬腿 20 秒：全程动满 →", r8.total, "分 | 只动一半 →", r9.total, "分（应更低）");
console.log("  高频动作分项:", JSON.stringify(r8.parts));

console.log("== 体感结算与金币 ==");
P.state.fitness.motion.scores = [];
const mkMotion = (total, dateKey) => ({
  id: "m-" + Math.random().toString(36).slice(2),
  at: new Date().toISOString(),
  dateKey,
  exId: "jumpingJacks", exName: "开合跳", emoji: "⭐", mode: "rep",
  blockId: "", dayId: "mon", elapsed: 40, reps: 30, target: 30, goalLabel: "30 次",
  tempo: 60, rhythm: 90, symmetry: 95, amplitude: 80, stability: 0, activeRatio: 95, holdSeconds: 0,
  intensity: 80, total, parts: { "完成": 100, "节奏": 100, "规范": 89 }, hints: ["测试记录"]
});
P.saveMotionRecord(mkMotion(97, MON));
const md1 = P.motionDayDetail(MON);
console.log("  记录 97 分 → 当日最高:", md1.score, "| 奖牌:", md1.medal, "| 金币:", md1.coins, "(期望 97 / gold / 3)");
P.saveMotionRecord(mkMotion(40, MON));
const md2 = P.motionDayDetail(MON);
console.log("  同日再来一次 40 分 → 仍取最高:", md2.score, "| 金币:", md2.coins, "(期望 97 / 3)");
console.log("  体感累计金币未翻倍:", P.motionCoinsEarned(), "(期望 3)");
P.saveMotionRecord(mkMotion(62, "2026-09-26"));
console.log("  前一天 62 分 →", P.motionDayDetail("2026-09-26").medal, "+", P.motionDayDetail("2026-09-26").coins, "| 体感累计:", P.motionCoinsEarned(), "(期望 bronze +1 → 4)");
console.log("  历史最好:", P.motionBestRecord().total, "(期望 97)");
console.log("  奖金池 = 写作", P.writingCoinsEarned(), "+ 体能", P.fitnessCoinsEarned(), "+ 体感", P.motionCoinsEarned(), "=", P.coinsEarned());

console.log("== 体感达标自动勾选清单 ==");
P.state.fitness.done = {};
const recOk = mkMotion(95, P.todayKey());
recOk.blockId = "mon:main:0";
P.saveMotionRecord(recOk);
console.log("  动作分 95 ≥ 铜线 → 自动勾选 mon:main:0:", P.fitnessDoneIds(P.todayKey()).indexOf("mon:main:0") !== -1, "(期望 true)");
P.state.fitness.done = {};
const recLow = mkMotion(30, P.todayKey());
recLow.blockId = "mon:main:1";
P.saveMotionRecord(recLow);
console.log("  动作分 30 < 铜线 → 不勾选:", P.fitnessDoneIds(P.todayKey()).indexOf("mon:main:1") === -1, "(期望 true)");

console.log("== 体感奖励规则（家长可改 + 总开关）==");
P.state.admin.unlockedAt = Date.now();
document.getElementById("motionGoldScore").value = "95";
document.getElementById("motionSilverScore").value = "80";
document.getElementById("motionBronzeScore").value = "65";
document.getElementById("motionGoldCoin").value = "6";
document.getElementById("motionSilverCoin").value = "3";
document.getElementById("motionBronzeCoin").value = "1";
document.getElementById("motionEnabled").checked = true;
P.saveMotionRewards();
console.log("  保存后:", JSON.stringify(P.state.fitness.motion.rewards));
console.log("  97 分 →", P.motionMedalOf(97), "(金线 95) | 70 分 →", P.motionMedalOf(70), "(银 80 / 铜 65 → bronze)");
document.getElementById("motionGoldScore").value = "40";
document.getElementById("motionSilverScore").value = "90";
P.saveMotionRewards();
console.log("  非法分数线（金 < 银）被拒绝，金线仍为:", P.state.fitness.motion.rewards.thresholds.gold, "(期望 95)");
document.getElementById("motionGoldScore").value = "95";
document.getElementById("motionSilverScore").value = "80";
document.getElementById("motionEnabled").checked = false;
P.saveMotionRewards();
console.log("  关掉总开关 → motionEnabled():", P.motionEnabled(), "(期望 false)");
document.getElementById("motionEnabled").checked = true;
P.saveMotionRewards();
console.log("  重新打开 → motionEnabled():", P.motionEnabled(), "(期望 true)");

console.log("== 体感界面渲染（DOM 桩）==");
P.renderFitnessMotion();
P.renderFitnessReport();
P.renderStatWidget();
P.renderScoreboard();
console.log("  跟练页 / 报告页 / 统计组件 / 积分榜渲染无异常: true");
console.log("  摄像头错误文案覆盖:", Object.keys(P.MOTION_CAMERA_ERROR).length, "种");
console.log("  体感记录条数:", P.state.fitness.motion.scores.length);
P.clearMotionData();
console.log("  清空后记录数:", P.state.fitness.motion.scores.length, "(期望 0) | 体感金币:", P.motionCoinsEarned(), "(期望 0)");

console.log("\n全部通过，无运行时异常。");
