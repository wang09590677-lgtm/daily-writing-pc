const STORAGE_KEY = "dailyWritingPcStateV3";
const LEGACY_STORAGE_KEYS = ["dailyWritingPcStateV2", "dailyWritingPcStateV1"];

const taskTypes = [
  { id: "fragment", label: "故事补全", skill: "故事结构" },
  { id: "picture", label: "看图编故事", skill: "想象能力" },
  { id: "expand", label: "文字扩写", skill: "细节描写" },
  { id: "words", label: "词语编文", skill: "语言表达" },
  { id: "news", label: "热点感想", skill: "内容与立意" },
  { id: "fillgap", label: "文章补写", skill: "故事结构" }
];

/* ------------------------------------------------------------------
 * 数据层：把 data/tasks.js 与 data/models-*.js 的原始素材
 * 适配成应用内部统一结构
 * ------------------------------------------------------------------ */

const RAW_TASKS = (typeof window !== "undefined" && window.DAILY_TASK_LIBRARY) || { fragment: [], picture: [], expand: [], words: [], news: [] };

/* 文章补写素材库（data/fill-articles.js）。
 * 格式：[[id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力, 补写提示], ...]
 * ★ 硬约束：**正文永远存完整原文，挖空只存下标**。
 *   这样"孩子写的对照原文"永远拿得到真值，也不会出现"挖空版 / 完整版"两份正文各自不同步。 */
const RAW_FILL_ARTICLES = (typeof window !== "undefined" && window.FILL_ARTICLE_LIBRARY) || [];

const REQUIREMENTS = {
  fragment: "请接着这段开头往下写，把片段补成一个完整的故事。要有事情发生的原因、变化和结尾，可以写得温暖、有趣或带一点小悬念。",
  picture: "请根据这段画面描述编一个完整的故事。不要只把画面“翻译”成文字，要写出人物的目的、遇到的麻烦和最后的结果。",
  expand: "请把这句话扩写成一段完整的文字。加入颜色、声音、动作和你的心情，但不要把句子堆得太满。",
  words: "请用上这些词语，写一篇短文。词语可以打乱顺序，但要自然地出现在句子里，不要生硬地堆在一起。",
  news: "请围绕这则素材写一篇感想。可以写自己的经历、自己的看法，也可以写你会怎么做。",
  fillgap: "这篇文章中间被拿掉了几段。请先从头读一遍，再读一遍空缺后面的内容，然后沿着作者的意思把缺的地方补出来。不必和原文写得一样，但要做到：接得上前面、带得动后面、有自己的具体细节。"
};

/* 补写任务池里的「想一想」—— 不剧透原文内容，只给方向。
 * ★ 不能用原文挖空段的提示语当"想什么"，那等于把答案递给孩子。 */
function fillgapPromptList(article) {
  const list = [
    "空缺前面最后一句说了什么？下面接着要发生什么？",
    "空缺后面第一句是怎么接上的？中间必须补上哪件事？",
    `空缺的地方合起来大概要写 ${article.gapChars || 300} 字才够。`
  ];
  if (article.skill) list.push(`这一段主要练：${article.skill}。`);
  return list.slice(0, 4);
}

function buildTaskPool() {
  const pool = [];

  (RAW_TASKS.fragment || []).forEach((row, index) => {
    const [title, opening, prompts] = row;
    pool.push({
      id: `fragment-${index}`,
      type: "fragment",
      title: title || "故事补全",
      material: opening || "",
      requirement: REQUIREMENTS.fragment,
      prompts: (prompts || []).slice(0, 4),
      skill: "故事结构"
    });
  });

  (RAW_TASKS.picture || []).forEach((row, index) => {
    const [title, scene, prompts] = row;
    pool.push({
      id: `picture-${index}`,
      type: "picture",
      title: title || "看图编故事",
      material: scene || "",
      requirement: REQUIREMENTS.picture,
      prompts: (prompts || []).slice(0, 4),
      skill: "想象能力",
      picture: true,
      // 与 assets/pictures/picXXX.jpg 一一对应（由 build/gen-pictures.py 生成）
      imageId: `pic${String(index + 1).padStart(3, "0")}`
    });
  });

  (RAW_TASKS.expand || []).forEach((row, index) => {
    const [sentence, hint, skill, words] = row;
    pool.push({
      id: `expand-${index}`,
      type: "expand",
      title: "把一句话扩写成一段",
      material: `原句：${sentence}`,
      requirement: `${REQUIREMENTS.expand}建议写 ${words || 250} 字左右。`,
      prompts: [hint || "先想清楚这一段最想写什么。", "你会加入哪两个细节？", "结尾想表达什么心情？"].filter(Boolean),
      skill: skill || "细节描写"
    });
  });

  (RAW_TASKS.words || []).forEach((row, index) => {
    const [wordList, hint, skill, words] = row;
    const list = Array.isArray(wordList) ? wordList : [];
    pool.push({
      id: `words-${index}`,
      type: "words",
      title: "用词语编一篇短文",
      material: `词语：${list.join("、")}`,
      requirement: `${REQUIREMENTS.words}${hint ? "提示：" + hint : ""}建议写 ${words || 350} 字左右。`,
      prompts: ["故事发生在什么时候、什么地方？", "谁和谁之间发生了什么？", "哪个词可以放在最有意思的地方？"],
      skill: skill || "语言表达",
      words: list
    });
  });

  (RAW_TASKS.news || []).forEach((row, index) => {
    const [domain, title, material, requirement, prompts] = row;
    pool.push({
      id: `news-${index}`,
      type: "news",
      title: `热点感想：${title}`,
      material: material || "",
      requirement: requirement || REQUIREMENTS.news,
      prompts: (prompts || []).slice(0, 4),
      skill: "内容与立意",
      sourceLabel: domain || "热点素材"
    });
  });

  /* 文章补写：素材是"一篇被挖掉核心段落的文章"。
   * ★ 这里刻意**不在任务池里复制文章正文** —— 全库 80 篇 × 上千字，一旦复制，
   *   TASK_POOL 会膨胀几百 KB，而且"改了素材库但池子里还是旧副本"这种双源不一致迟早发生。
   *   所以池子里只放 id，正文一律按 id 回 FILL_BY_ID 取。
   * ★ 数据源用 RAW_FILL_ARTICLES（已适配的 FILL_ARTICLES 在这之后才初始化，
   *   在这里引用会踩 TDZ —— 而 TDZ 是整份 app.js 挂掉，不是局部错误），
   *   正文一个字都不碰，index / skill / category / source 原始行里都有。 */
  RAW_FILL_ARTICLES.forEach((row, index) => {
    const [id, category, title, author, source, , , , skill] = row;
    const key = id || `fill-${index}`;
    pool.push({
      id: `fillgap-${key}`,
      type: "fillgap",
      title: `文章补写：${title}`,
      material: "",
      articleId: key,
      requirement: REQUIREMENTS.fillgap,
      prompts: fillgapPromptList({ title, author, category, source }),
      skill: skill || "故事结构",
      sourceLabel: `${source || "素材库"} · ${category}`
    });
  });

  return pool;
}

const TASK_POOL = buildTaskPool();
const TASK_BY_ID = new Map(TASK_POOL.map(task => [task.id, task]));

const IMITATE_TIPS_BANK = [
  "先通读一遍，别急着写，感受一下它的语气。",
  "找出一个你最喜欢的句子，想想它为什么打动人。",
  "看它是怎么开头的：先写景、先写人，还是先写一件事？",
  "看它是怎么结尾的：收在心情上，还是收在一句话上？",
  "把它写的对象换成你自己的经历，写法可以借，内容要换成你的。",
  "写完后读一遍，检查有没有照抄原句。"
];

function autoTips(model) {
  const tips = IMITATE_TIPS_BANK.slice(0, 3);
  if (model.chars && model.chars < 60) {
    tips.push("它很短，请特别注意它是怎么用很少的字写清楚的。");
  } else if (model.chars && model.chars > 600) {
    tips.push("它比较长，注意它是怎么分层展开、一段一段推进的。");
  } else {
    tips.push("注意它的段落是怎么分的，每段只讲一件事。");
  }
  return tips;
}

function buildModelPool() {
  const pool = [];

  const classics = (typeof window !== "undefined" && window.MODEL_LIBRARY_CLASSICS) || [];
  classics.forEach((item, index) => {
    pool.push({
      id: item.id || `cls-${index}`,
      category: item.category || "古典作品",
      type: item.type || item.category || "古典作品",
      title: item.title || "无题",
      author: item.author || "",
      source: item.source || "",
      text: item.text || "",
      chars: item.chars || 0,
      skill: item.skill || "语言表达",
      tips: Array.isArray(item.tips) && item.tips.length ? item.tips.slice(0, 4) : autoTips({ chars: item.chars }),
      prompt: `受《${item.title}》启发，写一篇类似的文章。可以学它的写法，但内容要写你自己的经历或想象。`
    });
  });

  const authoredKeys = [
    "MODEL_LIBRARY_AUTHORED_1",
    "MODEL_LIBRARY_AUTHORED_2",
    "MODEL_LIBRARY_AUTHORED_3",
    "MODEL_LIBRARY_AUTHORED_4",
    "MODEL_LIBRARY_AUTHORED_5",
    "MODEL_LIBRARY_AUTHORED_6"
  ];

  authoredKeys.forEach(key => {
    const list = (typeof window !== "undefined" && window[key]) || [];
    list.forEach((row, index) => {
      const [category, subType, title, source, text, skill] = row;
      const chars = (text || "").replace(/\s/g, "").length;
      pool.push({
        id: `${key.toLowerCase()}-${index}`,
        category: category || "当代作品",
        type: subType || category || "短文",
        title: title || "无题",
        author: "",
        source: source || "",
        text: text || "",
        chars,
        skill: skill || "语言表达",
        tips: autoTips({ chars }),
        prompt: `受《${title}》启发，写一篇类似的文章。可以学它的写法，但内容要写你自己的经历或想象。`
      });
    });
  });

  return pool;
}

const MODEL_POOL = buildModelPool();
const MODEL_BY_ID = new Map(MODEL_POOL.map(model => [model.id, model]));

const MODEL_CATEGORIES = (() => {
  const map = new Map();
  MODEL_POOL.forEach(model => {
    map.set(model.category, (map.get(model.category) || 0) + 1);
  });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
})();

/* ---------- 文章补写：素材库 / 挖空 / 选文 ---------- */

/* 把二维数组适配成对象。为什么在这里做而不是在数据文件里：
 * 数据文件保持"纯数组"，好生成、好 diff、体积也小（210 篇 1.1MB）。
 * 适配成本只在启动时付一次。 */
const FILL_ARTICLES = RAW_FILL_ARTICLES.map((row, index) => {
  const [id, category, title, author, source, paragraphs, gapStart, gapCount, skill, hint] = row;
  const paras = (paragraphs || []).slice();
  const start = Math.max(0, Math.min(paras.length - 1, Number(gapStart) || 0));
  const count = Math.max(1, Math.min(paras.length - start, Number(gapCount) || 1));
  const gapParas = paras.slice(start, start + count);
  return {
    id: id || `fill-${index}`,
    category: category || "记事",
    title: title || "无题",
    author: author || "",
    source: source || "",
    paragraphs: paras,
    gapStart: start,
    gapCount: count,
    gapParas,
    gapChars: gapParas.join("").replace(/\s/g, "").length,
    chars: paras.join("").replace(/\s/g, "").length,
    skill: skill || "故事结构",
    hint: hint || "",
    // AI 现场生成的文章走同一份结构，用这个标记区分（界面上要如实说明来源）
    aiGenerated: false
  };
});

const FILL_BY_ID = new Map(FILL_ARTICLES.map(article => [article.id, article]));

const FILL_CATEGORIES = (() => {
  const map = new Map();
  FILL_ARTICLES.forEach(article => map.set(article.category, (map.get(article.category) || 0) + 1));
  // 按「记事 → 写景 → 说理 → 抒情」的固定顺序排，不用按数量排：
  // 数量会随素材库扩充变化，导致下拉框顺序每次都变，孩子找不到上次那一类。
  const order = ["记事", "写景", "说理", "抒情"];
  return [...map.entries()].sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
})();

function fillArticlesInCategory() {
  const cat = state.fillCategory;
  if (!cat || cat === "全部") return FILL_ARTICLES;
  return FILL_ARTICLES.filter(article => article.category === cat);
}

/* 取当前要用的文章。
 * ★ AI 生成的那篇**不进素材库**，单独挂在 state.fillAiArticle 上：
 *   否则一旦落库，用户重开软件就会看到一篇"凭空多出来的文章"，
 *   而它其实是上次生成、早已被用过的。 */
function getCurrentFillArticle() {
  if (state.fillSource === "ai" && state.fillAiArticle) return state.fillAiArticle;
  const cached = FILL_BY_ID.get(state.currentArticleId);
  if (cached && (!state.fillCategory || state.fillCategory === "全部" || cached.category === state.fillCategory)) return cached;
  const pool = fillArticlesInCategory();
  return pool[0] || FILL_ARTICLES[0] || null;
}

/* 挖空后给孩子看的视图：把挖掉的那几段换成占位块。
 * ★ 这是**唯一**允许把"哪几段被挖了"泄露给界面的地方；
 *   其余任何渲染路径都不许读 gapParas（否则孩子一划就看穿答案）。 */
function fillGapBlocks(article) {
  if (!article) return [];
  const blocks = [];
  article.paragraphs.forEach((text, i) => {
    const inGap = i >= article.gapStart && i < article.gapStart + article.gapCount;
    blocks.push(inGap ? { type: "gap", index: i } : { type: "text", index: i, text });
  });
  return blocks;
}

function chineseCount(text) {
  return String(text || "").replace(/\s/g, "").length;
}

/* ---------- 去重队列 ---------- */

const queues = {};
function nextFromQueue(key, pool) {
  if (!pool.length) return null;
  if (!queues[key] || !queues[key].length) {
    queues[key] = pool.slice().sort(() => Math.random() - 0.5);
  }
  return queues[key].pop();
}

/* ------------------------------------------------------------------ */

const scaffolds = {
  "人物": ["外貌：只选一个最有特点的地方", "典型动作：他经常怎么做？", "语言：写一句真实的话", "小细节：一个别人不一定注意到的点", "我的感受：我为什么记住他"],
  "故事": ["发生什么", "出现问题", "事情变化", "高潮时刻", "结果", "我的感受"],
  "景物": ["远景", "近景", "颜色", "声音", "气味", "感受"],
  "观察": ["先看整体", "再看局部", "补充声音/触感/气味", "写一个发现", "写自己的想法"],
  "观点": ["我的看法", "理由一", "理由二", "小例子", "总结"],
  "生活": ["事情发生前", "事情发生时", "我看到/听到的细节", "事情之后", "我想到什么"],
  "想象": ["假设出现", "角色反应", "遇到困难", "有趣变化", "结尾收束"],
  "情感": ["发生了什么", "我当时的心情", "一个动作或细节", "心情变化", "我明白了什么"],
  "范文临摹": ["先读一遍范文", "找出你喜欢的写法", "换成自己的事情", "写完后检查有没有照抄", "补一个自己的感受"],
  "文章补写": ["先读空缺前面那一段，看看作者刚说完什么", "再看空缺后面那一段，想想它要接上什么", "猜一猜：中间必须有哪一件事，后面才说得通", "补的时候加一个具体的动作或声音，别只写心里想", "写完从头顺一遍，看看接得顺不顺"],
  "热点感想": ["这件事是什么", "我想到自己的哪个经历", "我赞成/好奇/担心什么", "如果是我会怎么做", "最后写一句总结"],
  "每日必写": ["今天发生了什么", "我最想写哪一刻", "谁在场", "我看到/听到什么", "我的心情有什么变化"]
};

const defaultState = {
  // "" = 还没选模块（显示选择页）｜"write" = 写作 ｜"fitness" = 体能训练
  module: "",
  profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
  selectedTaskType: "fragment",
  currentTaskId: "",
  currentModelId: "",
  modelCategory: "全部",
  // ---- 文章补写 ----
  currentArticleId: "",
  fillCategory: "全部",
  fillSource: "library",      // "library" = 从已有文库选；"ai" = 现场调用大模型生成
  fillAiArticle: null,        // AI 生成的那一篇（只存最近一次，不落素材库）
  fillGenerating: false,      // 是否正在请求 AI 生成（防重复点）
  mode: "daily",
  draft: "",
  activeWriting: { kind: "daily", title: "今天我想写：", type: "每日必写", goal: "自由表达 10-20 分钟", skill: "语言表达", prompts: scaffolds["每日必写"] },
  essays: [],
  pinnedMaterials: [],
  skills: {
    "人物描写": 72,
    "环境描写": 51,
    "细节描写": 58,
    "故事结构": 76,
    "语言表达": 70,
    "想象能力": 83,
    "内容与立意": 64,
    "观察描写": 60
  },
  lastFeedback: null,
  // ---- 积分 / 奖励体系 ----
  // 家长可改：每日分数线（金牌/银牌/铜牌）与对应金币
  rewards: {
    thresholds: { gold: 240, silver: 180, bronze: 120 },
    coins: { gold: 5, silver: 3, bronze: 1 },
    // 兑换比例：1 金币 = 多少分钟游戏时间 / 多少元零钱
    redeem: { minutesPerCoin: 5, yuanPerCoin: 0.5 },
    // 写作奖牌权重设置（需求 3）
    weights: {
      dailyRequired: 0.5,    // 每日必写 AI 打分权重（0~1）
      otherTasks: 0.5        // 其他每日任务权重（0~1）
    },
    // 奖牌资格：完成所有项目后的最终总分阈值
    medalQualify: {
      gold: 200,   // 金牌对应最终分数
      silver: 150, // 银牌对应最终分数
      bronze: 100  // 铜牌对应最终分数
    }
  },
  redemptions: [],       // [{id, at, coins, kind:"game"|"cash", amount, note}]
  admin: {
    password: "09590677",
    /* 是否要求输入密码才能进家长管理。
     * 默认 false：单机给孩子用的工具，把家长挡在门外比挡不住孩子更糟。
     * 家长想要"防孩子乱改"，在管理页把开关打开、或设一个新密码即可（设密码会自动启用）。 */
    passwordEnabled: false,
    unlockedAt: 0,
    passwordChangedAt: "",   // 上次改密码时间（用于在管理页明确告诉家长"密码什么时候被动过"）
    passwordHistory: []      // 最近几次改动记录（本机留痕，方便排查"谁改的"）
  },

  // ---- 体能训练（与写作并列的独立模块）----
  fitness: {
    startDate: "",   // 第一次训练的日期键，用来算"第几周"
    picked: {},      // { "2026-09-27": ["mon:main:0", ...] } 当天"打钩选中"了哪些训练块
    done: {},        // { "2026-09-27": ["mon:main:0", ...] } 当天"真的做完了"的训练块（计时跑完写入）
    sessions: [],    // [{id, date, dayId, week, completion, medal, coins, durationSec, doneCount, totalCount}]
    tests: [],       // [{id, at, testId, value}] 自测成绩
    rewards: {
      // 体能用"当日完成度(%)"而不是分数来判定奖牌
      thresholds: { gold: 100, silver: 85, bronze: 70 },
      coins: { gold: 5, silver: 3, bronze: 1 }
    },
    // ---- 体感跟练（摄像头动作分析）----
    motion: {
      enabled: true,       // 家长可以整体关掉摄像头功能
      rewards: {
        // 体感按"单次动作分(0-100)"判奖牌，每天只结算一次（取当天最高分）
        thresholds: { gold: 90, silver: 75, bronze: 60 },
        coins: { gold: 3, silver: 2, bronze: 1 }
      },
      scores: []           // [{id, at, dateKey, exId, exName, mode, blockId, reps, target, total, parts, hints, ...}]
    },
    // 每日一练运动时间与间隔设置（需求 4）
    timing: {
      // 每个运动项目的默认时间（秒）和组间隔（秒）
      // 家长可自定义，未设置的使用默认值
      defaults: {
        workTime: 30,      // 单项运动时间（秒）
        restTime: 10       // 组间隔休息时间（秒）
      },
      // 按运动类型自定义（可选）
      custom: {}  // { "jumping-jack": { work: 45, rest: 15 }, ... }
    },
    // 跟做视频导入（需求 6）：每个动作项目可导入本地视频，运动时左侧播放
    // 这里只是**运行时缓存**，不进 localStorage（存了也没用）。
    // 真正的持久化：用户导入的 Blob 存在 IndexedDB（见 video-store.js），
    // 项目自带的视频按相对路径引用。启动时由 videoBootstrap() 填回来。
    videoMap: {},        // { "exerciseId": "blob:..." 或 "体能训练动作演示/xx.mp4" }
    builtinVideoMap: {}, // 项目自带视频（只读，用于区分"内置"和"自己导入的"）
    restVideoUrl: ""     // 休息段固定播放的视频（体能训练动作演示/中场休息.mp4）
  }
};

let state = loadState();

/* 作文正在被大模型批改中（防止孩子连点提交按钮重复调用、重复计分） */
let essayGrading = false;

/* 老数据迁移：以前"打钩"就等于"完成"，没有单独的"选中"状态。
 * 升级后"选中"才是能点计时的前提，所以把已完成的块补进 picked，
 * 否则老用户打开会发现所有计时按钮都被禁用了。 */
(function migratePicked() {
  const done = (state.fitness && state.fitness.done) || {};
  if (!state.fitness.picked) state.fitness.picked = {};
  const picked = state.fitness.picked;
  Object.keys(done).forEach(key => {
    const list = Array.isArray(done[key]) ? done[key] : [];
    const have = new Set(Array.isArray(picked[key]) ? picked[key] : []);
    const merged = [...have, ...list.filter(id => !have.has(id))];
    if (merged.length) picked[key] = merged;
  });
})();

/* 一次性迁移：把家长密码强制改成 09590677。
 *
 * 为什么不能只改 defaultState：家长本机的 localStorage 里已经存了旧密码，
 * loadState() 的 {...base.admin, ...stored.admin} 会让**旧值覆盖新默认值**，
 * 于是"改了代码但密码没变"。这里用迁移标记位保证只做一次 ——
 * 迁移之后家长自己再改密码，不会被重新覆盖回 09590677。
 *
 * 密码保护开关只在"确实迁移了密码"时才打开：
 *   - 家长这台机器（旧密码 1234）→ 改成 09590677 并启用，这才叫"强行改成"。
 *   - 全新安装 → 密码默认就是 09590677，不开保护，保持"不把家长锁在门外"
 *     （上一轮用户被密码挡在外面，明确要求过默认免密，这条不能推翻）。 */
(function migrateAdminPassword() {
  const TARGET = "09590677";
  if (!state.admin) state.admin = {};
  if (state.admin.passwordMigratedTo09590677) return;   // 已经迁移过，尊重家长后来的修改
  const before = String(state.admin.password || "");
  const changed = before !== TARGET;
  if (changed) {
    state.admin.password = TARGET;
    state.admin.passwordChangedAt = new Date().toISOString();
    // 记进历史，家长在「家长密码」卡片里能看到"密码被改过、从什么改成了什么"
    state.admin.passwordHistory = [
      ...(Array.isArray(state.admin.passwordHistory) ? state.admin.passwordHistory : []),
      { from: before, to: TARGET, at: new Date().toISOString(), by: "程序升级" }
    ].slice(-10);
    // 用户明确要求"强行改成这个密码" → 顺带打开密码保护，否则改了却仍免密，等于没生效。
    state.admin.passwordEnabled = true;
    state.admin.unlockedAt = Date.now();   // 这次仍留在面板里，从下次打开才拦
  }
  state.admin.passwordMigratedTo09590677 = true;
  saveState();
})();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map(key => localStorage.getItem(key)).find(Boolean);
    const stored = JSON.parse(raw || "null");
    if (!stored) return structuredClone(defaultState);
    const base = structuredClone(defaultState);
    return {
      ...base,
      ...stored,
      profile: { ...base.profile, ...stored.profile },
      skills: { ...base.skills, ...stored.skills },
      activeWriting: { ...base.activeWriting, ...stored.activeWriting },
      pinnedMaterials: stored.pinnedMaterials || [],
      essays: Array.isArray(stored.essays) ? stored.essays : [],
      redemptions: Array.isArray(stored.redemptions) ? stored.redemptions : [],
      // 老版本数据没有这几个字段，必须逐层合并，否则家长设置会被整体覆盖掉
      rewards: {
        ...base.rewards,
        ...(stored.rewards || {}),
        thresholds: { ...base.rewards.thresholds, ...((stored.rewards || {}).thresholds || {}) },
        coins: { ...base.rewards.coins, ...((stored.rewards || {}).coins || {}) },
        redeem: { ...base.rewards.redeem, ...((stored.rewards || {}).redeem || {}) }
      },
      admin: {
        ...base.admin,
        ...(stored.admin || {}),
        // 密码历史是老版本没有的字段，必须显式兜底，否则会被展开成 undefined
        passwordHistory: Array.isArray((stored.admin || {}).passwordHistory)
          ? stored.admin.passwordHistory : []
      },
      // 体能模块同样逐层合并，保证老数据升级后不丢已勾选的清单和家长设置
      fitness: {
        ...base.fitness,
        ...(stored.fitness || {}),
        done: (stored.fitness && typeof stored.fitness.done === "object" && stored.fitness.done) || {},
        picked: (stored.fitness && typeof stored.fitness.picked === "object" && stored.fitness.picked) || {},
        sessions: Array.isArray((stored.fitness || {}).sessions) ? stored.fitness.sessions : [],
        tests: Array.isArray((stored.fitness || {}).tests) ? stored.fitness.tests : [],
        motion: {
          ...base.fitness.motion,
          ...(((stored.fitness || {}).motion) || {}),
          scores: Array.isArray(((stored.fitness || {}).motion || {}).scores)
            ? stored.fitness.motion.scores
            : [],
          rewards: {
            ...base.fitness.motion.rewards,
            ...((((stored.fitness || {}).motion) || {}).rewards || {}),
            thresholds: {
              ...base.fitness.motion.rewards.thresholds,
              ...((((((stored.fitness || {}).motion) || {}).rewards) || {}).thresholds || {})
            },
            coins: {
              ...base.fitness.motion.rewards.coins,
              ...((((((stored.fitness || {}).motion) || {}).rewards) || {}).coins || {})
            }
          }
        },
        rewards: {
          ...base.fitness.rewards,
          ...((stored.fitness || {}).rewards || {}),
          thresholds: { ...base.fitness.rewards.thresholds, ...(((stored.fitness || {}).rewards || {}).thresholds || {}) },
          coins: { ...base.fitness.rewards.coins, ...(((stored.fitness || {}).rewards || {}).coins || {}) }
        },
        // 跟做视频不进 localStorage：用户导入的存在 IndexedDB，
        // 自带的按相对路径引用，启动时由 videoBootstrap() 重新填进 videoMap。
        videoMap: {},
        builtinVideoMap: {},
        restVideoUrl: "",
        // timing 也必须逐层合并：老数据里没有 timing 字段时，
        // 光靠上面的 ...spread 会把它整个丢掉，家长设置的时间就"白设"了
        timing: {
          ...(base.fitness.timing || {}),
          ...(((stored.fitness || {}).timing) || {}),
          defaults: {
            ...((base.fitness.timing || {}).defaults || {}),
            ...((((stored.fitness || {}).timing) || {}).defaults || {})
          },
          custom: {
            ...((base.fitness.timing || {}).custom || {}),
            ...((((stored.fitness || {}).timing) || {}).custom || {})
          }
        }
      }
    };
  } catch (error) {
    return structuredClone(defaultState);
  }
}

function saveState() {
  // 视频是"运行时缓存"，不落 localStorage（Blob URL 存进去也是死字符串）。
  // 持久化由 IndexedDB（video-store.js）负责。
  const fitness = { ...state.fitness, videoMap: {}, builtinVideoMap: {}, restVideoUrl: "" };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, fitness }));
}

// 日期键必须用**本地日期**。原来用 toISOString() 取的是 UTC，
// 北京时间晚上 8 点之后写的作文会被算到"第二天"，按日计分会整体错位。
function todayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// 周一为一周的第一天
function weekStartKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return todayKey(d);
}

function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addDays(key, delta) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + delta);
  return todayKey(d);
}

/* ---------- 积分 / 奖励体系 ----------
 *
 * 计分规则（由家长设定的分数线决定奖牌）：
 *   1. 每日必写是每天必须完成的项目；
 *   2. 只有完成了当天的"每日必写"，当天才算有效成绩；
 *      没完成 → 当日记 0 分（哪怕写了别的模块也不计分，因为门禁本来也不允许）；
 *   3. 当日总分 = 当天所有已完成单次写作的 AI 得分之和
 *      （每日必写 + 每日任务 + 范文临摹 + 文章补写，不限次数）；
 *   4. 当日总分达到分数线 → **只取最高那一档**奖牌 → 得对应金币
 *      （默认金/银/铜 = 5/3/1，三档不叠加：拿到金牌只拿 5，不是 5+3+1）；
 *   5. 金币进入奖金池累计，可按家长设定的比例兑换游戏时间或零钱。
 *
 * 实现上**全部从 state.essays 实时推导**，不额外落库一份日汇总，
 * 避免"改了数据但汇总没同步"这类双写不一致的 bug。
 */

const DAILY_ESSENTIAL_TYPE = "每日必写";
const ESSAY_MODULE_TYPES = ["每日必写", "每日任务", "范文临摹", "文章补写"];

function essaysOnDay(key) {
  return state.essays.filter(item => todayKey(new Date(item.date)) === key);
}

// 当天是否完成了"每日必写"（每日必写是解锁其他模块的前提）
function dailyEssentialDone(key = todayKey()) {
  return essaysOnDay(key).some(item => item.type === DAILY_ESSENTIAL_TYPE || item.kind === "daily");
}

/* 单篇计入当日总分的分值。
 *
 * ★ 「文章补写」的额外加分已经**并进了 feedback.score**（见 ai-grader.normalizeFillGrade），
 *   这里再取一次会重复加。所以别在这里加 extraBonus ——
 *   之所以单独抽成函数，是为了让"分值从哪来"只有一个出口，以后改口径不会漏。 */
function essayPoints(item) {
  const score = (item.feedback && item.feedback.score) || 0;
  return Number.isFinite(score) ? score : 0;
}

function dayScore(key) {
  if (!dailyEssentialDone(key)) return 0;
  return essaysOnDay(key).reduce((sum, item) => sum + essayPoints(item), 0);
}

function medalOf(score) {
  const t = state.rewards.thresholds;
  if (score > 0 && score >= t.gold) return "gold";
  if (score > 0 && score >= t.silver) return "silver";
  if (score > 0 && score >= t.bronze) return "bronze";
  return "none";
}

const MEDAL_LABEL = { gold: "金牌", silver: "银牌", bronze: "铜牌", none: "未达标" };
const MEDAL_ICON = { gold: "🥇", silver: "🥈", bronze: "🥉", none: "·" };

function coinsForMedal(medal) {
  return medal === "none" ? 0 : (state.rewards.coins[medal] || 0);
}

function dayDetail(key) {
  const essays = essaysOnDay(key);
  const done = dailyEssentialDone(key);
  const score = done ? essays.reduce((sum, item) => sum + essayPoints(item), 0) : 0;
  const medal = done ? medalOf(score) : "none";
  return { key, essays, done, score, medal, coins: done ? coinsForMedal(medal) : 0 };
}

function weekDayKeys(date = new Date()) {
  const start = weekStartKey(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function weekDetails(date = new Date()) {
  return weekDayKeys(date).map(dayDetail);
}

function weekScore(date = new Date()) {
  return weekDetails(date).reduce((sum, day) => sum + day.score, 0);
}

// 当月每一天（到当月最后一天为止），用于月度走势曲线
function monthDayKeys(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const total = new Date(y, m + 1, 0).getDate();
  return Array.from({ length: total }, (_, i) => todayKey(new Date(y, m, i + 1)));
}

function monthScore(date = new Date()) {
  return monthDayKeys(date).reduce((sum, key) => sum + dayScore(key), 0);
}

function writingCoinsEarned() {
  const keys = new Set(state.essays.map(item => todayKey(new Date(item.date))));
  let total = 0;
  keys.forEach(key => { total += dayDetail(key).coins; });
  return total;
}

// 奖金池 = 写作金币 + 体能金币 + 体感金币（三个来源共用同一个池子）
function coinsEarned() {
  return writingCoinsEarned() + fitnessCoinsEarned() + motionCoinsEarned();
}

function coinsSpent() {
  return state.redemptions.reduce((sum, item) => sum + (Number(item.coins) || 0), 0);
}

function coinBalance() {
  // 金币按"当前奖励规则"实时重算，家长调高分数线会让历史金币变少。
  // 这时累计获得可能小于已兑换，可用金币钳到 0，不允许出现负数余额。
  return Math.max(0, coinsEarned() - coinsSpent());
}

// 今天能不能进"每日任务 / 范文临摹 / 文章补写"
function canStartExtraWriting() {
  return dailyEssentialDone();
}

/* ==================================================================
 * 体能训练模块（与写作并列）
 *
 * 计分规则：
 *   1. 每天按星期几取一个主题日（心肺/腿力/恢复/爆发/核心/挑战/休息）；
 *   2. 每个主题日拆成"热身 / 主训练 / 放松"三组动作块。
 *      流程：先在块前**打钩选中**（picked）→ 再点这个块的「计时」→ 跟着教练把
 *      计时**跑完**才算这块**完成**（done）。没勾选时「计时」是禁用的。
 *   3. 完成度 = 已完成块权重 / 总权重 × 100%
 *      （热身每块 1 分、主训练每块 3 分、放松每块 1 分，所以主训练占约 2/3）；
 *   4. 完成度达到分数线 → **只取最高那一档**奖牌 → 对应金币
 *      （金牌/银牌/铜牌三档不叠加：做到 100% 只拿金牌那一档）；
 *   5. 每天只结算一次，取当天完成度最高的那次训练，避免反复刷分；
 *   6. 金币与写作共用同一个奖金池。
 *
 * 与写作一样，全部从 state.fitness.sessions 实时推导，不额外落库日汇总。
 * ================================================================== */

const FITNESS_EX = (typeof window !== "undefined" && window.FITNESS_EX) || {};
const FITNESS_PLAN = (typeof window !== "undefined" && window.FITNESS_PLAN) || [];
const FITNESS_PHASES = (typeof window !== "undefined" && window.FITNESS_PHASES) || [];
const FITNESS_TESTS = (typeof window !== "undefined" && window.FITNESS_TESTS) || [];
const FITNESS_MOTION_GUIDE = (typeof window !== "undefined" && window.FITNESS_MOTION_GUIDE) || { canDo: [], cannotDo: [], setup: [] };

const FIT_GROUP_WEIGHT = { warmup: 1, main: 3, cooldown: 1 };
const FIT_GROUP_LABEL = { warmup: "热身", main: "主训练", cooldown: "放松拉伸" };

function fitnessDayFor(date = new Date()) {
  return FITNESS_PLAN.find(day => day.weekday === date.getDay()) || FITNESS_PLAN[0] || null;
}

function fitnessWeekNo(date = new Date()) {
  const start = state.fitness.startDate || todayKey(date);
  const days = Math.round((dateFromKey(todayKey(date)) - dateFromKey(start)) / 86400000);
  return Math.max(1, Math.min(8, Math.floor(Math.max(0, days) / 7) + 1));
}

function fitnessPhaseOf(week) {
  return FITNESS_PHASES.find(p => week >= p.from && week <= p.to) || FITNESS_PHASES[0] || { name: "", scale: 1, extraSets: 0, note: "" };
}

// 目标数按阶段放大；次数取整、秒数取 5 的倍数，避免出现"34.5 秒"这种数
function scaleTarget(target, unit, scale) {
  const raw = target * scale;
  if (unit === "秒" || unit === "秒/侧") return Math.max(5, Math.round(raw / 5) * 5);
  if (target >= 20) return Math.max(5, Math.round(raw / 5) * 5);
  return Math.max(1, Math.round(raw));
}

// 把一天的训练展开成"动作块"列表（含阶段进阶后的实际组次）
function fitnessBlocks(day, phase) {
  const p = phase || fitnessPhaseOf(fitnessWeekNo());
  const out = { warmup: [], main: [], cooldown: [] };
  if (!day) return out;

  const build = (raw, group) => {
    const ex = FITNESS_EX[raw[0]];
    if (!ex) return null;
    const isMain = group === "main";
    const sets = isMain ? (raw[1] || 1) + (p.extraSets || 0) : (raw[1] || 1);
    return {
      id: `${day.id}:${group}:${out[group].length}`,
      group,
      ex: raw[0],
      name: ex.name,
      emoji: ex.emoji,
      how: ex.how,
      unit: ex.unit,
      sets,
      target: scaleTarget(raw[2] || 0, ex.unit, p.scale || 1),
      rest: raw[3] || 0,
      weight: FIT_GROUP_WEIGHT[group]
    };
  };

  (day.warmup || []).forEach(row => { const b = build(row, "warmup"); if (b) out.warmup.push(b); });
  (day.cooldown || []).forEach(row => { const b = build(row, "cooldown"); if (b) out.cooldown.push(b); });

  (day.main || []).forEach(row => {
    if (row && row.circuit) {
      const items = (row.items || []).map(it => {
        const ex = FITNESS_EX[it[0]];
        if (!ex) return null;
        return { ex: it[0], name: ex.name, emoji: ex.emoji, unit: ex.unit, target: scaleTarget(it[1] || 0, ex.unit, p.scale || 1) };
      }).filter(Boolean);
      if (!items.length) return;
      out.main.push({
        id: `${day.id}:main:${out.main.length}`,
        group: "main",
        circuit: true,
        rounds: row.circuit + (p.extraSets || 0),
        rest: row.rest || 60,
        items,
        weight: FIT_GROUP_WEIGHT.main
      });
    } else {
      const b = build(row, "main");
      if (b) out.main.push(b);
    }
  });

  return out;
}

function fitnessTotalBlocks(day, phase) {
  const b = fitnessBlocks(day, phase);
  return b.warmup.length + b.main.length + b.cooldown.length;
}

/* ---------- 选中（打钩）与完成，是两件事 ----------
 *
 *   选中 picked = 孩子"打钩选了这个项目"，是能点「计时」的前提
 *   完成 done  = 真的跟着教练把计时跑完了，只有它计入完成度 / 奖牌 / 金币
 *
 * 所以：完成 ⊆ 选中。取消选中会连带清掉完成标记。
 */

function fitnessPickedIds(key = todayKey()) {
  const list = state.fitness.picked && state.fitness.picked[key];
  return Array.isArray(list) ? list : [];
}

function isFitBlockPicked(id, key = todayKey()) {
  return fitnessPickedIds(key).indexOf(id) !== -1;
}

function fitnessDoneIds(key = todayKey()) {
  const list = state.fitness.done && state.fitness.done[key];
  return Array.isArray(list) ? list : [];
}

function isFitBlockDone(id, key = todayKey()) {
  return fitnessDoneIds(key).indexOf(id) !== -1;
}

// 直接设置某个动作块的完成状态（计时跑完 / 体感跟练达标后写入，不做"取反"）
function setFitBlockDone(id, done) {
  const key = todayKey();
  if (!state.fitness.done) state.fitness.done = {};
  if (!state.fitness.picked) state.fitness.picked = {};
  const list = fitnessDoneIds(key).slice();
  const at = list.indexOf(id);
  if (done) {
    if (at !== -1) return false;
    list.push(id);
    state.fitness.done[key] = list;
    // 完成了必然也是选中过的
    const picked = fitnessPickedIds(key).slice();
    if (picked.indexOf(id) === -1) { picked.push(id); state.fitness.picked[key] = picked; }
    if (!fitSessionStart) fitSessionStart = Date.now();
  } else {
    if (at === -1) return false;
    list.splice(at, 1);
    state.fitness.done[key] = list;
  }
  return true;
}

/* 点动作块前面的复选框 = 选中 / 取消选中。
 * 取消选中时连带清掉完成标记，保证"完成度不会算在没选中的项目上"。 */
function toggleFitPick(id) {
  const key = todayKey();
  if (!state.fitness.picked) state.fitness.picked = {};
  const list = fitnessPickedIds(key).slice();
  const at = list.indexOf(id);
  const nowPicked = at === -1;
  if (nowPicked) {
    list.push(id);
    if (!fitSessionStart) fitSessionStart = Date.now();
  } else {
    list.splice(at, 1);
  }
  state.fitness.picked[key] = list;
  if (!nowPicked) setFitBlockDone(id, false);   // 取消选中 → 完成也一起撤销
  saveState();

  // 只更新被点的那一块 + 进度环，不整块重渲染。
  // 整块重渲染会把其余按钮的 DOM 换掉，快速连点时后面的点击会落在已卸载的节点上而丢失。
  syncFitBlockEl(id);
  renderFitProgress();
  renderFitnessBoard();
  fitSeqRender();   // 勾选数量变了，「依次进行（N 项）」的文案要跟着变
}

// 把某一块的 DOM 刷成"选中 / 完成 / 可计时"对应的样子
function syncFitBlockEl(id) {
  const el = document.querySelector(`.fit-block[data-block-id="${id}"]`);
  if (!el) return;
  const picked = isFitBlockPicked(id);
  const done = isFitBlockDone(id);
  el.classList.toggle("is-picked", picked && !done);
  el.classList.toggle("is-done", done);

  const check = el.querySelector(".fit-check");
  if (check) {
    check.textContent = picked ? "✓" : "";
    check.setAttribute("aria-pressed", String(picked));
    check.title = picked ? "取消选中（不再练这个）" : "勾选这个动作，才能开始计时";
  }
  const badge = el.querySelector(".fit-done-badge");
  if (badge) badge.classList.toggle("hidden", !done);

  const timer = el.querySelector(".fit-timer-btn");
  if (timer) {
    timer.disabled = !picked;
    timer.title = picked ? "" : "先勾选这个动作，再点「计时」";
    if (!el.classList.contains("is-timing")) {
      timer.textContent = el.classList.contains("fit-circuit") ? "开始循环" : "计时";
    }
  }
}

// 只刷新完成度环与提交按钮文案
function renderFitProgress() {
  const ring = document.getElementById("fitRing");
  const submit = document.getElementById("fitSubmitBtn");
  const key = todayKey();
  const day = fitnessDayFor(dateFromKey(key));
  if (!ring || !day || day.rest) return;
  const result = fitnessCompletion(key);
  ring.innerHTML = fitRingHtml(result.percent, fitnessMedalOf(result.percent), "完成度");
  if (submit) {
    const best = fitnessDayDetail(key);
    submit.textContent = best.done ? `再练一次（今日最好 ${best.completion}%）` : "完成训练，结算奖牌";
  }
}

// 完成度：按块加权（热身 1 / 主训练 3 / 放松 1）
function fitnessCompletion(key = todayKey(), date) {
  const d = date || dateFromKey(key);
  const day = fitnessDayFor(d);
  if (!day) return { percent: 0, doneCount: 0, totalCount: 0, groups: {}, rest: false };
  if (day.rest) return { percent: 0, doneCount: 0, totalCount: 0, groups: {}, rest: true };

  const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo(d)));
  const done = new Set(fitnessDoneIds(key));
  let total = 0, got = 0, doneCount = 0, totalCount = 0;
  const groups = {};

  ["warmup", "main", "cooldown"].forEach(group => {
    let gTotal = 0, gGot = 0;
    blocks[group].forEach(block => {
      gTotal += block.weight;
      totalCount += 1;
      if (done.has(block.id)) { gGot += block.weight; doneCount += 1; }
    });
    groups[group] = { done: gGot, total: gTotal, count: blocks[group].length };
    total += gTotal;
    got += gGot;
  });

  return {
    percent: total ? Math.round((got / total) * 100) : 0,
    doneCount,
    totalCount,
    groups,
    rest: false,
    day
  };
}

function fitnessMedalOf(percent) {
  const t = state.fitness.rewards.thresholds;
  if (percent > 0 && percent >= t.gold) return "gold";
  if (percent > 0 && percent >= t.silver) return "silver";
  if (percent > 0 && percent >= t.bronze) return "bronze";
  return "none";
}

function fitnessCoinsForMedal(medal) {
  return medal === "none" ? 0 : (state.fitness.rewards.coins[medal] || 0);
}

function fitnessSessionsOnDay(key) {
  return state.fitness.sessions.filter(item => todayKey(new Date(item.date)) === key);
}

// 每天只结算一次：取当天完成度最高的那次
function fitnessDayDetail(key) {
  const list = fitnessSessionsOnDay(key);
  const best = list.reduce((acc, item) => (!acc || item.completion > acc.completion ? item : acc), null);
  return {
    key,
    sessions: list,
    best,
    done: !!best,
    completion: best ? best.completion : 0,
    medal: best ? best.medal : "none",
    coins: best ? best.coins : 0
  };
}

function fitnessCoinsEarned() {
  const keys = new Set(state.fitness.sessions.map(item => todayKey(new Date(item.date))));
  let total = 0;
  keys.forEach(key => { total += fitnessDayDetail(key).coins; });
  return total;
}

function fitnessWeekDetails(date = new Date()) {
  return weekDayKeys(date).map(fitnessDayDetail);
}

function fitnessWeekScore(date = new Date()) {
  return fitnessWeekDetails(date).reduce((sum, day) => sum + day.completion, 0);
}

function fitnessMonthSeries(date = new Date()) {
  return monthDayKeys(date).map(key => ({ key, ...fitnessDayDetail(key) }));
}

function fitnessTrainingDays() {
  return new Set(state.fitness.sessions.map(item => todayKey(new Date(item.date)))).size;
}

function fitnessStreak() {
  const keys = [...new Set(state.fitness.sessions.map(item => todayKey(new Date(item.date))))].sort().reverse();
  if (!keys.length) return 0;
  let streak = 0;
  let cursor = todayKey();
  if (keys[0] !== cursor) {
    const yesterday = addDays(cursor, -1);
    if (keys[0] !== yesterday) return 0;
    cursor = yesterday;
  }
  for (const key of keys) {
    if (key === cursor) { streak += 1; cursor = addDays(cursor, -1); } else break;
  }
  return streak;
}

function fitnessTestLatest(testId) {
  const list = state.fitness.tests.filter(item => item.testId === testId);
  return list.length ? list[list.length - 1] : null;
}

function fitnessTestBest(testId) {
  return state.fitness.tests
    .filter(item => item.testId === testId)
    .reduce((best, item) => (!best || item.value > best.value ? item : best), null);
}

function fitnessTestFirst(testId) {
  const list = state.fitness.tests.filter(item => item.testId === testId);
  return list.length ? list[0] : null;
}

/* ---------- 体能训练计时器 ----------
 *
 * 交互原则（改造后）：
 *   在动作块上点一次「计时」= 直接开始这个项目，不需要再去侧边"训练计时器"
 *   选时长、点继续或归零（那张卡片已经隐藏了）。
 *
 * 多组动作会**自动串上组间歇**：
 *   原地小步跑 3 组 × 30 秒、组间歇 30 秒
 *     → 运动30 + 间歇30 + 运动30 + 间歇30 + 运动30 = 150 秒
 *   每一段"运动"都有自己的倒计时（浮层右侧大数字按段重置）。
 *
 * 计时开始后弹出占屏幕 80% 的"教练浮层"（coach-timer.js）：
 *   左半 = 所选动作的人形演示，右半 = 当前这一段自己的倒计时，
 *   计时中循环播钟表滴答声、每段过半播「坚持，还剩一半」、全部结束播「完美结束」。
 * 计时循环仍然是这里唯一的时间来源，浮层只负责显示（CoachTimer.update）。
 */

let fitTimer = {
  total: 0, left: 0, running: false, handle: null, label: "",
  exId: "", name: "", emoji: "🏃", how: "", paused: false, closeHandle: null,
  blockId: "",            // 正在计时的动作块 id（跑完自动帮孩子打勾用）
  plan: null,             // { segments: [{kind,seconds,setNo,setCount,exId,label,sides}], setCount }
  endsAt: 0,              // 用挂钟推剩余时间，避免 setInterval 累积漂移
  prepping: false,        // 正在播「就位口令 + 数 3、2、1」，此阶段不计入动作时间
  cueHolding: false       // 循环训练换动作的口令期间：挂钟停住，口令不占动作时间
};
let fitSessionStart = 0;
let fitAudioCtx = null;

/* 「依次进行」序列状态。
 *
 * 为什么单独一份状态、而不是塞进 fitTimer：fitTimer 描述的是"当前这一段"，
 * 每跑完一项就会被下一次 fitTimerStartPlan 重置；而序列描述的是"整个清单走到哪了"，
 * 生命周期跨越好几个 fitTimer，所以必须分开存。
 *   ids      = 本次要按顺序跑的动作块 id（已按 热身→主训练→放松 排好）
 *   index    = 当前跑到第几个（0 基）
 *   advancing= "这次浮层关闭是自动推进引起的"标记，见 fitTimerFinish / fitTimerReset 的注释
 *   cancelled= 已作废（配合 clearTimeout，防"迟到的定时器"把孩子又拽回训练）
 */
let fitSeq = null;   // { ids: [...], index: 0, cancelled: false, advancing: false }

// 提示音用 Web Audio 现场合成，不依赖音频文件（file:// 下点击即用户手势，可以出声）
function fitBeep(times = 2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!fitAudioCtx) fitAudioCtx = new Ctx();
    if (fitAudioCtx.state === "suspended") fitAudioCtx.resume();
    for (let i = 0; i < times; i++) {
      const at = fitAudioCtx.currentTime + i * 0.28;
      const osc = fitAudioCtx.createOscillator();
      const gain = fitAudioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.28, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain).connect(fitAudioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    }
  } catch (error) { /* 声音失败不影响计时 */ }
}

/* 计次类动作"完成一次"的提示音（开合跳、跳绳这类一次一声「滴」）。
 *
 * 为什么不直接复用 fitBeep(1)：
 *   fitBeep 一声 240ms、880Hz，是"开始 / 完成"的仪式音；而跳绳、开合跳一秒能出
 *   一两次动作，240ms 的音会糊在一起，根本听不出"一次一声"。所以计次的提示音必须
 *   **短**（约 70ms）且音高更脆（1200Hz），增益与 fitBeep 同量级（不更响）。
 * 复用同一个 fitAudioCtx（同一个用户手势解锁的上下文）。
 * offsetSec：同一帧内补响多次时错开一点，避免几个同频正弦叠在一起爆音。 */
function fitRepTick(offsetSec = 0) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!fitAudioCtx) fitAudioCtx = new Ctx();
    if (fitAudioCtx.state === "suspended") fitAudioCtx.resume();
    const at = fitAudioCtx.currentTime + offsetSec;
    const osc = fitAudioCtx.createOscillator();
    const gain = fitAudioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.26, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    osc.connect(gain).connect(fitAudioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.08);
  } catch (error) { /* 声音失败不影响计数 */ }
}

/* ---------- 动作块 → 分段计划 ---------- */

const FIT_REP_PER_MIN = 30;   // 动作库里没有节奏参考时的兜底（次/分钟）
const FIT_KID_PAD = 1.2;      // 小孩子做得比成人慢，按推荐节奏再放宽两成

// 一个"组"要做多少秒：秒类直接用秒数（"/侧"左右各一遍），计次类按该动作的推荐节奏折算
function fitWorkSeconds(unit, target, exId) {
  const n = Math.max(1, Number(target) || 0);
  const perSide = /侧/.test(unit || "");
  if (/秒/.test(unit || "")) return Math.round(perSide ? n * 2 : n);
  const ex = (typeof FITNESS_EX !== "undefined" && FITNESS_EX[exId]) || null;
  const band = ex && ex.motion && ex.motion.tempoBand;
  const perMin = band ? (band[0] + band[1]) / 2 : FIT_REP_PER_MIN;
  const reps = perSide ? n * 2 : n;
  const sec = reps * (60 / Math.max(6, perMin)) * FIT_KID_PAD;
  return Math.max(10, Math.min(180, Math.round(sec)));
}

/* ---------------- 每日一练的时长来源 ----------------
 *
 * 时长有两个来源，优先级必须明确，否则会重演"家长设了却不起作用"的老问题：
 *   1. 家长在「家长管理 → 每日一练时间设置」里填的 运动时间 / 组间隔（timing.defaults）
 *   2. 教案（data/fitness-plan.js）里每个动作自带的目标数、组间歇
 *
 * 规则：默认以**家长设置为准**（家长更清楚孩子当下的体能），教案只作为兜底；
 * 家长想严格照教案走，可以在同一个卡片里取消勾选「用我设的时间覆盖教案」。
 */
function fitTiming() {
  const t = (state.fitness && state.fitness.timing) || {};
  const d = t.defaults || {};
  return {
    workTime: clamp(Math.round(Number(d.workTime) || 30), 5, 300),
    restTime: clamp(Math.round(Number(d.restTime) || 10), 3, 120),
    // override 默认 true：家长填了值却看不到效果是最容易让人困惑的
    override: d.override !== false
  };
}

/* 一个动作块的单组运动时长 + 组间歇，统一在这里算，别处不要再各算各的 */
function fitBlockTiming(block) {
  const tm = fitTiming();
  const isTime = /秒/.test(block.unit || "");
  // 秒类动作：教案写的就是秒数；计次类动作：按动作节奏折算成"参考配速"
  const byPlan = Math.max(5, fitWorkSeconds(block.unit, block.target, block.ex));
  const work = tm.override && !isTime ? tm.workTime : byPlan;

  const planRest = Math.max(0, Math.round(block.rest || 0));
  // override 时家长的值说了算；否则教案写了用教案的，没写才用家长的
  const rest = tm.override ? tm.restTime : (planRest > 0 ? planRest : tm.restTime);

  return { work: Math.max(5, Math.round(work)), rest, byPlan, planRest, isTime };
}

/* 把一个动作块展开成连续分段。点一次「计时」就按这个计划一路跑完。
 *   秒类多组：运动 → 间歇 → 运动 → 间歇 → 运动（组间歇自动带上）
 *   计次类：  同样串组间歇，单组时长按动作节奏折算成"参考配速"
 *   循环块：  一轮里逐项做完（中间不休息），轮与轮之间休息 */
function fitPlanFor(block) {
  if (!block) return { segments: [], setCount: 0 };
  const segs = [];
  const tm = fitBlockTiming(block);

  if (block.circuit) {
    const rounds = Math.max(1, block.rounds || 1);
    for (let r = 1; r <= rounds; r++) {
      block.items.forEach(item => {
        // 循环块里每个小项仍然按自己的类型算时长（秒类用教案秒数，计次类用家长设的）
        const sub = fitBlockTiming({ unit: item.unit, target: item.target, ex: item.ex, rest: 0 });
        segs.push({
          kind: "work",
          seconds: sub.work,
          setNo: r, setCount: rounds,
          exId: item.ex, label: item.name,
          sides: /侧/.test(item.unit || "") ? 2 : 1
        });
      });
      if (r < rounds && tm.rest > 0) segs.push({ kind: "rest", seconds: tm.rest });
    }
    return { segments: segs, setCount: rounds, circuit: true, timing: tm };
  }

  const sets = Math.max(1, block.sets || 1);
  const perSide = /侧/.test(block.unit || "");
  for (let i = 1; i <= sets; i++) {
    segs.push({
      kind: "work", seconds: tm.work, setNo: i, setCount: sets,
      exId: block.ex, label: "", sides: perSide ? 2 : 1
    });
    if (i < sets && tm.rest > 0) segs.push({ kind: "rest", seconds: tm.rest });
  }
  return { segments: segs, setCount: sets, perSide, isTime: tm.isTime, timing: tm };
}

// 浮层左上方那行小字：告诉孩子这一块到底要做多少
function fitPlanCaption(block, plan) {
  const tm = (plan && plan.timing) || fitBlockTiming(block);
  const unit = tm.isTime ? "秒" : "次";
  if (block.circuit) return `${block.rounds} 轮 · 轮间休息 ${tm.rest} 秒`;
  const sets = Math.max(1, block.sets || 1);
  const work = plan && plan.segments.length ? plan.segments[0].seconds : tm.work;
  if (sets > 1) {
    const dose = `${sets} 组 × ${block.target} ${unit}`;
    const pace = tm.isTime
      ? `${work} 秒/组`
      : `每组做 ${work} 秒（约 ${block.target} ${unit}）`;
    return `${dose} · ${pace} · 组间歇 ${tm.rest} 秒`;
  }
  return tm.isTime
    ? `${block.target} ${block.unit}`
    : `${block.target} ${unit} · 参考配速 ${work} 秒`;
}

function fitTimerRender() {
  const display = document.getElementById("fitTimerDisplay");
  const stateEl = document.getElementById("fitTimerState");
  const toggle = document.getElementById("fitTimerToggle");
  if (display) {
    const s = Math.max(0, Math.ceil(fitTimer.left));
    display.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  if (stateEl) {
    const segs = fitTimer.plan ? fitTimer.plan.segments.length : 0;
    stateEl.textContent = fitTimer.running
      ? `${fitTimer.label || "计时中"}…${segs > 1 ? `（共 ${segs} 段，自动串组间歇）` : ""}`
      : (fitTimer.paused ? "已暂停，点「继续」接着做" : "先勾选动作，再点「计时」就直接开始");
  }
  if (toggle) toggle.textContent = fitTimer.running ? "暂停" : (fitTimer.left > 0 ? "继续" : "开始");
  const card = display ? display.closest(".fit-timer-card") : null;
  if (card) card.classList.toggle("is-running", fitTimer.running);
}

/* 在清单上把"正在计时的这一块"高亮出来，按钮文字也换成「计时中…」，
 * 孩子一眼能看出现在练的是哪一个项目。 */
function fitTimerMarkBlock(id) {
  document.querySelectorAll(".fit-block.is-timing").forEach(el => {
    el.classList.remove("is-timing");
    const b = el.querySelector(".fit-timer-btn");
    if (b) b.textContent = el.classList.contains("fit-circuit") ? "开始循环" : "计时";
  });
  if (!id) return;
  const el = document.querySelector(`.fit-block[data-block-id="${id}"]`);
  if (!el) return;
  el.classList.add("is-timing");
  const btn = el.querySelector(".fit-timer-btn");
  if (btn) btn.textContent = "计时中…";
}

/* 停表并收起浮层（归零、切模块、计时结束都用它） */
function fitTimerStop() {
  if (fitTimer.handle) { clearInterval(fitTimer.handle); fitTimer.handle = null; }
  // 结束后的"让「完美结束」说完再收浮层"定时器，也必须一起清掉：
  // 否则这 2 秒里用户再点「计时」，旧定时器会把刚打开的新浮层关掉
  if (fitTimer.closeHandle) { clearTimeout(fitTimer.closeHandle); fitTimer.closeHandle = null; }
  fitTimer.running = false;
  fitTimer.paused = false;
  fitTimer.prepping = false;
  fitTimer.cueHolding = false;
  fitTimer.endsAt = 0;
  fitTimerMarkBlock("");
  if (window.CoachTimer) CoachTimer.close();
  fitTimerRender();
}

/* 暂停：浮层留着，只是冻结演示与滴答声，孩子能看到自己停在哪 */
function fitTimerPause() {
  if (fitTimer.handle) { clearInterval(fitTimer.handle); fitTimer.handle = null; }
  fitTimer.running = false;
  fitTimer.paused = true;
  fitTimer.cueHolding = false;   // 暂停期间正好在念口令的话，恢复时别再"补时间"
  if (window.CoachTimer) CoachTimer.setPaused(true);
  fitTimerRender();
}

/* 从暂停里接着做（不重置过半标记，也不重排分段） */
function fitTimerResume() {
  if (!fitTimer.left) return;
  if (!fitAudioCtx) fitBeep(1); // 用一次极短的响声解锁音频上下文
  fitTimer.running = true;
  fitTimer.paused = false;
  if (!fitTimer.prepping) fitTimer.endsAt = Date.now() + fitTimer.left * 1000;
  fitTimerRender();
  if (window.CoachTimer) {
    CoachTimer.setPaused(false);
    CoachTimer.update(fitTimer.prepping ? fitTimer.total : fitTimer.left);
  }
  fitTimer.handle = setInterval(fitTimerTick, 200);
}

/* 装载一个分段计划，然后**立刻开跑**（不用再点"继续"） */
function fitTimerStartPlan(block, plan) {
  fitTimerStop();
  fitTimer.blockId = block.id || "";
  fitTimer.plan = plan;
  fitTimer.total = plan.segments.reduce((sum, s) => sum + s.seconds, 0);
  fitTimer.left = fitTimer.total;
  fitTimer.label = fitPlanCaption(block, plan);

  /* 循环训练的开场口令不能念"循环训练"这一整块的名字 ——
   * 孩子听到的是"准备开始进行循环训练，请就位"，但根本不知道第一个要做什么。
   * 直接拿**第一段的动作**来念（「准备开始进行开合跳，请就位」），
   * 之后每换一个动作再念一次，这样"每个运动开始前都有口令"才真的成立。
   * 注意 name 也要用动作名：口令 mp3 缺失时会退回系统 TTS 念 fallbackName，
   * 那时如果传的是"循环训练"，孩子听到的还是笼统的一句话。 */
  const firstWork = plan.segments.find(s => s.kind === "work") || {};
  const firstEx = firstWork.exId || "";
  const firstExName = firstWork.label || (FITNESS_EX[firstEx] || {}).name || "";
  if (block.circuit && firstEx) {
    fitTimer.exId = firstEx;
    fitTimer.name = firstExName || block.name || "循环训练";
    fitTimer.emoji = (FITNESS_EX[firstEx] || {}).emoji || "🔁";
    fitTimer.how = "一轮就是从上到下做一遍，中间不停；一轮做完再休息。";
  } else {
    fitTimer.exId = block.ex || "";
    fitTimer.name = block.name || "自由训练";
    fitTimer.emoji = block.emoji || "🏃";
    fitTimer.how = block.how || "跟着教练的节奏做，注意呼吸不要憋气。";
  }
  // 循环块的身份要留在标题里，否则孩子看不出这是"一整轮循环"而不是单个动作
  if (block.circuit) fitTimer.label = `🔁 循环训练 · ${fitTimer.label}`;

  fitTimer.paused = false;
  fitTimer.running = false;
  fitTimerRender();
  fitTimerMarkBlock(fitTimer.blockId);
  fitTimerRun();
}

/* 真正开跑：打开教练浮层 + 挂上计时循环。
 *
 * 注意时序：浮层会先播「准备开始进行XX，请就位」+ 人声数 3、2、1，
 * 这段时间**不算孩子做动作的时间**——否则口令还没听完，30 秒就少了 6 秒。
 * 所以先把 running 挂上但 endsAt 先不启动，等 CoachTimer 回调说"准备完了"再起表。 */
function fitTimerRun() {
  if (!fitTimer.total) return;
  if (!fitAudioCtx) fitBeep(1); // 解锁音频上下文
  fitTimer.running = true;
  fitTimer.paused = false;
  fitTimer.prepping = true;
  fitTimer.endsAt = 0;
  fitTimerRender();

  if (window.CoachTimer) {
    const isCircuit = !!(fitTimer.plan && fitTimer.plan.circuit);
    CoachTimer.open({
      exId: fitTimer.exId,
      name: fitTimer.name,
      emoji: fitTimer.emoji,
      how: fitTimer.how,
      label: fitTimer.label,
      segments: fitTimer.plan ? fitTimer.plan.segments : null,
      seconds: fitTimer.total,
      onPause: fitTimerToggle,
      onClose: fitTimerReset,
      videoUrl: getVideoUrl(fitTimer.exId),
      videoUrls: { ...(state.fitness.videoMap || {}) },
      onPrepEnd: fitTimerBegin,
      /* 循环训练：每换一个动作都要「准备开始进行XX，请就位」+ 数 3、2、1。
       * cueFirstExId 预置开场口令覆盖的动作，避免第一段重复念一遍。 */
      cuePerSegment: isCircuit,
      cueFirstExId: isCircuit ? fitTimer.exId : "",
      onSegCueStart: fitTimerHoldForCue,
      onSegCueEnd: fitTimerReleaseCue,
      // 休息段不再播中场休息视频：整块换成纯倒计时（见 CoachTimer 的 rest 面板）
      restUrl: ""
    });
    CoachTimer.update(fitTimer.total);
  } else {
    fitTimerBegin();
  }

  if (fitTimer.handle) clearInterval(fitTimer.handle);
  fitTimer.handle = setInterval(fitTimerTick, 200);
}

/* 口令数完、正式开表 */
function fitTimerBegin() {
  if (!fitTimer.running || !fitTimer.prepping) return;
  fitTimer.prepping = false;
  fitTimer.endsAt = Date.now() + fitTimer.left * 1000;
  fitTimerRender();
}

/* 循环训练换动作：口令开念时把挂钟停住。
 * 关键在 fitsTimer.endsAt —— 挂钟是"剩余时间 = endsAt - now"推出来的，
 * 只把 running 置 false 是没用的（CoachTimer 那边的段落还需要继续渲染）。
 * 所以这里把 endsAt 换成 0 当哨兵，表示"表停了"，等口令念完再由
 * fitTimerReleaseCue() 用"停住的剩余时间"重新起表 —— 口令不占动作时间。 */
function fitTimerHoldForCue() {
  if (!fitTimer.running) return;
  fitTimer.endsAt = 0;         // 哨兵：表停着，别再按挂钟扣时间
  fitTimer.cueHolding = true;
}

function fitTimerReleaseCue() {
  if (!fitTimer.cueHolding) return;
  fitTimer.cueHolding = false;
  if (!fitTimer.running || fitTimer.paused) return;
  // 从"停住那一刻的剩余时间"接着走：口令白送，动作时间一秒不少
  fitTimer.endsAt = Date.now() + Math.max(0, fitTimer.left) * 1000;
}

function fitTimerTick() {
  if (!fitTimer.running) return;
  if (fitTimer.prepping) {
    // 准备阶段：表还没起，浮层自己管口令和数数
    if (window.CoachTimer) CoachTimer.update(fitTimer.total);
    return;
  }
  // 换动作口令期间：挂钟停着（endsAt=0），把剩余时间原样喂给浮层，
  // 否则浮层会以为时间在走、倒计时数字自己往下跳。
  if (!fitTimer.endsAt) {
    if (window.CoachTimer) CoachTimer.update(fitTimer.left);
    return;
  }
  const left = (fitTimer.endsAt - Date.now()) / 1000;
  if (left <= 0) { fitTimer.left = 0; fitTimerFinish(); return; }
  fitTimer.left = left;
  if (window.CoachTimer) CoachTimer.update(fitTimer.left);
  fitTimerRender();
}

/* 全部跑完：播「完美结束」，浮层留着把话说完再收，并把这一块标记为"已完成" */
function fitTimerFinish() {
  fitTimer.running = false;
  if (fitTimer.handle) { clearInterval(fitTimer.handle); fitTimer.handle = null; }
  if (window.CoachTimer && CoachTimer.isOpen()) {
    CoachTimer.finish();
  } else {
    fitBeep(3);
  }
  const id = fitTimer.blockId;
  let msg = `完美结束！${fitTimer.name || "训练"} 完成`;
  if (id && setFitBlockDone(id, true)) {   // 计时跑完 = 这个项目完成
    saveState();
    syncFitBlockEl(id);
    renderFitProgress();
    renderFitnessBoard();
    msg += "，这个项目算完成了";
  }
  toast(msg + "。");
  fitTimer.closeHandle = setTimeout(() => {
    fitTimer.closeHandle = null;
    /* 自动推进时这次浮层关闭是"我们自己的"收尾动作，先打上标记，
     * 免得可能被触发的 fitTimerReset 把序列作废（见 fitTimerReset 的注释）。
     * 经读 coach-timer.js：close() 只置 state.open=false 并清空回调，**不会**回调 onClose
     * （onClose 只在点关闭按钮/点空白/Esc 时触发），所以这条路径本来就是安全的；
     * 留着标记是为了防将来 close() 改成会回调 onClose。 */
    if (fitSeq) fitSeq.advancing = true;
    if (window.CoachTimer) CoachTimer.close();
    fitTimerMarkBlock("");
    fitTimerRender();
    fitSeqAdvance();                    // 还有下一项就自动开跑；没有就收尾
    if (fitSeq) fitSeq.advancing = false;
  }, 2000);
}

/* 兼容旧入口：直接给一段秒数（快捷时长按钮、老测试用） */
function fitTimerSet(seconds, label, opts) {
  const o = opts || {};
  const sec = Math.max(0, Math.round(seconds));
  // 快捷时长按钮 / 自由训练 = 孩子改主意自己挑了别的练，退出「依次进行」
  if (fitSeq) fitSeqAbort();
  fitTimerStop();
  fitTimer.blockId = o.blockId || "";
  fitTimer.plan = {
    segments: sec > 0
      ? [{ kind: "work", seconds: sec, setNo: 1, setCount: 1, exId: o.exId || "", label: "", sides: 1 }]
      : [],
    setCount: 1
  };
  fitTimer.total = sec;
  fitTimer.left = sec;
  fitTimer.label = label || "";
  fitTimer.exId = o.exId || "";
  fitTimer.name = o.name || label || "自由训练";
  fitTimer.emoji = o.emoji || "🏃";
  fitTimer.how = o.how || "";
  fitTimer.paused = false;
  fitTimer.running = false;
  fitTimerRender();
}

function fitTimerToggle() {
  if (fitTimer.running) { fitTimerPause(); return; }
  if (fitTimer.paused && fitTimer.left > 0) { fitTimerResume(); return; }
  if (!fitTimer.total) {
    // 没有装载任何计划时，兜底给一段 30 秒自由训练
    fitTimerSet(30, "自由训练", { name: "自由训练", emoji: "🏃" });
  }
  fitTimerRun();
}

function fitTimerReset() {
  /* 「归零」按钮、浮层关闭（点关闭按钮/点空白/Esc）都会走到这里 —— 都是"孩子主动退出"，
   * 所以要把「依次进行」序列一起作废，否则 2 秒后的自动推进会把浮层又弹回来。
   * ⚠️ advancing 例外：自动推进时我们也会调 CoachTimer.close()，若以后 close() 改成
   * 会回调 onClose，这一层就能保证序列不会被自己的收尾逻辑掐死（见 fitTimerFinish）。 */
  if (fitSeq && !fitSeq.advancing) fitSeqAbort();
  fitTimerStop();
  fitTimer.total = 0;
  fitTimer.left = 0;
  fitTimer.label = "";
  fitTimer.exId = "";
  fitTimer.name = "";
  fitTimer.how = "";
  fitTimer.blockId = "";
  fitTimer.plan = null;
  fitTimer.paused = false;
  fitTimer.cueHolding = false;
  fitTimerRender();
}

/* ---------- 跟做视频导入 ---------- */

let fitVideoInput = null;

function ensureVideoInput() {
  if (fitVideoInput) return fitVideoInput;
  fitVideoInput = document.createElement("input");
  fitVideoInput.type = "file";
  fitVideoInput.accept = "video/*";
  fitVideoInput.style.display = "none";
  fitVideoInput.addEventListener("change", event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const exId = fitVideoInput.dataset.ex;
    if (!exId) return;
    importVideo(exId, file);
    fitVideoInput.value = "";
  });
  document.body.appendChild(fitVideoInput);
  return fitVideoInput;
}

function importVideo(exId, file) {
  if (!exId || !file) return;
  const store = window.VideoStore;
  const name = (FITNESS_EX[exId] || {}).name || exId;

  // 立即写进 IndexedDB：这样"下次启动还在"，不再是开一次导一次。
  const done = (url, persisted) => {
    if (!state.fitness.videoMap) state.fitness.videoMap = {};
    state.fitness.videoMap[exId] = url;
    renderFitnessToday();
    if (persisted) toast(`已导入「${name}」的跟做视频：${file.name}（已保存，下次打开还在）`);
    else toast(`已导入「${name}」的跟做视频：${file.name}（本次可用，但本机存储不可写，下次打开需重新导入）`);
  };

  if (!store) {
    // 极端降级：没有 video-store.js 时退回旧的会话内 Blob URL
    const url = URL.createObjectURL(file);
    done(url, false);
    return Promise.resolve({ url: url, persisted: false });
  }
  return store.save(exId, file).then(res => { done(res.url, res.persisted); return res; })
    .catch(() => {
      try {
        const url = URL.createObjectURL(file);
        done(url, false);
        return { url: url, persisted: false };
      } catch (e) { return { url: "", persisted: false }; }
    });
}

function removeVideo(exId) {
  if (!exId) return;
  const store = window.VideoStore;
  const builtin = (state.fitness.builtinVideoMap || {})[exId] || "";
  const clear = () => {
    if (state.fitness.videoMap) delete state.fitness.videoMap[exId];
    // 删掉自己导入的之后，若项目自带同一个动作的视频，回落到自带的
    if (builtin) state.fitness.videoMap[exId] = builtin;
    renderFitnessToday();
    toast(builtin ? "已删除导入的视频，回落到项目自带的演示视频。" : "已删除跟做视频。");
  };
  if (store) store.remove(exId).then(clear).catch(clear);
  else clear();
}

function getVideoUrl(exId) {
  return (state.fitness.videoMap && state.fitness.videoMap[exId]) || "";
}

/* 这个动作现在用的是"家长自己导入的视频"还是"项目自带的"？
 * 循环块要靠它统计"已导入几个"，因为 videoMap 里天生就填了自带视频，
 * 不能拿"有没有 url"当"导没导入"（那是两个问题）。 */
function fitVideoIsOwn(exId) {
  const url = getVideoUrl(exId);
  if (!url) return false;
  const builtin = (state.fitness.builtinVideoMap || {})[exId] || "";
  return url !== builtin;
}

function getRestVideoUrl() {
  return (state.fitness && state.fitness.restVideoUrl) || "";
}

/* 启动时把"当前可用的跟做视频"装回来：
 *   项目自带的（体能训练动作演示/*.mp4，按文件名与动作 id 对照）+ 
 *   用户导入的（IndexedDB 里的 Blob → 重新 createObjectURL）。
 * 完成前界面照常可用（只是暂时显示"导入跟做视频"），完成后再重绘一次。 */
function videoBootstrap() {
  if (!window.VideoStore) return Promise.resolve();
  return window.VideoStore.resolveAll().then(info => {
    state.fitness.builtinVideoMap = info.builtin || {};
    state.fitness.restVideoUrl = info.restUrl || "";
    state.fitness.videoMap = Object.assign({}, info.videos || {});
    renderFitnessToday();
    return info;
  }).catch(() => {});
}

/* 点动作块上的「计时」：直接开跑，多组自动串组间歇。
 * 前提是这个项目已经被"打钩选中"——没选中的话按钮本来就是禁用的，
 * 这里再兜一道，防止脚本/键盘绕过。 */
function timeFitBlock(blockId) {
  // 手动点某个动作的「计时」= 孩子要单独练这一项，退出「依次进行」序列。
  // （序列自己推进走的是 fitTimerStartPlan，不会经过这里，所以这里放手作废是安全的）
  if (fitSeq) fitSeqAbort();
  const day = fitnessDayFor(new Date());
  const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
  const all = [...blocks.warmup, ...blocks.main, ...blocks.cooldown];
  const block = all.find(item => item.id === blockId);
  if (!block) return;

  if (!isFitBlockPicked(blockId)) {
    toast("先勾选这个动作，再点「计时」。");
    return;
  }

  const plan = fitPlanFor(block);
  if (!plan.segments.length) { toast("这个动作没有可计时的时间。"); return; }

  fitTimerStartPlan(block, plan);

  const work = plan.segments.filter(s => s.kind === "work").length;
  const restCount = plan.segments.length - work;
  toast(restCount
    ? `${block.circuit ? "循环训练" : block.name}：${work} 段运动 + ${restCount} 段休息，共 ${fitTimer.total} 秒，开始！`
    : `${block.circuit ? "循环训练" : block.name}：共 ${fitTimer.total} 秒，开始！`);
}

/* ---------- 「依次进行」：勾选的项目一个个自动启动 ----------
 *
 * 孩子勾完今天的项目后不用再挨个点「计时」，点一次「依次进行」就按
 * 热身 → 主训练 → 放松 的**教案顺序**（不是勾选先后顺序）自动一项接一项地跑。
 * 每一项仍然走原来的 fitTimer + 教练浮层那一整套（口令、数 3、2、1、组间歇全保留），
 * 只是"一项跑完后自动开下一项"由这里接管。
 */

// 今天全部动作块，按 热身 → 主训练 → 放松 的固定顺序拍平
function fitSeqAllBlocks() {
  const day = fitnessDayFor(new Date());
  const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
  return [...blocks.warmup, ...blocks.main, ...blocks.cooldown];
}

// 今天被勾选的块，保持教案顺序
function fitSeqPickedBlocks() {
  return fitSeqAllBlocks().filter(b => isFitBlockPicked(b.id));
}

/* 刷新按钮文案 + 状态行。
 * 没在跑：按钮显示勾选数量（没勾选就禁用）；
 * 在跑：按钮变成「停止依次进行」，状态行显示"第 i / n 项 · 动作名"。 */
function fitSeqRender() {
  const btn = document.getElementById("fitTimeSeqBtn");
  const status = document.getElementById("fitSeqStatus");
  const running = !!fitSeq;
  if (btn) {
    if (running) {
      btn.disabled = false;
      btn.textContent = "停止依次进行";
    } else {
      const n = fitSeqPickedBlocks().length;
      btn.disabled = n === 0;
      btn.textContent = n ? `依次进行（${n} 项）` : "依次进行";
      btn.title = n ? "按 热身→主训练→放松 的顺序，把勾选的项目一个个自动开始" : "先勾选要练的项目";
    }
    btn.classList.toggle("is-running", running);
  }
  if (status) {
    if (running && fitSeq.ids.length) {
      const block = fitSeqAllBlocks().find(b => b.id === fitSeq.ids[fitSeq.index]);
      status.textContent = `依次进行：第 ${fitSeq.index + 1} / ${fitSeq.ids.length} 项 · ${block ? block.name : ""}`;
    } else {
      status.textContent = "";
    }
  }
}

/* 点「依次进行」的总入口：没在跑就开跑，在跑就中止。 */
function timeFitPickedSequence() {
  if (fitSeq) { fitSeqAbort(); toast("已停止依次进行。"); return; }

  const picked = fitSeqPickedBlocks();
  if (!picked.length) { toast("先勾选要练的项目，再点「依次进行」。"); return; }

  // 只收"有可计时时间"的块，保证 ids 的下标和实际能跑的项一一对应
  const items = picked
    .map(block => ({ block, plan: fitPlanFor(block) }))
    .filter(x => x.plan.segments.length);
  if (!items.length) { toast("勾选的项目没有可计时的时间。"); return; }

  /* 有意为之：**已经完成过的块也不跳过**。
   * 用户要的是"勾选的项目一个个自动启动"，所以严格按勾选照跑 ——
   * 既不偷偷跳过已完成的，也不顺手改勾选状态（跳过会让"第 i / n 项"和实际不符，
   * 也会让孩子以为自己没勾对）。 */
  fitSeq = { ids: items.map(x => x.block.id), index: 0, cancelled: false, advancing: false };
  fitSeqRender();

  const first = items[0];
  fitTimerStartPlan(first.block, first.plan);
  fitSeqRender();
  toast(`依次进行开始：共 ${items.length} 项，先练「${first.block.name}」。`);
}

/* 一项跑完 → 开下一项。由 fitTimerFinish 的"说完完美结束、收完浮层"定时器调用。
 * 也允许测试直接调用（本项目在 puppeteer 下被节流，不能靠等真实定时器）。 */
function fitSeqAdvance() {
  if (!fitSeq || fitSeq.cancelled) return;
  const next = fitSeq.index + 1;
  if (next >= fitSeq.ids.length) {
    fitSeq = null;
    fitSeqRender();
    toast("今天勾选的项目全部练完了！");
    return;
  }
  const all = fitSeqAllBlocks();
  const block = all.find(b => b.id === fitSeq.ids[next]);
  const plan = block ? fitPlanFor(block) : null;
  if (!block || !plan || !plan.segments.length) {
    // 理论上进不来（入口已过滤），兜底跳过，避免卡住整个序列
    fitSeq.index = next;
    return fitSeqAdvance();
  }
  fitSeq.index = next;
  fitTimerStartPlan(block, plan);
  fitSeqRender();
  toast(`第 ${next + 1} / ${fitSeq.ids.length} 项：${block.name}，开始！`);
}

/* 作废序列。这是本项目"迟到的定时器"硬规则的执行点：
 * 任何"延时后要改变主状态"的流程都必须能被取消，否则孩子切了页，
 * 2 秒后浮层自己又弹回来、又开跑 —— 所以这里必须把待触发的收尾定时器
 * （fitTimer.closeHandle）一起清掉，光把 fitSeq 置空是不够的。
 *
 * 收尾时统一调 fitSeqRender() 把按钮/状态行刷回"未在跑"的样子：
 * 切页时视图虽然隐藏了，但状态行里的旧文字会留在 DOM 里，
 * 不刷的话下次回到今日训练页在 renderFitnessToday 跑之前会闪一下旧文案。 */
function fitSeqAbort() {
  if (fitTimer.closeHandle) { clearTimeout(fitTimer.closeHandle); fitTimer.closeHandle = null; }
  if (fitSeq) fitSeq.cancelled = true;
  fitSeq = null;
  fitSeqRender();
}

/* ---------- 体能训练结算 ---------- */

function submitFitness(key = todayKey()) {
  // 直接当事件处理器绑定时会把 MouseEvent 传进来，这里兜一下
  if (typeof key !== "string") key = todayKey();
  const day = fitnessDayFor(dateFromKey(key));
  if (!day || day.rest) { toast("今天是休息日，不用训练。"); return; }

  const result = fitnessCompletion(key);
  if (!result.doneCount) { toast("先勾选一个动作、跟着计时做完，再提交训练。"); return; }

  // 校验都过了才动手：结算 = 今天这一轮结束，正在跑的「依次进行」序列就地作废，
  // 免得结算完 2 秒后浮层又自动开下一项。（放在校验之后，避免一次无效提交误杀序列）
  if (fitSeq) fitSeqAbort();

  const medal = fitnessMedalOf(result.percent);
  const coins = fitnessCoinsForMedal(medal);
  const durationSec = fitSessionStart ? Math.round((Date.now() - fitSessionStart) / 1000) : 0;

  state.fitness.sessions.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: new Date(dateFromKey(key).setHours(19, 0, 0, 0)).toISOString(),
    dayId: day.id,
    dayName: day.name,
    week: fitnessWeekNo(dateFromKey(key)),
    completion: result.percent,
    doneCount: result.doneCount,
    totalCount: result.totalCount,
    medal,
    coins,
    durationSec
  });
  if (!state.fitness.startDate) state.fitness.startDate = key;
  saveState();
  fitSessionStart = 0;

  renderAll();
  const best = fitnessDayDetail(key);
  if (medal === "none") {
    toast(`本次完成度 ${result.percent}%，还没到铜牌线（${state.fitness.rewards.thresholds.bronze}%）。明天再来一次就更好了。`);
  } else {
    toast(`完成度 ${result.percent}%，${MEDAL_ICON[medal]} ${MEDAL_LABEL[medal]}，得 ${coins} 🪙！今日最好成绩 ${best.completion}%。`);
  }
}

function resetTodayChecklist(key = todayKey()) {
  if (typeof key !== "string") key = todayKey();
  // 清单都清空了，正在跑的「依次进行」自然也没意义了（否则它会按旧 ids 继续开下一项）
  if (fitSeq) fitSeqAbort();
  if (state.fitness.done) delete state.fitness.done[key];
  if (state.fitness.picked) delete state.fitness.picked[key];
  fitSessionStart = 0;
  saveState();
  renderFitnessToday();
  renderFitnessBoard();
  toast("今天的清单已经清空，可以重新选项目练一次。");
}

function saveFitnessTest(testId) {
  const input = document.querySelector(`[data-fit-test-input="${testId}"]`);
  const value = Number(input && input.value);
  if (!Number.isFinite(value) || value <= 0) { toast("请输入一个大于 0 的成绩。"); return; }
  state.fitness.tests.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    at: new Date().toISOString(),
    testId,
    value: Math.round(value)
  });
  saveState();
  if (input) input.value = "";
  renderFitnessTest();
  const best = fitnessTestBest(testId);
  const first = fitnessTestFirst(testId);
  const name = (FITNESS_TESTS.find(t => t.id === testId) || {}).name || "成绩";
  if (best && first && best.value > first.value && best.at === state.fitness.tests[state.fitness.tests.length - 1].at) {
    toast(`新纪录！${name} ${best.value}，比第一次多了 ${best.value - first.value}。`);
  } else {
    toast(`${name} 已记录。`);
  }
}

function clearFitnessData() {
  if (!confirm("确定要清空本机的体能训练记录吗？写作部分的数据不会受影响。")) return;
  state.fitness.sessions = [];
  state.fitness.tests = [];
  state.fitness.done = {};
  state.fitness.startDate = "";
  saveState();
  renderAll();
  toast("体能记录已清空。");
}

/* ---------- 体能训练渲染 ---------- */

function fitVideoBar(exId, opts) {
  if (!exId) return "";
  const o = opts || {};
  const url = getVideoUrl(exId);
  const builtin = (state.fitness.builtinVideoMap || {})[exId] || "";
  const isOwn = !!(url && url !== builtin);   // 用户自己导入的（不是项目自带的）

  if (o.compact) {
    /* 循环块（周六「综合挑战日」）一行一个动作，必须**每一项都能导入**。
     * 不能因为"这个动作项目自带视频"就不给入口 —— 循环块 5 个动作里 3 个自带，
     * 一刀切藏掉按钮的话家长会发现"循环训练还是导不进去"（用户原话的缺口）。
     * 所以紧凑档一律保留「导入」按钮：已有视频时按钮改成「换视频」，
     * 点了就用自己拍的替换掉自带的那版。 */
    const state0 = isOwn ? "✅ 已导入" : (url ? "✅ 自带" : "");
    return `<div class="fit-video-bar is-compact" data-ex="${exId}">
      ${state0 ? `<span class="fit-video-status">${state0}</span>` : ""}
      ${isOwn
        ? `<button class="fit-video-remove" type="button" data-action="remove-video" data-ex="${exId}"
             title="${builtin ? "删除自己导入的，回落到项目自带视频" : "删除视频"}">删除</button>`
        : ""}
      <button class="fit-video-btn" type="button" data-action="import-video" data-ex="${exId}"
        title="${url
          ? "导入本地视频替换现在的这一版（会保存到本机，下次打开还在）"
          : "导入本地跟做视频（会保存到本机，下次打开还在）"}">🎬 ${url ? "换视频" : "导入视频"}</button>
    </div>`;
  }

  if (url) {
    return `<div class="fit-video-bar" data-ex="${exId}">
      <span class="fit-video-status">✅ 导入成功</span>
      <span class="fit-video-src">${isOwn ? "自己的视频" : "项目自带"}</span>
      ${isOwn
        ? `<button class="fit-video-remove" type="button" data-action="remove-video" data-ex="${exId}"
             title="${builtin ? "删除自己导入的，回落到项目自带视频" : "删除视频"}">删除</button>`
        : ""}
    </div>`;
  }
  return `<div class="fit-video-bar" data-ex="${exId}">
    <button class="fit-video-btn" type="button" data-action="import-video" data-ex="${exId}"
      title="导入本地跟做视频（会保存到本机，下次打开还在）">🎬 导入跟做视频</button>
  </div>`;
}

function fitBlockHtml(block, doneSet, pickedSet) {
  const isDone = doneSet.has(block.id);
  const isPicked = pickedSet ? pickedSet.has(block.id) : isDone;
  // 复选框 = 选中这个项目；选中后才能点「计时」
  const check = `<button class="fit-check" type="button" data-action="toggle-fit-block" data-block="${block.id}"
      aria-pressed="${isPicked}" title="${isPicked ? "取消选中（不再练这个）" : "勾选这个动作，才能开始计时"}">${isPicked ? "✓" : ""}</button>`;
  const badge = `<span class="fit-done-badge${isDone ? "" : " hidden"}">✓ 已完成</span>`;
  const cls = `fit-block${isDone ? " is-done" : (isPicked ? " is-picked" : "")}`;
  const timerAttr = isPicked
    ? ""
    : ` disabled title="先勾选这个动作，再点「计时」"`;

  if (block.circuit) {
    /* 循环块不是"一个动作"，而是好几个动作轮流做。所以视频导入必须**逐项**给：
     * 每个小项自己一行"导入视频"，导入后只有那一段换视频，其他段不受影响。
     * 之前循环块整块没有导入入口 —— 孩子练到循环训练时只能看画布动画，
     * 而别的项目都能看自己导入的跟做视频，这是用户明确指出的缺口。 */
    const rows = block.items.map((item, index) => {
      const bar = fitVideoBar(item.ex, { compact: true });
      return `<li class="fit-ci-row">
        <span class="fit-ci-no">${index + 1}</span>
        <span class="fit-ci-name">${item.emoji} ${escapeHtml(item.name)}</span>
        <strong>${item.target} ${item.unit}</strong>
        ${bar}
      </li>`;
    }).join("");
    const importedCount = block.items.filter(it => fitVideoIsOwn(it.ex)).length;
    const readyCount = block.items.filter(it => getVideoUrl(it.ex)).length;
    return `<div class="${cls} fit-circuit" data-block-id="${block.id}">
      ${check}
      <div class="fit-block-body">
        <div class="fit-block-title">
          <span class="fit-emoji">🔁</span>
          <span class="fit-block-name">循环训练</span>
          <span class="fit-dose">${block.rounds} 轮 · 轮间休息 ${fitBlockTiming(block).rest} 秒</span>
          ${badge}
        </div>
        <ul class="fit-circuit-items">${rows}</ul>
        <p class="fit-how">一轮就是从上到下做一遍，中间不停；一轮做完再休息。开始后每换一个动作都会先念「准备开始进行XX，请就位」再倒数 3、2、1。</p>
        <p class="fit-how fit-ci-video-hint">上面每个动作都能单独导入跟做视频${
          importedCount ? `（已导入 ${importedCount}/${block.items.length} 个，点「换视频」可以重新导）`
            : (readyCount ? `（其中 ${readyCount} 个先用项目自带的演示视频，点「换视频」可换成自己拍的）`
              : "，不导入就看教练动画示范")
        }。</p>
      </div>
      <button class="ghost small fit-timer-btn" type="button" data-action="time-block" data-block="${block.id}"${timerAttr}>开始循环</button>
    </div>`;
  }

  // 剂量文案必须走 fitBlockTiming() 这一个入口，否则卡片上写"组间歇 30 秒"
  // 而实际按家长设置跑 10 秒，家长会以为设置没生效（就是最初那个 bug 的翻版）
  const tm = fitBlockTiming(block);
  const dose = block.sets > 1
    ? `${block.sets} 组 × ${block.target} ${block.unit} · 组间歇 ${tm.rest} 秒`
    : `${block.target} ${block.unit}`;

  return `<div class="${cls}" data-block-id="${block.id}">
    ${check}
    <div class="fit-block-body">
      <div class="fit-block-title">
        <span class="fit-emoji">${block.emoji}</span>
        <span class="fit-block-name">${escapeHtml(block.name)}</span>
        <span class="fit-dose">${dose}</span>
        ${badge}
      </div>
      <p class="fit-how">${escapeHtml(block.how)}</p>
      ${fitVideoBar(block.ex)}
    </div>
    <button class="ghost small fit-timer-btn" type="button" data-action="time-block" data-block="${block.id}"${timerAttr}>计时</button>
  </div>`;
}

function fitRingHtml(percent, medal, label) {
  const C = 2 * Math.PI * 30;
  const ratio = Math.max(0, Math.min(1, percent / 100));
  return `<div class="fit-ring-inner medal-${medal}">
    <svg viewBox="0 0 72 72" aria-hidden="true">
      <circle class="donut-track" cx="36" cy="36" r="30"></circle>
      <circle class="donut-fill" cx="36" cy="36" r="30"
        stroke-dasharray="${(ratio * C).toFixed(1)} ${(C - ratio * C).toFixed(1)}"
        transform="rotate(-90 36 36)"></circle>
    </svg>
    <div class="donut-center"><strong>${percent}<small>%</small></strong><small>${label}</small></div>
  </div>`;
}

function renderFitnessToday() {
  const box = document.getElementById("fitWarmup");
  if (!box) return;

  const now = new Date();
  const week = fitnessWeekNo(now);
  const phase = fitnessPhaseOf(week);
  const day = fitnessDayFor(now);
  const key = todayKey();

  document.getElementById("fitPhaseLabel").textContent = `第 ${week} 周 · ${phase.name}`;
  document.getElementById("fitDayTitle").textContent = `${day.icon} ${day.name}`;
  document.getElementById("fitDayWhy").textContent = day.why;

  const ring = document.getElementById("fitRing");
  const submit = document.getElementById("fitSubmitBtn");

  if (day.rest) {
    document.getElementById("fitWarmup").innerHTML = "";
    document.getElementById("fitMain").innerHTML =
      `<div class="fit-rest">🌤️ 今天是休息日，什么都不用练。可以去户外散散步、晒晒太阳，或者早点睡觉——肌肉是在休息的时候变强的。</div>`;
    document.getElementById("fitCooldown").innerHTML = "";
    document.getElementById("fitWarmupMeta").textContent = "—";
    document.getElementById("fitMainMeta").textContent = "休息";
    document.getElementById("fitCooldownMeta").textContent = "—";
    if (ring) ring.innerHTML = `<div class="fit-ring-inner is-rest"><div class="fit-rest-icon">🌤️</div><small>休息日</small></div>`;
    if (submit) submit.classList.add("hidden");
    const resetBtn = document.getElementById("fitResetBtn");
    if (resetBtn) resetBtn.classList.add("hidden");
    // 休息日没有动作可练，「依次进行」也跟着藏起来，别让孩子点了没反应
    const seqBtnRest = document.getElementById("fitTimeSeqBtn");
    if (seqBtnRest) seqBtnRest.classList.add("hidden");
    const seqStatusRest = document.getElementById("fitSeqStatus");
    if (seqStatusRest) seqStatusRest.textContent = "";
    renderFitTips(day);
    return;
  }

  if (submit) submit.classList.remove("hidden");
  const resetBtn2 = document.getElementById("fitResetBtn");
  if (resetBtn2) resetBtn2.classList.remove("hidden");
  const seqBtn2 = document.getElementById("fitTimeSeqBtn");
  if (seqBtn2) seqBtn2.classList.remove("hidden");

  const blocks = fitnessBlocks(day, phase);
  const doneSet = new Set(fitnessDoneIds(key));
  const pickedSet = new Set(fitnessPickedIds(key));

  document.getElementById("fitWarmup").innerHTML = blocks.warmup.map(b => fitBlockHtml(b, doneSet, pickedSet)).join("");
  document.getElementById("fitMain").innerHTML = blocks.main.map(b => fitBlockHtml(b, doneSet, pickedSet)).join("");
  document.getElementById("fitCooldown").innerHTML = blocks.cooldown.map(b => fitBlockHtml(b, doneSet, pickedSet)).join("");
  // 整块重渲染会把「正在计时」的高亮冲掉，重新标回去
  if (fitTimer.running || fitTimer.paused) fitTimerMarkBlock(fitTimer.blockId);

  const totalBlocks = blocks.warmup.length + blocks.main.length + blocks.cooldown.length;
  document.getElementById("fitWarmupMeta").textContent = `约 5 分钟 · ${blocks.warmup.length} 个动作`;
  document.getElementById("fitMainMeta").textContent = `15-20 分钟 · ${blocks.main.length} 个动作`;
  document.getElementById("fitCooldownMeta").textContent = `约 5 分钟 · ${blocks.cooldown.length} 个动作`;

  const result = fitnessCompletion(key);
  const medal = fitnessMedalOf(result.percent);
  if (ring) ring.innerHTML = fitRingHtml(result.percent, medal, "完成度");

  const best = fitnessDayDetail(key);
  if (submit) {
    submit.textContent = best.done
      ? `再练一次（今日最好 ${best.completion}%）`
      : "完成训练，结算奖牌";
  }
  if (!totalBlocks) {
    document.getElementById("fitMain").innerHTML = `<div class="fit-rest">今天的计划还没配置动作。</div>`;
  }
  renderFitTips(day);
  fitSeqRender();   // 整块重渲染后，按钮文案/状态行按当前勾选与序列状态刷回
}

function renderFitTips(day) {
  const tips = document.getElementById("fitTips");
  const safety = document.getElementById("fitSafety");
  if (tips) {
    tips.innerHTML = [
      `今天练的是「${day.focus}」，先勾选要练的项目，再点它右边的「计时」。`,
      "组间休息不要省。休息够了下组才做得动，效果反而更好。",
      "某个动作实在做不动，可以把组数减半，但不要整块跳过。",
      "做动作时呼吸别憋着：用力的时候呼气，还原的时候吸气。",
      "跟着教练把计时跑完，这个项目才算完成；全部完成就是 100%，也就是今天的金牌。"
    ].map(t => `<li>${escapeHtml(t)}</li>`).join("");
  }
  if (safety) {
    safety.textContent = "训练前 1 小时别吃太饱；穿运动鞋，别在光滑地板上做跳跃动作；膝盖或脚踝一有疼痛就立刻停下来；感冒、发烧或女生生理期当天，改成轻量内容或直接休息。";
  }
}

function renderFitnessTest() {
  const box = document.getElementById("fitTestCards");
  if (!box) return;
  box.innerHTML = FITNESS_TESTS.map(test => {
    const latest = fitnessTestLatest(test.id);
    const best = fitnessTestBest(test.id);
    const first = fitnessTestFirst(test.id);
    const delta = (best && first && best !== first) ? best.value - first.value : 0;
    return `<article class="card fit-test-card">
      <div class="fit-test-head">
        <h3>${escapeHtml(test.name)}</h3>
        <span class="tag">${escapeHtml(test.unit)}</span>
      </div>
      <p class="hint">${escapeHtml(test.hint)}</p>
      <div class="fit-test-numbers">
        <div><span>上次</span><strong>${latest ? latest.value : "--"}</strong></div>
        <div><span>最好</span><strong>${best ? best.value : "--"}</strong></div>
        <div><span>比第一次</span><strong class="${delta > 0 ? "up" : ""}">${delta > 0 ? "+" + delta : (best ? "0" : "--")}</strong></div>
      </div>
      <div class="fit-test-form">
        <input type="number" min="1" step="1" data-fit-test-input="${test.id}" placeholder="输入成绩" />
        <button class="primary" type="button" data-action="save-fit-test" data-test="${test.id}">记录</button>
      </div>
    </article>`;
  }).join("");

  const hist = document.getElementById("fitTestHistory");
  if (!hist) return;
  if (!state.fitness.tests.length) {
    hist.innerHTML = `<p class="hint">还没有自测记录。建议每两周测一次，训练日之后隔一天再测，成绩更准。</p>`;
    return;
  }
  const rows = state.fitness.tests.slice().reverse().map(item => {
    const test = FITNESS_TESTS.find(t => t.id === item.testId) || { name: item.testId, unit: "" };
    const d = new Date(item.at);
    return `<div class="fit-test-row">
      <span class="fit-test-date">${d.getMonth() + 1} 月 ${d.getDate()} 日</span>
      <span class="fit-test-name">${escapeHtml(test.name)}</span>
      <strong>${item.value} ${escapeHtml(test.unit)}</strong>
    </div>`;
  }).join("");
  hist.innerHTML = `<div class="fit-test-list">${rows}</div>`;
}

function renderFitnessHistory() {
  const box = document.getElementById("fitHistoryList");
  if (!box) return;
  if (!state.fitness.sessions.length) {
    box.innerHTML = `<p class="hint">还没有训练记录。去「今日训练」按今天的计划练一次，提交后这里就会留下记录。</p>`;
    return;
  }
  box.innerHTML = state.fitness.sessions.slice().reverse().map(item => {
    const d = new Date(item.date);
    const mins = item.durationSec ? `${Math.max(1, Math.round(item.durationSec / 60))} 分钟` : "—";
    return `<div class="fit-history-row">
      <div class="fit-history-main">
        <strong>${escapeHtml(item.dayName || "训练")}</strong>
        <small>${d.getMonth() + 1} 月 ${d.getDate()} 日 · 第 ${item.week || 1} 周 · ${mins}</small>
      </div>
      <div class="fit-history-bar">
        <div class="fit-history-fill medal-${item.medal}" style="width:${item.completion}%"></div>
      </div>
      <span class="fit-history-pct">${item.completion}%</span>
      <span class="rank-medal medal-${item.medal}">${MEDAL_ICON[item.medal]}${item.coins ? " +" + item.coins : ""}</span>
    </div>`;
  }).join("");
}

function renderFitnessBoard() {
  const pool = document.getElementById("fitCoinPool");
  if (!pool) return;
  const earned = fitnessCoinsEarned();
  const r = state.fitness.rewards;
  // 三档只是"分数线表"，不是三份奖励：同一天只按完成度取**最高**那一档结算
  const medalRows = ["gold", "silver", "bronze"].map(kind => `
    <div class="medal-row ${kind}">
      <span class="medal-icon">${MEDAL_ICON[kind]}</span>
      <span class="medal-name">${MEDAL_LABEL[kind]}</span>
      <span class="medal-line">完成度 ≥ <strong>${r.thresholds[kind]}%</strong></span>
      <span class="medal-coin">${r.coins[kind]} 🪙</span>
    </div>`).join("");

  pool.innerHTML = `
    <div class="coin-hero">
      <span>体能累计金币</span>
      <strong>${earned}</strong>
      <small>共训练 ${fitnessTrainingDays()} 天 · 连续 ${fitnessStreak()} 天</small>
    </div>
    <div class="medal-rules">
      <p class="medal-rules-head">同一天只发一个牌 · 按完成度取最高那一档</p>
      ${medalRows}
      <p class="medal-rules-foot">三档不会叠加：做到 100% 就是金牌，只拿金牌那一档的金币，不会再把银牌、铜牌的也加上。</p>
    </div>
    <div class="coin-split">
      <div><span>🏃 完成度金币</span><strong>${earned}</strong></div>
      <div><span>📷 体感金币</span><strong>${motionCoinsEarned()}</strong></div>
    </div>
    <p class="hint">体能金币会和写作、体感金币合并到同一个奖金池，在「家长管理」里一起兑换游戏时间或零钱。</p>`;

  const rank = document.getElementById("fitWeekRank");
  if (rank) {
    const details = fitnessWeekDetails();
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const max = Math.max(100, ...details.map(d => d.completion));
    const sorted = details.slice().sort((a, b) => b.completion - a.completion || (a.key < b.key ? -1 : 1));
    rank.innerHTML = sorted.map((day, index) => {
      const d = dateFromKey(day.key);
      const isToday = day.key === todayKey();
      const isFuture = day.key > todayKey();
      const plan = fitnessDayFor(d);
      const isRest = plan && plan.rest;
      const top = day.completion > 0 && index < 3 ? ` top${index + 1}` : "";
      const width = (isRest || isFuture) ? 0 : (day.completion / max) * 100;
      return `<div class="rank-row${top}${isToday ? " is-today" : ""}${isFuture ? " is-future" : ""}">
        <span class="rank-no">${index + 1}</span>
        <span class="rank-day">周${weekdays[d.getDay()]}<small>${d.getMonth() + 1}/${d.getDate()}</small></span>
        <span class="rank-bar"><i style="width:${width}%" class="medal-${isRest ? "none" : day.medal}"></i></span>
        <span class="rank-medal">${isRest ? "🌤️" : MEDAL_ICON[day.medal]}</span>
        <span class="rank-score">${isRest ? "休息" : (isFuture ? "—" : day.completion + "%")}</span>
      </div>`;
    }).join("");
  }
}

function drawFitMonthChart() {
  const canvas = document.getElementById("fitMonthChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const padL = 52, padR = 24, padT = 26, padB = 40;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);
  const series = fitnessMonthSeries();
  const t = state.fitness.rewards.thresholds;

  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  [0, 25, 50, 75, 100].forEach(value => {
    const y = padT + plotH - (value / 100) * plotH;
    ctx.strokeStyle = value === 0 ? "#cbd5e1" : "#eef2f7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(value + "%", padL - 10, y);
  });

  // 三条奖牌完成度线
  [["gold", "#f59e0b", t.gold], ["silver", "#94a3b8", t.silver], ["bronze", "#d97706", t.bronze]].forEach(([kind, color, value]) => {
    if (!value || value > 100) return;
    const y = padT + plotH - (value / 100) * plotH;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.restore();
  });

  const n = series.length;
  const stepX = n > 1 ? plotW / (n - 1) : plotW;
  const xOf = i => padL + i * stepX;
  const yOf = v => padT + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH;
  const colorOf = medal => ({ gold: "#f59e0b", silver: "#94a3b8", bronze: "#d97706", none: "#e2e8f0" }[medal] || "#e2e8f0");

  const pts = series.map((day, i) => ({ x: xOf(i), y: yOf(day.completion), day }));

  // 填充
  const fillPts = pts.filter(p => p.day.done);
  if (fillPts.length > 1) {
    ctx.beginPath();
    ctx.moveTo(fillPts[0].x, padT + plotH);
    fillPts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(fillPts[fillPts.length - 1].x, padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, "rgba(56,189,248,0.28)");
    grad.addColorStop(1, "rgba(56,189,248,0.02)");
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.beginPath();
  let started = false;
  pts.forEach(p => {
    if (!p.day.done) { started = false; return; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2.6;
  ctx.lineJoin = "round";
  ctx.stroke();

  const today = todayKey();
  pts.forEach(p => {
    if (!p.day.done) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.day.key === today ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(p.day.medal);
    ctx.fill();
    if (p.day.key === today) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5; ctx.stroke(); }
  });

  ctx.textAlign = "center";
  ctx.fillStyle = "#94a3b8";
  const labelEvery = n > 20 ? 3 : (n > 12 ? 2 : 1);
  series.forEach((day, i) => {
    if (i % labelEvery !== 0) return;
    ctx.fillText(String(dateFromKey(day.key).getDate()), xOf(i), padT + plotH + 18);
  });

  if (!series.some(day => day.done)) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("这个月还没有训练记录", padL + plotW / 2, padT + plotH / 2);
  }

  const legend = document.getElementById("fitMonthLegend");
  if (legend) {
    legend.innerHTML = ["gold", "silver", "bronze"].map(kind =>
      `<span class="legend-item"><i class="dot medal-${kind}"></i>${MEDAL_LABEL[kind]} ≥ ${state.fitness.rewards.thresholds[kind]}%</span>`
    ).join("") + `<span class="legend-item"><i class="dot is-line"></i>完成度曲线</span>`;
  }
}

/* ==================================================================
 * 体感跟练（摄像头动作分析）
 *
 * 思路：摄像头拍到的画面**只在本机分析**，不上传、不录像。
 *   引擎（motion-engine.js）把画面降到 96×72 灰度做帧差，提取"运动能量 /
 *   重心 / 包围盒"等信号，再按动作类型做峰值检测，得到：
 *     次数、节奏、幅度、对称、连续、保持时长
 *   然后 MotionEngine.scoreSession() 把这些统计量算成 0-100 的动作分。
 *
 * 为什么不用 MediaPipe / TensorFlow.js：
 *   本应用是双击 index.html 打开的（file://）。实测 file:// 下 getUserMedia
 *   可用，但 fetch/XHR 会被 CORS 拦掉（origin 为 null），**下载不了模型权重**。
 *   所以只能纯 JS 做信号分析——这也是 Wii / Switch 体感游戏的做法。
 *   代价是测不了关节角度，界面上如实说明，不夸大。
 *
 * 结算：动作分达到家长设定的分数线 → 金/银/铜牌 → 金币，每天只结算一次
 * （取当天最高分）。金币与写作、体能共用同一个奖金池。
 * ================================================================== */

const MOTION_ENGINE = (typeof window !== "undefined" && window.MotionEngine) || null;

let motionEngine = null;
let motionStream = null;
let motionChoice = null;        // 当前选中的动作（{exId, profile, target, blockId, label, group}）
let motionRunning = false;
let motionResultRecord = null;  // 最近一次评分记录（用来渲染右侧结果卡）
let motionEls = {};             // 实时面板的 DOM 缓存
let motionTickBound = false;

/* ---------- 「达标即完成 + 自动下一项」的状态 ----------
 *
 * 用户要求：运动过程中显示本项的次数/时间计数，达标后提醒「项目完成」，
 * 然后这一项就算完了，**自动开始下一项**（今天计划里热身→主训→放松一路走完）。
 *
 * 为什么要用独立状态位而不是从 running/reps 推：
 *   达标判在每一帧回调里（renderMotionLive，约 25~60fps），一次达标会被
 *   连续几十帧重复判定。没有这个锁，一次达标会打出几十条成绩记录。
 *   —— 这是本项目"迟到的定时器"之外的第二类重复触发风险。 */
let motionSetDone = null;       // { exId, at } 本项已达标完成
let motionAutoNext = null;      // 自动推进的把手 { timer, cancelled }（可 abort）
let motionRestLeft = 0;         // 项间休息剩余秒数（0 = 不在休息）
let motionRestTimer = 0;        // 休息倒计时的 interval id
let motionAutoNextDone = false; // 今天整套已经走完了（不再自动往下）

/* ---------- 语音/提示音反馈的状态（计次滴声 + 计时无效语音）----------
 *
 * 用户原话：「在运动时由于距离显示器远不方便看体感正确与否的反馈，需要增加
 * 体感的语音反馈」——计次类每完成一次动作「滴」一声；计时类动作无效时停表并报
 * 「动作不正确」（没播完不重复）。
 *
 * 为什么要单独记状态位、而不每帧现推：
 *   · 计次滴声靠"和上一帧比 reps 涨了多少"，必须记住上一帧的基线；
 *   · "动作无效"要防抖（连续 1.2 秒不动才算）且不能重复播报，必须记住起点与标记。
 *   —— 这两类都是"跨帧"的判断，推不出来，只能存。 */
let motionLastReps = -1;        // 上一帧的计次总数（-1 = 尚未初始化，下一帧只建基线不响）
let motionInvalidSince = 0;     // 连续"没有动作"的起点（monoNow 毫秒；0 = 还没开始计）
let motionInvalidFlag = false;  // 当前是否已判定"动作无效（停表）"
let motionSetStartAt = 0;       // 本组开跑时刻（monoNow；算宽限期用）

/* "动作无效"判定的两个时间参数（一律用 monoNow 量）：
 *  · 防抖 1.2 秒：单帧抖动（骨架丢一帧、运动量瞬间掉到门限下）不能算无效，
 *    要连续约 1.2 秒没动作才认定，避免界面和语音乱闪乱报。
 *  · 宽限 3 秒：开跑后孩子刚听完「3、2、1」还在起势，前 3 秒不判无效，
 *    否则一开跑就骂「动作不正确」是错的。 */
const MOTION_INVALID_HOLD_MS = 1200;
const MOTION_INVALID_GRACE_MS = 3000;

/* "动作无效（停表）"的可见反馈。
 * 为什么用行内样式而不是加一条 .is-paused 规则：styles.css 由另一个任务在改，
 * 硬加规则会打架。灰色 + 虚线边 + 进度条也灰掉 = "停住了 / 没在计"，与正常的
 * 青绿（进行中）、琥珀（休息）、绿（完成）都区分得开；恢复时清空行内样式，
 * 自动退回 CSS 里那套颜色。 */
function applyMotionPausedLook(box, paused) {
  if (!box) return;
  const num = document.getElementById("motionGoalNum");
  const fill = document.getElementById("motionGoalFill");
  if (paused) {
    box.style.borderColor = "#94a3b8";
    box.style.borderStyle = "dashed";
    box.style.background = "#e2e8f0";
    if (num) num.style.color = "#64748b";
    // 进度条从青绿渐变变平灰：一眼看出"计时冻住了"
    if (fill) fill.style.background = "#94a3b8";
  } else {
    box.style.borderColor = "";
    box.style.borderStyle = "";
    box.style.background = "";
    if (num) num.style.color = "";
    if (fill) fill.style.background = "";
  }
}

/* 计次滴声 + 计时无效语音这两条反馈链路的"状态归零"。
 * 所有"换主状态"的点都必须调它 —— 新开一组（motionStartSetNow）、换动作
 * （setMotionChoice）、停一组 / 重来 / 结束评分 / 离开体感流程。否则迟到的
 * 无效计时或上一组的计次基线会漏进下一组，出现"刚开跑就骂动作不正确"
 * 或"一开跑补一串滴声"。 */
function motionFeedbackReset() {
  motionLastReps = -1;
  motionInvalidSince = 0;
  motionInvalidFlag = false;
  applyMotionPausedLook(document.getElementById("motionGoalProgress"), false);
}

/* 计时类动作"动作无效"的语音播报。
 * 走 VoiceGuide.sayExclusive：那一句还没播完就绝不打断重播（用户原话
 * "没有播报完的话不要立即重复播报"）。VoiceGuide 没加载时静默跳过，不影响计时。 */
function motionSayWrong() {
  if (window.VoiceGuide && window.VoiceGuide.sayExclusive) return window.VoiceGuide.sayExclusive("wrong");
  return false;
}

/* 摄像头选择：把上次用过的那台记下来，下次直接沿用。
 * 之前约束里写死 facingMode:"user"，笔记本上会被解析成内置前置摄像头，
 * 外接的 Astra Pro 根本轮不到——这就是"体感效果非常不好"的一半原因。 */
const MOTION_CAM_KEY = "dw.motion.camera";
let motionCam = { id: "", label: "" };
let motionCamList = [];
try {
  const saved = JSON.parse(localStorage.getItem(MOTION_CAM_KEY) || "{}");
  if (saved && typeof saved === "object") motionCam = { id: saved.id || "", label: saved.label || "" };
} catch (error) { /* 隐私模式下 localStorage 不可用，用内存默认值即可 */ }

// 能从名字里认出来的深度摄像头（这类设备的彩色画质一般，但深度流很值钱）。
// 除了英文名，也认 USB 厂商 ID：Orbbec 是 2bc5，设备名一般带 "(2bc5:0501)" 这样的后缀。
function motionCamIsDepth(label) {
  const s = label || "";
  return /astra|orbbec|realsense|kinect|depth|深度/i.test(s) || /\(?2bc5[:_]/i.test(s);
}

// 笔记本自带的前置头。外接了 Astra 之后它是**最不该**被选中的那个：
// 广角畸变大、贴着天花板往下拍，体感轮廓会糊成一团。
function motionCamIsBuiltin(label) {
  return /integrated|built-?in|内置|hd user facing|front/i.test(label || "");
}

/* 从设备列表里挑一台默认要用的：Astra 这类深度摄像头优先，实在没有再退回内置头。
 * 返回 null 表示"让浏览器自己挑"。 */
function motionCamPickPreferred(devices) {
  const list = (devices || []).filter(d => d && d.kind === "videoinput");
  if (!list.length) return null;
  const depth = list.find(d => motionCamIsDepth(d.label));
  if (depth) return depth;
  const outer = list.find(d => !motionCamIsBuiltin(d.label));
  return outer || list[0];
}

function motionCamSave(deviceId) {
  const hit = motionCamList.find(d => d.deviceId === deviceId);
  motionCam = deviceId ? { id: deviceId, label: (hit && hit.label) || "" } : { id: "", label: "" };
  try {
    if (motionCam.id) localStorage.setItem(MOTION_CAM_KEY, JSON.stringify(motionCam));
    else localStorage.removeItem(MOTION_CAM_KEY);
  } catch (error) { /* 忽略 */ }
}

/* 读摄像头列表。allowProbe=true 时，若设备名全是空的（还没授权过 label 读不到），
 * 就先悄悄开一次把权限拿到再重新枚举。 */
async function motionCamEnumerate(allowProbe) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
  } catch (error) { devices = []; }
  if (!allowProbe || devices.some(d => d.label)) return devices;

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (error) {
    /* 用户拒绝或没有设备，保持列表原样即可 */
  } finally {
    if (stream) stream.getTracks().forEach(track => track.stop());
  }
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
  } catch (error) { devices = []; }
  return devices;
}

/* 默认摄像头必须在开流之前定下来。
 * 如果这里不管，约束里只能写 facingMode:"user"，笔记本上会被解析成内置前置头，
 * 外接的 Astra Pro 就永远轮不到——体感效果差的一大半原因就在这里。 */
async function motionCamEnsureDefault() {
  if (motionCam.id) return motionCam.id;
  if (!navigator.mediaDevices) return "";
  let devices = await motionCamEnumerate(false);
  if (!devices.some(d => d.label)) devices = await motionCamEnumerate(true);
  motionCamList = devices;
  const pick = motionCamPickPreferred(devices);
  if (pick && pick.deviceId) motionCamSave(pick.deviceId);
  return motionCam.id;
}

async function motionCamRefresh() {
  const select = document.getElementById("motionCamSelect");
  const info = document.getElementById("motionCamInfo");
  if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    if (info) info.textContent = "这个浏览器读不到摄像头列表。";
    return;
  }

  let devices = await motionCamEnumerate(true);
  motionCamList = devices;

  // 同一台摄像头的 deviceId 会随插拔变化，用名字做二次匹配，尽量认出上次那台
  if (motionCam.id && !devices.some(d => d.deviceId === motionCam.id)) {
    const same = devices.find(d => d.label && d.label === motionCam.label);
    if (same) motionCamSave(same.deviceId);
    else if (motionCam.label && !devices.length) { /* 设备拔掉了，先留着记忆 */ }
  }

  // 第一次进来还没选过：直接把 Astra 这类深度头定成默认值，别等孩子自己翻下拉框
  if (!motionCam.id || !devices.some(d => d.deviceId === motionCam.id)) {
    const pick = motionCamPickPreferred(devices);
    if (pick && pick.deviceId) motionCamSave(pick.deviceId);
  }

  if (!devices.length) {
    select.innerHTML = `<option value="">（没有检测到摄像头）</option>`;
    select.disabled = true;
    if (info) info.textContent = "没检测到摄像头，检查一下有没有插好。";
    return;
  }

  select.disabled = false;
  select.innerHTML = [`<option value="">自动（优先深度摄像头）</option>`]
    .concat(devices.map((d, i) => {
      const name = d.label || `摄像头 ${i + 1}`;
      let tag = "";
      if (motionCamIsDepth(name)) tag = "（深度摄像头 · 推荐）";
      else if (motionCamIsBuiltin(name)) tag = "（笔记本自带）";
      return `<option value="${d.deviceId}">${name}${tag}</option>`;
    }))
    .join("");
  select.value = devices.some(d => d.deviceId === motionCam.id) ? motionCam.id : "";
  if (info && !info.textContent) info.textContent = `检测到 ${devices.length} 个摄像头`;
}

/* 实际生效的约束。
 * 这里绝对不能写 facingMode:"user"——笔记本上它必然解析成内置前置头，
 * 外接的 Astra Pro 就永远轮不到。所以任何时候都锁死 deviceId。 */
function motionCamConstraints() {
  const video = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  if (motionCam.id) {
    video.deviceId = { exact: motionCam.id };
  } else {
    const pick = motionCamPickPreferred(motionCamList);
    if (pick && pick.deviceId) video.deviceId = { exact: pick.deviceId };
  }
  return { video, audio: false };
}

// 把真正在用的设备名 / 分辨率 / 帧率显示出来，方便确认没选错
function motionCamApplyInfo() {
  const info = document.getElementById("motionCamInfo");
  if (!info) return;
  const track = motionStream && motionStream.getVideoTracks && motionStream.getVideoTracks()[0];
  if (!track) { info.textContent = ""; return; }
  const s = track.getSettings ? track.getSettings() : {};
  const hit = motionCamList.find(d => d.deviceId === s.deviceId);
  const parts = [];
  if (hit && hit.label) parts.push(hit.label);
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.frameRate) parts.push(`${Math.round(s.frameRate)} fps`);
  info.textContent = parts.join(" · ");
  info.classList.toggle("is-depth", motionCamIsDepth(hit && hit.label));
}

function motionEnabled() {
  return !!(MOTION_ENGINE && state.fitness.motion && state.fitness.motion.enabled);
}

/* ---------- Astra Pro 深度接入 ----------
 * 浏览器拿不到 USB 深度设备，由 tools/orbbec/start-depth-bridge.bat 起一个
 * 本地服务把深度推过来。服务没跑时这里一直是"未连接"，体感自动退回纯彩色
 * 分析，功能不受影响——只是人形轮廓没那么准。
 */
let motionDepth = null;

function motionDepthLink() {
  if (motionDepth) return motionDepth;
  if (typeof window === "undefined" || !window.DepthLink) return null;
  motionDepth = window.DepthLink.createLink({ width: 96, height: 72 });
  motionDepth.onStatus(() => motionDepthRenderChip());
  motionDepth.connect();
  // 状态可能连上后几秒才稳定，定期刷一下标签
  if (!motionDepthTimer) motionDepthTimer = setInterval(motionDepthRenderChip, 1500);
  return motionDepth;
}
let motionDepthTimer = null;

function motionDepthRenderChip() {
  const chip = document.getElementById("motionDepthChip");
  if (!chip) return;
  const link = motionDepth;
  /* 深度是**可选**增强项：动作判断的主链路是彩色画面上的 MediaPipe 骨架，不读深度；
   * 深度只用在"空房扫描防幻影人"和"退回掩码链路时选人"两处兜底。所以没接深度时
   * 文案要说成"未开启"（可选、没坏），而不是"未连接"（像坏了）。怎么开启的说明
   * 放进 title 提示，不占孩子看得见的这一行。 */
  if (!link) {
    chip.classList.remove("is-on");
    chip.textContent = "深度：未开启";
    chip.title = "深度测距是可选项，不开启也能正常跟练。开启后能多一个“离摄像头多远”的测距提示；要开启需先运行 tools/orbbec/start-depth-bridge.bat 并保持窗口开着。";
    return;
  }
  const s = link.stats();
  if (link.available()) {
    chip.classList.add("is-on");
    chip.textContent = `深度：已连接 ${s.fps}fps · 有效 ${Math.round(s.validRatio * 100)}%`;
    chip.title = `${s.device || "Astra"}  源 ${s.srcW}×${s.srcH}  ${s.minMM}~${s.maxMM}mm`;
  } else {
    chip.classList.remove("is-on");
    chip.textContent = "深度：未开启";
    chip.title = "没收到深度帧（这是可选项，不影响跟练）。要启用测距提示，先运行 tools/orbbec/start-depth-bridge.bat 并保持窗口开着。";
  }
}

// 动作的体感参数（动作库里 mode 为 none 的动作返回 null，表示不参与体感评分）
function motionProfileFor(exId) {
  const ex = FITNESS_EX[exId];
  if (!ex || !ex.motion || ex.motion.mode === "none") return null;
  return Object.assign({ id: exId, name: ex.name, emoji: ex.emoji, unit: ex.unit, how: ex.how }, ex.motion);
}

function motionMeasurableIds() {
  return Object.keys(FITNESS_EX).filter(id => FITNESS_EX[id].motion && FITNESS_EX[id].motion.mode !== "none");
}

// 候选动作：今天计划里的动作排在最前面，后面补上"自由加练"
function motionChoices() {
  const day = fitnessDayFor(new Date());
  const phase = fitnessPhaseOf(fitnessWeekNo());
  const blocks = (day && !day.rest) ? fitnessBlocks(day, phase) : { warmup: [], main: [], cooldown: [] };
  const out = [];
  const seen = new Set();

  const push = (exId, target, blockId, group) => {
    const profile = motionProfileFor(exId);
    if (!profile) return;
    out.push({ exId, profile, target: target || 0, blockId: blockId || "", group });
    seen.add(exId);
  };

  ["warmup", "main", "cooldown"].forEach(group => {
    blocks[group].forEach(block => {
      if (block.circuit) {
        // 循环训练里每个动作单独当一组来跟练
        block.items.forEach(item => push(item.ex, item.target, block.id, group));
      } else {
        push(block.ex, block.target, block.id, group);
      }
    });
  });

  motionMeasurableIds().forEach(exId => { if (!seen.has(exId)) push(exId, 0, "", "free"); });
  return out;
}

// 本组目标：次数 / 秒数 / 保持秒数
/* 动作类型的中文说法：rep=计次 / burst=高频连续 / hold=静态保持 / none=测不了 */
function motionModeText(mode) {
  if (mode === "hold") return "保持类动作";
  if (mode === "burst") return "高频连续动作";
  if (mode === "none") return "摄像头测不了";
  return "计次类动作";
}

function motionGoalFor(choice) {
  if (!choice || !choice.profile) return { label: "自由练习" };
  const p = choice.profile;
  const ex = FITNESS_EX[choice.exId] || {};
  const unit = ex.unit || "";

  if (p.mode === "hold") {
    const sec = choice.target || p.holdSeconds || 30;
    /* 秒/侧 的动作（单腿站立）：左右各做一遍，界面按"每侧 X 秒"显示 */
    const perSide = unit === "秒/侧";
    return { holdSeconds: sec, label: perSide ? `${sec} 秒/侧` : `保持 ${sec} 秒` };
  }

  // 高频动作：不数次数，测"连续动了多久、动得有多猛"
  if (p.mode === "burst") {
    const seconds = choice.target || p.burstSeconds || 30;
    return { seconds, label: `连续动 ${seconds} 秒` };
  }

  const perSide = unit === "次/侧";
  const per = choice.target || 12;
  const reps = per * (perSide ? 2 : 1);
  return { reps, label: perSide ? `${per} 次/侧（两边一共 ${reps} 次）` : `${per} 次` };
}

/* ---------- 体感结算（派生，不落库日汇总）---------- */

function motionMedalOf(score) {
  const t = state.fitness.motion.rewards.thresholds;
  if (score > 0 && score >= t.gold) return "gold";
  if (score > 0 && score >= t.silver) return "silver";
  if (score > 0 && score >= t.bronze) return "bronze";
  return "none";
}

function motionCoinsForMedal(medal) {
  return medal === "none" ? 0 : (state.fitness.motion.rewards.coins[medal] || 0);
}

function motionScoresOnDay(key) {
  return state.fitness.motion.scores.filter(item => item.dateKey === key);
}

// 每天只结算一次：取当天动作分最高的那次
function motionDayDetail(key) {
  const list = motionScoresOnDay(key);
  const best = list.reduce((acc, item) => (!acc || item.total > acc.total ? item : acc), null);
  return {
    key,
    list,
    best,
    done: !!best,
    score: best ? best.total : 0,
    medal: best ? motionMedalOf(best.total) : "none",
    coins: best ? motionCoinsForMedal(motionMedalOf(best.total)) : 0
  };
}

function motionCoinsEarned() {
  const keys = new Set(state.fitness.motion.scores.map(item => item.dateKey));
  let total = 0;
  keys.forEach(key => { total += motionDayDetail(key).coins; });
  return total;
}

function motionLastRecord() {
  const list = state.fitness.motion.scores;
  return list.length ? list[list.length - 1] : null;
}

function motionBestRecord() {
  return state.fitness.motion.scores.reduce((best, item) => (!best || item.total > best.total ? item : best), null);
}

/* ---------- 摄像头 ---------- */

const MOTION_CAMERA_ERROR = {
  NotAllowedError: "摄像头权限没通过。以后请用 start-app.bat 打开本应用（它会自动允许摄像头），或者点地址栏左边的图标把摄像头改成「允许」再刷新。",
  PermissionDeniedError: "摄像头权限没通过。以后请用 start-app.bat 打开本应用（它会自动允许摄像头），或者点地址栏左边的图标把摄像头改成「允许」再刷新。",
  NotFoundError: "没有找到摄像头。请确认电脑接了摄像头（笔记本一般自带），或者换一台设备。",
  DevicesNotFoundError: "没有找到摄像头。请确认电脑接了摄像头（笔记本一般自带），或者换一台设备。",
  NotReadableError: "摄像头被别的程序占用了（比如正在视频会议）。关掉那个程序再试一次。",
  TrackStartError: "摄像头被别的程序占用了（比如正在视频会议）。关掉那个程序再试一次。",
  OverconstrainedError: "摄像头不支持请求的分辨率，请换一个摄像头试试。",
  SecurityError: "浏览器不允许在当前页面使用摄像头。请确认页面是通过 https 或本机文件打开的。"
};

function motionShowUnsupported(text) {
  const box = document.getElementById("motionUnsupported");
  if (box) {
    box.textContent = text;
    box.classList.remove("hidden");
  }
  const ph = document.getElementById("motionPlaceholder");
  if (ph) ph.classList.add("hidden");
  toast(text);
}

/* 兜底：万一开出来的是笔记本内置头（浏览器默认设备、旧记忆、或者 Astra 被占用），
 * 而列表里还有别的外接头，就换过去。只有显式 deviceId 才锁得住，
 * 光靠约束里的弱提示保不住。 */
async function motionCamEscapeBuiltin(videoEl) {
  if (!motionStream || !navigator.mediaDevices) return false;
  const track = motionStream.getVideoTracks && motionStream.getVideoTracks()[0];
  const label = (track && track.label) || "";
  if (!motionCamIsBuiltin(label)) return false;

  const list = motionCamList.length ? motionCamList : await motionCamEnumerate(false);
  const alt = list.find(d => d.deviceId && !motionCamIsBuiltin(d.label));
  if (!alt) return false;

  const old = motionStream;
  let next = null;
  const keepId = motionCam.id;
  try {
    motionCamSave(alt.deviceId);
    next = await navigator.mediaDevices.getUserMedia(motionCamConstraints());
  } catch (error) { next = null; }
  if (!next) {
    motionCamSave(keepId);   // 换失败就还用原来那台
    return false;
  }
  old.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* 忽略 */ } });
  motionStream = next;
  videoEl.srcObject = next;
  await motionPlayVideo(videoEl);
  motionSyncOverlaySize(videoEl);
  return true;
}

async function motionToggleCamera() {
  if (motionStream) { motionStopCamera(); return; }
  if (!motionEnabled()) {
    toast(MOTION_ENGINE ? "家长在「家长管理」里关掉了摄像头体感功能。" : "体感引擎没加载成功，请刷新页面重试。");
    return;
  }
  const video = document.getElementById("motionVideo");
  if (!video) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    motionShowUnsupported("这个浏览器不支持摄像头。请用较新版本的 Chrome 或 Edge 打开本页面。");
    return;
  }

  // 开流之前先把要用的那台定下来：优先 Astra 这类外接深度头，
  // 绝不让约束落到 facingMode:"user" 上（那必然是笔记本内置头）。
  await motionCamEnsureDefault();

  let camError = null;
  try {
    motionStream = await navigator.mediaDevices.getUserMedia(motionCamConstraints());
  } catch (error) { camError = error; }

  // 记住的那台可能已经拔掉了，退回"自动选择"再试一次，别让孩子卡在这里
  if (!motionStream && motionCam.id) {
    motionCamSave("");
    try {
      motionStream = await navigator.mediaDevices.getUserMedia(motionCamConstraints());
      camError = null;
    } catch (error) { camError = error; }
  }

  if (!motionStream) {
    motionStream = null;
    motionShowUnsupported(MOTION_CAMERA_ERROR[camError && camError.name] || `打开摄像头失败：${(camError && camError.message) || "未知错误"}`);
    return;
  }

  // 开成功后重新枚举一次（这时才有权限读到设备名），并把真正的设备显示出来
  await motionCamRefresh();
  motionCamApplyInfo();

  video.srcObject = motionStream;
  await motionPlayVideo(video);
  await motionCamEscapeBuiltin(video);

  // 换过摄像头的话设备名/分辨率要跟着更新
  motionCamApplyInfo();

  if (!motionEngine) {
    motionEngine = MOTION_ENGINE.createEngine();
    motionEngine.attach(video);
    motionEngine.attachOverlay(document.getElementById("motionOverlay"));
    motionEngine.attachDepth(motionDepthLink());   // 有 Astra 深度就用，没有就纯彩色
    motionEngine.attachVision(motionVisionLink(video)); // 真实骨架（MediaPipe）；没加载好就自动走掩码
  } else {
    // 摄像头重开时把画面源换给感知器，否则它还在读那个已经死掉的 video
    motionVisionAttach(video);
  }
  if (!motionTickBound) {
    motionEngine.onTick(st => renderMotionLive(st));
    motionTickBound = true;
  }

  // 叠加层画布的像素尺寸要跟视频流一致，CSS 上的 object-fit: cover 才会把
  // 视频和骨架按同样的方式裁切。否则视频是 16:9、画布是 4:3 时，
  // 骨架会整体偏移到画面外——这是"看不到识别效果"的常见原因。
  motionSyncOverlaySize(video);

  const ph = document.getElementById("motionPlaceholder");
  if (ph) ph.classList.add("hidden");
  const un = document.getElementById("motionUnsupported");
  if (un) un.classList.add("hidden");
  const screen = document.getElementById("motionScreen");
  if (screen) screen.classList.add("is-live");

  // 一开摄像头就进入预览分析：立刻把感应到的人形骨架画出来，
  // 让孩子先确认"系统看到我了"，再点「开始这一组」正式计时。
  if (motionChoice && motionChoice.profile) motionEngine.setProfile(motionChoice.profile);
  motionEngine.preview();
  // 真实骨架推理循环单独跑（引擎的 rAF 与它无关，两者各跑各的）。
  // 模型在进入本页时已预热过，这里 start 之后第一帧就只剩 ~0.3 秒。
  motionVisionStart();

  renderMotionButtons();
  // 先进开场校准：站好位、骨架锁定之后才让孩子开跑
  motionCalibOpen();
  // 有深度就先把房间量一遍（人要先退出去），量完再让孩子进场。
  // 没有深度时这一步自动跳过，行为与以前完全一致。
  motionRoomScanMaybeStart();
  toast("摄像头已开启。画面只在本机分析，不会上传。");
}

/* 播视频但不能无限等：摄像头刚开时流还没出帧，video.play() 的 Promise
 * 会一直不 settle（实测外接 USB 摄像头冷启动就有这个情况）。
 * 让它最多等 1.5 秒——等不到也放行，后面 loadedmetadata 会再同步一次画布尺寸，
 * 骨架照样能画出来。不加这个保护的话，摄像头会永远停在"正在打开"。 */
function motionPlayVideo(video) {
  if (!video) return Promise.resolve();
  let p = null;
  try { p = video.play(); } catch (error) { return Promise.resolve(); }
  if (!p || typeof p.catch !== "function") return Promise.resolve();
  return Promise.race([
    p.catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
}

// 让叠加层画布与视频流同尺寸（含 videoWidth 还没就绪时稍后重试一次）
function motionSyncOverlaySize(video) {
  const overlay = document.getElementById("motionOverlay");
  if (!overlay || !video) return;
  const apply = () => {
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h && (overlay.width !== w || overlay.height !== h)) {
      overlay.width = w;
      overlay.height = h;
    }
    motionUpdateStage();
  };
  apply();
  if (!video.videoWidth) {
    video.addEventListener("loadedmetadata", apply, { once: true });
    setTimeout(apply, 400);
  }
}

/* 算出"摄像头真正能看到的那块画面"在容器里的位置和大小，写进 CSS 变量。
 *
 * 为什么必须这么做：视频和画布都用 object-fit: contain，画面周围会有黑边
 * （全屏校准时尤其明显：屏幕 16:9、画面 4:3，左右各一条黑边）。
 * 白框、提示这些"贴在人身上"的 HUD 如果按容器定位，就会跑到画面外面去，
 * 孩子照着框站、结果站在了摄像头根本拍不到的地方——"怎么退都看不到全身"
 * 有一半是这么来的。 */
function motionUpdateStage() {
  const screen = document.getElementById("motionScreen");
  // 单测会在 Node 的 vm 里用最小 DOM 桩跑 app.js，这里必须容错
  if (!screen || typeof screen.getBoundingClientRect !== "function") return;
  const rect = screen.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return;
  const video = document.getElementById("motionVideo");
  const overlay = document.getElementById("motionOverlay");
  const vw = (video && video.videoWidth) || (overlay && overlay.width) || 640;
  const vh = (video && video.videoHeight) || (overlay && overlay.height) || 480;
  const fit = Math.min(rect.width / vw, rect.height / vh);
  const cw = Math.max(1, vw * fit), ch = Math.max(1, vh * fit);
  if (!screen.style || typeof screen.style.setProperty !== "function") return;
  screen.style.setProperty("--motion-cw", cw.toFixed(1) + "px");
  screen.style.setProperty("--motion-ch", ch.toFixed(1) + "px");
  screen.style.setProperty("--motion-cx", ((rect.width - cw) / 2).toFixed(1) + "px");
  screen.style.setProperty("--motion-cy", ((rect.height - ch) / 2).toFixed(1) + "px");
  screen.style.setProperty("--motion-aspect", String(Math.round(vw / vh * 1000) / 1000));
}

let motionStageObserver = null;
function motionInitStage() {
  motionUpdateStage();
  if (typeof window.addEventListener === "function") window.addEventListener("resize", motionUpdateStage);
  const screen = document.getElementById("motionScreen");
  if (screen && typeof ResizeObserver !== "undefined") {
    // 进/出全屏校准会改变 #motionScreen 的尺寸，靠它自动跟上
    motionStageObserver = new ResizeObserver(motionUpdateStage);
    motionStageObserver.observe(screen);
  }
  const video = document.getElementById("motionVideo");
  if (video && typeof video.addEventListener === "function") {
    video.addEventListener("loadedmetadata", motionUpdateStage);
  }
}

/* ---------- 真实骨架感知源（MediaPipe Pose，经 pose-vision.js 翻译）----------
 *
 * 这一段是**唯一**新增的接线：把 pose-vision 的感知器造出来、交给引擎，
 * 引擎会优先用真实骨架、失败自动退回原来的掩码链路。
 *
 * 为什么敢在 file:// 下用：本项目的 start-app.bat 带
 * `--allow-file-access-from-files`，实测该 flag 下 file:// 页面能 fetch
 * 本地 .wasm/.tflite，MediaPipe 完整可用（33 关键点）。不带这个 flag 时
 * 才会被 origin 'null' 拦掉 —— 那种情况下这里的 Promise 会 reject，
 * 感知器不启动，引擎照旧走掩码链路，功能不退化、只是精度低一些。
 *
 * 定位目录固定指向本地 vendor/mediapipe/，不走任何 CDN（离线可用）。 */
let motionVision = null;
let motionVisionReady = false;
let motionVisionFailed = false;
let motionVisionComplexity = null;   // 本次实例用的档位（null=还没定）

/* ---- 姿态模型档位：lite(0) / full(1) ----
 *
 * 背景：vendor 里同时放着 lite(2.8MB) 与 full(6.4MB) 两个模型，
 * 但本模块早期只用 lite。2026-10-05 专门测了"改成 full 值不值"，
 * 结论是 **没有一致优势 → 默认仍用 lite，保持既有行为不变**。
 *
 * 实测（本机 16 核 Chrome；每档开**独立浏览器冷启动**，
 * 规避"两个 Pose 实例共享 wasm runtime"造成的顺序效应）：
 *
 *   输入                     指标           lite        full
 *   静态真实人体 640x480      可见关键点      33          29     ← lite 优
 *                           引擎可用关节     26          23     ← lite 优
 *   高抬腿视频 1280x704       左脚踝可见度    0.87~0.91   0.97   ← full 优
 *                           关节数           26          26     持平
 *   14 帧序列帧间位移         抖动均值        0.0634      0.0659 持平
 *
 * ⚠️ 关键教训：**别拿"可见关键点数量"当精度指标**。
 *    MediaPipe 的 visibility 是模型**置信度**，不是坐标准确度。
 *    full 更"保守"（给低置信度），lite 更"乐观"，两者比大小没有意义。
 *    一开始只看视频数据得出"full 明显更准"，再测静态图结论就反了 ——
 *    说明差异**随内容变化**，不存在一边倒的优势。
 *
 * 为什么还要留这个开关：
 *    自动化测试帮不上忙 —— 测试走 pushLandmarks（绕过 MediaPipe 直接喂关键点），
 *    两档在测试里表现完全一样。真正能判断的只有"真实相机 + 真实房间 + 真实孩子"。
 *    所以留一个可切、可回退、能持久化的入口，需要时在真机上 A/B。
 *
 * 切换：进入「体感跟练」页后，浏览器控制台执行
 *     motionVisionSetComplexity(1)     // 改用 full 档（精确模型）
 *     motionVisionSetComplexity(0)     // 改回 lite 档
 *     motionVisionDebug()              // 看当前档位与实时帧率
 * 选择记在 localStorage，下次打开沿用。 */
const MV_COMPLEXITY_KEY = "motionVisionComplexity";

function motionVisionStoredComplexity() {
  try {
    const v = localStorage.getItem(MV_COMPLEXITY_KEY);
    if (v === "0" || v === "1") return parseInt(v, 10);
  } catch (e) { /* localStorage 不可用时用默认值 */ }
  return 0;   // 默认 lite：既有行为，实测无劣势；full 留作可选项
}

function motionVisionLink(video) {
  if (motionVisionFailed) return null;                  // 已确认加载不了，别再试
  if (typeof window.PoseVision === "undefined") { motionVisionFailed = true; return null; }
  if (motionVision) { motionVision.setVideo(video); return motionVision; }
  const complexity = motionVisionStoredComplexity();
  const pv = window.PoseVision.createPoseVision({
    video: video,
    locateFile: file => `vendor/mediapipe/${file}`,
    modelComplexity: complexity,   // 0=lite / 1=full，见上文实测对比表
    rateLimit: 20,          // 每秒最多 20 次推理，够跟上手速，也不把 CPU 吃满
    holdMs: 700             // 漏检宽限：抬手挡脸/快转身时骨架不闪断
  });
  motionVisionComplexity = complexity;
  motionVision = pv;
  // 注意这里**不 start()**：start 要等 video 真的出帧了才有意义。
  // （用 try 包住是为了"感知器构造失败也不能拖垮体感功能"）
  return pv;
}

/* 切换姿态模型档位（需重建感知器 + 重新预热）。
 * 为什么必须重建：modelComplexity 是 setOptions 时一次性定下的，
 * 改它要重新实例化 Pose。重建后必须重新预热，否则下次开摄像头又卡 3.7 秒。 */
function motionVisionSetComplexity(c) {
  const v = (c === 0 || c === "0") ? 0 : 1;
  try { localStorage.setItem(MV_COMPLEXITY_KEY, String(v)); } catch (e) { /* 忽略 */ }
  if (motionVisionComplexity === v && motionVision) {
    return { ok: true, complexity: v, changed: false, note: "已是该档位" };
  }
  motionVisionStop();
  motionVision = null;
  motionVisionReady = false;
  motionVisionFailed = false;          // 允许重新尝试（换档可能换一条不同的加载路径）
  motionVisionComplexity = null;
  if (motionEngine) { try { motionEngine.attachVision(null); } catch (e) { /* 忽略 */ } }
  // 立刻用新档位重建 + 预热，孩子在页面上时就能把 3.7 秒付掉
  motionVisionWarmup();
  return { ok: true, complexity: v, changed: true, note: "已切换，正在预热新模型" };
}
window.motionVisionSetComplexity = motionVisionSetComplexity;

/* 预热真实骨架模型。**必须在孩子点「开启摄像头」之前调用。**
 *
 * 实测（本机 Chrome）：首次 pose.send() 要 3.2 秒 —— wasm 实例化 + 模型加载 +
 * 计算图初始化全在这一步，且**同步阻塞主线程**。这时引擎的 rAF 被饿死，
 * 预览态一个骨架都画不出来，孩子看到"点了摄像头却半天没反应"。
 * 稳态每帧只要 9~11ms，所以问题纯粹是这一次性开销的位置放错了。
 *
 * 预热（先用 1×1 画面发一帧）之后，真实首帧只要 ~0.33s（实测 3213ms → 334ms）。
 * 调用时机选在**刚进入体感跟练页**：此时孩子正在读站位说明，
 * 卡一下完全察觉不到；等他点开摄像头，模型已经就绪。 */
function motionVisionWarmup() {
  if (motionVisionFailed) return;
  if (motionVision) {
    motionVision.warmup().then(motionVisionMark).catch(() => {});
    return;
  }
  if (typeof window.PoseVision === "undefined") { motionVisionFailed = true; return; }
  const pv = motionVisionLink(null);   // 此时还没有 video，先只造实例
  if (!pv) return;
  pv.warmup().then(motionVisionMark).catch(() => {});
}

/* 预热结果的唯一裁决点。
 * 为什么要裁决：文件协议下若没有 --allow-file-access-from-files，
 * 浏览器对被拦的 .wasm/.tflite 请求**既不成功也不失败**，会一直挂着。
 * 早期实现只判"成功"，于是状态永远停在 ready=false / failed=false ——
 * 一个静默的半死状态：不提示、也不退回掩码链路（掩码其实完全可用）。
 * 现在由 pose-vision 的 warmup() 带 15 秒超时明确给出成败，这里据此收口。 */
function motionVisionMark(ok) {
  if (ok) {
    motionVisionReady = true;
    motionVisionFailed = false;
    // 预热时可能还没挂 video；start 由开摄像头处负责
    return;
  }
  motionVisionReady = false;
  motionVisionFailed = true;
  // 感知器不可用 → 从引擎摘掉，让引擎走纯掩码链路（不留一个永远 false 的轮询）
  if (motionEngine) { try { motionEngine.attachVision(null); } catch (error) { /* 忽略 */ } }
  motionVision = null;
  console.warn("真实骨架不可用，已退回轮廓识别。请用 start-app.bat 打开（需要 --allow-file-access-from-files）。");
}

// 摄像头重开时把新的 video 交给感知器（它在跑 rAF，不重挂会一直读旧元素）
function motionVisionAttach(video) {
  if (motionVision) motionVision.setVideo(video);
}

function motionVisionStart() {
  if (!motionVision) return;
  try { motionVision.start(); } catch (error) { /* 忽略 */ }
}

function motionVisionStop() {
  if (!motionVision) return;
  try { motionVision.stop(); } catch (error) { /* 忽略 */ }
}

// 排查用：控制台执行 window.motionVisionDebug() 看感知器与引擎各自的判定
window.motionVisionDebug = function () {
  const eng = motionEngine && motionEngine.visionStats ? motionEngine.visionStats() : null;
  const pv = motionVision && motionVision.stats ? motionVision.stats() : null;
  const sk = motionEngine ? motionEngine.getSkeleton() : null;
  return {
    ready: motionVisionReady, failed: motionVisionFailed,
    vision: pv, engine: eng,
    jointCount: sk ? sk.jointCount : 0,
    source: eng ? eng.source : "none",
    // 档位：0=lite（默认）1=full。改档用 motionVisionSetComplexity(0|1)
    complexity: motionVisionComplexity,
    complexityLabel: motionVisionComplexity === 1 ? "full(精确档)"
      : motionVisionComplexity === 0 ? "lite(轻量档)" : "未定",
    fps: pv ? pv.fps : 0
  };
};

function motionStopCamera() {
  // 关摄像头时校准与准备口令都要停：口令还在念、画面已经黑了是最糟的状态
  motionFlowTeardown();
  motionStopSet(true);
  // 结束一组后引擎会回到"预览态"继续跑，所以这里必须显式停掉分析循环，
  // 否则摄像头关了、rAF 还在空转采样一个已经死掉的 video。
  if (motionEngine) motionEngine.stop();
  motionVisionStop();             // 真实骨架感知器也在跑 rAF，一起停掉
  if (motionStream) {
    motionStream.getTracks().forEach(track => { try { track.stop(); } catch (error) { /* 忽略 */ } });
    motionStream = null;
  }
  const video = document.getElementById("motionVideo");
  if (video) video.srcObject = null;
  const overlay = document.getElementById("motionOverlay");
  if (overlay) {
    const octx = overlay.getContext("2d");
    if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
  }
  const screen = document.getElementById("motionScreen");
  if (screen) screen.classList.remove("is-live");
  const sourceStatus = document.getElementById("motionSourceStatus");
  if (sourceStatus) sourceStatus.textContent = "相机来源：尚未开启。深度与彩色画面未配准。";
  const ph = document.getElementById("motionPlaceholder");
  if (ph) ph.classList.remove("hidden");
  renderMotionButtons();
}

/* ---------- 开始 / 结束一组 ---------- */

/* 自动化测试要跳过「口令 + 人声数 3、2、1」：那是真实的人机节奏，
 * 整套走完要 8 秒左右（口令约 4.6s + 数 3、2、1 各 1s + "开始"后的余量），
 * 脚本干等会把整个回归拖垮。
 *
 * 这属于"新增的拦主流程的闸门"，按本项目既有约定必须同时开一个跳过入口：
 * 默认**开启**（孩子平时走的就是带口令的路），只有 URL 上明确写
 * ?motionPrep=0 才关掉。用 URL 参数而不是 localStorage，是为了让"跳过"
 * 只影响当前这一次测试会话，不会污染孩子平时用的存档。 */
function motionPrepDisabled() {
  try {
    const s = String((window.location && window.location.search) || "");
    return /[?&]motionPrep=0(?:&|$)/.test(s);
  } catch (e) { return false; }
}

/* 「准备开练」流程的把手。用一个对象而不是散落的变量，是为了让取消能
 * 一次性收干净 —— 这个流程随时可能被打断（切页、关摄像头、重选动作），
 * 留下没清掉的定时器就会在别的界面上突然冒出一声"3"，比不出声更难查。 */
let motionPrep = null;

function motionPrepEls() {
  return {
    box: document.getElementById("posePrep"),
    name: document.getElementById("posePrepName"),
    count: document.getElementById("posePrepCount"),
    sub: document.getElementById("posePrepSub")
  };
}

/* 正在念口令 / 数数。界面渲染与测试断言都读它。 */
function motionPrepActive() { return !!motionPrep; }

/* 把「准备开练」大字层收掉（界面部分）。
 * 全屏（is-calib）也在这里退出 —— 它本来是校准画面撑起来的，
 * 准备阶段沿用同一块全屏，开跑这一刻才还回去。 */
function motionPrepHide() {
  const els = motionPrepEls();
  if (els.box) { els.box.classList.add("hidden"); els.box.classList.remove("is-go"); }
  if (els.count) els.count.textContent = "";
  const screen = document.getElementById("motionScreen");
  if (screen) screen.classList.remove("is-calib");
}

/* 打断准备流程：停掉已排的定时器与正在播的人声，收起大字层。
 * 不在这里开跑 —— 被打断就是"不练了"，不能反而把运动启动起来。 */
function motionPrepAbort() {
  if (!motionPrep) return;
  const seq = motionPrep.seq;
  motionPrep = null;
  if (seq) seq.cancel();
  motionPrepHide();
}

/* 真正的开跑动作。手动点「开始这一组」与校准后自动开练**都收敛到这里**：
 * 两条路各写一份的话迟早会漂移（比如自动那条忘了 setGoal），最后只有一条是对的。 */
function motionStartSetNow() {
  if (!motionChoice || !motionChoice.profile || !motionEngine) return;
  const p = motionChoice.profile;
  motionEngine.setProfile(p);
  motionEngine.setGoal(motionGoalFor(motionChoice));
  motionResultRecord = null;
  // 新的一组开跑 → 清掉"本项已完成"锁，否则第二次开始永远不会再判达标
  motionSetDone = null;
  renderMotionResult(null);
  motionEngine.start();
  motionRunning = true;
  // 新的一组开跑：计次基线归零（否则第一帧会补一串滴声），无效标记清掉，
  // 并把"开跑时刻"记下来给宽限期用（见 MOTION_INVALID_GRACE_MS）。
  motionFeedbackReset();
  motionSetStartAt = monoNow();
  renderMotionButtons();
  fitBeep(1);
  toast(`开始！目标：${motionGoalFor(motionChoice).label}`);

  /* ★★ 2026-10-21：默认**不再**进入全屏 3D 人偶模式（老李：「先不要默认使用现在的
   * 那个 3D 模型人同步展示动作了，改为默认在实际镜头前感应人体，实时显示感应的
   * 人体关节点，就是一开始感应人体的那个画面效果」）。
   *
   * 原来这里无条件 MotionAvatar.show()，孩子一开练就被 3D 角色占满整个窗口，
   * 看不到自己真实的关节点效果。
   *
   * 现在默认走"真实摄像头画面 + 关节点 + 大字进度浮层"，3D 模型改为**可选**：
   * 只有 motionAvatarWanted() 为真（孩子在画面上手动开）才 show()。
   * 进度读数已由 #motionBig 大字浮层接管，站两三米外照样读得到。 */
  if (window.MotionAvatar && window.MotionAvatar.isVisible && motionAvatarWanted()) {
    window.MotionAvatar.show();
  }
}

/* 是否要用 3D 模型人跟练。默认 false（用真实关节点画面）。
 * 存在 localStorage，家长/孩子切换一次就记住。 */
function motionAvatarWanted() {
  try { return window.localStorage.getItem("motionAvatar3d") === "1"; } catch (e) { return false; }
}
function motionAvatarSetWanted(on) {
  try { window.localStorage.setItem("motionAvatar3d", on ? "1" : "0"); } catch (e) { /* 隐私模式下写不了，忽略 */ }
}
/* 把按钮文案与当前选择对齐（初始化 / 切换后各调一次） */
function motionAvatarSyncBtn() {
  const btn = document.getElementById("motionAvatarToggleBtn");
  if (!btn) return;
  const on = motionAvatarWanted();
  btn.textContent = `3D 模型人：${on ? "开" : "关"}`;
  btn.classList.toggle("is-on", on);
  btn.title = on
    ? "当前用 3D 模型人跟练。点一下回到真实关节点画面。"
    : "当前在摄像头画面上显示你真实的关节点。点这里可以换成 3D 模型人跟练。";
}

/* 开练前统一入口：先播「准备开始进行XX，请就位」+ 人声数 3、2、1，数到"开始"再开跑。
 *
 * 为什么必须有这一步：体感跟练时孩子站在离电脑两三米的地方（摄像头要拍全身）。
 * 原来校准通过只把按钮点亮、等人跑过来点 —— 他要么根本看不清按钮亮了没有，
 * 要么跑过来点完再跑回去，前几秒就白白耗在"还没到位"上了。
 * 现在锁定即自动播报，孩子原地就能听口令起跑。 */
function motionStartSet() {
  if (!motionEnabled()) { toast("体感功能当前不可用。"); return; }
  if (motionCalib.active) { toast("先做完骨骼识别校准，站好位再开始。"); return; }
  if (!motionStream) { toast("先点「开启摄像头」。"); return; }
  if (!motionChoice) { toast("先选一个动作。"); return; }
  const p = motionChoice.profile;
  if (!p) { toast("这个动作是慢速拉伸，摄像头测不出质量，换一个动作吧。"); return; }
  if (motionRunning) return;            // 已经在计时了，别重开
  if (motionPrep) return;               // 口令已经在念了，别重入叠一层数数

  const ex = FITNESS_EX[motionChoice.exId] || {};
  const name = ex.name || motionChoice.exId || "这个动作";

  /* 测试捷径：不念口令，直接开跑，并把大字层收掉，
   * 让「点开始就进入正式计时」这条既有断言继续成立。 */
  if (motionPrepDisabled()) { motionStartSetNow(); return; }

  const els = motionPrepEls();
  if (els.box) { els.box.classList.remove("hidden"); els.box.classList.remove("is-go"); }
  if (els.name) els.name.textContent = `准备开始进行${name}`;
  if (els.count) els.count.textContent = "";
  if (els.sub) els.sub.textContent = "听口令，站好位置";

  const CoachTimer = window.CoachTimer;
  const seq = (CoachTimer && CoachTimer.prepSequence)
    ? CoachTimer.prepSequence(motionChoice.exId, name, {
      onStep: function (step) {
        if (!motionPrep) return;        // 期间被取消了，别再往界面上写
        const e = motionPrepEls();
        if (step === "cue") {
          if (e.count) e.count.textContent = "";
          if (e.sub) e.sub.textContent = "听口令，站好位置";
          return;
        }
        if (step === "go") {
          if (e.count) e.count.textContent = "开始";
          if (e.sub) e.sub.textContent = "动起来！";
          if (e.box) e.box.classList.add("is-go");
          return;
        }
        if (e.count) e.count.textContent = String(step);
        if (e.sub) e.sub.textContent = step === 3 ? "准备…" : "马上";
      }
    })
    : null;

  /* 计时器模块没加载（例如被裁剪过的构建）：退化成"立刻开始"。
   * 不能因为少一句口令把整个跟练堵死 —— 功能可用优先于仪式感。 */
  if (!seq) { motionStartSetNow(); return; }

  const seqBox = { seq: seq };
  motionPrep = seqBox;
  renderMotionButtons();               // 口令期间「开始这一组」是灰的
  seq.promise.then(function () {
    if (motionPrep !== seqBox) return; // 期间被取消/替换过了
    motionPrep = null;
    motionPrepHide();
    renderMotionButtons();
    motionStartSetNow();
  });
}

/* 校准达标 → 自动开练。孩子不跑过来也能开始。
 * 拆成独立入口是为了让"等 1.4 秒听完识别成功"和"真正开练"分开，
 * 定时器里只调这一个函数，语义清楚、也不会被别处的改动绕过。 */
function motionCalibAutoStart() {
  if (!motionCalib.active) return;
  motionCalibClose(true, true);        // keepFull：倒计时要在大屏上看得见
  motionStartSet();
}

/* 离开体感流程（切页 / 关摄像头）时，把跟练相关的浮层**成套**收干净。
 * 必须成套：只收校准、不收准备层的话，那 8 秒口令会继续念，
 * 而孩子早就换到别的页面了。 */
function motionFlowTeardown() {
  motionPrepAbort();
  motionAutoNextAbort();
  motionCalibClose(false);
  // 反馈链路的状态也要一起收：否则切页后那个"无效计时"还会自己把提示点起来
  motionFeedbackReset();
}

/* ---------- 「达标即完成 + 自动下一项」 ---------- */

/* 自动推进的总开关。与 motionPrepDisabled 同一套约定：
 * 默认开启（孩子走的就是自动推进的路），只有 URL 明确写 ?motionAutoNext=0 才关。
 * 用 URL 参数而非 localStorage，避免"测试关一次"把孩子的存档改掉。 */
function motionAutoNextDisabled() {
  try {
    const s = String((window.location && window.location.search) || "");
    return /[?&]motionAutoNext=0(?:&|$)/.test(s);
  } catch (e) { return false; }
}

/* 取消自动推进（含休息倒计时）。
 * ⚠️ 这是本项目"迟到的定时器"硬规则的执行点：任何"延时后要改变主状态"的流程
 * 都必须能被取消，否则孩子切了页/关了摄像头，几秒后运动自己又开跑了。
 * 必须接在：motionFlowTeardown（覆盖切页/关摄像头/beforeunload/家长开关/换相机）、
 * motionResetSet（重来）、motionStopSet（停一组）、motionCalibOpen（重开校准）、
 * setMotionChoice（换动作）五处。 */
function motionAutoNextAbort() {
  if (motionAutoNext) {
    clearTimeout(motionAutoNext.timer);
    motionAutoNext.cancelled = true;
    motionAutoNext = null;
  }
  if (motionRestTimer) {
    clearInterval(motionRestTimer);
    motionRestTimer = 0;
  }
  if (motionRestLeft > 0) {
    motionRestLeft = 0;
    renderMotionProgress(null);
  }
}

/* 本项达标了：打分落库 → 播「项目完成」→ 休息 restTime 秒 → 自动进下一项。
 *
 * 与手动点「结束并评分」共用 motionFinishSet()（它负责打分、落库、勾选今日
 * 清单、刷新 8 处界面）。另写一套迟早漂移，最后只有一条是对的。 */
function motionAutoComplete(reason) {
  if (!motionRunning || motionSetDone) return;   // 防重入：每帧回调都会调到这里
  const c = motionChoice;
  if (!c) return;
  motionSetDone = { exId: c.exId, at: Date.now() };
  motionAutoNextDone = false;

  const ex = FITNESS_EX[c.exId] || {};
  const name = ex.name || c.exId || "这一项";

  /* 先把进度面板切到"完成"态，让"项目完成"这句话有画面支撑。
   * 必须在 motionFinishSet 之前调 —— 它会 MotionAvatar.hide() 把全屏层收掉。 */
  renderMotionProgress(motionEngine.getState());

  motionFinishSet();          // 打分 + 落库 + 勾选今日清单 + 出结算卡
  fitBeep(2);

  if (motionAutoNextDisabled()) { motionSayDone("item"); return; }

  // 整套走完了？今天计划里已经没有下一项
  const next = motionNextChoice();
  if (!next) {
    motionAutoNextDone = true;
    motionSayDone("all");
    toast(`${name} 完成，今天计划的体感项目全部练完了！`);
    return;
  }

  const rest = motionRestSeconds();
  motionSayDone("item");
  if (rest <= 0) { motionAutoAdvance(next); return; }
  motionStartRest(rest, next);
}

/* 「项目完成」语音。
 *
 * 为什么不用 CoachTimer 的 finish.mp3：那句是"完美结束"，用在**单项达标**上
 * 会让孩子以为今天就练完了。所以另生成了 done-item / done-rest / done-all 三句
 * （build/gen-fit-voice.py 的 DONE_LINES）。
 * 走 VoiceGuide 而不是自己 new Audio()：那里已有预加载、文件缺失退回系统 TTS、
 * 以及节流处理，重复造一遍只会多一处会坏的地方。 */
function motionSayDone(kind) {
  const VG = window.VoiceGuide;
  if (!VG) return;
  const key = kind === "all" ? "doneall" : kind === "rest" ? "donerest" : "doneitem";
  try {
    if (VG.isEnabled && !VG.isEnabled()) return;
    VG.force(key);          // force：无视节流，达标这句必须每次都响
  } catch (e) { /* 语音坏了不能拖垮完成流程 */ }
}

/* 项间休息秒数。复用家长在「家长管理 → 每日一练时间设置」里填的组间隔
 * （fitTiming().restTime，默认 10 秒）—— 用户明确要求这个值将来能在家长
 * 模块里改，所以**必须走这个既有入口**，不要在这里另写一个常量。
 * 教案里给这一项单独写了 rest 时，教案优先（与计时链路 fitBlockTiming 一致）。 */
function motionRestSeconds() {
  const tm = fitTiming();
  const c = motionChoice;
  if (!c || !c.blockId) return tm.restTime;
  const day = fitnessDayFor(new Date());
  const phase = fitnessPhaseOf(fitnessWeekNo());
  const blocks = (day && !day.rest) ? fitnessBlocks(day, phase) : null;
  if (blocks) {
    const all = [].concat(blocks.warmup || [], blocks.main || [], blocks.cooldown || []);
    const hit = all.find(b => b.id === c.blockId);
    if (hit && hit.rest > 0 && !tm.override) return hit.rest;
  }
  return tm.restTime;
}

/* 休息倒计时。进度条冻在 100%，数字换成剩余秒数。
 *
 * ⚠️ 这里曾经有一个死锁（真机实测复现，导致"达标后看不到休息、也不自动进下一项"）：
 *   tick() 的第一行是 `if (!motionAutoNext) return;`，本意是"被 abort 了就停"。
 *   但 `motionAutoNext` 这个变量身兼**两个身份**：
 *     ① 「进行中的自动推进把手」（motionAutoAdvance / motionAutoNextAbort 用它）；
 *     ② tick 又拿它当「有没有被取消」的**标志位**用。
 *   而进入休息时**从来没有人给 motionAutoNext 赋过值**（它唯一的赋值点是
 *   motionAutoAdvance，那恰恰是被这行挡住的下一步）→ 每 1 秒 tick 都早退：
 *   倒计时不刷新、数字冻在「休息 10 秒」，motionRestLeft 还会一路减成负数，
 *   motionAutoAdvance 永远不执行 → 不自动进下一项。
 *   修法：进休息就先**占住这个把手**（休息本身就是"排着的自动动作"，占用它是语义
 *   正确的），让守卫能通过；取消权仍交给既有的 motionAutoNextAbort()。
 *   abort 里 clearTimeout(motionAutoNext.timer) + clearInterval(motionRestTimer)
 *   **两个都清**，所以占位把手不会被漏掉；`timer: 0` 让 clearTimeout(0) 成为安全
 *   no-op（这里只借它的"非空即未取消"语义，没有任何延时任务挂在上面）。 */
function motionStartRest(seconds, next) {
  motionRestLeft = seconds;
  // 占住把手：休息期间 motionAutoNext 必须非空，否则下面的 tick 守卫会把
  // "正常休息"误当成"已被 abort"（timer:0 = 无延时任务，仅作未取消的标记）
  motionAutoNext = { timer: 0, cancelled: false };
  /* 休息倒计时要画在**孩子实际看得见的地方**。默认（不用 3D 模型人时）就是
   * 摄像头画面上的 #motionBig 大字浮层 —— renderMotionProgress(null) 会双写
   * 页内进度条 + 大字浮层，所以这里什么都不用额外做。
   * 只有用户主动开了 3D 模型人才需要重新 show()：motionFinishSet() 刚 hide()
   * 过它（那里要收掉全屏出结算卡），不补 show 的话休息期间就只剩页面小字了。 */
  if (window.MotionAvatar && motionAvatarWanted()) window.MotionAvatar.show();
  renderMotionProgress(null);
  const tick = () => {
    if (!motionAutoNext) return;         // 已被 abort
    if (motionRestLeft > 0) {
      renderMotionProgress(null);
      return;
    }
    clearInterval(motionRestTimer);
    motionRestTimer = 0;
    motionAutoAdvance(next);
  };
  if (motionRestTimer) clearInterval(motionRestTimer);
  renderMotionProgress(null);            // 先把休息态画出来，别等第一个 1 秒
  motionRestTimer = setInterval(() => { motionRestLeft -= 1; tick(); }, 1000);
}

/* 今天的动作序列里，当前项的下一项。走到末尾返回 null（今天练完了）。
 * 只认可测动作：motionChoices() 已经把测不了的动作过滤掉了。 */
function motionNextChoice() {
  const list = motionChoices();
  const c = motionChoice;
  if (!c || !list.length) return null;
  const i = list.findIndex(x => x.exId === c.exId && x.blockId === c.blockId);
  if (i < 0) return null;
  return list[i + 1] || null;
}

/* 真正切到下一项：换动作 → 走口令 → 开跑。
 * 走 motionStartSet() 而不是 motionStartSetNow()，是为了让它和"孩子自己点
 * 开始"完全同一条路（同样念口令、同样有准备层），不会漂移。
 * 共用 motionPrep 单例锁也靠它：口令期间再触发一次会被 `if (motionPrep) return` 挡住。 */
function motionAutoAdvance(next) {
  const box = { timer: 0, cancelled: false };
  motionAutoNext = box;
  // 用 0 延时而不是直接调：保证"这一步"和"下一帧"分开，
  // 也保证 abort（同帧内可能被切页调用）能先把它掐掉
  box.timer = setTimeout(() => {
    if (motionAutoNext !== box || box.cancelled) return;
    motionAutoNext = null;
    // 休息态收掉后再换项，否则进度面板会停在"休息"字样
    if (motionRestLeft > 0) motionRestLeft = 0;
    const idx = motionChoices().findIndex(x => x.exId === next.exId && x.blockId === next.blockId);
    if (idx < 0) return;
    motionSetDone = null;               // 新项，清掉"已完成"锁
    setMotionChoice(idx);               // 会 setProfile / 重渲染读数
    if (motionEngine && motionChoice) motionEngine.setProfile(motionChoice.profile);
    toast(`下一项：${(FITNESS_EX[next.exId] || {}).name || next.exId}`);
    /* 测试捷径：?motionPrep=0 时连口令一起跳过，直接开跑。
     * 否则每自动推进一项都要多等 ~8 秒（口令 4.6s + 数 3/2/1 各 1s），
     * 一条回归跑几项就会顶到 bash 的 2 分钟超时被 SIGTERM，变成假失败。
     * 与 motionStartSet 里那处捷径同一个约定，不要各写各的。 */
    if (motionPrepDisabled()) motionStartSetNow();
    else motionStartSet();              // 口令 + 数 3、2、1 → 自动开跑
  }, 0);
}

function motionFinishSet() {
  if (!motionRunning || !motionEngine) return;
  const st = motionEngine.getState();
  // 先取快照再回预览态：结束后骨架继续显示，孩子能接着试下一组
  if (motionStream) motionEngine.pause(); else motionEngine.stop();
  motionRunning = false;
  // 结束评分：停表提示与计次基线一并归零，别漏到下一组
  motionFeedbackReset();

  // 退出全屏 3D 人偶，回到正常界面
  if (window.MotionAvatar) window.MotionAvatar.hide();

  const p = motionChoice.profile;
  const goal = motionGoalFor(motionChoice);
  const result = MOTION_ENGINE.scoreSession(p, st, goal);
  const medal = motionMedalOf(result.total);
  const ex = FITNESS_EX[motionChoice.exId] || {};

  const record = {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    at: new Date().toISOString(),
    dateKey: todayKey(),
    exId: motionChoice.exId,
    exName: ex.name || motionChoice.exId,
    emoji: ex.emoji || "🏃",
    mode: p.mode,
    blockId: motionChoice.blockId || "",
    dayId: (fitnessDayFor(new Date()) || {}).id || "",
    elapsed: Math.round((st.elapsed || 0) * 10) / 10,
    reps: st.reps || 0,
    target: goal.reps || goal.seconds || goal.holdSeconds || 0,
    goalLabel: goal.label,
    tempo: Math.round(st.tempo || 0),
    rhythm: Math.round((st.rhythm || 0) * 100),
    symmetry: Math.round((st.symmetry || 0) * 100),
    amplitude: Math.round((st.amplitude || 0) * 100),
    stability: Math.round((st.stability || 0) * 100),
    activeRatio: Math.round((st.activeRatio || 0) * 100),
    intensity: Math.round((st.intensity || 0) * 100),
    holdSeconds: Math.round((st.holdSeconds || 0) * 10) / 10,
    total: result.total,
    parts: result.parts,
    hints: result.hints
  };

  const { autoChecked } = saveMotionRecord(record);

  motionResultRecord = record;
  renderMotionResult(record);
  renderMotionButtons();
  renderMotionRing();
  renderFitnessToday();
  renderFitnessReport();
  renderFitnessBoard();
  renderStatWidget();
  fitBeep(3);

  const coinText = medal === "none" ? "" : ` ${MEDAL_ICON[medal]}${MEDAL_LABEL[medal]}，+${motionCoinsForMedal(medal)} 🪙`;
  toast(`动作分 ${result.total}。${coinText}${autoChecked ? " 今天清单里的这个项目也标成已完成了。" : ""}`);
}

// 把一次体感结果落库，并在动作分达标时把今天计划里对应的动作块标成"已完成"
function saveMotionRecord(record) {
  state.fitness.motion.scores.push(record);
  let autoChecked = false;
  if (record.blockId && record.total >= state.fitness.motion.rewards.thresholds.bronze && !isFitBlockDone(record.blockId)) {
    setFitBlockDone(record.blockId, true);
    autoChecked = true;
  }
  saveState();
  return { autoChecked };
}

function motionResetSet() {
  // 口令还在念就点了「重来」→ 把它掐掉，否则几秒后那声"开始"会自己开跑
  motionPrepAbort();
  // 同理：自动下一项 / 休息倒计时还在排着，也要掐掉
  motionAutoNextAbort();
  motionSetDone = null;
  motionAutoNextDone = false;
  motionStopSet(true);
  motionResultRecord = null;
  renderMotionResult(null);
  renderMotionButtons();
  renderMotionRing();
  // 回到预览态：骨架继续显示，孩子能马上再试一组
  if (motionEngine && motionStream) motionEngine.pause();
  toast("已重置，可以重新开始一组。");
}

function motionStopSet(silent) {
  /* 「停一组」是语义中心，被重来/换动作/关摄像头等多处调用 ——
   * 自动下一项与休息倒计时必须在这里也掐掉，否则"停止"之后几秒
   * 运动又自己开跑了（本项目"迟到的定时器"的典型形态）。 */
  motionAutoNextAbort();
  // 停表 = 这一组结束：无效标记与计次基线一并清掉（重来/换动作都走这里）
  motionFeedbackReset();
  if (motionRunning && motionEngine) {
    // 结束这一组后不彻底停分析——回到预览态，骨架继续跟着人动
    if (motionStream) motionEngine.pause();
    else motionEngine.stop();
    motionRunning = false;
    if (!silent) renderMotionButtons();
  }
}

// 只读调试钩子：把引擎当前状态暴露出来，方便自动化测试断言
// "有没有真的在预览、有没有认出人体"。单机版、本机分析，无隐私顾虑。
window.__motionDebug = function () {
  if (!motionEngine) return null;
  const st = motionEngine.getState();
  return {
    running: st.running,
    previewing: st.previewing,
    mode: st.mode,
    hint: st.hint,
    hasMotion: st.hasMotion,
    calibrating: motionCalib.active,   // 站位校准还开着 → 「开始这一组」是灰的
    skeleton: st.skeleton,
    /* 准备流程（口令 + 数 3、2、1）是不是在跑。
     * 不打出来，"锁定之后到底有没有自动开练"就只能靠眼睛看，
     * 而自动开练恰恰是本轮改动的核心 —— 会变成无法验证的暗区。 */
    prepping: !!motionPrep,
    /* 达标即完成 / 自动下一项 的状态。
     * 不打出来的话，"到底有没有自动完成、有没有自动进下一项、休息还剩几秒"
     * 就只能靠眼睛看，会变成无法验证的暗区 —— 与 prepping 同一个理由。 */
    setDone: motionSetDone ? motionSetDone.exId : null,
    restLeft: motionRestLeft,
    autoNextPending: !!motionAutoNext,
    autoNextDone: motionAutoNextDone,
    progress: (() => {
      try {
        const info = motionProgressOf(motionEngine ? motionEngine.getState() : null);
        if (!info) return null;
        const pos = motionSequencePos();
        return { name: info.name, current: Math.round((info.current || 0) * 10) / 10,
          target: info.target, unit: info.unit, percent: Math.round(info.percent || 0),
          done: !!info.done, resting: !!info.resting, restLeft: info.restLeft || 0,
          seqIndex: pos.index, seqTotal: pos.total };
      } catch (e) { return null; }
    })(),
    prepText: (() => {
      const el = document.getElementById("posePrepCount");
      return el ? el.textContent : "";
    })(),
    prepShown: !!(function () {
      const el = document.getElementById("posePrep");
      return el && !el.classList.contains("hidden");
    })(),
    prepDisabled: motionPrepDisabled(),
    /* 计次幅度闸门的实况（原始信号单位，未归一化）。
     *
     * 为什么必须打出来 —— 这是"真机到底有没有在正确计数"的唯一观察窗口：
     *   门限 = expectedAmplitude × 0.5 × bodyScale，而 expectedAmplitude 是为
     *   **掩码链路**标的（开合跳 0.18）。孩子实际走的是 **MediaPipe 姿态主链路**，
     *   它的 width / centroidY 来自关键点 bbox，绝对量级与掩码链路并不相同。
     *   一旦姿态链路的信号比掩码链路小，门限就会偏严 —— 表现是"孩子真的在跳，
     *   但次数不动"。没有这两个数，遇到这种情况只能盲猜是门限太高还是信号没出来。
     *   repSpread < repGate 就是被闸门挡下的直接证据。 */
    repGate: st.repGate,
    repSpread: st.repSpread,
    /* 这一帧的人的轮廓是"真实骨架（pose）"还是"彩色轮廓估计（mask）"。
     * 量级校准要按链路分别看 —— 两条链路的 width/height 量纲不同。 */
    visionSource: (st.live && st.live.visionSource) || ""
  };
};

/* ---------- 体感界面渲染 ---------- */

function renderMotionGuide() {
  const set = (id, list) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = (list || []).map(t => `<li>${escapeHtml(t)}</li>`).join("");
  };
  set("motionCanDo", FITNESS_MOTION_GUIDE.canDo);
  set("motionCannotDo", FITNESS_MOTION_GUIDE.cannotDo);
  set("motionSetup", FITNESS_MOTION_GUIDE.setup);
}

// 实时面板显示哪几项，取决于动作类型：
//   计次类 → 次数；高频类 → 强度（数不准次数，改测运动强度）；保持类 → 保持秒数
const MOTION_READOUTS = {
  rep: [["reps", "次数", "0"], ["tempo", "节奏", "—"], ["amp", "幅度", "—"], ["sym", "对称", "—"], ["cont", "连续", "—"]],
  burst: [["intensity", "强度", "—"], ["tempo", "节奏", "—"], ["amp", "幅度", "—"], ["sym", "对称", "—"], ["cont", "连续", "—"]],
  hold: [["hold", "保持", "0.0 秒"], ["stab", "稳定", "—"], ["cont", "连续", "—"]]
};

function renderMotionReadouts() {
  const box = document.getElementById("motionReadouts");
  if (!box) return;
  const p = motionChoice && motionChoice.profile;
  const mode = p && MOTION_READOUTS[p.mode] ? p.mode : "rep";
  const tiles = MOTION_READOUTS[mode];
  box.innerHTML = tiles.map(([key, label, value]) =>
    `<div class="motion-readout"><span>${label}</span><strong id="mr-${key}">${value}</strong></div>`
  ).join("");
  motionEls = {};
  tiles.forEach(([key]) => { motionEls[key] = document.getElementById(`mr-${key}`); });
}

function renderMotionPicker() {
  const select = document.getElementById("motionExSelect");
  if (!select) return;
  const choices = motionChoices();
  if (!choices.length) {
    select.innerHTML = `<option value="">今天没有可体感跟练的动作</option>`;
    motionChoice = null;
    return;
  }
  const groupLabel = { warmup: "热身", main: "主训练", cooldown: "放松", free: "自由加练" };
  let html = "";
  let lastGroup = "";
  choices.forEach((choice, index) => {
    if (choice.group !== lastGroup) {
      if (lastGroup) html += "</optgroup>";
      html += `<optgroup label="${groupLabel[choice.group] || "动作"}">`;
      lastGroup = choice.group;
    }
    const goal = motionGoalFor(choice);
    html += `<option value="${index}">${choice.profile.emoji} ${escapeHtml(choice.profile.name)} · ${escapeHtml(goal.label)}</option>`;
  });
  if (lastGroup) html += "</optgroup>";
  select.innerHTML = html;

  const keep = choices.findIndex(c => motionChoice && c.exId === motionChoice.exId && c.blockId === motionChoice.blockId);
  select.value = String(keep >= 0 ? keep : 0);
  motionChoice = choices[Number(select.value)] || choices[0];
}

function setMotionChoice(index) {
  const choices = motionChoices();
  motionChoice = choices[index] || choices[0] || null;
  /* 预览态（没在计时）换动作不会走到 motionStopSet，所以这里要显式取消
   * 自动下一项：孩子自己挑了个别的动作，就说明他不想按计划往下走了。 */
  motionAutoNextAbort();
  motionSetDone = null;
  // 换动作 = 换了判据：计次基线必须归零，否则新动作第一帧会按旧基线补一串滴声
  motionFeedbackReset();
  if (motionRunning) motionStopSet(true);
  // 立刻把动作参数交给引擎：预览态的背景学习率、提示语都跟动作类型有关
  if (motionEngine && motionChoice) motionEngine.setProfile(motionChoice.profile);
  motionResultRecord = null;
  renderMotionReadouts();
  renderMotionGoalHint();
  renderMotionResult(null);
  renderMotionButtons();
  renderMotionRing();
}

function renderMotionGoalHint() {
  const el = document.getElementById("motionGoalHint");
  if (!el) return;
  if (!motionChoice) { el.textContent = ""; return; }
  const goal = motionGoalFor(motionChoice);
  const p = motionChoice.profile;
  el.textContent = `${motionModeText(p.mode)} · 本组目标：${goal.label}`;
}

/* ---------- 达标进度（次数 / 秒数） ----------
 *
 * 把"这个动作算次数还是算时间"统一折算成 {current, target, unit, percent}，
 * **页面内进度条与全屏 3D 层上的大数字都读这一份**，避免两处各算一套
 * 然后漂移（本项目已有教训：界面文案与实际计时必须走同一入口）。
 *
 * 三种 mode 的目标字段是**互斥**的（见 motionGoalFor 的三条 return），
 * 所以这里必须先判 mode 再取字段，不能像 motionFinishSet 里那样用
 * `reps || seconds || holdSeconds` 兜底 —— 那样读起来不知道在取什么。 */
function motionProgressOf(st, choice) {
  const c = choice || motionChoice;
  if (!c || !c.profile) return null;
  const p = c.profile;
  const goal = motionGoalFor(c);
  const ex = FITNESS_EX[c.exId] || {};
  const done = motionSetDone && motionSetDone.exId === c.exId;

  /* 休息中：进度条冻在 100%，数字换成倒计时。
   * 不能把 current 显示成 0，否则孩子会以为刚才白练了。 */
  if (motionRestLeft > 0) {
    return { name: ex.name || c.exId, current: goal.reps || goal.seconds || goal.holdSeconds || 0,
      target: goal.reps || goal.seconds || goal.holdSeconds || 0, unit: ex.unit === "次" ? "次" : "秒",
      percent: 100, done: true, resting: true, restLeft: motionRestLeft };
  }
  if (done) {
    const tgt = goal.reps || goal.seconds || goal.holdSeconds || 0;
    return { name: ex.name || c.exId, current: tgt, target: tgt,
      unit: ex.unit === "次" ? "次" : "秒", percent: 100, done: true };
  }
  if (!st) return null;

  let current = 0; let target = 0; let unit = "次";
  if (p.mode === "hold") {
    /* 保持类一律读秒。秒数由引擎在"姿态判据通过"时才累积
     * （motion-engine.js 的 updateHold / holdPoseOk），所以这里读到的
     * holdSeconds 已经是"姿势正确的秒数"，不是墙上的钟。 */
    current = st.holdSeconds || 0;
    target = goal.holdSeconds || 0;
    unit = "秒";
  } else if (p.mode === "burst") {
    /* 用引擎单调累积的 activeSeconds，**不是** activeRatio*elapsed：
     * 后者在长时长下会虚高（详见 motion-engine.js activeSeconds 的注释）。 */
    current = (st.activeSeconds != null ? st.activeSeconds : 0);
    target = goal.seconds || 0;
    unit = "秒";
  } else {
    current = st.reps || 0;
    target = goal.reps || 0;
    unit = "次";
  }
  const percent = target > 0 ? Math.max(0, Math.min(100, (current / target) * 100)) : 0;
  return { name: ex.name || c.exId, current, target, unit, percent, done: false };
}

/* 把进度同时刷到「页面内」与「全屏 3D 层」两处。
 * 两处都要刷的原因：开练后全屏层盖住整个窗口（孩子只看得到它），
 * 而校准中/暂停/返回画面后又只能看到页面内那一条。 */
function renderMotionProgress(st) {
  const info = motionProgressOf(st);
  const seq = motionSequencePos();

  if (info) { info.seqIndex = seq.index; info.seqTotal = seq.total; }

  // 页面内
  const box = document.getElementById("motionGoalProgress");
  if (box) {
    if (!info) {
      box.classList.add("hidden");
    } else {
      box.classList.remove("hidden");
      box.classList.toggle("is-done", !!info.done);
      box.classList.toggle("is-resting", !!info.resting);
      const name = document.getElementById("motionGoalName");
      const num = document.getElementById("motionGoalNum");
      const fail = document.getElementById("motionGoalFill");
      const seqEl = document.getElementById("motionGoalSeq");
      if (name) name.textContent = info.name;
      if (num) {
        if (info.resting) num.textContent = `休息 ${Math.max(0, Math.round(info.restLeft))} 秒`;
        else if (info.done) num.textContent = "完成！";
        else num.textContent = info.target > 0 ? `${fmtMotionValue(info.current, info.unit)} / ${fmtMotionValue(info.target, info.unit)} ${info.unit}` : `${fmtMotionValue(info.current, info.unit)} ${info.unit}`;
      }
      if (fail) fail.style.width = Math.round(info.percent) + "%";
      if (seqEl) seqEl.textContent = (info.seqTotal > 1 && info.seqIndex > 0) ? `第 ${info.seqIndex} / ${info.seqTotal} 项` : "";
    }
    /* "动作无效（停表）"的可见反馈：正常/完成/休息时都不画灰色，只有真在无效态才画。
     * 每帧同步一次，保证状态一变界面立刻跟上（行内样式见 applyMotionPausedLook 注释）。 */
    applyMotionPausedLook(box, motionInvalidFlag && !!info && !info.done && !info.resting);
  }

  // 全屏 3D 层
  if (window.MotionAvatar && window.MotionAvatar.setProgress) {
    window.MotionAvatar.setProgress(info);
  }

  /* ★ 摄像头画面上的大字浮层（2026-10-21）。
   * 体感默认不再铺 3D 模型人，孩子两三米外唯一能读的就是这块 ——
   * 所以它必须与上面页内那份**同源同步**，不能另算一套（本项目已有教训：
   * 界面文案与实际计时必须走同一入口）。
   * 只在真的有目标时才显示；预览态 / 没选动作时保持 hidden。 */
  const big = document.getElementById("motionBig");
  if (big) {
    if (!info) {
      big.classList.add("hidden");
    } else {
      big.classList.remove("hidden");
      big.classList.toggle("is-done", !!info.done && !info.resting);
      big.classList.toggle("is-resting", !!info.resting);
      const bNum = document.getElementById("motionBigNum");
      const bName = document.getElementById("motionBigName");
      const bFill = document.getElementById("motionBigFill");
      if (bNum) {
        if (info.resting) bNum.textContent = `休息 ${Math.max(0, Math.round(info.restLeft))}`;
        else if (info.done) bNum.textContent = "完成";
        else if (info.target > 0) {
          bNum.textContent = `${fmtMotionValue(info.current, info.unit)} / ${fmtMotionValue(info.target, info.unit)}`;
        } else {
          bNum.textContent = `${fmtMotionValue(info.current, info.unit)} ${info.unit}`;
        }
      }
      if (bName) bName.textContent = info.resting ? "歇一下，下一组马上来" : (info.name || "");
      if (bFill) bFill.style.width = Math.round(info.percent) + "%";
    }
  }
}

function fmtMotionValue(v, unit) {
  const n = Number(v) || 0;
  return unit === "次" ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);
}

/* 当前项在今天动作序列里的位置（第几项 / 共几项）。
 * 用 exId + blockId 双匹配：同一个动作在热身和主训里可能各出现一次，
 * 只按 exId 找会定位到错的那一项。 */
function motionSequencePos(choice) {
  const c = choice || motionChoice;
  const list = motionChoices();
  const total = list.length;
  if (!c || !total) return { index: 0, total };
  const i = list.findIndex(x => x.exId === c.exId && x.blockId === c.blockId);
  return { index: i >= 0 ? i + 1 : 0, total };
}

function renderMotionButtons() {
  const camBtn = document.getElementById("motionCameraBtn");
  const startBtn = document.getElementById("motionStartBtn");
  const finishBtn = document.getElementById("motionFinishBtn");
  // 开场骨骼校准没过之前，「开始这一组」必须是灰的：站位不对就开跑，
  // 骨架和计次全都会歪，分数没有意义。
  const ready = !!motionStream && !!motionChoice && !!motionChoice.profile
    && motionEnabled() && !motionCalib.active;
  if (camBtn) {
    camBtn.textContent = motionStream ? "关闭摄像头" : "开启摄像头";
    camBtn.classList.toggle("ghost", !!motionStream);
    camBtn.classList.toggle("primary", !motionStream);
  }
  if (startBtn) {
    // 口令期间也置灰：这时数数正在念，再点一下会叠出第二层口令
    startBtn.disabled = !ready || motionRunning || !!motionPrep;
    startBtn.textContent = motionRunning ? "进行中…"
      : motionPrep ? "准备中…" : "开始这一组";
  }
  if (finishBtn) finishBtn.disabled = !motionRunning;
}

/* ---------- 开场骨骼校准 ----------
 * 骨架"挂"得准不准，九成取决于站位：人只进半个身子、离得太近（Astra
 * 结构光最近有效距离约 0.7 米）、或者整个人只占画面一小条，轮廓都会糊成
 * 一坨，后面再怎么调算法都救不回来。
 * 所以开摄像头后先进这个界面：全屏实时画面 + 骨架，系统一边评分一边用
 * 语音告诉孩子该往哪边挪；站位达标并稳住 1.5 秒才算「锁定」，锁定后
 * 「开始跟练」才亮，才能进下一环节。
 */
const POSE_HOLD_MS = 1500;        // 达标后要稳住这么久
const POSE_PASS_SCORE = 82;       // 通过分数线
let motionCalib = { active: false, okSince: 0, hold: 0, guideKey: "", passed: false };
/* 空房扫描状态机：'off' 不扫 | 'scanning' 正在扫 | 'done' 已就绪 | 'skipped' 用户跳过。
 * 只在深度可用时才会进入 'scanning'（纯彩色/合成模式直接 'skipped'）。 */
let roomScan = { phase: "off", timer: 0, settled: 0, coverage: 0, startedAt: 0, depthDead: false };

/* 空房扫描的**超时闸**（必须有的兜底，2026-10-06 加）。
 *
 * 为什么必须有 —— 用户实测：「总是要先弹出"我先记一下房间的样子"，但都是等好久
 * 也不结束只能跳过」。复现确认根因：深度桥 **WebSocket 连上了、却没有一帧深度数据**
 * （实测 `motionDepth.stats()` 恒为 `{status:"open", frameIndex:0, valid:0}`）。
 * 而引擎 structureWarm() 每帧都要求"有效格 ≥ 5%"才计入样本，于是 stSamples 永远 0、
 * stReady 永远 false；app 侧的 tick 又只写 `if (!info.ready) return;`，
 * **没有任何超时** → 对话框永久卡住。
 *
 * 这是本项目反复出现的缺陷模式（见 MEMORY 踩坑 17）：
 * **"既不成功也不失败"的挂起比报错更危险**。凡"等外部异步结果"的流程，
 * 都必须配一个超时闸 + 唯一裁决点。这里就是那个闸门。
 *
 * 8 秒的取法：正常情况 12 帧 + 2.5 秒就完成（见 ST_WARM_FRAMES/ST_MIN_SCAN_MS），
 * 深度桥帧率 15fps，给到 8 秒已是 3 倍余量；再长就是在浪费孩子时间了。 */
/* 单调时钟。判断"过了多久"必须用它，不能用 Date.now()：
 *   · Date.now() 会被系统时间调整影响（改时区/对时会让"超时"提前或延后触发）
 *   · 测试脚本有时会冻结 Date.now() 以便固定"今天"，那会让一切计时失效
 * performance.now() 只单调递增，正是量时长该用的。 */
function monoNow() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

const ROOM_SCAN_TIMEOUT_MS = 8000;      // 有帧、但一直凑不满覆盖 → 最多等这么久
/* 「桥压根不出帧」的判定时限。取 3 秒的依据：深度桥 15fps，正常 3 秒该有 45 帧；
 * 而正常扫描 12 帧 + 2.5 秒就完成了。所以"3 秒还一帧都没有"是很硬的信号 ——
 * 比等满 8 秒体验好得多（用户原话是"等好久也不结束"）。 */
const ROOM_SCAN_NOFRAME_MS = 3000;

/* 扫描没扫成时统一从这里收尾（超时 → 跳过）。
 * **唯一裁决点**：别在 tick 与别处各写一套收尾，容易漂移出两个不同的状态。 */
function motionRoomScanGiveUp(reason, dead) {
  if (roomScan.phase !== "scanning") return;
  motionRoomScanSkip();
  /* 判定"深度桥不出数据"时，记下来：**本会话不再弹这个框**。
   * 否则孩子每次进体感都要被它拦一次、再等一次、再手动跳过一次 ——
   * 而"没有可用深度就跳过"本来就是这个功能的设计约定
   * （见 motionRoomScanMaybeStart 开头那段"没有深度摄像头 → 跳过"）。 */
  if (dead) roomScan.depthDead = true;
  toast(reason || "没读到深度数据，已跳过。不影响体感跟练。");
}
/* 达标后有个"等孩子听完识别成功"的延时才自动进入。这个定时器必须记下来：
 * 否则它会在界面被重新打开之后才触发，把新开的校准界面又关掉一次，
 * 表现就是"明明站好了却一直卡在校准界面进不去"。 */
let motionCalibTimer = 0;

const POSE_CHECK_ROWS = [
  ["whole", "全身都在画面里"],
  ["size", "站得远近合适"],
  ["center", "站在画面中间"],
  ["legs", "两条腿能分开"],
  ["arms", "双手张开"],
  ["distance", "离摄像头 2.0~3.5 米"]
];

// 引擎只给一个方向（back/closer/…），这里再细分出"头没了/脚没了"，
// 语音才有针对性 —— 孩子听到"看不到你的头"比"往后退一点"反应快得多。
function motionPoseVoice(pose) {
  if (!pose) return "";
  if (!pose.seen) return "nobody";
  /* 这里曾经会把 back 细分到 head / feet（"看不到你的头/脚，请往后退"）。
   * 现在 back 只可能是"离得太近"，而太近时人本来就占满画面、头脚都在画面外，
   * 结果就是每次都播成"看不到你的脚"——孩子根本不知道自己该干嘛。直接播"太近"。 */
  return pose.guide === "none" ? "" : pose.guide;
}

function motionCalibOpen() {
  clearTimeout(motionCalibTimer); motionCalibTimer = 0;
  /* 重开校准要作废上一次没走完的「准备开练」。
   * 否则会串成一场很难查的怪事：孩子站好一次、准备口令开始念，他在念完之前
   * 退出去又重进校准 —— 8 秒后那句"开始"照着原计划喊出来，运动在
   * 新一轮校准进行到一半时**自己启动了**，而屏幕上没有任何东西是他点的。 */
  motionPrepAbort();
  motionAutoNextAbort();
  motionCalib = { active: true, okSince: 0, hold: 0, guideKey: "", passed: false };
  const box = document.getElementById("poseCalib");
  const screen = document.getElementById("motionScreen");
  const target = document.getElementById("poseTarget");
  if (screen) screen.classList.add("is-calib");
  if (target) { target.classList.remove("hidden"); target.classList.remove("is-good"); }
  if (box) box.classList.remove("hidden");
  const go = document.getElementById("poseCalibGo");
  if (go) { go.disabled = true; go.textContent = "开始跟练"; }
  const bar = document.getElementById("poseHoldBar");
  if (bar) bar.style.width = "0%";
  motionCalibRenderChecks(null);
  motionCalibRenderScore(null);
  motionCalibRenderChips();
  renderMotionButtons();          // 校准期间「开始这一组」是灰的

  if (window.VoiceGuide) {
    window.VoiceGuide.resetOnce();
    window.VoiceGuide.warm();
    // 点「开启摄像头」本身就是一次用户手势，这里可以直接出声
    setTimeout(function () {
      if (motionCalib.active) window.VoiceGuide.force("welcome");
    }, 320);
  }
}

/* 收起校准界面。
 *
 * keepFull = true 时**不退出全屏**：紧接着要走「准备开始进行XX」+ 数 3、2、1，
 * 孩子还站在两三米外，这时把画面缩回页面里的小窗，他就看不见倒计时了。
 * 全屏留给紧随其后的准备层，等真正开跑（或流程被取消）时才还回去。 */
function motionCalibClose(passed, keepFull) {
  if (!motionCalib.active) return;
  motionCalib.active = false;
  const box = document.getElementById("poseCalib");
  const screen = document.getElementById("motionScreen");
  const target = document.getElementById("poseTarget");
  if (box) box.classList.add("hidden");
  if (screen && !keepFull) screen.classList.remove("is-calib");
  if (target) target.classList.add("hidden");
  if (window.VoiceGuide) window.VoiceGuide.stop();
  motionRoomScanStop();
  renderMotionButtons();
  if (passed && !keepFull) toast("骨骼识别已锁定，可以开始跟练了。");
}

/* ================= 空房扫描（房间结构基线） =================
 *
 * 为什么必须做这一步（真实房间实测）：
 *   引擎原来靠"深度分位数选带"找人。真实房间里墙把深度直方图切碎，
 *   人那一小撮常被整个跳过；更致命的是"带"有上下界 hi，落在带外的像素
 *   会被整块丢掉 —— 孩子张开双臂时，手指尖正好在 hi 外面被切掉，
 *   于是 T-pose 和"双臂下垂"量出来的宽度几乎一样（实测只有 1.24 倍），
 *   "双手张开"永远判不出来。
 *   改成"和空房不一样的地方就是人"之后，没有带、没有截断，
 *   同一份数据量出 2.65 倍（真人剪影真值 3.75 倍），空房间也正确地判"没人"。
 *
 * 对孩子的说法：先请他退到画面外，等进度条走满，再说"好了，请站过来"。
 * 这一步只做一次（每次开摄像头一次），大约 12 帧 / 不到 2 秒。
 */
function motionRoomScanEls() {
  return {
    box: document.getElementById("roomScan"),
    bar: document.getElementById("roomScanBar"),
    count: document.getElementById("roomScanCount"),
    tip: document.getElementById("roomScanTip"),
    title: document.getElementById("roomScanTitle"),
    step: document.getElementById("poseCalibStep"),
    title2: document.getElementById("poseCalibTitle")
  };
}

function motionRoomScanMaybeStart() {
  const els = motionRoomScanEls();
  // 没有深度摄像头 → 跳过，行为与以前完全一致
  const hasDepth = !!(motionDepth && motionDepth.stats && motionDepth.stats().status === "open");
  /* 本会话已经判定过"桥连着但不出数据" → 直接跳过，别再拦孩子一次。
   * （判定的地方在 motionRoomScanTick 的超时闸，见 ROOM_SCAN_NOFRAME_MS） */
  if (roomScan.depthDead) {
    roomScan.phase = "skipped";
    if (els.box) els.box.classList.add("hidden");
    return false;
  }
  if (!hasDepth || !motionEngine || !motionEngine.beginRoomScan) {
    roomScan.phase = "skipped";
    if (els.box) els.box.classList.add("hidden");
    return false;
  }
  // 已经就绪过（同一场会话里重新进校准）→ 不用重扫
  const info = motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null;
  if (info && info.ready) {
    roomScan.phase = "done";
    roomScan.coverage = info.coverage || 0;
    if (els.box) els.box.classList.add("hidden");
    return false;
  }
  roomScan.phase = "scanning";
  roomScan.settled = 0;
  roomScan.coverage = 0;
  roomScan.startedAt = monoNow();    // 超时闸的起算点（见 ROOM_SCAN_TIMEOUT_MS）
  const started = motionEngine.beginRoomScan();
  /* ★ 超时闸必须挂在**独立定时器**上，不能挂在每帧 tick 里。
   * 踩过的坑：第一版写在 `motionRoomScanTick()` 里，而它的唯一调用者是
   *   `motionCalibTick()`，后者**首行就是 `if (!motionCalib.active) return;`**
   * —— 空房扫描期间校准可能压根不是 active，于是 tick 几乎不跑，
   * 超时闸永远不触发，对话框照样永久卡住（实测 15 秒仍在 scanning）。
   * 定时器不依赖任何渲染循环，最可靠。`roomScan.timer` 这个字段本来就有
   * （`motionRoomScanStop` 一直在 clearTimeout 它），只是从没人设过 —— 现在补上。
   * 递归 500ms 轮询：3 秒先判"桥不出数据"，8 秒兜底判"有帧但扫不满"。 */
  if (roomScan.timer) { clearTimeout(roomScan.timer); roomScan.timer = 0; }
  const deadline = monoNow() + ROOM_SCAN_TIMEOUT_MS;
  const watch = function () {
    roomScan.timer = 0;
    if (roomScan.phase !== "scanning") return;          // 已收工（扫好/用户跳过）
    const info = motionEngine && motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null;
    if (info && info.ready) return;                     // 扫好了，收尾交给 tick
    const dst = motionDepth && motionDepth.stats ? motionDepth.stats() : null;
    const noFrames = !!(dst && dst.status === "open" && !(dst.frameIndex > 0));
    const waited = monoNow() - roomScan.startedAt;
    if (noFrames && waited >= ROOM_SCAN_NOFRAME_MS) {
      motionRoomScanGiveUp("深度摄像头没有数据（连接正常但收不到画面），已跳过这一步。体感跟练照常可用。", true);
      return;
    }
    if (monoNow() >= deadline) {
      motionRoomScanGiveUp("这一步等太久了，已跳过。体感跟练照常可用。", false);
      return;
    }
    roomScan.timer = setTimeout(watch, 500);
  };
  roomScan.timer = setTimeout(watch, ROOM_SCAN_NOFRAME_MS);
  if (els.box) els.box.classList.remove("hidden");
  if (els.bar) els.bar.style.width = "0%";
  if (els.count) els.count.textContent = "正在记录… 0 / 12";
  if (els.title) els.title.textContent = "我先记一下房间的样子";
  if (els.tip) {
    els.tip.innerHTML = "请你先退到画面外面，或者站到摄像头拍不到的地方。<br>这几秒钟不要出现在画面里。";
  }
  if (els.step) els.step.textContent = "第 0 步 · 先认一认房间";
  if (els.title2) els.title2.textContent = "请先离开画面";
  // 校准的评分/清单这时候没有意义，先盖住
  const panel = document.querySelector(".pose-calib-panel");
  if (panel) panel.classList.add("is-dimmed");
  if (window.VoiceGuide) {
    window.VoiceGuide.resetOnce();
    window.VoiceGuide.warm();
    setTimeout(function () {
      if (roomScan.phase === "scanning") window.VoiceGuide.force("roomscan");
    }, 300);
  }
  return started;
}

function motionRoomScanStop() {
  clearTimeout(roomScan.timer);
  roomScan.timer = 0;
  if (roomScan.phase === "scanning" && motionEngine && motionEngine.roomScanCancel) {
    motionEngine.roomScanCancel();
  }
  if (roomScan.phase === "scanning") roomScan.phase = "off";
}

function motionRoomScanSkip() {
  const els = motionRoomScanEls();
  motionRoomScanStop();
  if (motionEngine && motionEngine.roomScanReset) motionEngine.roomScanReset();
  roomScan.phase = "skipped";
  if (els.box) els.box.classList.add("hidden");
  const panel = document.querySelector(".pose-calib-panel");
  if (panel) panel.classList.remove("is-dimmed");
  if (els.step) els.step.textContent = "第 1 步 · 让我看清你";
  if (els.title2) els.title2.textContent = "站到摄像头前面";
  if (window.VoiceGuide) window.VoiceGuide.force("welcome");
}

// 每帧调用：推进空房扫描进度条，扫满就切到"请进场"
function motionRoomScanTick() {
  if (roomScan.phase !== "scanning") return;
  const els = motionRoomScanEls();
  const info = motionEngine && motionEngine.roomScanInfo ? motionEngine.roomScanInfo() : null;
  if (!info) return;
  /* 进度必须**同时**看帧数和时长 —— 引擎要求两者都满足才冻结
   * （只数帧的话 60fps 下 12 帧仅 0.2 秒，孩子来不及走出画面，
   *   会把站在镜头前的人学成"墙"，之后人就整块消失）。 */
  const pFrame = (info.samples || 0) / Math.max(1, info.need || 12);
  const pTime = (info.elapsedMs || 0) / Math.max(1, info.minMs || 2500);
  const pct = Math.min(100, Math.min(pFrame, pTime) * 100);
  if (els.bar) els.bar.style.width = pct + "%";
  if (els.count) {
    els.count.textContent = info.ready
      ? "记录完成"
      : "正在记录… " + Math.min(info.samples || 0, info.need || 12) + " / " + (info.need || 12)
        + "（约 " + Math.max(0, Math.ceil(((info.minMs || 2500) - (info.elapsedMs || 0)) / 1000)) + " 秒）";
  }
  if (!info.ready) return;

  // 扫满了：收起卡片，说"我记住房间了，请站过来"，然后交回校准流程
  roomScan.phase = "done";
  roomScan.coverage = info.coverage || 0;
  if (els.box) els.box.classList.add("hidden");
  const panel = document.querySelector(".pose-calib-panel");
  if (panel) panel.classList.remove("is-dimmed");
  if (els.step) els.step.textContent = "第 1 步 · 让我看清你";
  if (els.title2) els.title2.textContent = "站到摄像头前面";
  if (window.VoiceGuide) window.VoiceGuide.force("roomok");
  toast("已经记住房间的样子了（覆盖 " + Math.round(roomScan.coverage * 100) + "%）。");
}

function motionCalibRenderScore(pose) {
  const ring = document.getElementById("poseScoreRing");
  const num = document.getElementById("poseScoreNum");
  const label = document.getElementById("poseScoreLabel");
  const score = pose ? pose.score || 0 : 0;
  if (ring) {
    const deg = Math.round(Math.max(0, Math.min(100, score)) * 3.6);
    const color = score >= POSE_PASS_SCORE ? "#16a34a" : score >= 55 ? "#f59e0b" : "#dc2626";
    ring.style.background = `conic-gradient(${color} ${deg}deg, #e5e7eb ${deg}deg)`;
  }
  if (num) num.textContent = String(score);
  if (label) {
    label.textContent = !pose ? "正在打开摄像头…"
      : !pose.seen ? "还没看到你"
      : score >= POSE_PASS_SCORE ? "站得很好，正在锁定…"
      : score >= 55 ? "快好了，再调整一下"
      : "位置还差得远，跟着提示动一动";
  }
}

function motionCalibRenderChecks(pose) {
  const ul = document.getElementById("poseChecks");
  if (!ul) return;
  const checks = (pose && pose.checks) || {};
  ul.innerHTML = POSE_CHECK_ROWS.map(row => {
    const key = row[0];
    // 没接深度时"距离"这一项压根没被测，显示成灰色而不是打个叉
    if (key === "distance" && pose && !pose.distanceMeasured) {
      return `<li><i>·</i>${row[1]}（没接深度摄像头，跳过）</li>`;
    }
    const v = checks[key] || 0;
    const cls = v >= 0.95 ? "is-ok" : v >= 0.5 ? "is-bad" : "";
    const mark = v >= 0.95 ? "✓" : v >= 0.5 ? "!" : "·";
    return `<li class="${cls}"><i>${mark}</i>${row[1]}</li>`;
  }).join("");
}

function motionCalibRenderChips() {
  const depthEl = document.getElementById("poseCalibDepth");
  const camEl = document.getElementById("poseCalibCam");
  if (depthEl) {
    const s = motionDepth ? motionDepth.stats() : null;
    const on = !!(s && s.status === "open" && s.validRatio > 0.02);
    // 同上：深度是可选增强项，没接就说"未开启"（不是坏了），开启说明放 title
    depthEl.textContent = on ? `深度：已连接 ${s.fps || 0}fps` : "深度：未开启";
    depthEl.classList.toggle("is-on", on);
    depthEl.title = "深度测距是可选项，不开启也能正常跟练；要开启需先运行 tools/orbbec/start-depth-bridge.bat。";
  }
  if (camEl) {
    const track = motionStream && motionStream.getVideoTracks && motionStream.getVideoTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    camEl.textContent = track ? (track.label || "摄像头") : "摄像头：未开启";
  }
}

// 每帧（引擎 tick）调用：更新分数 / 清单 / 引导语 / 保持进度
function motionCalibTick(st) {
  if (!motionCalib.active) return;
  // 空房扫描期间：只推进进度条，不做站位评分（这帧本来就该是空房间）
  motionRoomScanTick();
  if (roomScan.phase === "scanning") { motionCalibRenderChips(); return; }
  // pose 挂在 live 上（getState 里 live 是整块透传的），不是 st.pose
  const pose = (st && st.live && st.live.pose) || (motionEngine ? motionEngine.getPose() : null);
  motionCalibRenderScore(pose);
  motionCalibRenderChecks(pose);

  const guideEl = document.getElementById("poseGuide");
  const target = document.getElementById("poseTarget");
  if (guideEl) {
    guideEl.textContent = pose ? (pose.guideText || "正在感应画面…") : "正在感应画面…";
    guideEl.classList.toggle("is-ok", !!(pose && pose.locked));
  }
  if (target) target.classList.toggle("is-good", !!(pose && pose.locked));

  // ---- 语音引导：换指令就说，同一句有节流 ----
  const key = motionPoseVoice(pose);
  if (key && key !== motionCalib.guideKey && window.VoiceGuide) {
    if (key === "hold") window.VoiceGuide.sayOnce("hold");
    else window.VoiceGuide.say(key);
  }
  motionCalib.guideKey = key;

  // ---- 保持进度：达标并稳住 POSE_HOLD_MS 才算锁定 ----
  const now = performance.now();
  if (pose && pose.locked) {
    if (!motionCalib.okSince) motionCalib.okSince = now;
    motionCalib.hold = now - motionCalib.okSince;
  } else {
    motionCalib.okSince = 0;
    motionCalib.hold = 0;
  }
  const bar = document.getElementById("poseHoldBar");
  if (bar) bar.style.width = `${Math.min(100, (motionCalib.hold / POSE_HOLD_MS) * 100)}%`;

  if (motionCalib.hold >= POSE_HOLD_MS && !motionCalib.passed) {
    motionCalib.passed = true;
    const go = document.getElementById("poseCalibGo");
    if (go) { go.disabled = false; go.textContent = "识别成功，开始跟练"; }
    if (window.VoiceGuide) window.VoiceGuide.sayOnce("good");
    /* 给孩子一点时间听到"识别成功"，再自动进入。
     * 注意这里调的是 motionCalibAutoStart（不是 motionCalibClose）：
     * 孩子站在两三米外，等他跑过来点按钮不现实 —— 锁定成功就直接接着
     * 念「准备开始进行XX」+ 数 3、2、1，原地起跑。
     * 屏幕上的按钮仍然保持可用，作为自动流程万一失败时的人工兜底。 */
    motionCalibTimer = setTimeout(function () {
      motionCalibTimer = 0;
      motionCalibAutoStart();
    }, 1400);
  }
  motionCalibRenderChips();
}

function renderMotionLive(st) {
  if (!st) return;
  const screen = document.getElementById("motionScreen");
  /* 叠加层恒用彩色坐标系（见 motion-engine.js 的 overlayUsesDepth），
     真实视频一直可见。这里不再切 is-depth-view —— 那个 class 原本会让
     视频 visibility:hidden，做成「全黑底 + 青色线条」，孩子看不懂。
     骨架精度改由 MediaPipe 主链路保证（彩色坐标系，天然与画面配准）。 */
  const tracked = !!(st.live && st.live.depthTracked);
  const sourceStatus = document.getElementById("motionSourceStatus");
  if (sourceStatus) {
    const link = motionDepth && motionDepth.stats();
    sourceStatus.textContent = tracked
      ? `当前来源：真实骨架（彩色坐标系）· 深度测距约 ${Math.round(st.live.depthNear / 100) / 10} 米 · 关节点直接画在你的真实画面上`
      : link && link.status === "open"
        ? "深度桥已连接，但这一帧没有可靠人体；画面用彩色轮廓估计。"
        : "当前来源：仅彩色轮廓估计。请检查深度桥是否启动，无法精确追踪胳膊或关节。";
  }
  if (motionCalib.active) motionCalibTick(st);
  const set = (key, value) => { const el = motionEls[key]; if (el) el.textContent = value; };

  set("reps", String(st.reps || 0));

  /* ---------- 体感语音/提示音反馈（远距离看不到屏幕，只能靠听）----------
   * 两条链路，按 st.mode 分流：
   *   计次类（rep）：每完成一次动作「滴」一声。
   *   计时类（hold / burst）：动作无效时停表并报「动作不正确」，恢复后继续。
   *   hold 的"有效"由引擎判定 —— 带 holdCheck 的动作要求姿态几何判据通过
   *   （平板支撑要趴平、靠墙静蹲要蹲平、单腿站立要真的抬起一只脚），
   *   判据不通过时 holdSeconds 不累积，进度条和这里的提示都会停。
   * 只在真的在跑、且不是预览态时才响（预览态是"还没开始，随便动动"）。 */
  const feedbackOn = motionRunning && !st.previewing && !!motionChoice;

  // ---- A. 计次类：每正确完成一次动作「滴」一声 ----
  if (feedbackOn && st.mode === "rep") {
    const reps = st.reps || 0;
    if (motionLastReps < 0) {
      motionLastReps = reps;                 // 首帧只建基线，不响（否则会补一串）
    } else if (reps > motionLastReps) {
      const delta = reps - motionLastReps;
      motionLastReps = reps;
      // 防异常：增量大得离谱（引擎被重置过）时只响一声，别连响一串
      const times = delta > 5 ? 1 : delta;
      // 家长把语音关了 → 提示音也一并静音，保持"静音就是全静音"一致
      const voiceOn = !window.VoiceGuide || window.VoiceGuide.isEnabled();
      if (voiceOn) for (let i = 0; i < times; i++) fitRepTick(i * 0.12);
    } else if (reps < motionLastReps) {
      motionLastReps = reps;                 // 引擎被重置（换组/重来）→ 重新对齐，不响
    }
  }

  // ---- B. 计时类：动作无效 → 停表提示 + 语音「动作不正确」 ----
  if (feedbackOn && (st.mode === "hold" || st.mode === "burst")) {
    const t = monoNow();
    const inGrace = (t - motionSetStartAt) < MOTION_INVALID_GRACE_MS;   // 刚开跑的起势期不判
    if (st.hasMotion) {
      /* 动作恢复正确：清掉无效计时与标记。引擎的 holdSeconds / activeSeconds
       * 本来就"随动停走"，恢复后进度会自己继续走 —— 这里只要恢复我们的标记与界面。 */
      motionInvalidSince = 0;
      motionInvalidFlag = false;
    } else if (!inGrace) {
      if (!motionInvalidSince) motionInvalidSince = t;
      // 连续无效够久（防抖）且还没报过 → 标记 + 播报（sayExclusive 保证不打断重播）
      if (!motionInvalidFlag && (t - motionInvalidSince) >= MOTION_INVALID_HOLD_MS) {
        motionInvalidFlag = true;
        motionSayWrong();
      }
    }
  }

  set("tempo", st.tempo > 0 ? `${Math.round(st.tempo)}/分` : "—");
  set("amp", `${Math.round((st.amplitude || 0) * 100)}%`);
  set("sym", `${Math.round((st.symmetry || 0) * 100)}%`);
  set("cont", `${Math.round((st.activeRatio || 0) * 100)}%`);
  set("hold", `${Math.round((st.holdSeconds || 0) * 10) / 10} 秒`);
  set("stab", `${Math.round((st.stability || 0) * 100)}%`);
  set("intensity", `${Math.round((st.intensity || 0) * 100)}%`);

  const hint = document.getElementById("motionHint");
  if (hint) {
    hint.textContent = st.hint;
    hint.className = `motion-hint ${st.hintLevel || "info"}`;
  }

  const badge = document.getElementById("motionBadge");
  if (badge) {
    if (st.calibrating) badge.textContent = "校准中";
    else if (st.hasMotion) badge.textContent = `检测到动作 · ${st.fps ? Math.round(st.fps) : 0} fps`;
    else badge.textContent = "等待动作";
    badge.className = `motion-badge ${st.hasMotion ? "is-active" : ""}`;
  }

  // 图例顺带告诉孩子"有没有认出你来"——这是"看不出识别效果"的直接解药
  const legend = document.getElementById("motionLegend");
  if (legend) {
    const found = !!(st.skeleton && st.skeleton.has);
    const span = typeof legend.querySelector === "function" ? legend.querySelector("span") : null;
    if (span) {
      span.textContent = st.calibrating ? "正在感应画面…"
        : found ? (st.live && st.live.depthTracked
            ? "关节点画在你的真实画面上"
            : "彩色画面轮廓估计 · 非真实人体关节")
          : "未获取到可靠的人形，请检查站位与深度连接";
    }
    legend.className = `motion-legend ${found || st.calibrating ? "" : "is-lost"}`;
  }

  // 3D 人偶：有骨架数据时实时驱动
  if (window.MotionAvatar && window.MotionAvatar.isVisible()) {
    const sk = st.skeleton;
    const source = tracked ? "Astra 深度轮廓" : "彩色轮廓估计";
    window.MotionAvatar.setStatus(sk && sk.has
      ? `${source} · ${sk.visibleJointCount || 0} 个估计关节（非精确姿态）`
      : `${source} · 未找到可靠人形，请查看原画面`);
    if (sk && sk.has && sk.joints) {
      window.MotionAvatar.updateFromSkeleton(sk.joints);
    } else {
      window.MotionAvatar.updateFromSkeleton({});
    }
  }

  // 环形进度跟着目标走：计次看次数，保持看秒数。
  // 预览态（没在计分）不动这个环——否则刚结算完的「今日最好」会被
  // 预览回调刷成「本组 0%」，孩子会以为成绩没了。
  const ring = document.getElementById("motionRing");
  let progressPercent = 0;
  if (ring && motionChoice && !st.previewing) {
    const goal = motionGoalFor(motionChoice);
    let percent = 0;
    let label = "本组";
    if (st.mode === "hold") {
      percent = goal.holdSeconds ? (st.holdSeconds / goal.holdSeconds) * 100 : 0;
      label = "保持";
    } else if (st.mode === "burst") {
      /* 用引擎单调累积的 activeSeconds（不是 activeRatio*elapsed，
       * 那个公式在长时长下会虚高，见 motion-engine.js 的注释）。 */
      const act = st.activeSeconds != null ? st.activeSeconds : 0;
      percent = goal.seconds ? (act / goal.seconds) * 100 : 0;
      label = "本组";
    } else if (goal.reps) {
      percent = (st.reps / goal.reps) * 100;
    }
    percent = Math.max(0, Math.min(100, Math.round(percent)));
    progressPercent = percent;
    ring.innerHTML = fitRingHtml(percent, motionMedalOf(percent), label);
  }

  /* 达标进度：页面内 + 全屏 3D 层两处一起刷。
   * 放在环形之后、达标判定之前，保证判定用的是刚刷出来的那份数据。 */
  if (motionChoice && !st.previewing) renderMotionProgress(st);

  /* 达标即完成。判定条件必须严格 —— 这是"自动结束"的闸门，
   * 一旦放宽（比如 >=90% 就算过）会把既有的半蹲热身用例（10 次目标、
   * 实测 9 次）在测试窗口内提前结束，连锁挂掉一批断言。
   * 所以只认 percent >= 100（计数类就是次数够了，秒类的秒数够了）。 */
  if (motionRunning && motionChoice && !st.previewing && !motionSetDone && progressPercent >= 100) {
    motionAutoComplete("reached");
  }
}

// 环形：不在跟练中时显示"今天最好的一次动作分"
function renderMotionRing() {
  const ring = document.getElementById("motionRing");
  if (!ring) return;
  const best = motionDayDetail(todayKey());
  ring.innerHTML = fitRingHtml(best.score, best.medal, "今日最好");
}

function renderMotionResult(record) {
  const box = document.getElementById("motionResult");
  if (!box) return;
  if (!record) {
    box.innerHTML = `<p class="hint">还没有成绩。做完一组并点「结束并评分」，这里会显示总分、分项和一句反馈。</p>`;
    return;
  }
  const medal = motionMedalOf(record.total);
  const parts = record.parts || {};
  const keys = Object.keys(parts);
  const bars = keys.map(key => `
    <div class="motion-part">
      <span>${escapeHtml(key)}</span>
      <span class="motion-part-bar"><i style="width:${Math.max(0, Math.min(100, parts[key]))}%"></i></span>
      <strong>${parts[key]}</strong>
    </div>`).join("");

  const stats = record.mode === "hold"
    ? [["保持", `${record.holdSeconds} 秒`], ["稳定", `${record.stability}%`], ["连续", `${record.activeRatio}%`]]
    : record.mode === "burst"
      ? [["强度", `${record.intensity}%`], ["连续", `${record.activeRatio}%`], ["幅度", `${record.amplitude}%`], ["对称", `${record.symmetry}%`]]
      : [["次数", `${record.reps} 次`], ["节奏", record.tempo ? `${record.tempo}/分` : "—"], ["幅度", `${record.amplitude}%`], ["对称", `${record.symmetry}%`]];

  box.innerHTML = `
    <div class="motion-score-hero medal-${medal}">
      <div><strong>${record.total}</strong><small>动作分</small></div>
      <span class="rank-medal medal-${medal}">${MEDAL_ICON[medal]} ${MEDAL_LABEL[medal]}</span>
    </div>
    <p class="hint">${escapeHtml(record.emoji)} ${escapeHtml(record.exName)} · 目标 ${escapeHtml(record.goalLabel || "")} · 用时 ${record.elapsed} 秒</p>
    <div class="motion-parts">${bars}</div>
    <div class="motion-mini-stats">${stats.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join("")}</div>
    <ul class="motion-feedback">${(record.hints || []).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
}

function renderFitnessMotion() {
  const select = document.getElementById("motionExSelect");
  if (!select) return;
  renderMotionGuide();
  if (!motionRunning) renderMotionPicker();
  renderMotionReadouts();
  renderMotionGoalHint();
  renderMotionButtons();
  renderMotionResult(motionResultRecord || motionLastRecord());

  if (!motionRunning) renderMotionRing();

  const un = document.getElementById("motionUnsupported");
  if (un && !motionEnabled()) {
    un.textContent = MOTION_ENGINE
      ? "家长在「家长管理」里关掉了摄像头体感功能。"
      : "体感引擎没有加载成功，请刷新页面重试。";
    un.classList.remove("hidden");
  }
}

function renderFitnessReport() {
  const pool = document.getElementById("motionCoinPool");
  if (!pool) return;
  const earned = motionCoinsEarned();
  const r = state.fitness.motion.rewards;
  const best = state.fitness.motion.scores.reduce((acc, item) => (!acc || item.total > acc.total ? item : acc), null);
  const medalRows = ["gold", "silver", "bronze"].map(kind => `
    <div class="medal-row ${kind}">
      <span class="medal-icon">${MEDAL_ICON[kind]}</span>
      <span class="medal-name">${MEDAL_LABEL[kind]}</span>
      <span class="medal-line">动作分 ≥ <strong>${r.thresholds[kind]}</strong></span>
      <span class="medal-coin">${r.coins[kind]} 🪙</span>
    </div>`).join("");

  pool.innerHTML = `
    <div class="coin-hero">
      <span>体感累计金币</span>
      <strong>${earned}</strong>
      <small>共 ${state.fitness.motion.scores.length} 组跟练 · 历史最好 ${best ? best.total : "--"} 分</small>
    </div>
    <div class="medal-rules">
      <p class="medal-rules-head">每天只发一个牌 · 按当天最高动作分取最高那一档</p>
      ${medalRows}
      <p class="medal-rules-foot">三档不会叠加：拿到金牌就只拿金牌那一档的金币。</p>
    </div>
    <p class="hint">体感金币与写作、体能金币合并进同一个奖金池。每天只结算一次，取当天最高的一次动作分。</p>`;

  const partsBox = document.getElementById("motionLastParts");
  if (partsBox) {
    const last = motionLastRecord();
    if (!last) {
      partsBox.innerHTML = `<p class="hint">还没有体感记录。去「体感跟练」打开摄像头做一组试试。</p>`;
    } else {
      const keys = Object.keys(last.parts || {});
      partsBox.innerHTML = `
        <p class="hint">${escapeHtml(last.emoji)} ${escapeHtml(last.exName)} · ${last.dateKey} · 总分 <strong>${last.total}</strong></p>
        <div class="motion-parts">${keys.map(key => `
          <div class="motion-part">
            <span>${escapeHtml(key)}</span>
            <span class="motion-part-bar"><i style="width:${Math.max(0, Math.min(100, last.parts[key]))}%"></i></span>
            <strong>${last.parts[key]}</strong>
          </div>`).join("")}</div>
        <ul class="motion-feedback">${(last.hints || []).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
    }
  }

  const list = document.getElementById("motionScoreList");
  if (!list) return;
  if (!state.fitness.motion.scores.length) {
    list.innerHTML = `<p class="hint">还没有体感记录。去「体感跟练」选一个动作，打开摄像头做一组，提交后这里就会留下记录。</p>`;
    return;
  }
  list.innerHTML = state.fitness.motion.scores.slice().reverse().slice(0, 40).map(item => {
    const d = new Date(item.at);
    const when = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const detail = item.mode === "hold"
      ? `保持 ${item.holdSeconds} 秒 · 稳定 ${item.stability}%`
      : item.mode === "burst"
        ? `强度 ${item.intensity}% · 连续 ${item.activeRatio}%`
        : `数到 ${item.reps} 次 · 节奏 ${item.tempo || 0}/分 · 幅度 ${item.amplitude}%`;
    return `<div class="fit-history-row">
      <div class="fit-history-main">
        <strong>${item.emoji} ${escapeHtml(item.exName)}</strong>
        <small>${when} · ${escapeHtml(item.goalLabel || "")} · ${detail}</small>
      </div>
      <div class="fit-history-bar"><div class="fit-history-fill medal-${item.medal || motionMedalOf(item.total)}" style="width:${item.total}%"></div></div>
      <span class="fit-history-pct">${item.total}</span>
      <span class="rank-medal medal-${item.medal || motionMedalOf(item.total)}">${MEDAL_ICON[item.medal || motionMedalOf(item.total)]}</span>
    </div>`;
  }).join("");
}

function clearMotionData() {
  if (!confirm("确定要清空本机的体感跟练记录吗？写作和体能训练的数据不会受影响。")) return;
  state.fitness.motion.scores = [];
  saveState();
  motionResultRecord = null;
  renderFitnessMotion();
  renderFitnessReport();
  renderFitnessBoard();
  renderStatWidget();
  toast("体感记录已清空。");
}

function saveMotionRewards() {
  const readNum = (id, min, max, fallback) => {
    const v = Number(document.getElementById(id).value);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  };
  const mr = state.fitness.motion.rewards;
  const gold = readNum("motionGoldScore", 1, 100, mr.thresholds.gold);
  const silver = readNum("motionSilverScore", 1, 100, mr.thresholds.silver);
  const bronze = readNum("motionBronzeScore", 1, 100, mr.thresholds.bronze);
  if (!(gold >= silver && silver >= bronze)) {
    toast("动作分线要满足：金牌 ≥ 银牌 ≥ 铜牌。");
    return;
  }
  const enableBox = document.getElementById("motionEnabled");
  state.fitness.motion.enabled = enableBox ? !!enableBox.checked : state.fitness.motion.enabled;
  state.fitness.motion.rewards = {
    thresholds: { gold, silver, bronze },
    coins: {
      gold: readNum("motionGoldCoin", 0, 999, mr.coins.gold),
      silver: readNum("motionSilverCoin", 0, 999, mr.coins.silver),
      bronze: readNum("motionBronzeCoin", 0, 999, mr.coins.bronze)
    }
  };
  if (!state.fitness.motion.enabled) motionStopCamera();
  saveState();
  renderAll();
  renderAdmin();
  renderFitnessMotion();
  toast("体感规则已保存，立即生效。");
}

/* ---------- 模块切换 ---------- */

const MODULE_META = {
  write: { icon: "写", title: "每日一写", sub: "儿童写作长期训练", home: "dashboard", card: "每日必写是每天必须完成的固定打卡；完成后才能进入每日任务、范文临摹、文章补写，这三个模块写几次都可以。当日总分是所有单次写作得分之和，达到家长设定的分数线即可拿金币。" },
  fitness: { icon: "练", title: "每日一练", sub: "儿童体能 · 跑步提升", home: "fitnessToday", card: "体能训练和写作是并列的两个部分。每天按星期几自动安排一个主题日（心肺 / 腿力 / 恢复 / 爆发 / 核心 / 挑战）。练之前先在动作块前面打钩选中要练的项目，再点它右边的「计时」跟着教练做，计时跑完这个项目才算完成。完成度达到家长设定的分数线就能拿奖牌和金币，同一天只发一个牌、取最高那一档，不叠加。还可以打开摄像头做「体感跟练」，系统在本机数次数、看节奏幅度，给每一组动作打分换金币。" }
};

function applyModule() {
  const mod = state.module || "";
  const chooser = document.getElementById("moduleChooser");
  const shell = document.getElementById("appShell");
  if (chooser) chooser.classList.toggle("hidden", !!mod);
  if (shell) shell.classList.toggle("hidden", !mod);
  if (!mod) return;

  const meta = MODULE_META[mod] || MODULE_META.write;
  document.getElementById("brandIcon").textContent = meta.icon;
  document.getElementById("brandTitle").textContent = meta.title;
  document.getElementById("brandSub").textContent = meta.sub;
  document.getElementById("sidebarCard").innerHTML = `<span class="eyebrow">PC单机版</span><p>${escapeHtml(meta.card)}</p>`;
  document.body.classList.toggle("module-fitness", mod === "fitness");

  document.querySelectorAll(".nav-item").forEach(item => {
    const itemModule = item.dataset.module || "both";
    item.classList.toggle("hidden", itemModule !== "both" && itemModule !== mod);
  });

  setView(meta.home);
}

function setModule(mod) {
  state.module = mod;
  saveState();
  if (mod === "fitness") fitTimerReset();
  applyModule();
}

function backToChooser() {
  fitTimerStop();
  if (fitSeq) fitSeqAbort();   // 回到模块选择页 = 离开训练，序列一起收掉
  motionStopCamera();
  state.module = "";
  saveState();
  applyModule();
}

/* ---------- 任务访问 ---------- */

function tasksOfType(type) {
  return TASK_POOL.filter(task => task.type === type);
}

function getCurrentTask() {
  const cached = TASK_BY_ID.get(state.currentTaskId);
  if (cached) return cached;
  const fallback = TASK_POOL.find(task => task.type === state.selectedTaskType) || TASK_POOL[0];
  if (fallback) state.currentTaskId = fallback.id;
  return fallback;
}

/* ---------- 范文访问 ---------- */

function modelsInCategory() {
  if (!state.modelCategory || state.modelCategory === "全部") return MODEL_POOL;
  return MODEL_POOL.filter(model => model.category === state.modelCategory);
}

function getCurrentModel() {
  const cached = MODEL_BY_ID.get(state.currentModelId);
  if (cached && (!state.modelCategory || state.modelCategory === "全部" || cached.category === state.modelCategory)) return cached;
  const pool = modelsInCategory();
  return pool[0] || MODEL_POOL[0];
}

function getWeakSkill() {
  return Object.entries(state.skills).sort((a, b) => a[1] - b[1])[0]?.[0] || "细节描写";
}

function usedTopicIds() {
  return new Set(state.essays.map(item => item.topicId));
}

function generateSmartTask(forceType) {
  const weakSkill = getWeakSkill();
  const used = usedTopicIds();
  const preferredType = forceType || taskTypes.find(type => type.skill === weakSkill)?.id || state.selectedTaskType;
  let pool = tasksOfType(preferredType);
  if (!pool.length) pool = TASK_POOL;
  const freshPool = pool.filter(task => !used.has(task.id));
  const usable = freshPool.length ? freshPool : pool;
  const weakPool = usable.filter(task => task.skill === weakSkill);
  const task = nextFromQueue(`task-${preferredType}`, weakPool.length ? weakPool : usable);
  if (!task) return;
  state.selectedTaskType = task.type;
  state.currentTaskId = task.id;
  saveState();
  renderAll();
}

function rerollModel() {
  const pool = modelsInCategory().filter(model => model.id !== state.currentModelId);
  const model = nextFromQueue(`model-${state.modelCategory}`, pool.length ? pool : modelsInCategory());
  if (!model) return;
  state.currentModelId = model.id;
  saveState();
  renderAll();
}

function setModelCategory(category) {
  state.modelCategory = category || "全部";
  state.currentModelId = "";
  const pool = modelsInCategory();
  if (pool.length) state.currentModelId = pool[Math.floor(Math.random() * pool.length)].id;
  saveState();
  renderAll();
}

/* ---------- 文章补写 ----------
 *
 * 孩子拿到一篇"中间被挖掉几段"的文章，读完之后把那几段补出来；
 * 提交后把「他写的」和「原文的」并排摆出来，再由 AI 对照批改。
 *
 * 三条设计上的硬约束（改这个模块前先读）：
 *
 *   1｜**挖空只存下标，正文永远存完整原文**。任何"帮孩子看答案"的渲染路径都必须
 *     显式去读 article.gapParas；默认视图（renderFillArticle）一律不读，只画占位块。
 *   2｜**AI 生成的文章不进素材库**。它只活在 state.fillAiArticle 上 —— 一旦落库，
 *     用户重开软件会看到一篇"凭空多出来的文章"，而它其实是上次生成的那一篇。
 *   3｜**额外加分必须并进 feedback.score**（见 ai-grader 的 normalizeFillGrade）。
 *     dayScore / dayDetail 只认 score，分开存"基础分 + 加分"会让积分榜纹丝不动。
 *
 * 来源两条：
 *   · 文库：data/fill-articles.js，80 篇 AI 按 5、6 年级课标编写的文章
 *     （2026-10-18 整库替换：旧库是 210 篇维基文库公版散文，句长中位 30.7 字、
 *      合适率仅 33/210，孩子读不下去。新库句长中位 16.3 字、合适率 72/80）
 *   · AI  ：点「AI 生成」才调用大模型，生成失败可重试，成功的那篇保留在本机
 */

function rerollFillArticle() {
  if (state.fillSource === "ai") {
    // 在 AI 模式里点"换一篇"，语义应该是"再让 AI 生成一篇"，不是回文库
    generateFillArticle();
    return;
  }
  const pool = fillArticlesInCategory().filter(article => article.id !== state.currentArticleId);
  const article = nextFromQueue(`fill-${state.fillCategory}`, pool.length ? pool : fillArticlesInCategory());
  if (!article) return;
  state.currentArticleId = article.id;
  saveState();
  renderAll();
}

function setFillCategory(category) {
  state.fillCategory = category || "全部";
  state.currentArticleId = "";
  const pool = fillArticlesInCategory();
  if (pool.length) state.currentArticleId = pool[Math.floor(Math.random() * pool.length)].id;
  saveState();
  renderAll();
}

function setFillSource(source) {
  state.fillSource = source === "ai" ? "ai" : "library";
  saveState();
  renderAll();
}

/* 素材库里"最近用过的标题"，传给 AI 让它别再写同一个题材。
 * 为什么不用"最近写过的文章正文"：那样 token 花得太多，而孩子要的只是"别重复"。 */
function fillRecentTitles(limit = 8) {
  return state.essays
    .filter(item => item.fillGap && item.fillGap.title)
    .slice(0, limit)
    .map(item => item.fillGap.title);
}

function generateFillArticle() {
  if (state.fillGenerating) return;
  if (!window.AiGrader || !window.AiGrader.isConfigured()) {
    toast("还没有配置 AI。请家长到「家长管理」里填好评分用的 API Key。");
    return;
  }
  state.fillGenerating = true;
  renderFillArticle();

  window.AiGrader.writeFillArticle({
    profile: state.profile,
    avoid: fillRecentTitles()
  }).then(result => {
    state.fillGenerating = false;
    if (result && result.ok && result.article) {
      const article = Object.assign({}, result.article, { aiGenerated: true });
      state.fillAiArticle = article;
      state.fillSource = "ai";
      saveState();
      renderAll();
      toast(`AI 生成好了：《${article.title}》，挖掉 ${article.gapCount} 段共 ${article.gapChars} 字。`);
      return;
    }
    const why = (result && result.message) || "AI 生成暂时不可用。";
    renderFillArticle();
    toast(why);
  }).catch(() => {
    state.fillGenerating = false;
    renderFillArticle();
    toast("AI 生成失败：网络异常，可以再点一次。");
  });
}

/* 开始补写：把孩子要看的那份（含占位块）和"答案"一起装进 activeWriting。
 * ★ originalGap 会跟着 activeWriting 走，提交时才拿得到 —— 但也意味着它会进 localStorage。
 *   这是有意的：孩子提交前刷新页面还得能继续写，代价是"答案在本机"。
 *   界面上不给任何"偷看"入口，靠的是**没有入口**，不是靠藏得深。 */
function startFillWriting() {
  if (!ensureGate()) return;
  const article = getCurrentFillArticle();
  if (!article) {
    toast("素材库是空的，请先检查 data/fill-articles.js。");
    return;
  }
  const blocks = fillGapBlocks(article);
  const before = blocks.filter(b => b.type === "text" && b.index < article.gapStart).map(b => b.text);
  const after = blocks.filter(b => b.type === "text" && b.index >= article.gapStart + article.gapCount).map(b => b.text);

  state.mode = "fillgap";
  state.activeWriting = {
    kind: "fillgap",
    topicId: `fillgap_${article.id}_${Date.now()}`,
    title: `文章补写：《${article.title}》`,
    type: "文章补写",
    goal: REQUIREMENTS.fillgap,
    requirement: REQUIREMENTS.fillgap,
    skill: article.skill,
    material: before.join("\n") + "\n\n【这里缺了 " + article.gapCount + " 段】\n\n" + after.join("\n"),
    prompts: scaffolds["文章补写"],
    // 下面这些是补写模块专属字段
    fillGap: {
      articleId: article.id,
      title: article.title,
      author: article.author,
      source: article.source,
      category: article.category,
      gapStart: article.gapStart,
      gapCount: article.gapCount,
      gapChars: article.gapChars,
      hint: article.hint,
      aiGenerated: !!article.aiGenerated,
      paragraphs: article.paragraphs,     // 完整原文（含被挖段）
      originalGap: article.gapParas       // 答案本身
    }
  };
  saveState();
  renderWritingPanel();
  setView("write");
}

/* 写作页的正文卡片：只画"能看到的"，挖掉的位置画占位块。
 * ★ 这里刻意**不**把 gapParas 落进 DOM —— 任何人按 F12 都拿不到答案，
 *   答案只在 activeWriting.fillGap.originalGap 里，而它只在提交后才被用到。 */
function fillWritingMaterialHtml(fg) {
  if (!fg || !Array.isArray(fg.paragraphs)) return "";
  const parts = [];
  fg.paragraphs.forEach((text, i) => {
    const inGap = i >= fg.gapStart && i < fg.gapStart + fg.gapCount;
    if (inGap) {
      // 连续多段只画一个新占位块，避免出现三个一模一样的框
      if (i === fg.gapStart) {
        parts.push(`<div class="fill-gap-hole">
          <span class="fill-gap-hole-label">这里缺 ${fg.gapCount} 段 · 共约 ${fg.gapChars} 字</span>
          ${i === fg.gapStart ? `<p class="fill-gap-hole-hint">${escapeHtml(fg.hint || "想一想：中间必须有哪一件事，后面才说得通？")}</p>` : ""}
        </div>`);
      }
      return;
    }
    parts.push(`<p class="fill-para">${escapeHtml(text)}</p>`);
  });
  return `<div class="fill-article">
    <div class="fill-article-head">
      <span class="tag green">${escapeHtml(fg.source || "素材库")}</span>
      <span class="tag purple">训练：${escapeHtml(fg.skill || "故事结构")}</span>
      ${fg.aiGenerated ? `<span class="tag blue">AI 现场生成</span>` : ""}
    </div>
    <h4 class="fill-article-title">${escapeHtml(fg.title)}</h4>
    <div class="fill-article-body">${parts.join("")}</div>
  </div>`;
}

function renderFillArticle() {
  const article = getCurrentFillArticle();
  const titleEl = document.getElementById("fillTitle");
  const metaEl = document.getElementById("fillMeta");
  const bodyEl = document.getElementById("fillBody");
  const catTag = document.getElementById("fillCategoryTag");
  const srcTag = document.getElementById("fillSourceTag");
  if (!titleEl || !bodyEl) return;

  // 生成中：整块换成"正在写"，并且把按钮锁住（防连点花钱）
  if (state.fillGenerating) {
    titleEl.textContent = "AI 正在写这篇文章…";
    if (metaEl) metaEl.textContent = "通常需要十几秒到一分钟，请稍等。";
    if (catTag) catTag.textContent = "AI 生成中";
    if (srcTag) srcTag.textContent = "";
    bodyEl.innerHTML = `<div class="fill-loading"><span class="spinner"></span><p>老师正在挑题目、写文章、再挖掉中间最关键的几段。</p></div>`;
    const btn = document.getElementById("fillAiBtn");
    if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
    const startBtn = document.getElementById("fillStartBtn");
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const aiBtn = document.getElementById("fillAiBtn");
  if (aiBtn) { aiBtn.disabled = false; aiBtn.textContent = "AI 生成一篇"; }
  const startBtn = document.getElementById("fillStartBtn");
  if (startBtn) startBtn.disabled = !article;

  if (!article) {
    titleEl.textContent = "素材库暂时是空的";
    if (metaEl) metaEl.textContent = "";
    bodyEl.innerHTML = `<p class="hint">没有读到 data/fill-articles.js，请检查这个文件是否随程序一起发布。</p>`;
    return;
  }

  titleEl.textContent = article.title;
  const bits = [];
  if (article.author) bits.push(`作者：${article.author}`);
  bits.push(`${article.chars} 字`);
  bits.push(`挖掉 ${article.gapCount} 段 · 共 ${article.gapChars} 字`);
  bits.push(`训练：${article.skill}`);
  if (metaEl) metaEl.textContent = bits.join(" · ");
  if (catTag) catTag.textContent = article.category || "记事";
  if (srcTag) srcTag.textContent = article.source || "";

  // 预览区只显示"开头一段 + 占位 + 结尾一段"，让孩子知道这篇讲什么，
  // 又不至于在选题阶段就把大半篇文章读完（读完了就不想写了）。
  const blocks = fillGapBlocks(article);
  const preview = [];
  blocks.forEach(block => {
    if (block.type === "gap") {
      if (!preview.some(x => x.type === "gap")) {
        preview.push({ type: "gap", count: article.gapCount, chars: article.gapChars });
      }
      return;
    }
    const beforeGap = block.index < article.gapStart;
    if (beforeGap && block.index >= article.gapStart - 1) preview.push({ type: "text", text: block.text });
    else if (!beforeGap && block.index < article.gapStart + article.gapCount + 1) preview.push({ type: "text", text: block.text });
  });
  bodyEl.innerHTML = preview.map(item => item.type === "gap"
    ? `<div class="fill-gap-hole compact"><span class="fill-gap-hole-label">这里缺 ${item.count} 段 · 约 ${item.chars} 字</span></div>`
    : `<p class="fill-para">${escapeHtml(item.text)}</p>`
  ).join("") + `<p class="hint fill-preview-note">上面是空缺前后的两段，点下面的按钮开始补写就能看到全文。</p>`;
}

function renderFillFilter() {
  const select = document.getElementById("fillCategorySelect");
  if (select) {
    const options = [`<option value="全部">全部（${FILL_ARTICLES.length} 篇）</option>`]
      .concat(FILL_CATEGORIES.map(([name, count]) =>
        `<option value="${escapeHtml(name)}" ${name === state.fillCategory ? "selected" : ""}>${escapeHtml(name)}（${count} 篇）</option>`));
    select.innerHTML = options.join("");
    select.value = state.fillCategory || "全部";
  }
  const meta = document.getElementById("fillLibraryMeta");
  if (meta) {
    const totalGap = FILL_ARTICLES.reduce((sum, a) => sum + a.gapChars, 0);
    const avgGap = FILL_ARTICLES.length ? Math.round(totalGap / FILL_ARTICLES.length) : 0;
    /* ★ 2026-10-18 换库后这句必须跟着改：原文案写「公有领域散文，来自维基文库」，
     *   而素材库已经整库换成 AI 按 5、6 年级课标生成的文章 —— 不改就是在界面上说假话。 */
    meta.textContent = `素材库共 ${FILL_ARTICLES.length} 篇（AI 按 5、6 年级课标编写），每篇都挖掉中间 ${avgGap} 字左右的核心段落。`;
  }
  /* 入口按钮下面那行小字也从数据里算，别再写死 —— 换库时它是最容易被忘掉的一处。 */
  const countHint = document.getElementById("fillLibraryCountHint");
  if (countHint) countHint.textContent = `${FILL_ARTICLES.length} 篇现成文章，离线可用`;
  // 来源切换按钮的高亮状态
  document.querySelectorAll("[data-fill-source]").forEach(btn => {
    btn.classList.toggle("active", (btn.dataset.fillSource || "library") === (state.fillSource || "library"));
  });
  const aiOnlyBar = document.getElementById("fillAiRow");
  if (aiOnlyBar) aiOnlyBar.classList.toggle("hidden", state.fillSource !== "ai");
  const libRow = document.getElementById("fillLibRow");
  if (libRow) libRow.classList.toggle("hidden", state.fillSource === "ai");
}
const LOCKED_VIEWS = { dailyTask: "每日任务", imitate: "范文临摹", fillgap: "文章补写" };

const VIEW_TITLES = {
  dashboard: "首页", write: "每日必写", dailyTask: "每日任务", imitate: "范文临摹",
  fillgap: "文章补写", result: "作文结果", history: "历史作文", growth: "成长分析",
  scoreboard: "积分榜", parent: "家长报告", admin: "家长管理", settings: "本机设置",
  fitnessToday: "今日训练", fitnessMotion: "体感跟练", fitnessTest: "体能自测",
  fitnessHistory: "训练记录", fitnessReport: "体感报告", fitnessBoard: "体能积分"
};

// 轻提示：比 alert 不打断操作，也不会有系统弹窗的压迫感
let toastTimer = null;
function toast(message) {
  let el = document.getElementById("toastBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "toastBar";
    el.className = "toast-bar";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setView(viewId) {
  // 离开体感跟练页就把摄像头关掉（指示灯灭掉），避免"以为关了其实还在拍"
  if (viewId !== "fitnessMotion") {
    // 校准浮层 + 准备口令层成套收掉：只收校准的话，那 8 秒口令会继续念，
    // 而孩子早就换到别的页面了。
    motionFlowTeardown();
    if (motionStream) motionStopCamera();
  }
  /* 离开今日训练页 → 作废「依次进行」序列。
   * 注意这是**计时链路**的 teardown，和上面体感链路的 motionFlowTeardown() 是两回事，
   * 千万别混用：那套收的是摄像头/校准浮层，这套收的是计时器 + 待触发的自动推进定时器。
   * 不接这里的话，孩子切到别的页，2 秒后浮层自己弹回来又开跑（本项目明确禁止的行为）。 */
  if (viewId !== "fitnessToday" && fitSeq) fitSeqAbort();
  // 进体感页时刷新一次摄像头列表（不在开屏就申请权限，避免一进来就弹框）
  if (viewId === "fitnessMotion") {
    motionCamRefresh(); motionDepthLink(); motionDepthRenderChip();
    if (window.VoiceGuide) window.VoiceGuide.warm();
    // 趁孩子读站位说明的空档，把真实骨架模型的一次性开销（实测 3.2 秒
    // 主线程阻塞）提前付掉。必须在这里，不能等点了摄像头才做，
    // 否则开摄像头那一刻页面会卡死、预览态画不出骨架。
    motionVisionWarmup();
  }

  // 门禁：没完成当天"每日必写"就不能进拓展模块
  if (LOCKED_VIEWS[viewId] && !canStartExtraWriting()) {
    toast(`今天还没完成「每日必写」。完成它之后，才能进入「${LOCKED_VIEWS[viewId]}」。`);
    viewId = "write";
  }

  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === viewId));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === viewId));
  document.getElementById("pageTitle").textContent = VIEW_TITLES[viewId] || "每日一练";
  if (viewId === "growth") drawRadar();
  if (viewId === "scoreboard") drawMonthChart();
  if (viewId === "fitnessToday") renderFitnessToday();
  if (viewId === "fitnessMotion") renderFitnessMotion();
  if (viewId === "fitnessTest") renderFitnessTest();
  if (viewId === "fitnessHistory") renderFitnessHistory();
  if (viewId === "fitnessReport") renderFitnessReport();
  if (viewId === "fitnessBoard") { renderFitnessBoard(); drawFitMonthChart(); }
  /* 结果页每次进来都重渲染一次。
   * 为什么必须有这一行：结果页上的东西会**在本页之外被改** ——
   * 最典型的就是「AI 范文」按钮的可用状态取决于家长有没有配 Key，
   * 而配 Key 是在「家长管理」页做的。不重渲染的话，家长配好 Key 切回来，
   * 按钮还是灰的（以为是坏的）。实测踩到过。 */
  if (viewId === "result") renderResult();
  if (viewId === "admin") renderAdmin();
  renderStatWidget();
}

function startDailyWriting() {
  state.mode = "daily";
  state.activeWriting = { kind: "daily", title: "今天我想写：", type: "每日必写", goal: "自由表达 10-20 分钟", skill: "语言表达", prompts: scaffolds["每日必写"] };
  saveState();
  renderWritingPanel();
  setView("write");
}

// 拓展模块的统一入口守卫（导航层已拦一次，这里再拦一次做双保险）
function ensureGate() {
  if (canStartExtraWriting()) return true;
  toast("先完成今天的「每日必写」，才能开始拓展写作。");
  setView("write");
  return false;
}

function startTaskWriting() {
  if (!ensureGate()) return;
  const task = getCurrentTask();
  if (!task) return;
  state.mode = "task";
  state.activeWriting = {
    kind: "task",
    topicId: task.id,
    title: task.title,
    type: taskTypes.find(type => type.id === task.type)?.label || "每日任务",
    goal: task.requirement,
    skill: task.skill,
    material: task.material,
    prompts: task.prompts,
    picture: task.picture,
    imageId: task.imageId,
    words: task.words,
    sceneId: task.sceneId,
    sourceLabel: task.sourceLabel,
    requirement: task.requirement
  };
  saveState();
  renderWritingPanel();
  setView("write");
}

function startImitateWriting() {
  if (!ensureGate()) return;
  const model = getCurrentModel();
  if (!model) return;
  state.mode = "imitate";
  state.activeWriting = {
    kind: "imitate",
    topicId: model.id,
    title: `受《${model.title}》启发写一篇`,
    type: "范文临摹",
    goal: model.prompt,
    skill: model.skill,
    material: `范文：《${model.title}》${model.source ? "（" + model.source + "）" : ""}\n\n${model.text}`,
    prompts: [...model.tips, model.prompt]
  };
  saveState();
  renderWritingPanel();
  setView("write");
}

function countChineseChars(text) {
  return text.replace(/\s/g, "").length;
}

function evaluateEssay(text) {
  const charCount = countChineseChars(text);
  const sentences = (text.match(/[。！？!?]/g) || []).length;
  const detailWords = ["看见", "听见", "闻到", "摸", "颜色", "声音", "突然", "慢慢", "因为", "所以", "可是", "后来", "心里", "感觉", "像", "亮", "暗", "安静", "热闹"];
  const detailHits = detailWords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  const hasDialogue = /“[^”]+”|"[^"]+"/.test(text);
  const structureWords = ["一开始", "然后", "后来", "最后", "结果", "突然", "可是", "但是", "原来", "没想到"];
  const structureHits = structureWords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  const opinionWords = ["我觉得", "我认为", "如果", "应该", "希望", "担心", "支持", "不同意"];
  const opinionHits = opinionWords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);

  const content = clamp(Math.round(12 + Math.min(10, charCount / 34) + Math.min(3, opinionHits)), 8, 25);
  const structure = clamp(Math.round(8 + Math.min(8, sentences * 1.2) + Math.min(4, structureHits)), 6, 20);
  const detail = clamp(Math.round(8 + Math.min(8, detailHits * 1.45) + (hasDialogue ? 3 : 0)), 6, 20);
  const language = clamp(Math.round(10 + Math.min(7, sentences) + (charCount > 180 ? 3 : 0)), 8, 20);
  const vocab = clamp(Math.round(5 + Math.min(5, new Set(text.replace(/[\s，。！？,.!?；;：“”"（）()]/g, "").split("")).size / 35)), 4, 10);
  const mechanics = clamp(Math.round(5 - Math.max(0, Math.floor((text.match(/[错别字]/g) || []).length / 2))), 3, 5);
  const parts = { "内容与立意": content, "结构与逻辑": structure, "细节与描写": detail, "语言表达": language, "词汇与句式": vocab, "错别字与标点": mechanics };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const strengths = [];
  const improvements = [];

  if (charCount >= state.profile.targetWords * 0.7) strengths.push("你坚持写出了比较完整的内容，这很重要。");
  if (detailHits >= 3) strengths.push("文章里已经有具体细节，读起来更像真实经历。");
  if (hasDialogue) strengths.push("你加入了人物说话，人物会更有现场感。");
  if (structureHits >= 3) strengths.push("事情有先后变化，故事线比较清楚。");
  if (opinionHits >= 2) strengths.push("你不只写事情，还写出了自己的想法。");
  while (strengths.length < 2) strengths.push(["你已经把主要事情写出来了，这是修改的基础。", "你能围绕一个主题写，没有跑得太远。", "句子表达比较自然，像是在认真讲自己的经历。"].find(item => !strengths.includes(item)));

  if (charCount < state.profile.targetWords * 0.6) improvements.push("内容还可以再展开：补充“什么时候、在哪里、谁在场”。");
  if (detailHits < 3) improvements.push("试着加入两个细节：一个看见的画面，一个听见的声音。");
  if (!hasDialogue && state.activeWriting.skill === "人物描写") improvements.push("如果有人物，可以加一句真实对话，让人物更活。");
  if (structureHits < 2) improvements.push("可以用“一开始、后来、最后”帮读者看清顺序。");
  if (state.activeWriting.type === "范文临摹") improvements.push("再回看范文，学它的写作顺序，但把素材换成自己的经历。");
  while (improvements.length < 3) improvements.push(["结尾可以再写一句你的感受或明白的道理。", "每段只讲一个重点，读起来会更清楚。", "找一个最精彩的地方多写两句，不要平均用力。"].find(item => !improvements.includes(item)));

  const weakest = Object.entries(parts).sort((a, b) => a[1] - b[1])[0][0];
  const nextGoalMap = {
    "内容与立意": "写之前先想清楚：这篇文章最想告诉别人什么。",
    "结构与逻辑": "用“一开始—后来—最后”把事情顺序写清楚。",
    "细节与描写": "补充两个看得见、听得到的细节。",
    "语言表达": "把过长的句子拆短，让每句话更清楚。",
    "词汇与句式": "尝试换掉重复词语，并加入一个比喻句。",
    "错别字与标点": "写完后朗读一遍，检查标点和漏字。"
  };

  return { score, parts, strengths: strengths.slice(0, 2), improvements: improvements.slice(0, 3), nextGoal: nextGoalMap[weakest], charCount };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* 组装给大模型的历史对比数据：最近几篇作文的正文 + 当时最弱项。
 * 只取最近几篇，是为了控制 token（省家长的钱），也够看出进步趋势。 */
function essayHistoryForAi(limit = 4) {
  return state.essays.slice(0, limit).map(item => {
    const parts = (item.feedback && item.feedback.parts) || {};
    const weakest = Object.keys(parts).length
      ? Object.entries(parts).sort((a, b) => a[1] - b[1])[0][0]
      : "";
    return {
      date: item.date ? String(item.date).slice(0, 10) : "",
      title: item.title || "",
      text: item.text || "",
      score: item.feedback ? item.feedback.score : null,
      weakest
    };
  });
}

function submitEssay() {
  const text = document.getElementById("essayInput").value.trim();
  const activeNow = state.activeWriting || defaultState.activeWriting;
  const isFill = activeNow.kind === "fillgap" && activeNow.fillGap;

  /* 补写的门槛和整篇作文不一样：
   * 整篇作文 40 字只是"别交白卷"，而补写的任务是**把 300 字左右的空缺填上**，
   * 交 40 字等于没做。这里按"空缺字数的四成"卡下限，再保底 60 字。 */
  const minChars = isFill ? Math.max(60, Math.round((activeNow.fillGap.gapChars || 300) * 0.4)) : 40;
  if (countChineseChars(text) < minChars) {
    alert(isFill
      ? `这次缺的段落一共 ${activeNow.fillGap.gapChars} 字左右，先补到至少 ${minChars} 个字再提交。`
      : "先写到至少 40 个字，再提交给 AI 老师。");
    return;
  }
  if (essayGrading) { toast("正在批改中，请稍等一下。"); return; }

  const gateWasLocked = !canStartExtraWriting();
  const active = activeNow;
  const charCount = countChineseChars(text);

  // 历史快照必须在写入本篇之前取，否则会把自己也带进去
  const history = essayHistoryForAi();
  const payload = {
    text,
    charCount,
    type: active.type,
    title: active.title,
    skillFocus: active.skill,
    goal: active.goal,
    material: active.material || "",
    profile: state.profile,
    history
  };

  /* 补写另带一份 payload：要额外把"原文被挖掉的那几段"和"孩子能看到的上下文"送过去。
   * ★ 为什么不复用上面那份再加字段：gradeFill 的提示词结构完全不同（对照批改），
   *   两个 payload 混用会让以后改一处、坏另一处。 */
  if (isFill) {
    const fg = active.fillGap;
    const contextBefore = (fg.paragraphs || []).slice(0, fg.gapStart || 0).join(String.fromCharCode(10));
    const contextAfter = (fg.paragraphs || []).slice((fg.gapStart || 0) + (fg.gapCount || 1)).join(String.fromCharCode(10));
    payload.context = contextBefore + String.fromCharCode(10) + "【这里缺了几段】" + String.fromCharCode(10) + contextAfter;
    payload.originalGap = (fg.originalGap || []).join(String.fromCharCode(10));
    payload.gapLabel = `原文第 ${(fg.gapStart || 0) + 1}～${(fg.gapStart || 0) + (fg.gapCount || 1)} 段`;
    payload.hint = fg.hint || "";
    payload.category = fg.category || "";
  }

  const finish = (feedback, sourceNote) => {
    const record = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      date: new Date().toISOString(),
      topicId: active.topicId || `${active.kind}_${todayKey()}_${Date.now()}`,
      type: active.type,
      title: active.title,
      goal: active.goal,
      skillFocus: active.skill,
      material: active.material || "",
      text,
      feedback
    };
    /* 补写的记录要额外留住"原文那几段"，否则历史作文打开就再也看不到对照了。
     * 存的是**完整原文**，不是挖空版 —— 孩子以后回头复盘要看的是全文。 */
    if (isFill) {
      const fg = active.fillGap;
      record.fillGap = {
        articleId: fg.articleId,
        title: fg.title,
        author: fg.author,
        source: fg.source,
        category: fg.category,
        gapStart: fg.gapStart,
        gapCount: fg.gapCount,
        gapChars: fg.gapChars,
        hint: fg.hint,
        aiGenerated: !!fg.aiGenerated,
        paragraphs: (fg.paragraphs || []).slice(),
        originalGap: (fg.originalGap || []).slice()
      };
      // 反馈里也留一份"原文真值"，结果页渲染时不用再回头找题目
      feedback.originalGap = record.fillGap.originalGap;
      feedback.gapCount = record.fillGap.gapCount;
    }
    state.essays.unshift(record);
    state.lastFeedback = record;
    state.draft = "";
    updateSkills(record);
    saveState();
    document.getElementById("essayInput").value = "";
    renderAll();
    setView("result");
    const today = dayDetail(todayKey());
    if (sourceNote) toast(sourceNote);
    else if (gateWasLocked && canStartExtraWriting()) {
      toast(`「每日必写」已完成，拓展模块已解锁！今日总分 ${today.score} 分${today.coins ? `，得 ${MEDAL_ICON[today.medal]} ${MEDAL_LABEL[today.medal]} +${today.coins} 🪙` : ""}。`);
    } else if (today.done) {
      toast(`本次 ${feedback.score} 分，今日总分 ${today.score} 分。`);
    }
  };

  // 没配大模型 → 直接用本地规则（并如实告诉家长这是本地估分）
  if (!window.AiGrader || !window.AiGrader.isConfigured()) {
    finish(localFallbackFeedback(text, "未配置 AI 评分"),
      "已用本地规则估分。想让孩子得到更准确的点评，请家长在「家长管理」里配置 AI 评分。");
    return;
  }

  // 配好了 → 调大模型；失败自动退回本地规则，功能不会整个不可用
  essayGrading = true;
  renderGradingState(true);
  // 补写走 gradeFill（对照原文批改 + 额外加分），其余走 grade
  const gradeCall = isFill ? window.AiGrader.gradeFill(payload) : window.AiGrader.grade(payload);
  gradeCall.then(result => {
    essayGrading = false;
    renderGradingState(false);
    if (result && result.ok) {
      finish(result.feedback, "");
    } else {
      const why = (result && result.message) || "AI 评分暂时不可用。";
      finish(localFallbackFeedback(text, why), `AI 评分未完成：${why} 已先用本地规则估分。`);
    }
  }).catch(() => {
    essayGrading = false;
    renderGradingState(false);
    finish(localFallbackFeedback(text, "网络异常"), "AI 评分未完成：网络异常。已先用本地规则估分。");
  });
}

/* 退回本地规则时，在反馈对象上留一个标记，界面上要如实说明"这不是 AI 评的" */
function localFallbackFeedback(text, reason) {
  const fb = evaluateEssay(text);
  fb.source = "local";
  fb.fallbackReason = reason || "";
  return fb;
}

// 批改中的界面状态：按钮转圈禁用 + 顶部提示条
function renderGradingState(active) {
  const btn = document.querySelector("[data-action='submit-essay']");
  if (btn) {
    btn.disabled = !!active;
    // 文案两边保持一致（和 index.html 里的初始文案对齐），避免按钮忽宽忽窄
    btn.textContent = active ? "AI老师正在批改…" : "提交给AI老师";
  }
  const bar = document.getElementById("gradingBar");
  if (bar) bar.classList.toggle("hidden", !active);
  // 批改开始/结束都会改变范文按钮的门禁，顺手刷一次
  renderGenModelTopBtn();
}


function updateSkills(record) {
  const focus = record.skillFocus || "语言表达";
  Object.keys(state.skills).forEach(skill => {
    const bump = skill === focus ? 2.6 : 0.6;
    const scoreSignal = (record.feedback.score - 70) / 16;
    state.skills[skill] = clamp(Math.round(state.skills[skill] + bump + scoreSignal), 35, 98);
  });
}

function getStreak() {
  const dates = [...new Set(state.essays.map(item => todayKey(new Date(item.date))))].sort().reverse();
  let streak = 0;
  const cursor = new Date();
  for (const dateText of dates) {
    if (dateText === todayKey(cursor)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (streak === 0 && dateText > todayKey(cursor)) {
      continue;
    } else {
      break;
    }
  }
  return streak;
}

function averageScore() {
  if (!state.essays.length) return null;
  return Math.round(state.essays.reduce((sum, item) => sum + item.feedback.score, 0) / state.essays.length);
}

function weekCount() {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return state.essays.filter(item => now - new Date(item.date).getTime() <= sevenDays).length;
}

function renderAll() {
  if (!state.currentTaskId) {
    const first = TASK_POOL.find(task => task.type === state.selectedTaskType) || TASK_POOL[0];
    if (first) state.currentTaskId = first.id;
  }
  if (!state.currentModelId) {
    const pool = modelsInCategory();
    if (pool.length) state.currentModelId = pool[0].id;
  }
  if (!state.currentArticleId || !FILL_BY_ID.has(state.currentArticleId)) {
    // 注意要判 has()：旧版存档里可能留着已经不存在的 id（素材库换过一轮），
    // 只判 falsy 的话会一直指向一篇"查不到的文章"，界面空着还找不出原因。
    const pool = fillArticlesInCategory();
    state.currentArticleId = pool.length ? pool[0].id : "";
  }

  const avg = averageScore();
  document.getElementById("todayText").textContent = new Date().toLocaleDateString("zh-CN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  document.getElementById("childNameText").textContent = state.profile.name;
  document.getElementById("childMetaText").textContent = `${state.profile.grade} · ${state.profile.age}岁`;
  document.getElementById("childAvatar").textContent = state.profile.name.slice(0, 1) || "童";
  document.getElementById("streakDays").textContent = getStreak();
  document.getElementById("metricEssayCount").textContent = state.essays.length;
  document.getElementById("metricAvgScore").textContent = avg ?? "--";
  document.getElementById("metricWeekCount").textContent = weekCount();
  document.getElementById("childNameInput").value = state.profile.name;
  document.getElementById("childAgeInput").value = state.profile.age;
  document.getElementById("childGradeInput").value = state.profile.grade;
  document.getElementById("targetWordsInput").value = state.profile.targetWords;
  renderDashboardRecommendation();
  renderTaskTabs();
  renderTask();
  renderModelFilter();
  renderModelArticle();
  renderFillFilter();
  renderFillArticle();
  renderWritingPanel();
  renderResult();
  renderHistory();
  renderGrowth();
  renderParent();
  renderNavLocks();
  renderStatWidget();
  renderChooserRewards();   // 模块选择页（首页）：共用奖金池 + 游戏卡 + 兑换记录
  renderScoreboard();
  renderFitnessToday();
  renderFitnessMotion();
  renderFitnessTest();
  renderFitnessHistory();
  renderFitnessReport();
  renderFitnessBoard();
  if (document.getElementById("scoreboard")?.classList.contains("active")) drawMonthChart();
  if (document.getElementById("fitnessBoard")?.classList.contains("active")) drawFitMonthChart();
}

function renderDashboardRecommendation() {
  const weakSkill = getWeakSkill();
  const task = getCurrentTask();
  const box = document.getElementById("dashboardRecommendBox");
  if (!task) { box.innerHTML = "<p class=\"hint\">题库为空。</p>"; return; }
  box.innerHTML = `<span>${escapeHtml(taskTypes.find(type => type.id === task.type)?.label || "每日任务")}</span><span class="tag blue">薄弱能力：${escapeHtml(weakSkill)}</span><h4>${escapeHtml(task.title)}</h4><p>${escapeHtml(task.requirement)}</p>`;
}

function renderTaskTabs() {
  const tabs = document.getElementById("taskTypeTabs");
  tabs.innerHTML = taskTypes.map(type => {
    const count = tasksOfType(type.id).length;
    return `<button class="task-tab ${type.id === state.selectedTaskType ? "active" : ""}" data-task-type="${type.id}">${type.label}<small>${count} 题</small></button>`;
  }).join("");
  tabs.querySelectorAll(".task-tab").forEach(button => {
    button.addEventListener("click", () => generateSmartTask(button.dataset.taskType));
  });
  const hint = document.getElementById("taskCountHint");
  if (hint) hint.textContent = `素材库合计 ${TASK_POOL.length} 条：故事补全 ${tasksOfType("fragment").length}、看图编故事 ${tasksOfType("picture").length}、文字扩写 ${tasksOfType("expand").length}、词语编文 ${tasksOfType("words").length}、热点感想 ${tasksOfType("news").length}、文章补写 ${tasksOfType("fillgap").length}。`;
}

function renderTask() {
  const task = getCurrentTask();
  if (!task) return;
  const typeLabel = taskTypes.find(type => type.id === task.type)?.label || "每日任务";
  document.getElementById("taskTypeLabel").textContent = typeLabel;
  document.getElementById("taskTitle").textContent = task.title;
  const materialEl = document.getElementById("taskMaterial");
  materialEl.innerHTML = buildMaterialHtml(task, true);
  bindPictureFallback(materialEl);
  const weakSkill = getWeakSkill();
  document.getElementById("taskReason").innerHTML = [
    `系统检测当前较弱能力是 <strong>${escapeHtml(weakSkill)}</strong>。`,
    `本题主要训练 <strong>${escapeHtml(task.skill)}</strong>，并避开最近已写过的题目。`,
    `适合 ${escapeHtml(state.profile.grade)}、${escapeHtml(String(state.profile.age))} 岁孩子，建议写 ${state.profile.targetWords} 字左右。`
  ].map(text => `<div class="advice-item">${text}</div>`).join("");
}

// 看图编故事的配图：真实插画 + 加载失败兜底
function pictureHtml(task) {
  let imageId = task.imageId;
  if (!imageId && typeof task.id === "string" && task.id.indexOf("picture-") === 0) {
    const n = Number(task.id.slice("picture-".length));
    if (Number.isFinite(n)) imageId = `pic${String(n + 1).padStart(3, "0")}`;
  }
  if (!imageId) return `<div class="picture-prompt is-missing" aria-label="看图编故事插画"></div>`;
  return `<figure class="picture-prompt">
    <img class="picture-prompt-img" src="assets/pictures/${imageId}.jpg" alt="看图编故事配图：${escapeHtml(task.title || "")}" loading="lazy" decoding="async">
    <figcaption class="picture-caption">配图 · ${escapeHtml(task.title || "看图编故事")}</figcaption>
  </figure>`;
}

// 图片缺失（离线 / 尚未生成）时回退到 CSS 示意占位
function bindPictureFallback(container) {
  if (!container) return;
  container.querySelectorAll(".picture-prompt-img").forEach(img => {
    const drop = () => {
      const fig = img.closest(".picture-prompt");
      if (fig) fig.classList.add("is-missing");
      img.remove();
    };
    img.addEventListener("error", drop);
    if (img.complete && img.naturalWidth === 0) drop();
  });
}

function buildMaterialHtml(task, includePicture) {
  const source = task.sourceLabel ? `<span class="tag green">${escapeHtml(task.sourceLabel)}</span>` : "";
  const requirement = task.requirement || task.goal || "";

  /* 文章补写：素材是"一篇被挖掉几段的文章"。
   * ★ 这里用的是 articleId 而不是把正文拷进 task —— 见 buildTaskPool 里的注释。
   *   而且**不能**直接把完整原文铺出来：这时孩子还没开始，铺全文等于提前泄题。 */
  if (task.type === "fillgap" || task.articleId) {
    const article = FILL_BY_ID.get(task.articleId) || (state.fillAiArticle && state.fillAiArticle.id === task.articleId ? state.fillAiArticle : null);
    if (article) {
      // 只取"空缺前一段 + 空缺后一段"，中间画占位
      const before = article.paragraphs[article.gapStart - 1] || "";
      const after = article.paragraphs[article.gapStart + article.gapCount] || "";
      return `${source}<span class="tag purple">训练：${escapeHtml(task.skill)}</span>
        <div class="material-section"><strong>文章</strong>
          <p class="fill-para">${escapeHtml(before)}</p>
          <div class="fill-gap-hole compact"><span class="fill-gap-hole-label">中间缺 ${article.gapCount} 段 · 共 ${article.gapChars} 字</span></div>
          <p class="fill-para">${escapeHtml(after)}</p>
          <p class="hint">这是空缺前后的两段。点「开始补写」能看到完整文章。</p>
        </div>
        <div class="material-section"><strong>写作要求</strong><p>${escapeHtml(requirement)}</p></div>
        <div class="material-section"><strong>想一想</strong><ul class="prompt-list">${(task.prompts || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
    }
  }

  const words = task.words && task.words.length ? `<div class="word-chip-row">${task.words.map(word => `<span class="word-chip">${escapeHtml(word)}</span>`).join("")}</div>` : "";
  const picture = task.picture && includePicture ? pictureHtml(task) : "";
  return `${source}<span class="tag purple">训练：${escapeHtml(task.skill)}</span><div class="material-section"><strong>素材</strong><p>${escapeHtml(task.material)}</p>${words}${picture}</div><div class="material-section"><strong>写作要求</strong><p>${escapeHtml(requirement)}</p></div><div class="material-section"><strong>想一想</strong><ul class="prompt-list">${(task.prompts || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

function renderModelFilter() {
  const select = document.getElementById("modelCategorySelect");
  if (!select) return;
  const options = [`<option value="全部">全部（${MODEL_POOL.length} 篇）</option>`]
    .concat(MODEL_CATEGORIES.map(([name, count]) => `<option value="${escapeHtml(name)}" ${name === state.modelCategory ? "selected" : ""}>${escapeHtml(name)}（${count} 篇）</option>`));
  select.innerHTML = options.join("");
  select.value = state.modelCategory || "全部";
  const meta = document.getElementById("modelLibraryMeta");
  if (meta) meta.textContent = `范文库共 ${MODEL_POOL.length} 篇，涵盖古今中外名著、散文、议论文、科普文、当代短文与新闻稿。`;
}

function renderModelArticle() {
  const model = getCurrentModel();
  if (!model) return;
  document.getElementById("modelTypeLabel").textContent = model.type;
  document.getElementById("modelTitle").textContent = model.title;
  const metaParts = [model.category, model.source, model.chars ? `${model.chars} 字` : "", `训练：${model.skill}`].filter(Boolean);
  const metaEl = document.getElementById("modelMeta");
  if (metaEl) metaEl.textContent = metaParts.join(" · ");
  document.getElementById("modelText").textContent = model.text;
  document.getElementById("imitateTips").innerHTML = [...model.tips, model.prompt].map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderWritingPanel() {
  const active = state.activeWriting || defaultState.activeWriting;
  document.getElementById("writeModeLabel").textContent = active.type || "每日必写";
  document.getElementById("writeTopicTitle").textContent = active.title || "今天我想写：";
  document.getElementById("writeTopicHint").textContent = active.goal || "先把今天想说的事情写下来。";
  document.getElementById("essayInput").value = state.draft;
  document.getElementById("wordCount").textContent = countChineseChars(state.draft);
  renderPromptList(active.prompts || scaffolds["每日必写"]);
  const card = document.getElementById("activeMaterialCard");
  if (active.kind === "fillgap" && active.fillGap) {
    /* 补写任务：正文卡片显示"完整文章 + 占位块"。
     * ★ 走的是 fillWritingMaterialHtml，它**只读 paragraphs 和占位下标**，
     *   从不读 originalGap —— 答案不进 DOM，按 F12 也拿不到。 */
    card.innerHTML = fillWritingMaterialHtml(active.fillGap);
    card.classList.remove("hidden");
  } else if (active.material || active.sceneId) {
    const html = (active.kind === "task" || active.kind === "fillgap")
      ? buildMaterialHtml({ ...active, type: active.kind === "fillgap" ? "fillgap" : "task", requirement: active.requirement || active.goal }, true)
      : `<span class="tag purple">参考素材</span><p class="model-ref">${escapeHtml(active.material)}</p>`;
    card.innerHTML = html;
    card.classList.remove("hidden");
    bindPictureFallback(card);
  } else {
    card.innerHTML = "";
    card.classList.add("hidden");
  }
  // 「AI 范文参考」按钮的门禁状态也要跟着刷新（切回来 / 换题目 / 清空草稿都会走到这）
  renderGenModelTopBtn();
}

function renderPromptList(items) {
  const list = document.getElementById("promptList");
  list.innerHTML = items.map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderResult() {
  const record = state.lastFeedback;
  document.getElementById("emptyResult").classList.toggle("hidden", Boolean(record));
  document.getElementById("resultContent").classList.toggle("hidden", !record);
  if (!record) return;
  const fb = record.feedback || {};
  const avg = averageScore() || fb.score;
  document.getElementById("scoreValue").textContent = fb.score;
  const delta = fb.score - avg;
  document.getElementById("scoreDelta").textContent = delta >= 0 ? `比历史平均 +${delta}` : `比历史平均 ${delta}`;

  // 分数来源要如实标注：AI 评的、还是本地规则估的。不标清楚，
  // 家长会把本地估分当成真实评分，反而砸了 AI 评分的可信度。
  const sourceEl = document.getElementById("scoreSource");
  if (sourceEl) {
    if (fb.source === "ai") {
      sourceEl.textContent = "由 AI 老师批改";
      sourceEl.className = "score-source is-ai";
    } else {
      sourceEl.textContent = "本地规则估分（未配置 AI 评分或调用失败）";
      sourceEl.className = "score-source is-local";
    }
  }

  document.getElementById("strengthList").innerHTML = (fb.strengths || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  document.getElementById("improveList").innerHTML = (fb.improvements || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  document.getElementById("nextGoalText").textContent = fb.nextGoal || "";

  const narrative = document.getElementById("aiNarrative");
  if (narrative) {
    narrative.textContent = fb.narrative || "";
    narrative.classList.toggle("hidden", !fb.narrative);
  }

  // ---- 进步情况：这是"看得出进步还是退步"的落点 ----
  const pCard = document.getElementById("progressCard");
  const pTitle = document.getElementById("progressTitle");
  const pDetail = document.getElementById("progressDetail");
  if (pCard && pTitle && pDetail) {
    const pr = fb.progress || null;
    const show = !!(pr && pr.detail);
    pCard.classList.toggle("hidden", !show);
    if (show) {
      const map = {
        up: ["比上一篇有进步", "is-up"],
        down: ["比上一篇有退步", "is-down"],
        flat: ["和上一篇差不多", "is-flat"],
        first: ["这是第一篇，往后就能看趋势了", "is-flat"]
      };
      const hit = map[pr.trend] || map.flat;
      pTitle.textContent = hit[0];
      pCard.dataset.trend = pr.trend;
      pCard.className = `card wide progress-card ${hit[1]}`;
      pDetail.textContent = pr.detail;
    }
  }

  // ---- 原文对照点评：把评价钉回具体句子，避免"套话式夸奖" ----
  const eCard = document.getElementById("evidenceCard");
  const eList = document.getElementById("evidenceList");
  if (eCard && eList) {
    const ev = Array.isArray(fb.evidence) ? fb.evidence : [];
    eCard.classList.toggle("hidden", !ev.length);
    eList.innerHTML = ev.map(item => `
      <div class="evidence-item">
        <blockquote>${escapeHtml(item.quote || "")}</blockquote>
        <p>${escapeHtml(item.comment || "")}</p>
      </div>`).join("");
  }

  const maxMap = { "内容与立意": 25, "结构与逻辑": 20, "细节与描写": 20, "语言表达": 20, "词汇与句式": 10, "错别字与标点": 5 };
  document.getElementById("scoreBars").innerHTML = Object.entries(fb.parts || {}).map(([name, value]) => {
    const percent = Math.round((value / maxMap[name]) * 100);
    return `<div class="score-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${percent}%"></div></div><strong>${value}</strong></div>`;
  }).join("");

  renderFillCompare(record, fb);

  renderAiModel();
}

/* ---------- 文章补写的结果对照 ----------
 *
 * 需求原文：「当孩子补充写完提交后，同时显示孩子补充的部分与原文」。
 *
 * 「同时显示」有几种做法，这里是**逐段对齐**而不是两篇并排：
 *   · 并排的话，孩子的段落和原文的段落长度不一样，眼睛根本对不上哪句对哪句；
 *   · 逐段对齐（左边孩子、右边原文）才能一眼看出"这一处他多写了个细节"。
 * 只有一处例外：**AI 判"孩子更好"的那些句子**单独拎到最上面单独表扬并标出加分 ——
 * 需求里"要大家赞扬并获得额外加分"，藏在对比里就等于没表扬。
 */
function renderFillCompare(record, fb) {
  const card = document.getElementById("fillCompareCard");
  const bonusBox = document.getElementById("fillBonusBox");
  const listEl = document.getElementById("fillCompareList");
  const srcEl = document.getElementById("fillCompareSource");
  if (!card || !listEl) return;

  const fg = record && record.fillGap;
  // 不是补写记录（普通作文）→ 整块收起来，别在结果页留一块空壳
  if (!fg) {
    card.classList.add("hidden");
    if (bonusBox) bonusBox.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const titleEl = document.getElementById("fillCompareTitle");
  if (titleEl) titleEl.textContent = `《${fg.title || record.title || "无题"}》`;
  if (srcEl) {
    const bits = [fg.author ? `作者：${fg.author}` : "", fg.source || "", fg.aiGenerated ? "AI 现场生成" : ""]
      .filter(Boolean);
    srcEl.textContent = bits.join(" · ");
  }

  // 原文那几段（模型没给 originalGap 时可能是空的，要如实说明，不要假装有）
  const original = (fb.originalGap && fb.originalGap.length ? fb.originalGap : (fg.originalGap || []));
  const childText = record.text || "";
  // 孩子写的没有"段落划分信息"，按空行切；AI 往往也不按段回，所以切不开就当一整段
  const childParas = childText.split(new RegExp('[\\r\\n]+')).map(x => x.trim()).filter(Boolean);

  const rows = [];
  const n = Math.max(original.length, childParas.length, 1);
  for (let i = 0; i < n; i++) {
    const o = original[i] || "";
    const c = childParas[i] || "";
    if (!o && !c) continue;
    rows.push(`
      <div class="fill-compare-row">
        <div class="fill-compare-col is-child">
          <span class="fill-compare-tag">你补写的</span>
          <p>${c ? escapeHtml(c) : '<span class="hint">（这一段没有写）</span>'}</p>
        </div>
        <div class="fill-compare-col is-original">
          <span class="fill-compare-tag">原文这一段</span>
          <p>${o ? escapeHtml(o) : '<span class="hint">（原文这一段没有文字）</span>'}</p>
        </div>
      </div>`);
  }
  listEl.innerHTML = rows.join("");

  // ---- 额外加分与"确实比原文好"的句子 ----
  const bonus = Number(fb.extraBonus) || 0;
  const better = Array.isArray(fb.betterThan) ? fb.betterThan : [];
  if (bonusBox) {
    const show = bonus > 0 && better.length > 0;
    bonusBox.classList.toggle("hidden", !show);
    if (show) {
      bonusBox.innerHTML = `
        <div class="fill-bonus-head">
          <span class="fill-bonus-badge">+${bonus} 分</span>
          <strong>这几处你写得比原文好</strong>
        </div>
        <ul class="fill-bonus-list">
          ${better.map(item => `<li><blockquote>${escapeHtml(item.quote || "")}</blockquote><p>${escapeHtml(item.why || "")}</p></li>`).join("")}
        </ul>
        <p class="hint">这 ${bonus} 分已经算进本次得分里了。</p>`;
    }
  }
}

/* ---------- AI 范文参考 ----------
 *
 * 需求：AI 打分之后，再基于孩子写的这篇小文用 AI 扩写出一段范文给他参考。
 *
 * 三个设计取舍，都是有意的：
 *   1. **点按钮才生成，不自动跑**。范文比评分长、也慢（十几秒），而且不是每次都想看；
 *      自动生成等于让孩子白等、家长白花钱。生成过就存在这条记录里，再打开直接显示。
 *   2. **重在"怎么看"而不是"给一篇好文章"**。所以除了正文还给 highlights
 *      （这篇在哪儿比原文写得更具体），并明确写着"事情还是用你自己的"。
 *      否则孩子只会照抄，反而把自己那点真实经历丢了。
 *   3. **失败要能重来**，不能像空房扫描那样一挂不起 —— 所有失败路径都会
 *      把原因写进 status 行，按钮恢复可点。
 */
let essayModeling = false;       // 范文正在生成
let essayModelNote = "";         // 范文区的提示（错误原因等）
let essayModelNoteFor = "";      // 这条提示属于哪篇文章（换一篇就自动清空）

/* 取"这次最弱的一项"。AI 评分的结果里自带 weakest，但**本地兜底评分不带**
 * （见 evaluateEssay 的返回值），所以这里从 parts 现算一份。
 * 必须按**得分的百分比**比而不是绝对分 —— 各维度满分不同（25/20/10/5），
 * 直接比绝对分会永远把满分小的项误判成最弱。 */
function weakestDimensionOf(feedback) {
  if (feedback && feedback.weakest) return feedback.weakest;
  const parts = (feedback && feedback.parts) || {};
  const names = Object.keys(parts);
  if (!names.length) return "";
  const maxMap = { "内容与立意": 25, "结构与逻辑": 20, "细节与描写": 20, "语言表达": 20, "词汇与句式": 10, "错别字与标点": 5 };
  return names.slice().sort((a, b) =>
    (parts[a] / (maxMap[a] || 20)) - (parts[b] / (maxMap[b] || 20)))[0];
}

/* ---------- 写作页的「AI 范文参考」按钮（2026-10-11 老李要求）----------
 *
 * 为什么要在写作页再放一个入口：原来只有结果页最底下那张卡片上有按钮，
 * 实测卡片顶在 888px、视口 900px —— 正好压在折线以下，家长和孩子基本看不到，
 * 等于这个功能不存在。老李原话：「不太醒目，把这个选项按钮做的再大一些，
 * 位置放到AI打分按钮旁边」。
 *
 * 门禁（老李原话：「需要先AI打分完毕，之后这个 AI范文参考 才能生效，
 * 未生效时按钮是灰色」）：
 *   - 范文是**在评分结果上扩写**的，没评分就无从下手；
 *   - 更关键的是 lastFeedback 是"上一篇已评的作文"。草稿改过之后
 *     state.draft 和 record.text 就不一样了，这时候放行 = 把**旧作文**扩写出来。
 *     所以"草稿非空且与已评那篇不同"必须挡住。
 *
 * 这里只做**判定**，不碰 DOM；渲染在 renderGenModelTopBtn()。 */
function canGenerateModelNow() {
  if (essayModeling) return { ok: false, why: "AI 正在写范文，写完就能看了。" };
  const record = state.lastFeedback;
  if (!record) return { ok: false, why: "先写完作文、点「提交给AI老师」拿到评分，这里就能生成范文。" };
  if (essayGrading) return { ok: false, why: "AI 老师正在批改，等评分出来就能生成范文。" };
  const draft = String(state.draft || "").trim();
  const graded = String(record.text || "").trim();
  if (draft && draft !== graded) {
    return { ok: false, why: "这篇还没提交给 AI 老师评分。先点左边的按钮评一下，评分出来范文才能生成。" };
  }
  if (!(window.AiGrader && window.AiGrader.isConfigured())) {
    return { ok: false, why: "这个功能要用 AI。请家长在「家长管理 → AI 评分设置」里填好 API Key。" };
  }
  return { ok: true, why: "" };
}

/* 把判定结果画到写作页那个按钮 + 说明行上。
 * 说明行**永远有字**：空着一片灰是孩子和家长最难受的状态（不知道是坏了还是在等）。 */
function renderGenModelTopBtn() {
  const btn = document.getElementById("genModelTopBtn");
  if (!btn) return;
  const gate = canGenerateModelNow();
  btn.disabled = !gate.ok;
  btn.textContent = essayModeling ? "AI 正在写范文…" : "AI 范文参考";
  const hint = document.getElementById("genModelGateHint");
  if (!hint) return;
  if (!gate.ok) {
    hint.textContent = gate.why;
    return;
  }
  const record = state.lastFeedback;
  /* 把"是哪一篇"写出来：submitEssay 的 finish() 会把 draft 清空，
   * 所以写作页上那个输入框是空的，只写"已经有评分了"孩子根本对不上号。
   * 优先取**第一行**（孩子常常把题目写在第一行），第一行太长才退化成前 8 个字。 */
  const lines = String(record.text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const flat = lines.join("");
  let label;
  if (!flat) label = "这一篇";
  else if (firstLine.length <= 12) label = `《${firstLine}${flat.length > firstLine.length ? "…" : ""}》`;
  else label = `《${flat.slice(0, 8)}…》`;
  hint.textContent = (record && record.modelEssay)
    ? `${label}的范文已经写好了，点它回到结果页查看。`
    : `${label}已经有评分了，点它让 AI 按你写的事情扩写一篇范文。`;
}

function renderAiModel() {
  // 写作页那个按钮的可用状态跟着一起刷新（生成中 / 生成完都要变）
  renderGenModelTopBtn();
  const card = document.getElementById("aiModelCard");
  if (!card) return;
  const record = state.lastFeedback;
  if (!record) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  // 换了一篇文章就把上一轮的错误提示清掉（否则新文章会顶着旧报错）
  if (essayModelNoteFor !== record.id) { essayModelNote = ""; essayModelNoteFor = record.id; }

  const body = document.getElementById("aiModelBody");
  const status = document.getElementById("aiModelStatus");
  const hint = document.getElementById("aiModelHint");
  const btn = document.getElementById("genModelBtn");
  const saved = record.modelEssay || null;
  const aiReady = !!(window.AiGrader && window.AiGrader.isConfigured());

  btn.disabled = essayModeling || !aiReady;
  btn.textContent = essayModeling ? "AI 正在写…" : (saved ? "重新生成" : "生成范文");

  hint.textContent = saved
    ? "这是 AI 老师按你写的事情扩写的参考，重点看它是怎么把细节写具体的。"
    : "让 AI 老师在你写的事情上，把细节写得更具体一点，给你做个参考。";

  /* 状态行：把"为什么不能点 / 正在做什么 / 刚才为什么失败"都写在这里。
   * 空着一片灰是孩子和家长最难受的状态（不知道是坏了还是在等）。 */
  let note = "", bad = false;
  if (essayModeling) {
    note = "AI 老师正在读你的文章、写一篇范文…（大约十几秒，别走开）";
  } else if (essayModelNote) {
    note = essayModelNote; bad = true;
  } else if (!aiReady) {
    note = "这个功能要用 AI。请家长在「家长管理 → AI 评分设置」里填好 API Key 就能用了。";
  }
  status.textContent = note;
  status.classList.toggle("hidden", !note);
  status.classList.toggle("is-bad", bad);
  card.classList.toggle("is-loading", essayModeling);

  // 范文正文
  body.classList.toggle("hidden", !saved);
  if (!saved) return;
  document.getElementById("aiModelTitle").textContent = saved.title || record.title || "";
  document.getElementById("aiModelText").textContent = saved.text || "";
  const hlWrap = document.getElementById("aiModelHighlights");
  const hls = Array.isArray(saved.highlights) ? saved.highlights : [];
  hlWrap.classList.toggle("hidden", !hls.length);
  if (hls.length) {
    hlWrap.innerHTML = `<h5>看这几处是怎么写的</h5><ul>` +
      hls.map(t => `<li>${escapeHtml(t)}</li>`).join("") + `</ul>`;
  }
}

function generateAiModel() {
  if (essayModeling) { toast("范文还在写，稍等一下。"); return; }
  const record = state.lastFeedback;
  if (!record) return;
  if (!window.AiGrader || !window.AiGrader.isConfigured()) {
    essayModelNote = "还没有配置 AI 评分。请家长在「家长管理」里填好 API Key，回来就能生成范文。";
    renderAiModel();
    return;
  }
  if (record.modelEssay && !confirm("已经有一篇范文了，重新生成会覆盖它。继续吗？")) return;

  essayModeling = true;
  essayModelNote = "";
  renderAiModel();

  const payload = {
    text: record.text,
    charCount: countChineseChars(record.text),
    type: record.type,
    title: record.title,
    skillFocus: record.skillFocus,
    goal: record.goal,
    material: record.material || "",
    profile: state.profile,
    // 让范文**重点在孩子最弱的一项上做示范** —— 否则模型平均用力，
    // 孩子看完不知道该学哪一点，范文就白写了。
    weakest: weakestDimensionOf(record.feedback)
  };

  window.AiGrader.writeModel(payload).then(result => {
    essayModeling = false;
    if (result && result.ok) {
      record.modelEssay = result.model;
      saveState();                    // 存进记录，切视图/重开都还在，不重复花钱
      essayModelNote = "";
      toast("范文写好了，往下翻可以看到。");
    } else {
      essayModelNote = (result && result.message) || "范文没能生成出来，请稍后再试。";
    }
    renderAiModel();
  }).catch(() => {
    essayModeling = false;
    essayModelNote = "网络异常，范文没生成出来。检查网络后可以重试。";
    renderAiModel();
  });
}

/* ---------- 历史作文：日历视图 ----------
 *
 * 为什么改成日历：原来的历史是一列平铺的流水账，孩子看不出"哪天写了、哪天偷懒了"，
 * 也没法按天回看当天的 AI 评语。改成月历后：有作文的日子打点，点一下看当天详情。
 *
 * 下面三个字段纯粹是**展示态**，故意不落 localStorage ——
 * 刷新后回到"本月 + 未选中"才符合直觉，持久化反而会出现"一打开停在三个月前"的怪状态。
 */
const historyCal = {
  month: monthKey(),   // 当前展示的月份 "YYYY-MM"
  selected: "",        // 选中的日期键 "YYYY-MM-DD"；"" 表示还没选任何一天
  expanded: {}         // { [essayId]: true } 哪些作文展开了全文（正文可能很长，默认只给摘要）
};

// 某天所有作文里的**最高单篇分**。注意不是当天总分：总分要"完成每日必写"才计入，
// 日历格子只是给一个"这天写得怎么样"的直观标记，用最高分更直白，也不受门禁影响。
function dayBestScore(key) {
  const items = essaysOnDay(key);
  if (!items.length) return null;
  return Math.max(...items.map(item => Number(item.feedback?.score) || 0));
}

function renderHistoryCalendar() {
  const box = document.getElementById("historyCalendar");
  if (!box) return;
  const [year, month] = historyCal.month.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  // 周一开头，与 weekStartKey 的约定保持一致（getDay() 里周日=0，先 +6 取模把周一挪到 0）
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayKey();
  const cells = [];

  // 上个月补位：只为了让 1 号对齐到正确的星期列，弱化且不可点
  for (let i = lead; i > 0; i -= 1) {
    cells.push(`<span class="cal-day is-out" aria-hidden="true">${new Date(year, month - 1, 1 - i).getDate()}</span>`);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = todayKey(new Date(year, month - 1, day));
    const count = essaysOnDay(key).length;
    const best = dayBestScore(key);
    const cls = ["cal-day", count ? "has-essay" : "", key === today ? "is-today" : "",
      key === historyCal.selected ? "is-selected" : ""].filter(Boolean).join(" ");
    // 没作文的日子**也要可点**：用户要求"点某一天，没有则显示空"。
    // 所以统一用 button，而不是只给有作文的格子挂点击。
    cells.push(
      `<button class="${cls}" type="button" data-action="history-pick-day" data-day="${key}" ` +
        `aria-label="${key}${count ? `，${count} 篇作文` : "，没有作文"}">` +
        `<span class="cal-day-num">${day}</span>` +
        (count ? `<span class="cal-day-mark"><i class="cal-dot"></i><b>${best}</b></span>` : "") +
      `</button>`
    );
  }
  // 末尾补到下个月的格子，补到 7 的整数倍，最后一行才不会被拉歪
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= trailing; i += 1) {
    cells.push(`<span class="cal-day is-out" aria-hidden="true">${i}</span>`);
  }

  // 本月共写了多少篇（顺手给个月度小结）
  const monthTotal = monthDayKeys(new Date(year, month - 1, 1))
    .reduce((sum, key) => sum + essaysOnDay(key).length, 0);

  box.innerHTML = `
    <div class="cal-head">
      <div class="cal-title">${year} 年 ${month} 月<small>本月共 ${monthTotal} 篇</small></div>
      <div class="cal-nav">
        <button class="ghost small" type="button" data-action="history-prev-month">‹ 上一月</button>
        <button class="ghost small" type="button" data-action="history-this-month">回到本月</button>
        <button class="ghost small" type="button" data-action="history-next-month">下一月 ›</button>
      </div>
    </div>
    <div class="cal-weekdays">${["一", "二", "三", "四", "五", "六", "日"].map(w => `<span>${w}</span>`).join("")}</div>
    <div class="cal-grid">${cells.join("")}</div>`;
}

// 单篇作文卡片：标题 / 类型 / 时间 / 得分 + 正文（摘要可展开）+ AI 评语与改进意见
function renderHistoryEssay(item, index) {
  const fb = item.feedback || {};
  const id = item.id || `idx-${index}`;
  const expanded = !!historyCal.expanded[id];
  const text = String(item.text || "");
  const LIMIT = 120;
  const excerpt = text.slice(0, LIMIT) + (text.length > LIMIT ? "……" : "");
  const d = new Date(item.date);
  // 时间必须从本地 Date 取时分，不能切 ISO 字符串 —— ISO 是 UTC，晚上写的会差 8 小时
  const time = Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  // 分数来源要如实标注（与结果页 score-source 同一个原则）：
  // 本地兜底估分不能冒充 AI 评分，否则家长会误判孩子的真实水平。
  const sourceTag = fb.source === "ai"
    ? `<span class="score-source is-ai">AI 批改</span>`
    : `<span class="score-source is-local">本地估分</span>`;

  // 评语：只有 AI 版才有 narrative。本地兜底版为空时必须给一句说明，
  // 否则家长会以为"评语丢了"（留白是最糟的体验）。
  const narrativeBlock = fb.narrative
    ? `<div class="he-narrative"><h5>AI 评语</h5><p>${escapeHtml(fb.narrative)}</p></div>`
    : `<div class="he-narrative is-local"><h5>AI 评语</h5><p class="hint">这篇是本地兜底评分，没有 AI 评语。</p></div>`;

  const listBlock = (title, arr) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!list.length) return "";
    return `<div class="he-list"><h5>${title}</h5><ul>${list.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div>`;
  };

  return `<article class="history-essay">
    <div class="he-head">
      <h4>${escapeHtml(item.title)}</h4>
      <div class="he-meta"><span>${escapeHtml(item.type)}</span><span>${time}</span>${sourceTag}</div>
      <div class="he-score">${escapeHtml(fb.score ?? "--")}</div>
    </div>
    <div class="he-text">
      <p class="he-excerpt">${escapeHtml(expanded ? text : excerpt)}</p>
      ${text.length > LIMIT ? `<button class="ghost small" type="button" data-action="history-toggle-text" data-essay="${escapeHtml(id)}">${expanded ? "收起全文" : "看全文"}</button>` : ""}
    </div>
    ${narrativeBlock}
    ${listBlock("改进意见", fb.improvements)}
    ${listBlock("值得肯定", fb.strengths)}
    ${fb.nextGoal ? `<div class="he-goal"><h5>下一篇目标</h5><p>${escapeHtml(fb.nextGoal)}</p></div>` : ""}
  </article>`;
}

function renderHistoryDayDetail() {
  const box = document.getElementById("historyList");
  if (!box) return;
  const key = historyCal.selected;
  if (!key) {
    box.innerHTML = state.essays.length
      ? `<p class="hint history-pick-hint">点日历里的某一天，就能看到那天写了什么。</p>`
      : `<div class="empty-state"><h3>暂无历史作文</h3><p>完成第一篇后，作品会自动保存到本机。</p></div>`;
    return;
  }
  const items = essaysOnDay(key);
  const weekday = "一二三四五六日"[(dateFromKey(key).getDay() + 6) % 7];
  const head = `<div class="history-day-head"><h4>${escapeHtml(key)} <small>周${weekday}</small></h4>` +
    (items.length ? `<span class="history-day-count">共 ${items.length} 篇</span>` : "") + `</div>`;
  if (!items.length) {
    // 用户明确要求：那天没写就显示「空」，不要留白、也不要报错
    box.innerHTML = head + `<div class="history-empty-day">空</div>`;
    return;
  }
  box.innerHTML = head + items.map((item, index) => renderHistoryEssay(item, index)).join("");
}

function renderHistory() {
  renderHistoryCalendar();
  renderHistoryDayDetail();
}

/* 日历的月份/选日/展开全文 —— 都是纯展示态变更，改完整体重渲染一次即可。
 * 走事件委托（见 bindEvents 里那段 document click），所以 DOM 重渲染后事件依然有效。 */
function shiftHistoryMonth(delta) {
  const [year, month] = historyCal.month.split("-").map(Number);
  // Date 会自动处理跨年（12 月 +1 → 次年 1 月），不用手写边界
  historyCal.month = monthKey(new Date(year, month - 1 + delta, 1));
  renderHistory();
}

function pickHistoryDay(key) {
  if (!key) return;
  historyCal.selected = key;
  renderHistory();
}

function toggleHistoryText(id) {
  if (!id) return;
  historyCal.expanded[id] = !historyCal.expanded[id];
  renderHistory();
}

function renderGrowth() {
  const advice = document.getElementById("growthAdvice");
  const sorted = Object.entries(state.skills).sort((a, b) => a[1] - b[1]);
  advice.innerHTML = [
    `当前最值得练：<strong>${sorted[0][0]}</strong>。每日任务会优先安排相关形式。`,
    `保持优势：<strong>${sorted.at(-1)[0]}</strong> 已经表现不错，范文临摹时可以继续使用。`,
    `建议节奏：每日必写保习惯，任务训练补短板，范文临摹扩类型。`
  ].map(text => `<div class="advice-item">${text}</div>`).join("");

  const trend = document.getElementById("trendChart");
  const items = state.essays.slice(0, 8).reverse();
  if (!items.length) {
    trend.innerHTML = "<p class=\"hint\">暂无趋势。完成几篇作文后会显示分数变化。</p>";
    return;
  }
  trend.innerHTML = items.map(item => `<div class="trend-bar"><span style="height:${Math.max(18, item.feedback.score * 1.25)}px"></span>${item.feedback.score}</div>`).join("");
  drawRadar();
}

/* ---------- 积分榜 / 统计图 / 家长管理 ---------- */

// 侧边栏导航的锁状态：没完成"每日必写"时，三个拓展模块显示 🔒
function renderNavLocks() {
  const open = canStartExtraWriting();
  document.querySelectorAll(".nav-item").forEach(item => {
    const locked = Boolean(LOCKED_VIEWS[item.dataset.view]) && !open;
    item.classList.toggle("locked", locked);
    let badge = item.querySelector(".nav-badge");
    if (locked && !badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      item.appendChild(badge);
    }
    if (badge) badge.textContent = locked ? "🔒" : "";
    if (badge && !locked) badge.remove();
  });

  const gate = document.getElementById("gateHint");
  if (gate) {
    gate.innerHTML = open
      ? `<span class="tag green">今日已解锁</span><span>「每日必写」已完成，可以自由选择拓展模块，写几次都可以。</span>`
      : `<span class="tag gray">尚未解锁</span><span>先完成今天的「每日必写」，完成后「每日任务 / 范文临摹 / 文章补写」自动解锁。</span>`;
  }
  const lockBtn = document.getElementById("startFreeBtn");
  if (lockBtn) lockBtn.classList.toggle("pulse", !open);
}

// 右上角图形化统计：今日环形进度 + 本周柱状 + 月分数 + 金币
function renderStatWidget() {
  const box = document.getElementById("statWidget");
  if (!box) return;
  const balance = coinBalance();
  const C = 2 * Math.PI * 30;

  // 右上角统计组件跟随当前模块：写作看"今日分"，体能看"今日完成度"
  const isFitness = state.module === "fitness";
  const main = isFitness ? fitnessCompletion(todayKey()) : dayDetail(todayKey());
  // fitnessCompletion 只有完成度、没有"今天是否已结算"，这里取当天最好成绩来判
  const settledToday = isFitness ? fitnessDayDetail(todayKey()).done : main.done;
  const full = isFitness ? 100 : Math.max(1, state.rewards.thresholds.gold);
  const value = isFitness ? main.percent : main.score;
  const medal = isFitness ? (main.rest ? "none" : fitnessMedalOf(main.percent)) : main.medal;

  const ratio = Math.max(0, Math.min(1, value / full));
  const dash = (ratio * C).toFixed(1);

  const weekBars = (isFitness ? fitnessWeekDetails() : weekDetails()).map(day => {
    const v = isFitness ? day.completion : day.score;
    const h = v > 0 ? Math.max(10, Math.min(100, (v / full) * 100)) : 5;
    const title = isFitness ? `${day.key} · ${day.completion}%` : `${day.key} · ${day.score} 分`;
    return `<i class="spark ${day.medal}" style="height:${h.toFixed(0)}%" title="${title}"></i>`;
  }).join("");

  const medalText = isFitness
    ? (main.rest ? "🌤️ 今天休息" : (settledToday ? `${MEDAL_ICON[medal]} ${MEDAL_LABEL[medal]}` : (main.percent > 0 ? `已练 ${main.percent}%，待提交` : "待完成今日训练")))
    : `${MEDAL_ICON[medal]} ${main.done ? MEDAL_LABEL[medal] : "待完成每日必写"}`;

  const motionToday = motionDayDetail(todayKey());
  const lines = isFitness
    ? `<span>本周 <strong>${fitnessTrainingDays() ? fitnessWeekDetails().filter(d => d.done).length : 0}</strong> 练</span>
       <span>连续 <strong>${fitnessStreak()}</strong> 天</span>
       ${motionToday.score > 0 ? `<span>📷 <strong>${motionToday.score}</strong> 分</span>` : ""}
       <span class="coin-line">🪙 <strong>${balance}</strong></span>`
    : `<span>周 <strong>${weekScore()}</strong></span>
       <span>月 <strong>${monthScore()}</strong></span>
       <span class="coin-line">🪙 <strong>${balance}</strong></span>`;

  box.className = `stat-widget medal-${medal}`;
  box.dataset.module = state.module || "write";
  box.title = isFitness ? "点击查看体能积分" : "点击查看积分榜";
  box.innerHTML = `
    <div class="stat-donut">
      <svg viewBox="0 0 72 72" aria-hidden="true">
        <circle class="donut-track" cx="36" cy="36" r="30"></circle>
        <circle class="donut-fill" cx="36" cy="36" r="30"
                stroke-dasharray="${dash} ${(C - ratio * C).toFixed(1)}"
                transform="rotate(-90 36 36)"></circle>
      </svg>
      <div class="donut-center"><strong>${value}</strong><small>${isFitness ? "完成度%" : "今日分"}</small></div>
    </div>
    <div class="stat-body">
      <div class="stat-medal">${medalText}</div>
      <div class="stat-spark" aria-label="${isFitness ? "本周每日完成度" : "本周每日分数"}">${weekBars}</div>
      <div class="stat-lines">${lines}</div>
    </div>`;
}

/* ---------- 游戏卡（积分榜：这周能不能玩游戏） ----------
 *
 * 老李原话：「在积分榜中增加一个是否可以游戏的判断，有三张可变色的游戏卡」。
 * 三张卡初始灰色，达到条件变彩色：
 *   卡1 一周内完成今日训练 ≥3 天 且 70 分作文 ≥3 篇
 *   卡2 一周内完成今日训练 ≥5 天 且 70 分作文 ≥3 篇
 *   卡3 一周内完成今日训练 ≥5 天 且 70 分作文 ≥5 篇
 *
 * 口径（2026-10-22 定，全部从 state 现算、不额外落库 —— 与 dayScore 同一思路，
 * 避免"改了数据但汇总没同步"的双写不一致）：
 *   周窗口   今天所在的「周六 → 周五」7 天周期。周一~周五看就是"上一周周六到本周周五"；
 *            周六/周日时周期从本周六算起，卡片不会提前冻结成上周的结果。
 *   训练天数 窗口内完成「今日训练」并提交结算的天数（state.fitness.sessions）。
 *            同一天练多次只算一次 —— "完成当日训练"按天算，靠反复提交刷次数没有意义。
 *   作文篇数 窗口内 AI 得分 > 70 的作文篇数（所有模块都算；"超过 70"不含 70 本身）。
 * 卡3 全亮时卡1、卡2 必然也亮；三张卡各自独立判断，互不依赖。
 */

// 今天所在的「周六 → 周五」周周期（7 天）
function gameWeekKeys(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const back = (d.getDay() + 1) % 7; // 周六回退 0 天、周日 1 天、周一 2 天 …… 周五 6 天
  const start = new Date(d);
  start.setDate(d.getDate() - back);
  return Array.from({ length: 7 }, (_, i) => addDays(todayKey(start), i));
}

// 窗口内完成「今日训练」的天数（同一天多次提交只算一次）
function gameWeekTrainDays(date = new Date()) {
  const keys = new Set(gameWeekKeys(date));
  const days = new Set();
  state.fitness.sessions.forEach(item => {
    const key = todayKey(new Date(item.date));
    if (keys.has(key)) days.add(key);
  });
  return days.size;
}

// 窗口内得分超过 70 分的作文篇数（"超过 70"不含 70 本身）
function gameWeekGoodEssays(date = new Date()) {
  const keys = new Set(gameWeekKeys(date));
  return state.essays.filter(item =>
    keys.has(todayKey(new Date(item.date))) && essayPoints(item) > 70
  ).length;
}

// 三张游戏卡的解锁状态（实时推导，不落库）
function gameCardStatus(date = new Date()) {
  const trainDays = gameWeekTrainDays(date);
  const goodEssays = gameWeekGoodEssays(date);
  const rules = [
    { train: 3, essays: 3 },
    { train: 5, essays: 3 },
    { train: 5, essays: 5 }
  ];
  return {
    keys: gameWeekKeys(date),
    trainDays,
    goodEssays,
    cards: rules.map(rule => ({
      needTrain: rule.train,
      needEssays: rule.essays,
      unlocked: trainDays >= rule.train && goodEssays >= rule.essays
    }))
  };
}

/* 游戏卡：三张猫咪卡图（老李 10-23 提供的原图，960×1920 竖版卡）。
 * 懒猫 → 第一次游戏机会；游戏猫 → 第二次；干饭猫 → 第三次。
 * 卡面是图片本体，背面写解锁进度；未解锁整张去灰，解锁后恢复彩色。 */
const GAME_CARDS = [
  { img: "assets/img/game-cards/lazy-cat.jpg", name: "懒猫",   chance: "第一次游戏机会" },
  { img: "assets/img/game-cards/play-cat.jpg", name: "游戏猫", chance: "第二次游戏机会" },
  { img: "assets/img/game-cards/food-cat.jpg", name: "干饭猫", chance: "第三次游戏机会" }
];

/* ---------- 模块选择页（首页）奖励区 ----------
 * 老李 10-23：「游戏卡牌……应该放在首页，放在首页的'每日一写''每日一练'下方正中央；
 * 再把积分榜中的'金币奖金池'这部分也挪到首页，放到游戏卡下面」。
 * 这里渲染三块：共用奖金池（写作+体能+体感）、三张游戏卡、兑换记录。 */
function renderChooserRewards() {
  /* 共用奖金池：两个模块的金币进同一个池，家长在「家长管理」里统一兑换 */
  const pool = document.getElementById("coinPool");
  if (pool) {
    const earned = coinsEarned();
    const spent = coinsSpent();
    const balance = Math.max(0, earned - spent);
    const r = state.rewards;
    const medalRows = ["gold", "silver", "bronze"].map(kind => `
      <div class="medal-row ${kind}">
        <span class="medal-icon">${MEDAL_ICON[kind]}</span>
        <span class="medal-name">${MEDAL_LABEL[kind]}</span>
        <span class="medal-line">满 <strong>${r.thresholds[kind]}</strong> 分</span>
        <span class="medal-coin">${r.coins[kind]} 🪙</span>
      </div>`).join("");
    const overSpent = spent > earned
      ? `<div class="redeem-rate warn"><span>提示</span><div>家长调整过奖励规则，按新规则重算后累计金币为 ${earned}，已兑换 ${spent}。可用金币已按 0 计。</div></div>`
      : "";
    pool.innerHTML = `
      <div class="coin-hero">
        <span>可用金币</span>
        <strong>${balance}</strong>
        <small>累计获得 ${earned} · 已兑换 ${spent}</small>
      </div>
      <div class="coin-split">
        <div><span>✍️ 写作获得</span><strong>${writingCoinsEarned()}</strong></div>
        <div><span>🏃 体能获得</span><strong>${fitnessCoinsEarned()}</strong></div>
        <div><span>📷 体感获得</span><strong>${motionCoinsEarned()}</strong></div>
      </div>
      <div class="medal-rules">
        <p class="medal-rules-head">每天只发一个牌 · 按当日总分取最高那一档</p>
        ${medalRows}
        <p class="medal-rules-foot">三档不会叠加：拿到金牌就只拿金牌那一档的金币。</p>
      </div>
      <div class="redeem-rate">
        <span>兑换比例（家长设置）</span>
        <div>1 金币 = <strong>${r.redeem.minutesPerCoin}</strong> 分钟游戏时间</div>
        <div>1 金币 = <strong>${r.redeem.yuanPerCoin}</strong> 元零钱</div>
      </div>
      ${overSpent}`;
  }

  /* 游戏卡：三张猫咪卡初始灰色，达到条件变彩色（口径见 gameCardStatus 上面的注释）。
   * 正面是卡图，背面是本周进度；鼠标悬停（或点击，触屏用）整张卡绕横轴翻起。 */
  const gameBox = document.getElementById("gameCards");
  if (gameBox) {
    const g = gameCardStatus();
    const range = document.getElementById("gameWeekRange");
    if (range) {
      const fmt = key => key.slice(5).replace("-", "/");
      range.textContent = `统计周期 ${fmt(g.keys[0])} ~ ${fmt(g.keys[6])}（周六 → 周五）`;
    }
    gameBox.innerHTML = g.cards.map((card, i) => {
      const meta = GAME_CARDS[i] || GAME_CARDS[0];
      const tone = ["pink", "amber", "indigo"][i] || "pink";
      const trainOk = g.trainDays >= card.needTrain;
      const essayOk = g.goodEssays >= card.needEssays;
      return `<div class="game-card ${tone} ${card.unlocked ? "unlocked" : "locked"}" data-game-card="${i + 1}">
        <div class="game-card-flip">
          <div class="game-face game-face-front">
            <img src="${meta.img}" alt="游戏卡 ${i + 1}：${meta.name}（${meta.chance}）" />
          </div>
          <div class="game-face game-face-back">
            <strong>${meta.name}</strong>
            <small>${meta.chance}</small>
            <ul>
              <li class="${trainOk ? "ok" : ""}">训练 <b>${g.trainDays}</b>/${card.needTrain} 天</li>
              <li class="${essayOk ? "ok" : ""}">70 分作文 <b>${g.goodEssays}</b>/${card.needEssays} 篇</li>
            </ul>
            <p>统计周期：周六 → 周五</p>
          </div>
        </div>
        <div class="game-card-foot">
          <div class="game-card-foot-top">
            <strong>游戏卡 ${i + 1} · ${meta.name}</strong>
            <span class="game-card-flag">${card.unlocked ? "✨ 可游戏" : "🔒 未解锁"}</span>
          </div>
          <span class="game-card-progress">训练 <b class="${trainOk ? "ok" : ""}">${g.trainDays}</b>/${card.needTrain} 天 · 70 分作文 <b class="${essayOk ? "ok" : ""}">${g.goodEssays}</b>/${card.needEssays} 篇</span>
        </div>
      </div>`;
    }).join("");
    // 点击翻牌（触屏没有 hover，点一下翻过来，再点一下翻回去）
    gameBox.querySelectorAll(".game-card").forEach(el => {
      el.addEventListener("click", () => el.classList.toggle("flipped"));
    });
  }

  const hist = document.getElementById("redeemHistory");
  if (hist) {
    if (!state.redemptions.length) {
      hist.innerHTML = "<p class=\"hint\">还没有兑换记录。兑换由家长在「家长管理」里操作。</p>";
    } else {
      hist.innerHTML = state.redemptions.slice().reverse().map(item => {
        const when = new Date(item.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const what = item.kind === "game" ? `${item.amount} 分钟游戏时间` : `${item.amount} 元零钱`;
        return `<div class="redeem-row"><span>${when}</span><strong>${what}</strong><small>消耗 ${item.coins} 🪙</small></div>`;
      }).join("");
    }
  }
}

/* 写作金币（积分榜左上卡，与「体能积分」页的「体能金币」同口径）：
 * 只算写作这一块，共用奖金池的总额在模块选择页看。 */
function renderWriteCoins() {
  const box = document.getElementById("writeCoinPool");
  if (!box) return;
  const earned = writingCoinsEarned();
  const r = state.rewards;
  // 三档只是"分数线表"，不是三份奖励：同一天只按当日总分取**最高**那一档结算
  const medalRows = ["gold", "silver", "bronze"].map(kind => `
    <div class="medal-row ${kind}">
      <span class="medal-icon">${MEDAL_ICON[kind]}</span>
      <span class="medal-name">${MEDAL_LABEL[kind]}</span>
      <span class="medal-line">满 <strong>${r.thresholds[kind]}</strong> 分</span>
      <span class="medal-coin">${r.coins[kind]} 🪙</span>
    </div>`).join("");

  box.innerHTML = `
    <div class="coin-hero">
      <span>写作累计金币</span>
      <strong>${earned}</strong>
      <small>共写作 ${state.essays.length} 篇 · 连续 ${getStreak()} 天</small>
    </div>
    <div class="medal-rules">
      <p class="medal-rules-head">每天只发一个牌 · 按当日总分取最高那一档</p>
      ${medalRows}
      <p class="medal-rules-foot">三档不会叠加：拿到金牌就只拿金牌那一档的金币。</p>
    </div>
    <p class="hint">写作金币会和体能、体感金币合并成共用的奖金池，在模块选择页一眼看到总额；兑换由家长在「家长管理」里操作。</p>`;
}

/* 写作积分榜：模板与「每日一练 → 体能积分」保持一致（金币 + 本周榜单 + 本月走势），
 * 只统计写作部分；共用奖金池、游戏卡、兑换记录已移到模块选择页。 */
function renderScoreboard() {
  renderWriteCoins();

  const rank = document.getElementById("weekRank");
  if (rank) {
    const days = weekDetails().filter(day => dateFromKey(day.key) <= new Date());
    const sorted = [...days].sort((a, b) => b.score - a.score);
    const weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const todayK = todayKey();
    const top = sorted[0]?.score || 0;
    rank.innerHTML = sorted.map((day, index) => {
      const d = dateFromKey(day.key);
      const isToday = day.key === todayK;
      const rankClass = index === 0 && top > 0 ? "top1" : index === 1 && top > 0 ? "top2" : index === 2 && top > 0 ? "top3" : "";
      return `<div class="rank-row ${rankClass} ${isToday ? "is-today" : ""}">
        <span class="rank-no">${index + 1}</span>
        <span class="rank-day">${weekday[(d.getDay() + 6) % 7]}<small>${day.key.slice(5)}${isToday ? " · 今天" : ""}</small></span>
        <span class="rank-bar"><i style="width:${top > 0 ? Math.max(2, (day.score / top) * 100) : 0}%"></i></span>
        <span class="rank-medal">${MEDAL_ICON[day.medal]}</span>
        <span class="rank-score">${day.score}</span>
      </div>`;
    }).join("");
    if (!sorted.length) rank.innerHTML = "<p class=\"hint\">本周还没有记录。</p>";
  }

  const legend = document.getElementById("monthLegend");
  if (legend) {
    const r = state.rewards;
    legend.innerHTML = `<span><i class="dot gold"></i>金牌线 ${r.thresholds.gold}</span>
      <span><i class="dot silver"></i>银牌线 ${r.thresholds.silver}</span>
      <span><i class="dot bronze"></i>铜牌线 ${r.thresholds.bronze}</span>`;
  }
}

// 当月每日总分走势曲线（含三条奖牌分数线）
function drawMonthChart() {
  const canvas = document.getElementById("monthChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 34;
  ctx.clearRect(0, 0, W, H);

  const keys = monthDayKeys();
  const todayK = todayKey();
  const values = keys.map(key => (key <= todayK ? dayScore(key) : null));
  const t = state.rewards.thresholds;
  const maxVal = Math.max(t.gold, ...values.filter(v => v !== null), 10);
  const top = Math.ceil((maxVal * 1.15) / 20) * 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xOf = i => padL + (keys.length <= 1 ? 0 : (i / (keys.length - 1)) * plotW);
  const yOf = v => padT + plotH - (v / top) * plotH;

  ctx.font = "12px Microsoft YaHei";
  ctx.textBaseline = "middle";

  // 横向网格 + y 轴刻度
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const v = (top / steps) * i;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.strokeStyle = "#eef2f7";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(v)), padL - 10, y);
  }

  // 三条奖牌分数线
  [["gold", "#f59e0b"], ["silver", "#94a3b8"], ["bronze", "#d97706"]].forEach(([kind, color]) => {
    const y = yOf(t[kind]);
    ctx.beginPath();
    ctx.setLineDash([6, 6]);
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.65;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(MEDAL_LABEL[kind], padL + 4, y - 9);
  });

  // x 轴日期
  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "center";
  keys.forEach((key, i) => {
    const dayNum = Number(key.slice(8));
    if (dayNum === 1 || dayNum % 5 === 0) ctx.fillText(String(dayNum), xOf(i), H - padB + 16);
  });

  // 分数折线（只在有成绩的相邻点之间连线）
  const points = [];
  values.forEach((v, i) => { if (v !== null) points.push([xOf(i), yOf(v), v, keys[i]]); });
  if (points.length) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.lineTo(points.at(-1)[0], padT + plotH);
    ctx.lineTo(points[0][0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = "rgba(249, 115, 22, 0.10)";
    ctx.fill();

    points.forEach(([x, y, v, key]) => {
      const medal = medalOf(v);
      const color = medal === "gold" ? "#f59e0b" : medal === "silver" ? "#94a3b8" : medal === "bronze" ? "#d97706" : "#cbd5e1";
      ctx.beginPath();
      ctx.arc(x, y, key === todayK ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (key === todayK) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });
  } else {
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "center";
    ctx.fillText("本月还没有成绩记录", W / 2, padT + plotH / 2);
  }
}

/* 家长管理是否放行。
 * 只有家长**明确要求**密码（passwordEnabled === true）时才需要登录；
 * 默认（以及老数据里没有这个字段时）直接放行 —— 免得忘了密码就再也进不去设置。 */
function adminPasswordRequired() {
  return state.admin.passwordEnabled === true;
}

function adminUnlocked() {
  if (!adminPasswordRequired()) return true;
  return Date.now() - (state.admin.unlockedAt || 0) < 20 * 60 * 1000;
}

function renderAdmin() {
  const lock = document.getElementById("adminLock");
  const panel = document.getElementById("adminPanel");
  if (!lock || !panel) return;
  const unlocked = adminUnlocked();
  const needPass = adminPasswordRequired();
  // 只有"启用密码 + 未登录"才显示密码输入框；
  // 没启用密码时直接放行，锁页整个不出现（少一次无意义的点击）。
  lock.classList.toggle("hidden", unlocked || !needPass);
  const lockState = document.getElementById("adminLockState");
  if (lockState) {
    // 锁页上如实说明"当前是哪个密码"，家长不用猜
    lockState.textContent = needPass ? `当前密码是 ${state.admin.password}。下次打开时需输入它，本次进入 20 分钟内有效。` : "";
  }
  panel.classList.toggle("hidden", !unlocked);
  if (!unlocked) {
    // 上锁时把输入框里的残留内容清掉，也不让浏览器记住上一次的输入
    const pw = document.getElementById("adminPasswordInput");
    if (pw) pw.value = "";
    return;
  }

  const r = state.rewards;
  document.getElementById("adminGoldScore").value = r.thresholds.gold;
  document.getElementById("adminSilverScore").value = r.thresholds.silver;
  document.getElementById("adminBronzeScore").value = r.thresholds.bronze;
  document.getElementById("adminGoldCoin").value = r.coins.gold;
  document.getElementById("adminSilverCoin").value = r.coins.silver;
  document.getElementById("adminBronzeCoin").value = r.coins.bronze;
  document.getElementById("adminMinutes").value = r.redeem.minutesPerCoin;
  document.getElementById("adminYuan").value = r.redeem.yuanPerCoin;

  // 写作权重与奖牌资格
  const w = r.weights || { dailyRequired: 0.5, otherTasks: 0.5 };
  const q = r.medalQualify || { gold: 200, silver: 150, bronze: 100 };
  const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  setVal("weightDailyRequired", w.dailyRequired);
  setVal("weightOtherTasks", w.otherTasks);
  setVal("qualifyGoldScore", q.gold);
  setVal("qualifySilverScore", q.silver);
  setVal("qualifyBronzeScore", q.bronze);

  // 每日一练时间设置
  const tm = state.fitness.timing || { defaults: { workTime: 30, restTime: 10 } };
  setVal("defaultWorkTime", tm.defaults.workTime);
  setVal("defaultRestTime", tm.defaults.restTime);
  const overrideEl = document.getElementById("defaultTimeOverride");
  if (overrideEl) overrideEl.checked = tm.defaults.override !== false;
  renderTimingPreview();

  // AI 作文评分设置
  renderAiGraderPanel();
  renderPasswordInfo();

  const fr = state.fitness.rewards;
  document.getElementById("fitGoldScore").value = fr.thresholds.gold;
  document.getElementById("fitSilverScore").value = fr.thresholds.silver;
  document.getElementById("fitBronzeScore").value = fr.thresholds.bronze;
  document.getElementById("fitGoldCoin").value = fr.coins.gold;
  document.getElementById("fitSilverCoin").value = fr.coins.silver;
  document.getElementById("fitBronzeCoin").value = fr.coins.bronze;

  const mo = state.fitness.motion;
  const moR = mo.rewards;
  setVal("motionGoldScore", moR.thresholds.gold);
  setVal("motionSilverScore", moR.thresholds.silver);
  setVal("motionBronzeScore", moR.thresholds.bronze);
  setVal("motionGoldCoin", moR.coins.gold);
  setVal("motionSilverCoin", moR.coins.silver);
  setVal("motionBronzeCoin", moR.coins.bronze);
  const moSwitch = document.getElementById("motionEnabled");
  if (moSwitch) moSwitch.checked = !!mo.enabled;

  document.getElementById("adminBalance").textContent = coinBalance();
  document.getElementById("adminSpend").max = Math.max(0, coinBalance());
  document.getElementById("adminPreview").innerHTML = `
    <div>换游戏时间：<strong id="previewMinutes">0</strong> 分钟</div>
    <div>换零钱：<strong id="previewYuan">0</strong> 元</div>`;
  updateRedeemPreview();
}

function updateRedeemPreview() {
  const input = document.getElementById("adminSpend");
  const coins = Math.max(0, Math.min(Number(input?.value) || 0, coinBalance()));
  const r = state.rewards.redeem;
  const m = document.getElementById("previewMinutes");
  const y = document.getElementById("previewYuan");
  if (m) m.textContent = (coins * r.minutesPerCoin).toFixed(0);
  if (y) y.textContent = (coins * r.yuanPerCoin).toFixed(2).replace(/\.00$/, "");
}

/* ---------- 家长管理操作 ---------- */

/* 密码归一化：中文输入法下很容易打出「全角数字」（１２３４），
 * 屏幕上和半角长得几乎一样，肉眼分辨不出来，但 === 比较必然失败。
 * 另外还有零宽空格、不间断空格、各种横线等"看不见的字符"。
 * 这里统一折叠成标准形式，否则家长会一直卡在"密码明明是对的却进不去"。
 */
function normalizeSecret(raw) {
  return String(raw == null ? "" : raw)
    // 全角 → 半角（！到～ 整段）
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 全角空格
    .replace(/\u3000/g, " ")
    // 各种零宽 / 不可见字符
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // 不间断空格
    .replace(/\u00A0/g, " ")
    .trim();
}

function adminLogin() {
  const input = document.getElementById("adminPasswordInput");
  const rawValue = input?.value || "";
  const value = normalizeSecret(rawValue);
  if (!value) { toast("请输入家长密码。"); return; }
  if (value !== normalizeSecret(state.admin.password)) {
    // 全角/半角这类"看着一样"的错误，单独给一句人话提示，避免家长反复怀疑密码被改
    const looksSame = value === String(state.admin.password) && rawValue !== value;
    toast(looksSame ? "密码里的数字是全角，已按半角比对仍不符，请重输。" : "密码不对，请再试一次。");
    if (input) { input.value = ""; input.focus(); }
    return;
  }
  state.admin.unlockedAt = Date.now();
  saveState();
  if (input) input.value = "";
  renderAdmin();
  toast("已进入家长管理。");
}

/* 关掉密码：立即生效，不再需要任何验证。
 * 这不是安全漏洞——家长管理本来就是"家长自己的面板"，
 * 单机场景下"进不去"的代价远大于"孩子可能乱改"的代价。
 * 锁页和管理页各有一个入口，锁页那个是忘记密码时唯一能自救的地方。 */
function disableAdminPassword() {
  state.admin.passwordEnabled = false;
  state.admin.unlockedAt = Date.now();   // 顺手放行，家长就在里面
  saveState();
  renderAdmin();
  toast("已关闭家长密码，以后直接点「家长管理」就能进来。");
}

function setAdminPasswordEnabled(on) {
  state.admin.passwordEnabled = !!on;
  // 两种情况都把"现在"记为解锁时刻：
  //  - 开启：家长正站在面板里点这个开关，没理由反手把他踢出去。
  //    密码从"退出后"开始生效 —— 锁页上也写明了这一点。
  //  - 关闭：本来就不拦了，顺手放行。
  state.admin.unlockedAt = Date.now();
  saveState();
  renderAdmin();
  renderPasswordInfo();   // 开关切换后状态文案必须立刻变，家长要看到"究竟生效没有"
  toast(on ? "已开启密码保护，下次进入家长管理需要输入密码。" : "已关闭密码保护，进入家长管理不再需要密码。");
}

function adminLogout() {
  state.admin.unlockedAt = 0;
  saveState();
  renderAdmin();
  toast("已退出家长管理。");
}

function saveRewards() {
  const readNum = (id, min, max, fallback) => {
    const v = Number(document.getElementById(id).value);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  };
  const gold = readNum("adminGoldScore", 1, 2000, state.rewards.thresholds.gold);
  const silver = readNum("adminSilverScore", 1, 2000, state.rewards.thresholds.silver);
  const bronze = readNum("adminBronzeScore", 1, 2000, state.rewards.thresholds.bronze);
  if (!(gold >= silver && silver >= bronze)) {
    toast("分数线要满足：金牌 ≥ 银牌 ≥ 铜牌。");
    return;
  }
  state.rewards = {
    thresholds: { gold, silver, bronze },
    coins: {
      gold: readNum("adminGoldCoin", 0, 999, state.rewards.coins.gold),
      silver: readNum("adminSilverCoin", 0, 999, state.rewards.coins.silver),
      bronze: readNum("adminBronzeCoin", 0, 999, state.rewards.coins.bronze)
    },
    redeem: {
      minutesPerCoin: readNum("adminMinutes", 0, 600, state.rewards.redeem.minutesPerCoin),
      yuanPerCoin: readNum("adminYuan", 0, 1000, state.rewards.redeem.yuanPerCoin)
    }
  };
  saveState();
  renderAll();
  renderAdmin();
  toast("奖励规则已保存，立即生效。");
}

// 体能奖励规则：用"完成度(%)"判定奖牌
function saveFitnessRewards() {
  const readNum = (id, min, max, fallback) => {
    const v = Number(document.getElementById(id).value);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  };
  const gold = readNum("fitGoldScore", 1, 100, state.fitness.rewards.thresholds.gold);
  const silver = readNum("fitSilverScore", 1, 100, state.fitness.rewards.thresholds.silver);
  const bronze = readNum("fitBronzeScore", 1, 100, state.fitness.rewards.thresholds.bronze);
  if (!(gold >= silver && silver >= bronze)) {
    toast("完成度线要满足：金牌 ≥ 银牌 ≥ 铜牌。");
    return;
  }
  state.fitness.rewards = {
    thresholds: { gold, silver, bronze },
    coins: {
      gold: readNum("fitGoldCoin", 0, 999, state.fitness.rewards.coins.gold),
      silver: readNum("fitSilverCoin", 0, 999, state.fitness.rewards.coins.silver),
      bronze: readNum("fitBronzeCoin", 0, 999, state.fitness.rewards.coins.bronze)
    }
  };
  saveState();
  renderAll();
  renderAdmin();
  toast("体能奖励规则已保存，立即生效。");
}

// 写作权重与奖牌资格保存
function saveWritingWeights() {
  const readNum = (id, min, max, fallback) => {
    const v = Number(document.getElementById(id).value);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  };
  const dailyW = readNum("weightDailyRequired", 0, 1, 0.5);
  const otherW = readNum("weightOtherTasks", 0, 1, 0.5);
  if (Math.abs(dailyW + otherW - 1.0) > 0.01) {
    toast("权重之和必须等于 1.0（100%）。");
    return;
  }
  const gold = readNum("qualifyGoldScore", 1, 500, 200);
  const silver = readNum("qualifySilverScore", 1, 500, 150);
  const bronze = readNum("qualifyBronzeScore", 1, 500, 100);
  if (!(gold >= silver && silver >= bronze)) {
    toast("奖牌资格分数线要满足：金牌 ≥ 银牌 ≥ 铜牌。");
    return;
  }
  state.rewards.weights = { dailyRequired: dailyW, otherTasks: otherW };
  state.rewards.medalQualify = { gold, silver, bronze };
  saveState();
  renderAll();
  renderAdmin();
  toast("写作权重与奖牌资格已保存。");
}

// 每日一练时间设置保存
function saveTimingSettings() {
  const readNum = (id, min, max, fallback) => {
    const v = Number(document.getElementById(id).value);
    if (!Number.isFinite(v)) return fallback;
    return clamp(Math.round(v), min, max);
  };
  const workTime = readNum("defaultWorkTime", 5, 300, 30);
  const restTime = readNum("defaultRestTime", 3, 120, 10);
  const overrideEl = document.getElementById("defaultTimeOverride");
  const override = overrideEl ? !!overrideEl.checked : true;
  if (!state.fitness.timing) state.fitness.timing = { defaults: {}, custom: {} };
  state.fitness.timing.defaults = { workTime, restTime, override };
  saveState();
  renderAll();
  renderAdmin();
  toast(`已保存：每个动作 ${workTime} 秒，组间休息 ${restTime} 秒。${override ? "以你的设置为准。" : "改用教案建议时长。"}`);
}

/* 把"设了之后到底会变成什么样"直接算给家长看。
 * 之前家长改了数字却看不到任何变化，这本身就是最容易让人怀疑"设置没生效"的地方。 */
function renderTimingPreview() {
  const box = document.getElementById("timingPreview");
  if (!box) return;
  const day = fitnessDayFor(new Date());
  if (!day || day.rest) { box.textContent = "今天是休息日，没有可预览的训练。"; return; }
  const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
  const first = [...blocks.main, ...blocks.warmup, ...blocks.cooldown][0];
  if (!first) { box.textContent = "今天没有可预览的训练项目。"; return; }

  const tm = fitTiming();
  const plan = fitPlanFor(first);
  const work = plan.segments.filter(s => s.kind === "work").length;
  const rests = plan.segments.filter(s => s.kind === "rest");
  const total = plan.segments.reduce((sum, s) => sum + s.seconds, 0);
  const restSec = rests.length ? rests[0].seconds : tm.restTime;
  box.innerHTML = `以今天的「${escapeHtml(first.name)}」为例：` +
    `<strong>${work} 段运动（每段 ${plan.segments[0].seconds} 秒）+ ${rests.length} 段休息（每段 ${restSec} 秒）</strong>` +
    `，合计约 ${Math.round(total / 60 * 10) / 10} 分钟。${tm.override ? "当前按你的设置执行。" : "当前按教案建议执行，你的设置暂未生效。"}`;
}

function doRedeem(kind) {
  const input = document.getElementById("adminSpend");
  const coins = Math.max(0, Math.floor(Number(input?.value) || 0));
  const balance = coinBalance();
  if (coins <= 0) { toast("请输入要兑换的金币数量。"); return; }
  if (coins > balance) { toast(`金币不够，当前可用 ${balance} 个。`); return; }
  const rate = state.rewards.redeem;
  const raw = kind === "game" ? coins * rate.minutesPerCoin : coins * rate.yuanPerCoin;
  const amount = Math.round(raw * 100) / 100;
  const what = kind === "game" ? `${amount} 分钟游戏时间` : `${amount} 元零钱`;
  if (!confirm(`确认用 ${coins} 个金币兑换「${what}」吗？`)) return;
  state.redemptions.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    at: new Date().toISOString(),
    coins,
    kind,
    amount
  });
  saveState();
  renderAll();
  renderAdmin();
  toast(`已兑换 ${what}，扣除 ${coins} 个金币。`);
}

/* 修改家长密码。
 *
 * 之前这里不验证当前密码、不二次确认、改完也不显示新密码——
 * 家长在管理页里随手输入点什么（甚至只是想试试回车）就会把密码改掉，
 * 之后就变成"我记得没改过密码，怎么进不去了"。现在补上三道闸：
 *   1. 必须再输一次当前密码（防止误触 / 孩子偷改）
 *   2. 新密码要输两遍且一致（防止打字打错、自己把自己锁在门外）
 *   3. 改完把新密码明确回显一次并提示"请记下来"
 */
function changePassword() {
  const curField = document.getElementById("adminCurrentPassword");
  const nextField = document.getElementById("adminNewPassword");
  const againField = document.getElementById("adminNewPassword2");

  // 三个输入框都过一遍归一化，避免"全角数字"把新密码存成怪东西
  const cur = normalizeSecret(curField?.value);
  const next = normalizeSecret(nextField?.value);
  const again = normalizeSecret(againField?.value);

  // 当前密码校验：只在**确实启用了密码**时才需要。
  // 密码已关闭（或本来没设密码）时，家长就是这个面板的主人，没理由再问一次。
  if (adminPasswordRequired()) {
    if (!cur) { toast("请先输入当前密码，确认是家长本人在操作。"); curField?.focus(); return; }
    if (cur !== normalizeSecret(state.admin.password)) {
      toast("当前密码不对，密码没有改动。");
      if (curField) { curField.value = ""; curField.focus(); }
      return;
    }
  } else if (cur && cur !== normalizeSecret(state.admin.password)) {
    // 已关闭密码时仍然填了当前密码 —— 填错就提醒一下，但不拦着设新密码
    toast("当前密码不对（不过当前并未启用密码，可以继续设置新密码）。");
  }
  // 注意：≥4 位是按**归一化后**的长度算，全角数字不会虚增位数
  if (next.length < 4) { toast("新密码至少 4 位。"); nextField?.focus(); return; }
  if (next !== again) {
    toast("两次输入的新密码不一样，请重新输入。");
    if (againField) { againField.value = ""; againField.focus(); }
    return;
  }
  if (next === normalizeSecret(state.admin.password)) {
    toast("新密码和当前密码一样，直接启用即可，无需修改。");
    state.admin.passwordEnabled = true;      // 至少要让密码生效
    state.admin.unlockedAt = Date.now();
    saveState();
    renderAdmin();
    return;
  }

  const old = normalizeSecret(state.admin.password);
  state.admin.password = next;
  state.admin.passwordEnabled = true;        // 设了新密码 → 自动启用密码保护
  state.admin.unlockedAt = Date.now();
  state.admin.passwordChangedAt = new Date().toISOString();
  state.admin.passwordHistory = [...(state.admin.passwordHistory || []), { from: old, to: next, at: new Date().toISOString() }].slice(-10);
  saveState();

  [curField, nextField, againField].forEach(f => { if (f) f.value = ""; });
  renderAdmin();
  toast(`家长密码已从「${old}」改为「${next}」并已启用，请记下来。`);
}

/* ---------- AI 作文评分设置（家长管理） ---------- */

/* 把"当前密码是什么、什么时候被动过"摆到明面上。
 * 之前密码被改了没有任何痕迹，家长只能凭记忆猜，这就是"密码怎么被改了"这个疑问的来源。 */
function renderPasswordInfo() {
  const box = document.getElementById("adminPasswordInfo");
  if (!box) return;
  const pw = String(state.admin.password || "");
  const changedAt = state.admin.passwordChangedAt;
  const history = Array.isArray(state.admin.passwordHistory) ? state.admin.passwordHistory : [];
  const fmtTime = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const parts = [`当前密码是 <strong>${escapeHtml(pw)}</strong>`];
  if (changedAt) parts.push(`上次修改：${fmtTime(changedAt)}`);
  else parts.push("从未修改过（仍是初始密码）");
  if (history.length) {
    const last = history[history.length - 1];
    parts.push(`最近一次改动：${escapeHtml(last.from)} → ${escapeHtml(last.to)}（${fmtTime(last.at)}）`);
  }
  box.innerHTML = parts.join(" · ") + "。";

  // 当前到底拦不拦，必须一眼看到 —— 家长最怕"我设了到底生效没有"
  const stateEl = document.getElementById("adminPassState");
  if (stateEl) {
    const on = adminPasswordRequired();
    stateEl.innerHTML = on
      ? "🔒 <strong>已启用密码保护</strong>：每次进入家长管理都要输入上面的密码（20 分钟内有效）。"
      : "🔓 <strong>当前没有启用密码</strong>：点左侧「家长管理」可直接进入，不需要输入任何东西。想锁起来就在下面设一个新密码。";
    stateEl.dataset.on = on ? "1" : "0";
  }
  const toggle = document.getElementById("adminPasswordEnabled");
  if (toggle) toggle.checked = adminPasswordRequired();
}

function renderAiGraderPanel() {
  if (!window.AiGrader) return;
  const cfg = AiGrader.config();
  const provider = document.getElementById("aiProvider");
  const model = document.getElementById("aiModel");
  const status = document.getElementById("aiStatus");
  const keyHelp = document.getElementById("aiKeyHelp");
  const testBox = document.getElementById("aiTestResult");

  if (provider) provider.value = cfg.provider;
  // 只回填家长手填过的模型名；为空说明"用服务商默认"，输入框留空由 placeholder 提示
  if (model) {
    model.value = cfg.modelRaw || "";
    model.placeholder = cfg.defaultModel ? `留空即用 ${cfg.defaultModel}` : "留空即可";
  }
  if (status) {
    status.value = !cfg.hasKey ? "未配置（当前用本地规则估分）"
      : cfg.enabled ? `已配置 · ${cfg.apiKeyMasked}` : "已暂停使用";
  }
  if (keyHelp) {
    const p = AiGrader.PROVIDERS[cfg.provider] || {};
    keyHelp.innerHTML = `去 <a href="${escapeHtml(p.keyUrl || "")}" target="_blank" rel="noreferrer">${escapeHtml(p.name || "")} 控制台</a> 申请 API Key。${escapeHtml(p.note || "")} 当前使用模型：<strong>${escapeHtml(cfg.model)}</strong>。`;
  }
  if (testBox) testBox.textContent = "";
}

function saveAiGraderSettings() {
  if (!window.AiGrader) return;
  const keyInput = document.getElementById("aiApiKey");
  const patch = {
    provider: document.getElementById("aiProvider")?.value,
    model: document.getElementById("aiModel")?.value || "",
    enabled: true
  };
  // 输入框里的 Key 只有用户真的填了才覆盖，避免"改个模型名把 Key 清空"
  const typed = (keyInput?.value || "").trim();
  if (typed) patch.apiKey = typed;
  AiGrader.setConfig(patch);
  if (keyInput) keyInput.value = "";
  renderAiGraderPanel();
  toast(AiGrader.isConfigured()
    ? "AI 评分已开启，孩子下次提交作文就会用大模型批改。"
    : "设置已保存，但还没填 API Key，暂时仍用本地规则估分。");
}

function testAiGrader() {
  if (!window.AiGrader) return;
  const box = document.getElementById("aiTestResult");
  if (box) box.textContent = "正在测试连接…";
  // 先存下当前表单里的值，否则测试的是旧配置
  saveAiGraderSettings();
  AiGrader.test().then(r => {
    if (box) {
      box.textContent = (r.ok ? "✅ " : "❌ ") + r.message;
      box.className = `ai-test-result ${r.ok ? "is-ok" : "is-bad"}`;
    }
  });
}

function toggleAiGrader() {
  if (!window.AiGrader) return;
  const cfg = AiGrader.config();
  AiGrader.setConfig({ enabled: !cfg.enabled });
  renderAiGraderPanel();
  toast(cfg.enabled ? "已暂停 AI 评分，暂时改用本地规则估分。" : "已重新开启 AI 评分。");
}

function renderParent() {
  const avg = averageScore();
  const essays = state.essays.length;
  const weak = Object.entries(state.skills).sort((a, b) => a[1] - b[1])[0];
  document.getElementById("parentSummary").textContent = essays ? `${state.profile.name} 已完成 ${essays} 篇作文，当前平均分 ${avg}。从能力画像看，下一阶段建议重点训练“${weak[0]}”。产品会用每日必写建立习惯，用每日任务补短板，用范文临摹拓宽表达类型。` : "还没有足够记录。建议先让孩子完成 3 篇以上作文。";
  document.getElementById("parentFocusList").innerHTML = [
    "每日必写只要求持续表达，不要每天追求高分。",
    "每日任务要轮换：补故事、看图、扩写、词语编文、热点感想。",
    `本周优先看“${weak[0]}”有没有变好。`
  ].map(item => `<li>${escapeHtml(item)}</li>`).join("");

  // 体能部分：把训练频次和自测进步一起给家长看
  const fitBox = document.getElementById("parentFitness");
  if (!fitBox) return;
  const days = fitnessTrainingDays();
  const weekDays = fitnessWeekDetails().filter(d => d.done).length;
  const tests = FITNESS_TESTS.map(test => {
    const first = fitnessTestFirst(test.id);
    const best = fitnessTestBest(test.id);
    if (!first || !best) return null;
    const delta = best.value - first.value;
    return `${test.name} ${first.value} → ${best.value} ${test.unit}（${delta > 0 ? "+" + delta : "持平"}）`;
  }).filter(Boolean);

  fitBox.innerHTML = `
    <div class="parent-fit-grid">
      <div class="parent-fit-stat"><span>累计训练</span><strong>${days}</strong><small>天</small></div>
      <div class="parent-fit-stat"><span>本周训练</span><strong>${weekDays}</strong><small>天</small></div>
      <div class="parent-fit-stat"><span>连续训练</span><strong>${fitnessStreak()}</strong><small>天</small></div>
      <div class="parent-fit-stat"><span>当前阶段</span><strong>第 ${fitnessWeekNo()} 周</strong><small>${escapeHtml(fitnessPhaseOf(fitnessWeekNo()).name)}</small></div>
    </div>
    <p class="hint">${days ? `建议每周保持 5-6 天训练，每次 25-30 分钟。孩子做不动时宁可减组数，也不要整块跳过，更不要连续两天练同一个主题。` : "还没有训练记录。体能训练建议从「心肺耐力日」开始，先让孩子适应节奏。"}</p>
    ${tests.length ? `<h4 class="parent-fit-sub">自测进步</h4><ul class="parent-list">${tests.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
    ${motionHtml()}`;
}

// 家长报告里的体感板块：动作分变化 + 最近的薄弱项
function motionHtml() {
  const list = state.fitness.motion.scores;
  if (!list.length) {
    return `<h4 class="parent-fit-sub">体感跟练</h4>
      <p class="hint">还没有体感记录。体感跟练会用摄像头数次数、看节奏幅度，给每一组动作打 0-100 的动作分，家长可以在「家长管理」里设置动作分对应的金币，也可以整体关掉这个功能。</p>`;
  }
  const best = motionBestRecord();
  const recent = list.slice(-10);
  const avg = Math.round(recent.reduce((sum, item) => sum + item.total, 0) / recent.length);
  const firstAvg = Math.round(list.slice(0, 10).reduce((sum, item) => sum + item.total, 0) / Math.min(10, list.length));
  const delta = avg - firstAvg;

  // 最近 10 次里平均最弱的那一项，就是下一步该提醒孩子的
  const keys = ["完成", "节奏", "规范", "强度", "稳定", "连续"];
  const sums = {};
  recent.forEach(item => Object.keys(item.parts || {}).forEach(k => { sums[k] = (sums[k] || 0) + item.parts[k]; }));
  const weakest = keys
    .filter(k => sums[k] !== undefined)
    .map(k => [k, sums[k] / recent.length])
    .sort((a, b) => a[1] - b[1])[0];

  return `<h4 class="parent-fit-sub">体感跟练</h4>
    <div class="parent-fit-grid">
      <div class="parent-fit-stat"><span>跟练组数</span><strong>${list.length}</strong><small>组</small></div>
      <div class="parent-fit-stat"><span>历史最好</span><strong>${best ? best.total : "--"}</strong><small>分</small></div>
      <div class="parent-fit-stat"><span>最近 10 组均值</span><strong>${avg}</strong><small>分</small></div>
      <div class="parent-fit-stat"><span>相比最初</span><strong>${delta > 0 ? "+" + delta : delta}</strong><small>分</small></div>
    </div>
    <p class="hint">${weakest ? `最近 10 组里平均最弱的一项是「${weakest[0]}」（${Math.round(weakest[1])} 分），可以提醒孩子下次注意这一项。` : ""}体感只分析画面里的运动信号，能看次数、节奏、幅度、左右均衡和保持稳定性，<strong>测不了关节角度</strong>，不能替代教练当面纠正动作。</p>`;
}

function drawRadar() {
  const canvas = document.getElementById("radarCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2 + 8;
  const radius = 105;
  const entries = Object.entries(state.skills).slice(0, 8);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "13px Microsoft YaHei";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    entries.forEach((_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / entries.length;
      const r = radius * ring / 4;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = "#e2e8f0";
    ctx.stroke();
  }

  entries.forEach(([name], index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / entries.length;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.strokeStyle = "#e2e8f0";
    ctx.stroke();
    ctx.fillStyle = "#334155";
    ctx.fillText(name, cx + Math.cos(angle) * (radius + 46), cy + Math.sin(angle) * (radius + 30));
  });

  ctx.beginPath();
  entries.forEach(([_, value], index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / entries.length;
    const r = radius * value / 100;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(249, 115, 22, 0.22)";
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
}

function showScaffold() {
  const active = state.activeWriting || defaultState.activeWriting;
  const key = active.type === "范文临摹" ? "范文临摹" : active.type === "文章补写" ? "文章补写" : active.type === "热点感想" ? "热点感想" : active.type === "每日必写" ? "每日必写" : inferScaffoldKey(active.skill);
  const items = scaffolds[key] || scaffolds["生活"];
  document.getElementById("scaffoldContent").innerHTML = `<p class="hint">按这个顺序想，不是让你照抄。</p><ol class="flow-list">${items.map((item, index) => `<li><span>${index + 1}</span>${escapeHtml(item)}</li>`).join("")}</ol>`;
  document.getElementById("scaffoldModal").classList.remove("hidden");
}

function inferScaffoldKey(skill) {
  if (skill === "故事结构") return "故事";
  if (skill === "环境描写") return "景物";
  if (skill === "想象能力") return "想象";
  if (skill === "内容与立意") return "观点";
  if (skill === "细节描写") return "生活";
  return "生活";
}

function pinTask() {
  const task = getCurrentTask();
  if (!task) return;
  if (!state.pinnedMaterials.includes(task.id)) state.pinnedMaterials.push(task.id);
  saveState();
  alert(`已收藏到本机素材夹，当前共收藏 ${state.pinnedMaterials.length} 条。`);
}

function simulateNewsRefresh() {
  generateSmartTask("news");
  alert("单机版已从内置热点素材池刷新。真实联网采集需要接入本地服务或云端 AI/搜索接口。");
}

function saveProfile() {
  state.profile = {
    name: document.getElementById("childNameInput").value.trim() || "小作家",
    age: Number(document.getElementById("childAgeInput").value) || 10,
    grade: document.getElementById("childGradeInput").value,
    targetWords: Number(document.getElementById("targetWordsInput").value) || 350
  };
  saveState();
  renderAll();
  alert("已保存到本机。");
}

function clearData() {
  if (!confirm("确定清空本机保存的作文、评分和成长数据吗？此操作不会删除任何电脑文件，只会清除浏览器里的本应用数据。")) return;
  state = structuredClone(defaultState);
  saveState();
  renderAll();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach(item => item.addEventListener("click", () => setView(item.dataset.view)));
  document.querySelectorAll("[data-view-target]").forEach(button => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
  document.querySelector("[data-action='start-free']").addEventListener("click", startDailyWriting);
  document.querySelectorAll("[data-action='generate-smart-task']").forEach(button => button.addEventListener("click", () => generateSmartTask()));
  document.querySelector("[data-action='reroll-task']").addEventListener("click", () => generateSmartTask(state.selectedTaskType));
  document.querySelector("[data-action='start-task-writing']").addEventListener("click", startTaskWriting);
  document.querySelector("[data-action='pin-task']").addEventListener("click", pinTask);
  document.querySelector("[data-action='simulate-news-refresh']").addEventListener("click", simulateNewsRefresh);
  document.querySelector("[data-action='reroll-model']").addEventListener("click", rerollModel);
  document.querySelector("[data-action='start-imitate-writing']").addEventListener("click", startImitateWriting);
  // ---- 文章补写 ----
  // ⚠️ 一律用 if 兜：这些元素在 #fillgap 视图里，早前版本存档 / 局部渲染缺失时
  //    直接 querySelector(...).addEventListener 会抛 null，整个 bindEvents 后面的绑定全断。
  const fillReroll = document.querySelector("[data-action='reroll-fill']");
  if (fillReroll) fillReroll.addEventListener("click", rerollFillArticle);
  const fillAi = document.querySelector("[data-action='generate-fill-ai']");
  if (fillAi) fillAi.addEventListener("click", generateFillArticle);
  const fillStart = document.querySelector("[data-action='start-fill-writing']");
  if (fillStart) fillStart.addEventListener("click", startFillWriting);
  document.querySelectorAll("[data-fill-source]").forEach(btn => {
    btn.addEventListener("click", () => setFillSource(btn.dataset.fillSource));
  });
  document.querySelector("[data-action='submit-essay']").addEventListener("click", submitEssay);
  // AI 范文：点按钮才生成（见 generateAiModel 上方说明）。元素在结果页里，
  // 用 if 兜一下，免得哪天卡片被移走就整页报错。
  const genModelBtn = document.getElementById("genModelBtn");
  if (genModelBtn) genModelBtn.addEventListener("click", generateAiModel);
  /* 写作页那个「AI 范文参考」：门禁过了就跳到结果页并立刻开始生成。
   * 为什么要跳页：范文正文显示在结果页的卡片里，而写作页此刻是"空草稿"状态
   * （submitEssay 的 finish() 已经把 draft 清空并跳到结果页了）——
   * 在写作页原地生成，孩子看不到任何东西，会以为"点了没反应"。
   * 滚到卡片是必须的：那张卡在结果页最底下，不滚过去等于还是看不到。 */
  const genModelTopBtn = document.getElementById("genModelTopBtn");
  if (genModelTopBtn) genModelTopBtn.addEventListener("click", () => {
    const gate = canGenerateModelNow();
    if (!gate.ok) { toast(gate.why); return; }
    setView("result");
    generateAiModel();
    setTimeout(() => {
      const card = document.getElementById("aiModelCard");
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  });
  document.querySelector("[data-action='show-scaffold']").addEventListener("click", showScaffold);
  document.querySelector("[data-action='close-scaffold']").addEventListener("click", () => document.getElementById("scaffoldModal").classList.add("hidden"));
  document.querySelector("[data-action='save-profile']").addEventListener("click", saveProfile);
  document.querySelector("[data-action='clear-demo']").addEventListener("click", clearData);

  // 积分 / 家长管理
  const statWidget = document.getElementById("statWidget");
  if (statWidget) statWidget.addEventListener("click", () => setView(state.module === "fitness" ? "fitnessBoard" : "scoreboard"));
  document.querySelector("[data-action='admin-login']").addEventListener("click", adminLogin);
  // 「忘记密码 → 关闭密码」两个入口：锁页上的逃生口 + 管理页里的按钮。
  // 必须都绑上，锁页那个才是真正救命的地方（人还没进去就能用）。
  document.querySelectorAll("[data-action='disable-password']").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("关闭后，点「家长管理」将不再需要密码，可以立刻进去重新设置。确定关闭密码保护吗？")) return;
      disableAdminPassword();
    });
  });
  const passEnabledBox = document.getElementById("adminPasswordEnabled");
  if (passEnabledBox) passEnabledBox.addEventListener("change", () => setAdminPasswordEnabled(passEnabledBox.checked));
  document.querySelector("[data-action='admin-logout']").addEventListener("click", adminLogout);
  document.querySelector("[data-action='save-rewards']").addEventListener("click", saveRewards);
  document.querySelector("[data-action='save-writing-weights']")?.addEventListener("click", saveWritingWeights);
  document.querySelector("[data-action='save-fitness-rewards']").addEventListener("click", saveFitnessRewards);
  document.querySelector("[data-action='save-timing']")?.addEventListener("click", saveTimingSettings);
  // 改一个数字就先把预览刷出来（还没保存也能看到会变成什么样）
  ["defaultWorkTime", "defaultRestTime"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      if (!state.fitness.timing) state.fitness.timing = { defaults: {}, custom: {} };
      const v = Number(el.value);
      if (Number.isFinite(v)) state.fitness.timing.defaults[id === "defaultWorkTime" ? "workTime" : "restTime"] = v;
      renderTimingPreview();
    });
  });
  document.querySelector("[data-action='change-password']").addEventListener("click", changePassword);
  document.querySelector("[data-action='save-ai-grader']")?.addEventListener("click", saveAiGraderSettings);
  document.querySelector("[data-action='test-ai-grader']")?.addEventListener("click", testAiGrader);
  document.querySelector("[data-action='clear-ai-key']")?.addEventListener("click", () => {
    if (!window.AiGrader) return;
    if (!confirm("清除后作文评分会退回本地规则估分，确定清除 API Key 吗？")) return;
    AiGrader.clearKey();
    renderAiGraderPanel();
    toast("已清除 API Key。");
  });
  document.querySelector("[data-action='toggle-ai-grader']")?.addEventListener("click", toggleAiGrader);
  const aiProviderSel = document.getElementById("aiProvider");
  if (aiProviderSel) aiProviderSel.addEventListener("change", () => {
    // 换服务商时同步刷新"去哪申请 Key"的提示，但先不保存（等点保存再落库）
    const p = window.AiGrader && AiGrader.PROVIDERS[aiProviderSel.value];
    const keyHelp = document.getElementById("aiKeyHelp");
    if (p && keyHelp) {
      keyHelp.innerHTML = `去 <a href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(p.name)} 控制台</a> 申请 API Key。${escapeHtml(p.note || "")}`;
    }
  });

  // 模块切换
  document.querySelectorAll("[data-module]").forEach(button => {
    if (button.classList.contains("nav-item")) return;
    button.addEventListener("click", () => setModule(button.dataset.module));
  });
  const switchBtn = document.getElementById("moduleSwitchBtn");
  if (switchBtn) switchBtn.addEventListener("click", backToChooser);

  // 体能训练
  document.querySelector("[data-action='submit-fitness']").addEventListener("click", () => submitFitness());
  document.querySelector("[data-action='timer-toggle']").addEventListener("click", fitTimerToggle);
  document.querySelector("[data-action='timer-reset']").addEventListener("click", fitTimerReset);
  document.querySelector("[data-action='clear-fitness']").addEventListener("click", clearFitnessData);
  document.querySelectorAll("[data-timer]").forEach(button =>
    button.addEventListener("click", () => {
      const sec = Number(button.dataset.timer);
      const isRest = button.dataset.timerKind === "rest";
      if (isRest) {
        fitTimerSet(sec, "组间休息", { name: "组间休息", emoji: "😌", how: "慢慢呼吸，喝两口水，下一轮还要用劲。" });
      } else {
        fitTimerSet(sec, "自由训练", { name: "自由训练", emoji: "🏃", how: "跟着教练的节奏做，注意呼吸不要憋气。" });
      }
      fitTimerRun();     // 快捷时长也直接开跑，不再需要点"继续"
    }));
  document.querySelector("[data-action='reset-today-checklist']")?.addEventListener("click", () => resetTodayChecklist());
  document.querySelector("[data-action='reset-checklist']")?.addEventListener("click", () => resetTodayChecklist());

  // 体感跟练
  document.querySelector("[data-action='motion-camera']")?.addEventListener("click", motionToggleCamera);
  document.querySelector("[data-action='motion-cam-refresh']")?.addEventListener("click", () => {
    motionCamRefresh();
    toast("已重新检测摄像头。");
  });
  const motionCamSelectEl = document.getElementById("motionCamSelect");
  if (motionCamSelectEl) motionCamSelectEl.addEventListener("change", async event => {
    motionCamSave(event.target.value);
    if (motionStream) { motionStopCamera(); await motionToggleCamera(); }
  });
  // 开场骨骼校准
  document.querySelector("[data-action='pose-calib-skip']")?.addEventListener("click", () => {
    motionFlowTeardown();
    toast("已跳过骨骼校准，可以直接开始跟练。");
  });
  /* 人工兜底：自动流程万一没接上（比如语音模块缺失、口令被系统静音），
   * 屏幕上的「开始跟练」仍然可点，点了就走同一条 motionStartSet
   * （照样有口令和倒计时，保证节奏一致）。 */
  document.getElementById("poseCalibGo")?.addEventListener("click", () => {
    if (window.VoiceGuide) window.VoiceGuide.sayOnce("good");
    motionCalibClose(true);
    motionStartSet();
  });
  // 准备层上的「我准备好了，直接开始」：孩子嫌等太久，点了就跳过剩余倒计时
  document.getElementById("posePrepSkip")?.addEventListener("click", () => {
    if (!motionPrep) return;
    motionPrepAbort();
    renderMotionButtons();
    motionStartSetNow();
  });
  // 空房扫描：孩子/家长想直接练就跳过，退回原来的选带判断
  document.getElementById("roomScanSkip")?.addEventListener("click", () => {
    motionRoomScanSkip();
    toast("已跳过房间记录，会用默认判断继续。");
  });
  document.querySelector("[data-action='motion-start']")?.addEventListener("click", motionStartSet);
  document.querySelector("[data-action='motion-finish']")?.addEventListener("click", motionFinishSet);
  document.querySelector("[data-action='motion-reset']")?.addEventListener("click", motionResetSet);

  /* ★ 3D 模型人开关（2026-10-21）。默认关 = 用真实摄像头画面 + 关节点。
   * 切换后立即生效：开着就 show()，关了就 hide()，不用等下一组。 */
  document.querySelector("[data-action='motion-avatar-toggle']")?.addEventListener("click", () => {
    const on = !motionAvatarWanted();
    motionAvatarSetWanted(on);
    if (on) {
      if (window.MotionAvatar) window.MotionAvatar.show();
      toast("已换成 3D 模型人跟练。再点一下可回到真实关节点画面。");
    } else {
      if (window.MotionAvatar) window.MotionAvatar.hide();
      toast("已回到真实关节点画面。");
    }
    motionAvatarSyncBtn();
  });
  motionAvatarSyncBtn();   // 初始化时把按钮文案对齐 localStorage 里的选择
  document.querySelector("[data-action='save-motion-rewards']")?.addEventListener("click", saveMotionRewards);
  document.querySelector("[data-action='clear-motion']")?.addEventListener("click", clearMotionData);
  const motionSelect = document.getElementById("motionExSelect");
  if (motionSelect) motionSelect.addEventListener("change", event => setMotionChoice(Number(event.target.value)));
  // 动作块与自测按钮是动态渲染的，用事件委托
  document.addEventListener("click", event => {
    const toggle = event.target.closest("[data-action='toggle-fit-block']");
    if (toggle) { toggleFitPick(toggle.dataset.block); return; }
    const timeBtn = event.target.closest("[data-action='time-block']");
    if (timeBtn) { timeFitBlock(timeBtn.dataset.block); return; }
    // 「依次进行」：勾选的项目一个个自动启动 / 再点一次停止。按钮是静态的，
    // 但仍走同一个委托，跟动作块保持一致的写法，少一处单独 addEventListener。
    const seqBtn = event.target.closest("[data-action='time-picked-seq']");
    if (seqBtn) { timeFitPickedSequence(); return; }
    const testBtn = event.target.closest("[data-action='save-fit-test']");
    if (testBtn) { saveFitnessTest(testBtn.dataset.test); return; }
    const importBtn = event.target.closest("[data-action='import-video']");
    if (importBtn) {
      const input = ensureVideoInput();
      input.dataset.ex = importBtn.dataset.ex;
      input.click();
      return;
    }
    const removeBtn = event.target.closest("[data-action='remove-video']");
    if (removeBtn) { removeVideo(removeBtn.dataset.ex); return; }
    // 历史日历的格子/翻月/展开全文也是动态渲染的，同样走委托。
    // 关键点：格子整块 innerHTML 重渲染后旧节点会被丢弃，只有委托才不会被"点了没反应"坑到。
    const prevMonth = event.target.closest("[data-action='history-prev-month']");
    if (prevMonth) { shiftHistoryMonth(-1); return; }
    const nextMonth = event.target.closest("[data-action='history-next-month']");
    if (nextMonth) { shiftHistoryMonth(1); return; }
    const thisMonth = event.target.closest("[data-action='history-this-month']");
    if (thisMonth) { historyCal.month = monthKey(); renderHistory(); return; }
    const pickDay = event.target.closest("[data-action='history-pick-day']");
    if (pickDay) { pickHistoryDay(pickDay.dataset.day); return; }
    const toggleText = event.target.closest("[data-action='history-toggle-text']");
    if (toggleText) { toggleHistoryText(toggleText.dataset.essay); return; }
  });
  document.querySelectorAll("[data-redeem]").forEach(button =>
    button.addEventListener("click", () => doRedeem(button.dataset.redeem)));
  const spendInput = document.getElementById("adminSpend");
  if (spendInput) spendInput.addEventListener("input", updateRedeemPreview);
  const pwInput = document.getElementById("adminPasswordInput");
  if (pwInput) pwInput.addEventListener("keydown", event => { if (event.key === "Enter") adminLogin(); });
  // 三个修改密码的输入框都支持回车提交（走的是同一套校验，不会跳过确认）
  ["adminCurrentPassword", "adminNewPassword", "adminNewPassword2"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", event => { if (event.key === "Enter") changePassword(); });
  });
  const categorySelect = document.getElementById("modelCategorySelect");
  if (categorySelect) categorySelect.addEventListener("change", event => setModelCategory(event.target.value));
  const fillSelect = document.getElementById("fillCategorySelect");
  if (fillSelect) fillSelect.addEventListener("change", event => setFillCategory(event.target.value));
  window.addEventListener("beforeunload", () => {
    motionStopCamera();
    fitSeqAbort();   // 关页面/刷新：清掉待触发的自动推进定时器（虽然页面要没了，但保持"任何延时改主状态的流程都可取消"这条规则一致）
    // 只释放我们自己创建的 blob: URL；项目自带的相对路径不能 revoke
    const map = (state.fitness && state.fitness.videoMap) || {};
    Object.values(map).forEach(url => {
      if (typeof url === "string" && url.indexOf("blob:") === 0) {
        try { URL.revokeObjectURL(url); } catch (e) {}
      }
    });
  });
  document.getElementById("essayInput").addEventListener("input", event => {
    state.draft = event.target.value;
    document.getElementById("wordCount").textContent = countChineseChars(state.draft);
    document.getElementById("saveState").textContent = "草稿已保存到本机";
    saveState();
    // 一边写一边变：草稿一动，"这篇评过没有"就可能变了，按钮要跟着灰/亮
    renderGenModelTopBtn();
  });
}

bindEvents();
renderAll();
applyModule();
// 把跟做视频装回来（项目自带的 + 上次导入存在 IndexedDB 里的）
videoBootstrap();
// 画面区尺寸 → CSS 变量（白框/提示要按真实画面区定位，不能按容器）
motionInitStage();

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
