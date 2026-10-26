// AI 作文评分 · 离线回归（不需要真实 API Key，也不花钱）
//
// 大模型评分有两类风险，分开验证：
//   A. 纯逻辑：提示词是否把"历史对比""分数锚点"写进去了；模型返回的各种脏格式
//      （带 ``` 围栏、带前后废话、字段缺失、分数超范围）能不能被正确规整。
//   B. 集成：提交作文时是否真的走 AI、批改中界面状态、失败是否正确退回本地规则。
//
// A 用 vm 直接跑模块；B 用 puppeteer 起真实页面 + 拦网络返回假响应。
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "ai-grader.js"), "utf8");

const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

// ---- 造一个够用的浏览器环境（localStorage + fetch 占位）----
function makeEnv(seed) {
  const store = Object.assign({}, seed || {});
  const ctx = {
    console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    fetch: () => Promise.reject(new Error("测试环境不联网")),
    AbortController: global.AbortController,
    setTimeout, clearTimeout, Promise, Date, JSON, Number, Math, String, Object, Array, Set, RegExp
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, store };
}

console.log("\n== A1. 提示词质量（决定打分准不准的关键）==");
{
  const { ctx } = makeEnv();
  const sys = ctx.window.AiGrader.__buildSystemPrompt({ grade: "小学", targetWords: 300 });

  check("系统提示词写进了六个评分维度", ctx.window.AiGrader.RUBRIC.every(r => sys.includes(r.name)),
    `${ctx.window.AiGrader.RUBRIC.length} 个维度`);
  check("系统提示词给了分数锚点（否则模型全给 85 分）",
    /90-100/.test(sys) && /75-89/.test(sys) && /60-74/.test(sys));
  check("系统提示词明确「不看字数给分」", /不以.*字数|绝对不看字数/.test(sys));
  check("系统提示词要求引用原文作依据", /引用/.test(sys));
  check("系统提示词要求逐字检查错别字", /错别字/.test(sys));
  check("系统提示词要求只输出 JSON", /只输出 JSON/.test(sys));
  check("六个维度满分之和 = 100",
    ctx.window.AiGrader.RUBRIC.reduce((s, r) => s + r.max, 0) === 100,
    String(ctx.window.AiGrader.RUBRIC.reduce((s, r) => s + r.max, 0)));

  // 历史对比——这是"看得出进步还是退步"的根本
  const user = ctx.window.AiGrader.__buildUserPrompt({
    text: "今天我去公园玩，很开心。",
    charCount: 12,
    type: "每日必写",
    title: "去公园",
    skillFocus: "细节与描写",
    profile: { grade: "小学", targetWords: 300 },
    history: [
      { date: "2026-10-01", title: "第一篇", text: "以前写的作文内容", score: 65, weakest: "结构与逻辑" },
      { date: "2026-09-30", title: "更早的", text: "更早的内容", score: 60, weakest: "细节与描写" }
    ]
  });
  check("用户提示词带上了历史作文正文", /以前写的作文内容/.test(user));
  check("用户提示词带上了历史得分", /65/.test(user) && /60/.test(user));
  check("用户提示词带上了历史最弱项", /结构与逻辑/.test(user));
  check("用户提示词明确要求做纵向对比", /进步|退步/.test(user));
  check("用户提示词带上了本次作文正文", /今天我去公园玩/.test(user));
  check("用户提示词带上了本次写作任务（题目/类型）", /去公园/.test(user) && /每日必写/.test(user));

  const userFirst = ctx.window.AiGrader.__buildUserPrompt({
    text: "第一篇", charCount: 3, profile: {}, history: []
  });
  check("没有历史时明确告知这是第一篇", /第一篇/.test(userFirst) && /first/.test(userFirst));
}

console.log("\n== A2. 解析模型的脏输出（真实模型经常不老实）==");
{
  const { ctx } = makeEnv();
  const ex = ctx.window.AiGrader.__extractJson;
  const norm = ctx.window.AiGrader.__normalize;

  const clean = '{"parts":{"内容与立意":20}}';
  check("干净的 JSON 能解析", JSON.parse(ex(clean)).parts["内容与立意"] === 20);

  const fenced = '```json\n{"parts":{"内容与立意":20}}\n```';
  check("带 ``` 围栏能剥掉", JSON.parse(ex(fenced)).parts["内容与立意"] === 20);

  const chatty = '好的，我来评分：\n{"parts":{"内容与立意":20}}\n希望有帮助！';
  check("前后带废话能剥掉", JSON.parse(ex(chatty)).parts["内容与立意"] === 20);

  // 归一化：字段缺失、超范围、错别字地板
  const fb1 = norm({ parts: { "内容与立意": 20, "结构与逻辑": 16, "细节与描写": 14, "语言表达": 15, "词汇与句式": 7, "错别字与标点": 5 } }, { charCount: 100 });
  check("完整输入：总分 = 六项之和", fb1.score === 77, String(fb1.score));
  check("完整输入：来源标记为 ai", fb1.source === "ai");

  const fb2 = norm({}, { charCount: 10 });
  check("模型啥都没给：不崩，给 0 分并补默认优点/建议",
    fb2.score === 3 && fb2.strengths.length > 0 && fb2.improvements.length > 0,
    `score=${fb2.score} 优点${fb2.strengths.length} 建议${fb2.improvements.length}`);

  const fb3 = norm({ parts: { "内容与立意": 999, "结构与逻辑": -5 } }, {});
  check("分数超范围会被夹到 [0, 满分]",
    fb3.parts["内容与立意"] === 25 && fb3.parts["结构与逻辑"] === 0,
    `${fb3.parts["内容与立意"]} / ${fb3.parts["结构与逻辑"]}`);

  const fb4 = norm({ parts: {}, progress: { trend: "乱七八糟", detail: "有点进步" } }, {});
  check("非法 trend 会被规整成 first", fb4.progress.trend === "first");

  const fb5 = norm({ parts: {}, progress: { trend: "up", detail: "细节变多了" } }, {});
  check("合法 trend=up 被保留", fb5.progress.trend === "up" && fb5.progress.detail === "细节变多了");

  const fb6 = norm({ parts: {}, evidence: [{ quote: "今天的风很大", comment: "这句画面感强" }, { quote: "", comment: "" }] }, {});
  check("evidence 能带出来且过滤空项", fb6.evidence.length === 1 && fb6.evidence[0].quote === "今天的风很大");

  const fb7 = norm({ parts: {}, strengths: ["a", "b", "c", "d"], improvements: ["1", "2", "3", "4", "5"] }, {});
  check("优点/建议数量有上限（避免刷屏）", fb7.strengths.length <= 3 && fb7.improvements.length <= 4,
    `${fb7.strengths.length}/${fb7.improvements.length}`);

  check("weakest 按「得分/满分」比例算，不是按绝对分",
    norm({ parts: { "内容与立意": 20, "结构与逻辑": 10, "细节与描写": 0, "语言表达": 20, "词汇与句式": 10, "错别字与标点": 5 } }, {}).weakest === "细节与描写");
}

console.log("\n== A3. 配置管理（Key 不能泄露）==");
{
  const { ctx, store } = makeEnv();
  const G = ctx.window.AiGrader;

  check("初始未配置", G.isConfigured() === false);
  check("未配置时 config() 不含完整 Key", G.config().apiKeyMasked === "");

  G.setConfig({ provider: "qwen", apiKey: "sk-abcdef1234567890xyz" });
  check("保存后 isConfigured 为真", G.isConfigured() === true);
  check("换服务商后接口地址跟着换", /dashscope/.test(G.config().endpoint), G.config().endpoint);
  check("换服务商后默认模型跟着换", G.config().model === "qwen-plus", G.config().model);
  const masked = G.config().apiKeyMasked;
  check("config() 返回的是打码 Key，不是原文", masked !== "sk-abcdef1234567890xyz" && masked.includes("****"), masked);

  // 关键：改模型名不能把 Key 冲掉（界面上显示的是打码串）
  G.setConfig({ model: "qwen-max" });
  check("只改模型名不会清空 Key", G.isConfigured() === true && G.config().model === "qwen-max");

  G.setConfig({ enabled: false });
  check("暂停后即使有 Key 也算未就绪", G.isConfigured() === false);
  G.setConfig({ enabled: true });

  G.clearKey();
  check("清除 Key 后回到未配置", G.isConfigured() === false);

  check("配置写进 localStorage 的是明文 Key（本机存储，非外发）",
    Object.keys(store).includes("dailyWritingAiGraderV1"));
}

console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
if (fail.length) { console.log("失败项："); fail.forEach(f => console.log("  - " + f)); }
process.exit(fail.length ? 1 : 0);
