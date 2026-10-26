/* AI 作文评分 · 调用大模型给孩子作文打分
 *
 * 为什么是「家长自带 Key 直连」，而不是走云端服务：
 *   本应用是 file:// 双击打开的单机版。家长自己在「家长管理」里填一个
 *   API Key 就能用，作文内容只从这台电脑直接发给我们选定的模型服务，
 *   不经过任何中间服务器，也不需要把应用发布上线。
 *   实测 DeepSeek / 通义千问 / 智谱 都对 file:// 的 null origin 放行 CORS。
 *
 * 为什么不用本地关键词规则凑合（以前就是这么做的）：
 *   本地规则只会数"有没有出现看见/听见""有几个句号"，导致：
 *     · 把常用词堆上去就高分，和文章写得好不好无关；
 *     · 同一篇文章重复提交分数几乎不变，看不出真实水平；
 *     · 无法判断"这次比上次好在哪"。
 *   大模型能真正读懂内容，并且能拿到历史作文做纵向对比。
 *
 * 公开接口（window.AiGrader）：
 *   isConfigured()            是否已配置（至少填了 Key）
 *   config()                  当前配置（Key 自动打码，不泄露）
 *   setConfig({...})          保存配置
 *   test()                    连通性自检，返回 {ok, message}
 *   grade(payload)           评分，永远 resolve：{ok:true, feedback} / {ok:false, reason}
 *   writeModel(payload)      ★基于孩子原文扩写出范文，永远 resolve：{ok:true, model} / {ok:false, reason}
 *   PROVIDERS                 内置服务商预设
 */
(function () {
  var STORE_KEY = "dailyWritingAiGraderV1";
  var TIMEOUT_MS = 45000;          // 大模型评分比一般请求慢，给足时间
  var MAX_HISTORY_ESSAYS = 3;      // 历史作文正文最多带几篇（省 token，够做对比）
  var MAX_HISTORY_CHARS = 700;     // 每篇历史正文最多截多少字
  var MAX_ESSAY_CHARS = 6000;      // 本次作文正文上限（防止超长文本打爆上下文）
  /* 范文的长度上限（字）。孩子的原文可能很短，但范文不该变成中篇小说 ——
   * 太长孩子读不完、也不知道该学哪一段。按"目标字数的 2.2 倍"封顶（见 modelWordsFor）。 */
  var MODEL_WORD_MAX = 900;
  /* 范文请求的 max_tokens。中文 1 字 ≈ 1.5~2 token，再留余量给 JSON 外壳。
   * 不设的话有些服务商默认值偏小，范文会被**截断在半句话**上（很难查，因为返回是 200）。 */
  var MODEL_MAX_TOKENS = 2600;

  /* ---- 文章补写（Fill-Gap）专用常量 ----
   * 补写要生成一整篇文章（≤3000 字），比范文长，token 得给足，否则会被截在半句话上。 */
  var FILL_MAX_TOKENS = 5200;
  var FILL_WORD_MAX = 2600;        // 兜底上限（无年级信息时用，见 FILL_GRADE_SCALE）
  var FILL_WORD_MIN = 700;         // 兜底下限
  /* ★★ 各年级的「写作难度标尺」——单位：字。
   *
   * 2026-10-18 放宽：原标尺五年级 800～1200 字，实测模型稳定只写 550～650 字
   * （内容质量很好、句子也短，就是量不够），9 次生成全部因「挖空不足 280 字」作废。
   * 与其跟模型死磕字数，不如把下限降到它稳定能达到的位置 —— 但下限不能随便降：
   *
   *   1. 挖空必须 ≥280 字（normalizeFillArticle 的硬校验）；
   *   2. 挖空不超过全文 50%（原 45%，同步放宽）；
   *   ⇒ 全文至少 280/0.50 = 560 字。所以 min 统一取 600，留 40 字余量。
   *
   * sent = 单句字数上限，para = 单段目标字数。这两个是孩子「读不读得下去」的开关，
   * 跟篇幅无关，不放宽。
   */
  var FILL_GRADE_SCALE = {
    "三年级": { min: 600, max: 800, sent: 18, para: 80 },
    "四年级": { min: 600, max: 900, sent: 20, para: 90 },
    "五年级": { min: 600, max: 1000, sent: 22, para: 100 },
    "六年级": { min: 650, max: 1150, sent: 24, para: 110 }
  };
  /* 没给年级时的兜底：取五年级（与 state.profile 的默认年级一致）。
   * ⚠️ 不要兜底成"小学"——那是个跨 1~6 年级的词，等于没约束。 */
  function fillScaleFor(grade) {
    var g = String(grade == null ? "" : grade).replace(/\s/g, "");
    return FILL_GRADE_SCALE[g] || FILL_GRADE_SCALE["五年级"];
  }
  /* ★★ 把「篇幅区间」翻译成「几段 × 每段多少字」——必须自洽，否则模型一定写短。
   *
   * 踩过的坑（2026-10-18，批量生成 46 次只成 5 篇）：
   *   老写法 `段数 = max(6, round(min/para))`、`每段 = para*0.9 ～ para*1.15`，
   *   五年级算出来是「6～10 段，每段 90～115 字」。模型看到区间就取**下界**：
   *   6 × 90 = 540 字 —— 而提示词另一处又写着"不少于 600 字"。
   *   两个数字互相矛盾，模型服从了具体的那个（段数），于是 46 次里 41 次写不到 560 字，
   *   挖空永远凑不够 280，全部作废。
   *
   * 现在的算法：先定段数，再从篇幅区间**反推**每段区间，保证
   *   nPara × pMin ≥ min  且  nPara × pMax ≤ max
   * 数学上自洽，模型无论取下界还是上界都不会掉出篇幅区间。 */
  function fillLayoutFor(grade) {
    var sc = fillScaleFor(grade);
    /* ★ 段数必须按「模型实际写多长一段」来推，不能按我们希望的段长推。
     *
     * 实测（2026-10-18，deepseek-chat，两轮共 90 次生成）：
     *   · 告诉它「8 段，每段 75～125 字」→ 它真的写 8 段，但每段只有 52～79 字（中位 65）；
     *   · 告诉它「6～10 段，每段 90～115 字」→ 它取 6 段，每段 70～90，全文 540。
     * 结论：**模型对"段数"服从，对"每段字数"基本不服从**。它的自然段长就钉在 65 字左右。
     * 所以想让全文够长，只能加段数 —— 靠"每段写长点"这句话是没用的。
     *
     * 反过来，段短一点对孩子更好读（五年级课文本来也多是 50～80 字一段）。
     * 唯一要守住的是：段数够多 ⇒ 挖空才能凑够 280 字且不超过全文一半。 */
    var PER_PARA = 65;
    var nPara = Math.max(8, Math.round(((sc.min + sc.max) / 2) / PER_PARA));
    return {
      nPara: nPara,
      pMin: Math.ceil(sc.min / nPara),
      pMax: Math.floor(sc.max / nPara),
      floor: Math.ceil(sc.min / nPara) * nPara,   // 全文硬线 = 段数 × 每段下限
      target: Math.round(((sc.min + sc.max) / 2) / 10) * 10,
      scale: sc
    };
  }
  /* ★ 额外加分的硬上限。为什么必须封顶：
   *   1. 六维满分合计 100，额外分若不受限，家长设定的 240 分金牌线会被"补写一篇"轻松顶穿；
   *   2. 大模型天然爱给鼓励分，不封顶它会给 30、40；
   *   3. 封顶值取 10：折合"单维满分的 10%"，足够让一次出色的补写被实打实看见，
   *      又不会盖过一篇完整作文。 */
  var FILL_BONUS_MAX = 10;

  // 内置服务商预设。都用 OpenAI 兼容的 /chat/completions 接口，
  // 家长只要选一家、贴一个 Key 就行，不用自己查地址和模型名。
  var PROVIDERS = {
    deepseek: {
      name: "DeepSeek（深度求索）",
      url: "https://api.deepseek.com/chat/completions",
      model: "deepseek-chat",
      keyUrl: "https://platform.deepseek.com/api_keys",
      note: "中文写作评价质量好，价格便宜（一篇约 1 分钱）"
    },
    qwen: {
      name: "通义千问（阿里云）",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen-plus",
      keyUrl: "https://bailian.console.aliyun.com/",
      note: "有免费额度，中文语感自然"
    },
    zhipu: {
      name: "智谱 GLM",
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4-flash",
      keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      note: "glm-4-flash 型号有免费额度"
    }
  };

  // 六个维度的满分。必须和界面上「评分拆解」的进度条一致。
  var RUBRIC = [
    { name: "内容与立意", max: 25, desc: "写的这件事有没有讲清楚，是否有自己的想法和中心" },
    { name: "结构与逻辑", max: 20, desc: "分段是否合理，事情先后顺序是否清楚，有没有首尾呼应" },
    { name: "细节与描写", max: 20, desc: "有没有具体的动作、语言、心理、感官描写，而不是干巴巴概述" },
    { name: "语言表达", max: 20, desc: "句子是否通顺、用词是否准确，有没有语病和啰嗦" },
    { name: "词汇与句式", max: 10, desc: "词汇是否丰富、有没有重复用词，句式有没有变化" },
    { name: "错别字与标点", max: 5, desc: "错别字、漏字、标点使用是否正确" }
  ];

  var DIM_NAMES = RUBRIC.map(function (r) { return r.name; });
  var DIM_MAX = {};
  RUBRIC.forEach(function (r) { DIM_MAX[r.name] = r.max; });

  /* ---------------- 配置存取 ---------------- */

  function readConfig() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var cfg = raw ? JSON.parse(raw) : null;
      if (!cfg || typeof cfg !== "object") return defaultConfig();
      return {
        provider: PROVIDERS[cfg.provider] ? cfg.provider : "deepseek",
        apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : "",
        model: typeof cfg.model === "string" ? cfg.model : "",
        customUrl: typeof cfg.customUrl === "string" ? cfg.customUrl : "",
        enabled: cfg.enabled !== false
      };
    } catch (e) {
      return defaultConfig();
    }
  }

  function defaultConfig() {
    return { provider: "deepseek", apiKey: "", model: "", customUrl: "", enabled: true };
  }

  function writeConfig(cfg) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 打码：界面上只显示头尾几位，避免家长给孩子看屏幕时整串泄露
  function maskKey(key) {
    var s = String(key || "");
    if (!s) return "";
    if (s.length <= 10) return s.slice(0, 2) + "****";
    return s.slice(0, 6) + "****" + s.slice(-4);
  }

  function endpointOf(cfg) {
    if (cfg.customUrl) return cfg.customUrl;
    var p = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
    return p.url;
  }

  function modelOf(cfg) {
    if (cfg.model) return cfg.model;
    var p = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
    return p.model;
  }

  /* ---------------- 提示词（评分的灵魂） ----------------
   *
   * 这份提示词的目标是**客观、稳定、可复现**，所以刻意做了三件事：
   *   1. 给明确的分数锚点：不写锚点，大模型会习惯性给 85 分，全部分数挤在一起；
   *   2. 要求引用原文原句作为依据：逼它真的读文章，而不是套模板夸两句；
   *   3. 明确"字多≠高分"：否则孩子会靠凑字数刷分。
   */

  function buildSystemPrompt(profile) {
    var grade = (profile && profile.grade) || "小学";
    var targetWords = (profile && profile.targetWords) || 300;
    var lines = [];
    lines.push("你是一位有二十年经验的中文写作老师，正在给" + grade + "的孩子批改作文。");
    lines.push("你的评价必须**客观、真实、有依据**，宁可严格也不要一味鼓励。");
    lines.push("");
    lines.push("【评分维度与满分】总分 100 分，六个维度独立打分，各维度之和必须等于总分：");
    RUBRIC.forEach(function (r) {
      lines.push("  · " + r.name + "（满分 " + r.max + "）：" + r.desc);
    });
    lines.push("");
    lines.push("【分数锚点（必须对照执行，不要都给 85 分）】");
    lines.push("  90-100：非常出色。语言生动有个性，细节丰富，结构完整，几乎无错别字。很少见。");
    lines.push("  75-89 ：良好。内容完整，有一定细节，语句通顺，只有少量小毛病。");
    lines.push("  60-74 ：合格。基本把事情写完了，但明显有短板——流水账、内容单薄或错别字偏多。");
    lines.push("  40-59 ：不合格。篇幅严重不足、偏题、或语句不通顺到影响理解。");
    lines.push("  0-39  ：没有完成写作任务（如只有一两句话）。");
    lines.push("");
    lines.push("【必须遵守的规则】");
    lines.push("  1. 绝对不看字数给分。写得长但啰嗦重复，语言表达分要往下压。");
    lines.push("  2. 每条评价都要能指回原文。strengths 和 improvements 里要引用具体词句。");
    lines.push("  3. 如果引不出具体依据，就不要写这条评价，宁少勿空。");
    lines.push("  4. 错别字与标点这一项要逐字检查，找出真实的错别字、漏字、标点误用。");
    lines.push("  5. 面向孩子说话，用简单的话，不用「遣词造句」「谋篇布局」这类术语。");
    lines.push("  6. 只输出 JSON，不要输出任何解释文字、不要用 markdown 代码块包裹。");
    lines.push("");
    lines.push("【输出 JSON 格式】");
    lines.push("{");
    lines.push('  "parts": { "内容与立意": 数字, "结构与逻辑": 数字, "细节与描写": 数字, "语言表达": 数字, "词汇与句式": 数字, "错别字与标点": 数字 },');
    lines.push('  "strengths": ["值得肯定 1（要引用原文）", "值得肯定 2"],');
    lines.push('  "improvements": ["下次改进 1（要指向具体位置）", "下次改进 2", "下次改进 3"],');
    lines.push('  "nextGoal": "下一篇最该练的一个具体目标，一句话",');
    lines.push('  "narrative": "给孩子的整体点评，2-3 句话，先说好的再说要改的",');
    lines.push('  "evidence": [ { "quote": "原文里的句子", "comment": "这句好在哪或问题在哪" } ],');
    lines.push('  "progress": { "trend": "up|down|flat|first", "detail": "和上一篇比具体变好或变差在哪，要有原文依据；没有历史就填 first" }');
    lines.push("}");
    lines.push("");
    lines.push("写作任务的字数参考：" + targetWords + " 字左右。");
    return lines.join("\n");
  }

  function buildUserPrompt(payload) {
    var p = payload || {};
    var profile = p.profile || {};
    var essay = String(p.text || "");
    if (essay.length > MAX_ESSAY_CHARS) essay = essay.slice(0, MAX_ESSAY_CHARS) + "……（正文过长已截断）";

    var parts = [];
    parts.push("【本次写作任务】");
    parts.push("  类型：" + (p.type || "未说明"));
    parts.push("  题目：" + (p.title || "未说明"));
    parts.push("  训练重点：" + (p.skillFocus || "未说明"));
    if (p.goal) parts.push("  本组目标：" + p.goal);
    if (p.material) parts.push("  给的素材/提示：" + String(p.material).slice(0, 400));
    parts.push("  孩子实际写了 " + (p.charCount || essay.length) + " 字。");
    parts.push("");

    // 历史对比：这是"看得出进步还是退步"的关键。只带最近几篇，控制 token。
    var hist = Array.isArray(p.history) ? p.history : [];
    if (hist.length) {
      parts.push("【这个孩子以前的作文（按时间从新到旧，用来做纵向对比）】");
      hist.slice(0, MAX_HISTORY_ESSAYS).forEach(function (h, i) {
        var t = String(h.text || "");
        if (t.length > MAX_HISTORY_CHARS) t = t.slice(0, MAX_HISTORY_CHARS) + "……";
        parts.push("  第 " + (i + 1) + " 近的一篇：");
        parts.push("    日期：" + (h.date || "未知") + " · 题目：" + (h.title || "无题") + " · 得分：" + (h.score == null ? "未知" : h.score));
        if (h.weakest) parts.push("    当时最弱的一项：" + h.weakest);
        parts.push("    正文节选：" + t.replace(/\s+/g, " "));
      });
      parts.push("  请在 progress 里明确说明：这次比上一篇是进步、退步还是持平，并指出具体在哪里。");
    } else {
      parts.push("【历史】这是孩子的第一篇作文，没有可对比的历史，progress.trend 填 first。");
    }
    parts.push("");
    parts.push("【本次要批改的作文】");
    parts.push(essay);
    parts.push("");
    parts.push("请严格按前面的 JSON 格式输出评分结果。");
    return parts.join("\n");
  }

  /* ---------------- 范文（基于孩子原文扩写） ----------------
   *
   * 这份提示词的目标和评分**完全不同**：
   *   · 评分要「客观、严格、有依据」；范文要「在孩子的骨架上补血肉」。
   *   · 最大的风险是模型**跑题** —— 收到一段小孩的短文，它会自作主张写一篇
   *     全新的、题材相近但人物事件都不一样的"作文"。那样孩子看着热闹，
   *     却学不到"我这段该怎么写具体"，反而会觉得自己写的被否定了。
   *     所以把"必须沿用孩子的题目/人物/事件/中心"放在最前面、并反复强调。
   *   · 第二个风险是**写过头** —— 模型容易堆华丽词藻、写成初中甚至成人散文。
   *     孩子模仿不了 = 这篇范文没有用。所以明确要求"踮脚够得着"、宁可朴实。
   */

  /* 范文目标字数：按孩子的写作目标字数算，并设上下限。
   * 为什么不是"孩子原文的 N 倍"：原文可能只有 50 字，×3 也还是太短，
   * 起不到示范作用；直接按年级目标字数（家长可改）更稳。 */
  function modelWordsFor(profile) {
    var target = (profile && profile.targetWords) || 300;
    return Math.max(200, Math.min(MODEL_WORD_MAX, Math.round(target * 1.2)));
  }

  function buildModelSystemPrompt(profile, payload) {
    var p = payload || {};
    var grade = (profile && profile.grade) || "小学";
    var words = modelWordsFor(profile);
    var lines = [];
    lines.push("你是一位有二十年经验的中文写作老师，正在给" + grade + "的孩子写一篇**范文参考**。");
    lines.push("孩子刚写完一篇同样题目的作文，你要在他这篇的基础上，写出「他会觉得：原来可以这样写」的示范。");
    lines.push("");
    lines.push("【第一要求：必须基于孩子这篇原文来扩写，不许另写一篇】");
    lines.push("  · 题目、时间、地点、人物、事情经过、中心思想，**全部沿用孩子写的**。");
    lines.push("  · 孩子写到的每个情节都要保留；你只做「扩写」，不做「重写」，更不许删掉他的内容。");
    lines.push("  · 在关键处补出具体的：动作、对话、心里想什么、看到什么、听到什么。");
    lines.push("  · 如果你觉得孩子某处写得简单，就在那一处展开，而不是换一件事来写。");
    lines.push("");
    lines.push("【第二要求：语言水平「踮脚够得着」】");
    lines.push("  · 比孩子现在的水平**高一个台阶**就够，千万别写成初中生或成人散文。");
    lines.push("  · 用" + grade + "孩子看得懂、模仿得来的句子。**宁可朴实，不许堆华丽词藻**。");
    lines.push("  · 不用生僻词，不用长难句，不用「氤氲」「缱绻」「时光的褶皱」这类词。");
    lines.push("  · 孩子读完应该觉得「这个我也能学着写」，而不是「这我永远写不出来」。");
    lines.push("");
    lines.push("【篇幅】");
    lines.push("  写到 " + words + " 字左右。不要为了凑字数重复啰嗦。");
    lines.push("");
    lines.push("【不要做的事】");
    lines.push("  · 不要评价孩子（那是批改的活）。范文里不出现「更好」「应该」「建议」这类评语。");
    lines.push("  · 正文里不加任何标记：不要 markdown、不要小标题、不要序号、不要括注。");
    lines.push("  · 不写「范文」两个字当标题。");
    lines.push("");
    lines.push("【输出 JSON 格式】");
    lines.push("{");
    lines.push('  "title": "沿用孩子的题目；如果孩子没写题目，你替他起一个朴素的",');
    lines.push('  "model": "范文正文（一整段字符串，段落之间用 \\n\\n 分隔）",');
    lines.push('  "highlights": ["这篇范文在哪个地方比原文写得更具体（点出具体位置，一句一条，共 3 条）"]');
    lines.push("}");
    lines.push('highlights 是给孩子看的「看点提示」，要用孩子的话说，例如「写妈妈着急的时候，加了一句她说什么」。');
    return lines.join("\n");
  }

  function buildModelUserPrompt(payload) {
    var p = payload || {};
    var essay = String(p.text || "");
    if (essay.length > MAX_ESSAY_CHARS) essay = essay.slice(0, MAX_ESSAY_CHARS) + "……（正文过长已截断）";

    var parts = [];
    parts.push("【本次写作任务】");
    parts.push("  类型：" + (p.type || "未说明"));
    parts.push("  题目：" + (p.title || "未说明"));
    parts.push("  训练重点：" + (p.skillFocus || "未说明"));
    if (p.goal) parts.push("  本组目标：" + p.goal);
    if (p.material) parts.push("  给的素材/提示：" + String(p.material).slice(0, 400));
    parts.push("  孩子写了 " + (p.charCount || essay.length) + " 字（范文请写到 " + modelWordsFor(p.profile) + " 字左右）。");
    parts.push("");

    /* 把"孩子这次最弱的一项"点出来，让范文**重点在那一项上做示范**。
     * 这是让范文"有的放矢"的关键：否则模型平均用力，孩子看完不知道该学哪一点。
     * 对应关系与本地兜底提示词（app.js 的 nextGoalMap）保持一致的口径。 */
    if (p.weakest) {
      var HOW = {
        "内容与立意": "事情要写清楚、中心要明确——示范怎么把「我想说什么」自然地带出来",
        "结构与逻辑": "顺序和分段——示范怎么用「一开始→后来→最后」把过程铺清楚，一段一个重点",
        "细节与描写": "具体细节——示范怎么把动作、对话、心里的想法、看到听到的写出来，而不是干巴巴概述",
        "语言表达": "句子通顺——示范怎么把话说清楚，短句为主，不绕",
        "词汇与句式": "用词和句式变化——示范怎么避免重复用同一个词，适当换说法",
        "错别字与标点": "标点规范——示范对话怎么用引号、怎么断句"
      };
      parts.push("【孩子这次最弱的一项（范文要重点在这一项上做示范）】");
      parts.push("  " + p.weakest + "：" + (HOW[p.weakest] || ""));
      parts.push("");
    }

    parts.push("【孩子的原文（请在这篇的基础上扩写）】");
    parts.push(essay);
    parts.push("");
    parts.push("请按前面的 JSON 格式输出范文。记住：沿用孩子的题目、人物、事件、中心，只在他写的地方写得更具体。");
    return parts.join("\n");
  }

  /* 范文的返回规整。同样要防"模型乱来"：
   *   · model 为空 → 视为失败（不然界面上会出现一张空卡片）；
   *   · highlights 里模型常会写成"整体很好"这类空话 → 只保留有具体指向的；
   *   · model 里混进 markdown 标记 → 剥掉（孩子看的应该是干净的文章）。 */
  function normalizeModel(raw, payload) {
    var text = String((raw && (raw.model || raw.text || raw.essay)) || "").trim();
    text = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    // 模型有时会把标题也写进正文开头，去掉重复的标题行
    var title = String((raw && raw.title) || "").trim();
    if (title && text.indexOf(title) === 0) {
      text = text.slice(title.length).replace(/^[\s　:：]+/, "");
    }
    var highlights = strArray(raw && raw.highlights, 3);
    return {
      source: "ai",
      title: title || (payload && payload.title) || "",
      text: text,
      highlights: highlights,
      words: text.replace(/\s/g, "").length,
      generatedAt: new Date().toISOString()
    };
  }

  /* ==================================================================
   * 文章补写（Fill-Gap）
   *
   * 与「评分」「范文」并列的第三条链路：把一篇完整文章挖掉核心段落，
   * 让孩子照着上下文补出来，然后**跟原文对照**点评。
   *
   * 这条链路有三个独有的坑，提示词和规整函数都是围绕它们写的：
   *
   *   坑 1｜模型会"改写"而不是"补写"：它一看到整段空白，就想顺手润色孩子前面写的。
   *         对策：明确要求**一字不改地**保留上下文，只输出中间那一段。
   *   坑 2｜"比原文好"是**极易给的**廉价表扬：大模型几乎必然夸。
   *         对策：给出硬门槛（至少一项具体可指认的优势），并规定给分档位，
   *              再在 normalize 里按档位反推，不采用模型自报的分数。
   *   坑 3｜额外分会顶穿家长设定的奖牌线。对策：FILL_BONUS_MAX 封顶。
   * ================================================================== */

  function buildFillSystemPrompt(profile) {
    var grade = (profile && profile.grade) || "五年级";
    var sc = fillScaleFor(grade);
    var lay = fillLayoutFor(grade);
    var lines = [];
    lines.push("你是一位有二十年经验的" + grade + "语文老师，正在为" + grade + "的孩子准备一道「文章补写」练习。");
    lines.push("练习的形式：给出一篇**完整的文章**，把其中若干**核心段落**挖掉，让孩子照着上下文补写出来，");
    lines.push("然后再把他补的段落和原文放在一起对照点评。");
    lines.push("");
    lines.push("【你的任务】写一篇全新的、" + grade + "孩子**自己能独立读懂**的文章。");
    lines.push("  · 题材从" + "「记事」「写景」「说理」「抒情」里挑一个，不要每次都写记事。");
    lines.push("");
    lines.push("【难度标尺 —— 最容易被忽略、却最决定孩子能不能做下去的部分】");
    lines.push("  · 篇幅 **" + sc.min + "～" + sc.max + " 字**。具体写法：**写满 " + lay.nPara + " 段，每段 "
      + lay.pMin + "～" + lay.pMax + " 字**。");
    lines.push("    ★ **段落数组里必须有 " + lay.nPara + " 个元素**（不是 6 个、不是 8 个，" + lay.nPara + " 个）。");
    lines.push("      本题中间要挖掉 300 字，全文少于 " + lay.floor + " 字就作废，孩子会看不到题。");
    lines.push("      所以段数不够就补 —— 多写一段新的细节，比把一段写长更容易做到。");
    lines.push("    ★ 每段写不到 " + lay.pMin + " 字，说明细节还不够 ——");
    lines.push("      补上你看见的、听见的、手上感觉到的，不要用一句总结带过。");
    lines.push("  · **每一句不超过 " + sc.sent + " 个字**。写长了就拆成两三句短的——");
    lines.push("    孩子读长句要回读，一回读就跟不上情节，后面该补什么就全乱了。");
    lines.push("  · **一段只讲一件事**，不要把两件事挤在一段里，也不要为凑字数把一件事拆成三段。");
    lines.push("  · 用词只限小学阶段学过的常用字词（约 3500 常用字）。");
    lines.push("  · **禁止使用文言虚词**：之、乎、者、也、矣、焉、哉、乃、遂、故、虽、亦。出现一个就算不合格。");
    lines.push("  · **不要堆四字成语**。想写「很美」，就写看见了什么、听见了什么，不要写「美不胜收」。");
    lines.push("  · 比喻只能取自孩子熟悉的事物（学校、家里、天气、小动物、吃饭睡觉）；**不用典故、不引古诗**。");
    lines.push("  · 对话写「他说」「她说」，不要写「曰」「云」。");
    lines.push("  · 不写排比长句，不写「啊，多么……」这类抒情腔。");
    lines.push("  · 内容必须适合小学生：不涉及恋爱、暴力、政治、宗教、恐怖、赌博等题材。");
    lines.push("  · **必须是完整成篇的**：有开头、有推进、有结尾，不要写成提纲或片段。");
    lines.push("");
    lines.push("【挖空要求（这是本题的关键）】");
    lines.push("  · 只挖**中间偏后**的段落，**绝不许挖第一段或最后一段**（否则孩子没有起点/没有落点）。");
    /* ★ 挖空段数也要按「每段约 65 字」重算：300 字 ÷ 65 ≈ 5 段。
     *   老写法写「1～3 段」，在 65 字/段的情况下最多只能挖 195 字，**物理上不可能达标** ——
     *   这是 46 次生成里 30 次"挖空仅 130 字"的直接原因。 */
    var gapN = Math.max(2, Math.round(300 / 65));
    lines.push("  · 挖 **" + gapN + " 段左右（" + (gapN - 1) + "～" + (gapN + 1) + " 段）**，"
      + "被挖段落合计 **不少于 300 字**，且不超过全文的 50%。");
    lines.push("    （这两个条件联立 ⇒ 全文至少要有 " + Math.round(300 / 0.50) + " 字，"
      + "所以请按上面的 " + lay.nPara + " 段 × " + lay.pMin + "～" + lay.pMax + " 字来写，不要写成小短文）");
    lines.push("  · 被挖的段落必须是**承上启下的核心段**：它的内容要由前后文自然决定，");
    lines.push("    孩子读得懂该写什么，但又要自己组织语言——不能挖一段随便哪句都行的废话。");
    lines.push("  · 挖完之后，剩下的上下文合起来仍然要读得通顺、能看出文章在讲什么。");
    lines.push("");
    lines.push("【输出前自检（请逐条过一遍，不合格就重写）】");
    lines.push("  ① 一共写了 " + lay.nPara + " 段吗？每段都在 " + lay.pMin + "～" + lay.pMax + " 字之间吗？");
    lines.push("     （数一遍：paragraphs 数组里有几个元素，就是几段。少于 " + lay.nPara + " 段请补写）");
    lines.push("  ② 有没有超过 " + sc.sent + " 字的长句？有就拆开。");
    lines.push("  ③ 有没有出现之/乎/者/也/矣/焉/哉/乃/遂/故/虽/亦？有就换成口语。");
    lines.push("  ④ 有没有堆四字成语、引古诗、用典故？有就换成具体描写。");
    lines.push("  ⑤ " + grade + "的孩子读一遍，能不能说清这篇文章讲了什么事？");
    lines.push("");
    lines.push("【输出 JSON 格式，只输出 JSON】");
    lines.push("{");
    lines.push('  "title": "文章标题（不要加书名号）",');
    lines.push('  "category": "记事|写景|说理|抒情",');
    lines.push('  "skill": "内容与立意|故事结构|环境描写|细节描写|语言表达",');
    lines.push('  "paragraphs": ["第一段", "第二段", "……（完整原文，一段一个元素）"],');
    lines.push('  "gapStart": 数字,   // 被挖掉的第一段在 paragraphs 里的下标，从 0 开始');
    lines.push('  "gapCount": 数字,   // 一共挖掉几段');
    lines.push('  "hint": "给孩子的补写提示：说空缺处该写什么、可以抓哪几个细节。'
      + '**不要写「补写两段」「补写三段」这类具体段数** —— 段数由程序决定，你写不准"');
    lines.push("}");
    lines.push("");
    lines.push("注意：paragraphs 里要放**被挖掉的段落**（它们是原文），挖空位置由 gapStart/gapCount 标明；");
    lines.push("孩子看不到这几段，只能看到提示 hint 和前后段落。");
    return lines.join("\n");
  }

  function buildFillUserPrompt(payload) {
    var p = payload || {};
    var grade = (p.profile && p.profile.grade) || "五年级";
    var sc = fillScaleFor(grade);
    var lay = fillLayoutFor(grade);
    var parts = [];
    parts.push("【本次练习】文章补写");
    if (p.category) parts.push("  指定题材：" + p.category);
    if (p.skill) parts.push("  训练重点：" + p.skill);
    parts.push("  孩子年级：" + grade);
    /* ★ 字数硬线必须写在 **user** 里。实测同一个要求写在 system 里模型会忽略大半，
     *   写在 user 的"硬指标"行里命中率高得多 —— system 太长（4000+ 字），模型读成了背景。
     *   这里把段数和每段字数写成"数得出来"的具体数字，不给区间让它取下界。 */
    parts.push("  篇幅硬线：**写满 " + lay.nPara + " 段（paragraphs 数组里要有 " + lay.nPara
      + " 个元素）· 每段 " + lay.pMin + "～" + lay.pMax + " 字 · 全文不少于 " + lay.floor + " 字**（少于此数本题作废）");
    parts.push("  语言硬指标：每句 ≤" + sc.sent + " 字 · 不用文言虚词 · 不堆四字成语 · 不引典故");
    parts.push("  挖空：中间偏后 5 段左右，合计不少于 300 字且不超过全文 50%。");
    if (p.avoid && p.avoid.length) {
      /* ★ 列 12 个而不是 6 个。批量生成 80 篇时只给 6 个，模型很快又绕回
       *   《雨后的荷塘》《傍晚的江边》这几个模板，两轮下来 80 篇里有 22 篇撞名
       *   （撞名的只能丢，等于白花钱）。多列几个，它才会真的换人物和地点。 */
      parts.push("  以下标题已经用过，请换一个完全不同的人物、地点和事情：" + p.avoid.slice(0, 12).join("、"));
    }
    parts.push("");
    parts.push("请按前面的 JSON 格式输出。");
    return parts.join("\n");
  }

  /* 「AI 生成的文章」的规整。校验比范文严格得多，因为它是**整道题的地基**：
   * 挖空下标越界、挖到首尾段、被挖字数不够 —— 任何一条都会让这道题直接作废。
   * 所以这里**宁可返回 null 让上层重试**，也不硬凑一个残次品给孩子。 */
  function normalizeFillArticle(raw, payload) {
    var paras = Array.isArray(raw && raw.paragraphs) ? raw.paragraphs : [];
    paras = paras
      .map(function (x) {
        return String(x == null ? "" : x).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
      })
      .filter(Boolean);
    if (paras.length < 5) return null;

    var gapStart = Math.round(num(raw && raw.gapStart, 1));
    var gapCount = Math.round(num(raw && raw.gapCount, 1));
    // 下标越界 → 夹到合法范围；挖到首尾段 → 往里挪
    gapStart = Math.max(1, Math.min(paras.length - 2, gapStart));
    gapCount = Math.max(1, Math.min(paras.length - 1 - gapStart, gapCount));
    if (gapCount < 1) return null;

    var gapParas = paras.slice(gapStart, gapStart + gapCount);
    var gapChars = charsOf(gapParas.join(""));
    // ★ 用户硬要求：「隐藏的部分累计不少于 300 字」。不够就判生成失败，让上层换一次。
    //   阈值取 280 而不是 300：模型按自然段挖，很难精确卡到 300，留 20 字容忍度；
    //   真正卡住它的是这条**拒收**，而不是提示词里那句"不少于 300 字"。
    if (gapChars < 280) return null;

    var title = String((raw && raw.title) || "").trim().replace(/^[《【\[]|[》】\]]$/g, "");
    if (!title) return null;
    var total = charsOf(paras.join(""));
    /* ★ 按年级卡篇幅上限。提示词里已经写死「五年级 800～1200 字」，但实测模型经常
     *   写到 1800 字以上（它把"不超过 45% 挖空"理解成"文章越长越安全"）。
     *   阈值取 1.5 倍而不是 1.0 倍：模型对字数的控制精度大约 ±20%，
     *   压到 1.0 倍会连续失败，孩子点五次都出不来一道题。
     *   1.5 倍只拦"完全没听劝"的那一批，正常波动放行。 */
    var sc = fillScaleFor(payload && payload.profile && payload.profile.grade);
    if (total > Math.round(sc.max * 1.5)) return null;
    if (total > 3000) {
      // 太长也不浪费：裁到 3000 字以内的段落边界，且**保证挖空段不被裁掉**
      var trimmed = trimTo(paras, 3000, gapStart, gapCount);
      paras = trimmed.paragraphs;
      gapStart = trimmed.gapStart;
      gapCount = trimmed.gapCount;
      gapParas = paras.slice(gapStart, gapStart + gapCount);
      total = charsOf(paras.join(""));
      // 裁完再验一次：裁段有可能把挖空比例弄坏
      if (charsOf(gapParas.join("")) < 280) return null;
    }

    var cat = String((raw && raw.category) || "").trim();
    if (["记事", "写景", "说理", "抒情"].indexOf(cat) < 0) cat = "记事";
    var skill = String((raw && raw.skill) || "").trim();
    if (["内容与立意", "故事结构", "环境描写", "细节描写", "语言表达"].indexOf(skill) < 0) {
      skill = { "记事": "故事结构", "写景": "环境描写", "说理": "内容与立意", "抒情": "细节描写" }[cat];
    }

    return {
      id: "ai-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4).toString(36),
      category: cat,
      title: title,
      author: "AI 老师",
      source: "AI 现场生成",
      paragraphs: paras,
      gapStart: gapStart,
      gapCount: gapCount,
      gapParas: gapParas,
      gapChars: gapChars,
      chars: total,
      skill: skill,
      hint: String((raw && raw.hint) || "").trim() || "读一读前后两段，想一想中间应该发生什么、看到什么。",
      generatedAt: new Date().toISOString()
    };
  }

  /* 全文超过 3000 字时，按段丢到上限以内。
   * ★ 三个"绝不丢"：第一段（孩子要从这里读起）、最后一段（要有落点）、挖空段（题目本体）。
   * ⚠️ 循环条件不能写成 `list.length > 6` —— 模型给的往往正好是 6 段，
   *    那样一次都不裁，8400 字的文章会原样漏到界面上（这条踩过）。 */
  function trimTo(paras, maxChars, gapStart, gapCount) {
    var list = paras.slice();
    var guard = 0;
    while (charsOf(list.join("")) > maxChars && guard++ < 400) {
      var bestIdx = -1, bestLen = 0;
      for (var i = 1; i < list.length - 1; i++) {
        if (i >= gapStart && i < gapStart + gapCount) continue;   // 挖空段不丢
        var n = charsOf(list[i]);
        if (n > bestLen) { bestLen = n; bestIdx = i; }
      }
      // 已经没有可丢的中间段了 → 只能放弃（保持首尾完整 + 挖空段完整）
      if (bestIdx < 0) break;
      list.splice(bestIdx, 1);
      if (bestIdx < gapStart) gapStart -= 1;
    }
    return {
      paragraphs: list,
      gapStart: Math.max(1, Math.min(list.length - 2, gapStart)),
      gapCount: gapCount
    };
  }

  /* 按规则重算挖空位置。**只在上层已经判定模型给的挖空不合规时才调用**，
   * 不参与 normalizeFillArticle 的校验 —— 校验该严还得严（探针靠它判对错）。
   *
   * 为什么值得做这件事（2026-10-18 实测）：
   *   让模型同时"写好文章"和"算准挖空下标"，它只能顾一头。批量生成 46 次里，
   *   有 30 次是文章本身合格、只是 gapCount 给少了（挖 1 段 119 字）或下标越界。
   *   挖空位置是**纯规则**问题：中间偏后、连续若干段、合计够 300、不碰首尾。
   *   交给程序算，一次就对；让孩子多点一次「AI 生成」才是浪费。
   *
   * 返回 null 表示"文章本身就太短，怎么挖都凑不够 300 字"——这时确实该重生成。 */
  function pickFillGap(paras, minChars, maxRatio) {
    var lens = paras.map(function (x) { return charsOf(x); });
    var total = 0;
    for (var k = 0; k < lens.length; k++) total += lens[k];
    var maxChars = Math.floor(total * (maxRatio || 0.5));
    if (total < minChars) return null;
    var best = null;
    /* 起点从「中间偏后」开始：太靠前孩子没有铺垫，太靠后接不上结尾。
     * 上限 5 段：8 段 × 75 字的短文章，3 段只有 225 字，必须允许 4~5 段才够 280。 */
    for (var s = Math.floor(paras.length / 2); s <= paras.length - 2; s++) {
      var sum = 0;
      for (var c = 1; c <= 5 && s + c <= paras.length - 1; c++) {
        sum += lens[s + c - 1];
        if (sum >= minChars && sum <= maxChars) {
          var score = Math.abs(sum - 300);      // 优先挑最接近 300 字的
          if (!best || score < best.score) best = { gapStart: s, gapCount: c, gapChars: sum, score: score };
        }
      }
    }
    return best;
  }

  /* ---------------- 补写批改（对照原文） ----------------
   * 和普通评分最大的不同：**它不只是评孩子，还要把原文摆出来做对照**。
   * 所以额外产出两项：
   *   · compare     逐段对照（孩子这句好在哪 / 原文这句好在哪 / 谁更好）
   *   · betterThan  孩子哪些地方**确实**比原文好 → 专门表扬
   *   · bonus       额外加分（0~FILL_BONUS_MAX），由 betterThan 的档位反推
   */
  function buildFillGradeSystemPrompt(profile) {
    var grade = (profile && profile.grade) || "小学";
    var lines = [];
    lines.push("你是一位有二十年经验的中文写作老师，正在批改" + grade + "孩子做的「文章补写」练习。");
    lines.push("这道练习的形式：给一段挖掉了核心段落的文章，孩子照着上下文补写。现在你手上");
    lines.push("既有**孩子补写的段落**，也有**原文被挖掉的那几段**。");
    lines.push("");
    lines.push("【批改的基本规则（和批改完整作文一致）】");
    lines.push("  1. 客观、严格、有依据。宁可严格也不要一味鼓励。");
    lines.push("  2. 每条评价都要能指回具体词句，引不出依据就不要写。");
    lines.push("  3. 只评**孩子补写的那几段**，不要去评上下文（上下文是原作，不是孩子写的）。");
    lines.push("  4. 面向孩子说话，用简单的话。");
    lines.push("");
    lines.push("【最重要的判断：谁写得好】");
    lines.push("孩子补的和原文**不要求一样**。好的补写可以有完全不同的内容，只要它：");
    lines.push("  · 接得上前后文（人物、时间、地点、事情没有矛盾）；");
    lines.push("  · 自己是一个完整的小段（有具体的东西，不只是空话）；");
    lines.push("  · 语言通顺，不啰嗦。");
    lines.push("");
    lines.push("判断 better 字段时，请**只在下列情形**判为「孩子更好」（child）：");
    lines.push("  (a) 孩子写出了原文没有的具体细节，而且这个细节确实动人；");
    lines.push("  (b) 孩子的写法更贴合前面的铺垫，衔接更自然；");
    lines.push("  (c) 孩子的语言更准确、更生动（有画面、有节奏）。");
    lines.push("必须能**指出是哪一句、好在哪里**。如果只是「不一样」「更天真」「更朴素」，");
    lines.push("但说不出具体依据，一律判为 tie（持平）。**不要为了鼓励而抬高。**");
    lines.push("");
    lines.push("【额外加分怎么给（严格按档位，不要自己发明分数）】");
    lines.push("  · \"none\"：孩子补得不如原文，或明显有毛病 → 0 分");
    lines.push("  · \"minor\"：和原文差不多，各有可取 → 2 分");
    lines.push("  · \"clear\"：至少有 1 处**具体可指认**的地方比原文好 → 5 分");
    lines.push("  · \"great\"：有 2 处以上明显比原文好，且整段衔接自然、语言准确 → " + FILL_BONUS_MAX + " 分");
    lines.push("  分数由你选的档位决定，**不要自己写一个数字进去**。");
    lines.push("");
    lines.push("【评分维度与满分】总分 100 分，六个维度独立打分，各维度之和必须等于总分：");
    RUBRIC.forEach(function (r) {
      lines.push("  · " + r.name + "（满分 " + r.max + "）：" + r.desc);
    });
    lines.push("");
    lines.push("注意：补写的篇幅本来就短（300 字上下），**不要因为短就压分**；");
    lines.push("只按这段补写本身的完成度来评。");
    lines.push("");
    lines.push("【输出 JSON 格式，只输出 JSON】");
    lines.push("{");
    lines.push('  "parts": { "内容与立意": 数字, "结构与逻辑": 数字, "细节与描写": 数字, "语言表达": 数字, "词汇与句式": 数字, "错别字与标点": 数字 },');
    lines.push('  "strengths": ["值得肯定 1（引用孩子原句）", "值得肯定 2"],');
    lines.push('  "improvements": ["下次改进 1（指向具体位置）", "下次改进 2", "下次改进 3"],');
    lines.push('  "nextGoal": "下一篇最该练的一个具体目标，一句话",');
    lines.push('  "narrative": "整体点评，2-3 句话，先说好的再说要改的",');
    lines.push('  "evidence": [ { "quote": "孩子写的原句", "comment": "好在哪或有哪里可以改" } ],');
    lines.push('  "compare": [ { "child": "孩子这一段里的代表句", "original": "原文同位置的代表句", "better": "child|original|tie", "comment": "为什么" } ],');
    lines.push('  "betterThan": [ { "quote": "孩子写的原句", "why": "它比原文好在哪里（必须具体）" } ],');
    lines.push('  "bonusTier": "none|minor|clear|great"');
    lines.push("}");
    return lines.join("\n");
  }

  function buildFillGradeUserPrompt(payload) {
    var p = payload || {};
    var parts = [];
    parts.push("【本次练习】文章补写");
    parts.push("  文章标题：" + (p.title || "未说明"));
    if (p.category) parts.push("  题材：" + p.category);
    if (p.skillFocus) parts.push("  训练重点：" + p.skillFocus);
    parts.push("");
    parts.push("【孩子能看到的上下文（原文，不是孩子写的）】");
    parts.push(String(p.context || "（无）").slice(0, 3000));
    parts.push("");
    parts.push("【孩子看不到、被挖掉的位置】" + (p.gapLabel || ""));
    parts.push("");
    parts.push("【★ 原文被挖掉的那几段（对照用真值）】");
    parts.push(String(p.originalGap || "（没有拿到原文，只能按一般标准批改）"));
    parts.push("");
    parts.push("【★ 孩子自己补写的内容（这才是要批改的对象）】");
    parts.push(String(p.text || ""));
    parts.push("  孩子写了 " + (p.charCount || 0) + " 字。");
    parts.push("");
    if (p.hint) { parts.push("【给孩子的补写提示】" + p.hint); parts.push(""); }
    parts.push("请严格按前面的 JSON 格式输出批改结果。记住：bonusTier 判档要严，说不出具体依据就判 tie / none。");
    return parts.join("\n");
  }

  /* 补写批改的返回规整：
   *   · parts 走和普通评分同一套（错别字地板 3 分也照旧），保证「评分拆解」进度条能直接复用；
   *   · ★ bonus **不采信模型自报的分数**，只用它选的档位反推 —— 模型对数字的自控力很差；
   *   · 老记录没有 bonus/betterThan 时，界面必须能照常渲染，所以这两个字段永远有兜底值。 */
  function normalizeFillGrade(raw, payload) {
    var base = normalize(raw, payload);   // 复用 → parts/strengths/improvements/evidence/progress 口径完全一致

    var TIER_SCORE = { none: 0, minor: 2, clear: 5, great: FILL_BONUS_MAX };
    var tier = ["none", "minor", "clear", "great"].indexOf(raw && raw.bonusTier) >= 0
      ? raw.bonusTier : "none";

    var betterThan = Array.isArray(raw && raw.betterThan)
      ? raw.betterThan
          .slice(0, 3)
          .map(function (x) {
            return {
              quote: String((x && x.quote) || "").trim(),
              why: String((x && x.why) || "").trim()
            };
          })
          // 没有原句、或"好在哪"只有两三个字的，都是空话，直接丢掉
          .filter(function (x) { return x.quote && x.why.length >= 4; })
      : [];

    /* ★ 兜底逻辑：模型说"great"却一条具体优势都举不出来 → 只按 clear 给，甚至降到 minor。
     * 这条是防"廉价表扬"的最后一道闸：夸得越满，要求它越要有凭据。 */
    if (tier === "great" && betterThan.length < 2) tier = "clear";
    if (tier === "clear" && betterThan.length < 1) tier = "minor";
    var bonus = TIER_SCORE[tier] || 0;

    var compare = Array.isArray(raw && raw.compare)
      ? raw.compare.slice(0, 4).map(function (x) {
          var b = ["child", "original", "tie"].indexOf(x && x.better) >= 0 ? x.better : "tie";
          return {
            child: String((x && x.child) || "").trim(),
            original: String((x && x.original) || "").trim(),
            better: b,
            comment: String((x && x.comment) || "").trim()
          };
        }).filter(function (x) { return x.child || x.original || x.comment; })
      : [];

    // 额外分并进 score：dayScore/dayDetail 只认 feedback.score，
    // 不并进来的话"额外加分"就只是个显示值，永远进不了当日总分（见 app.js 顶部计分注释）。
    base.score = Math.round(base.score + bonus);
    base.baseScore = Math.round(base.score - bonus);
    base.extraBonus = bonus;
    base.bonusTier = tier;
    base.betterThan = betterThan;
    base.compare = compare;
    base.kind = "fillgap";
    return base;
  }

  /* ---------------- 解析与兜底 ---------------- */

  // 大模型有时会加代码块围栏或前后废话，这里剥干净再解析
  /* ⚠️ 这里刻意**不用 trim()**：JSON 字符串值里可能出现不换行空格（\u00A0）之类的
   * "空白"，trim 会把它们一起吃掉；而正文里出现 \u0000 这类非法控制字符时，
   * 先 trim 再删也没用（因为删完又露出新的空白）。所以顺序是：
   *   去围栏 → 截 {} → 删控制字符 → 才 trim。 */
  function extractJson(text) {
    var s = String(text || "");
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1];
    var start = s.indexOf("{");
    var end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    // 模型偶尔会把换行写成裸控制字符，JSON.parse 会直接报错
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    return s.trim();
  }

  function num(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // 数汉字/字符数（去掉所有空白）。和 app.js 的 countChineseChars 同口径。
  function charsOf(text) {
    return String(text || "").replace(/\s/g, "").length;
  }

  function clampNum(v, min, max) {
    return Math.max(min, Math.min(max, Math.round(num(v, min))));
  }

  function strArray(v, limit) {
    if (!Array.isArray(v)) return [];
    return v.map(function (x) { return String(x || "").trim(); })
      .filter(Boolean).slice(0, limit);
  }

  /* 把模型返回的 JSON 规整成和本地评分**完全相同的结构**。
   * 这样界面、历史记录、技能画像都不用改，两种来源可以无缝混用。 */
  function normalize(raw, payload) {
    var parts = {};
    var src = (raw && raw.parts) || {};
    DIM_NAMES.forEach(function (name) {
      parts[name] = clampNum(src[name], 0, DIM_MAX[name]);
    });

    // 错别字那一项模型常给 0 分（满分 5），太严了，给一个 3 分的地板，
    // 避免孩子因为一个错别字就掉 5 分、总分被压得很难看。
    if (parts["错别字与标点"] < 3 && parts["错别字与标点"] >= 0) {
      parts["错别字与标点"] = 3;
    }

    var score = DIM_NAMES.reduce(function (sum, n) { return sum + parts[n]; }, 0);

    var strengths = strArray(raw && raw.strengths, 3);
    var improvements = strArray(raw && raw.improvements, 4);
    var weakest = DIM_NAMES.slice().sort(function (a, b) {
      return (parts[a] / DIM_MAX[a]) - (parts[b] / DIM_MAX[b]);
    })[0];

    var pr = (raw && raw.progress) || {};
    var trend = ["up", "down", "flat", "first"].indexOf(pr.trend) >= 0 ? pr.trend : "first";

    return {
      source: "ai",
      score: score,
      parts: parts,
      strengths: strengths.length ? strengths : ["你已经把这件事写出来了，这是修改的基础。"],
      improvements: improvements.length ? improvements : ["写完后自己朗读一遍，看看哪里读起来不顺。"],
      nextGoal: String((raw && raw.nextGoal) || "").trim() ||
        ("下一篇重点练" + weakest + "。"),
      // 下面几项是本地规则给不出的，界面可以按需展示
      narrative: String((raw && raw.narrative) || "").trim(),
      evidence: Array.isArray(raw && raw.evidence)
        ? raw.evidence.slice(0, 4).map(function (e) {
            return { quote: String((e && e.quote) || "").trim(), comment: String((e && e.comment) || "").trim() };
          }).filter(function (e) { return e.quote || e.comment; })
        : [],
      progress: { trend: trend, detail: String(pr.detail || "").trim() },
      weakest: weakest,
      charCount: payload && payload.charCount || 0,
      gradedAt: new Date().toISOString()
    };
  }

  /* ---------------- 网络调用 ---------------- */

  /* 统一的「发一次 chat 请求」。
   * 抽出来是因为 grade 与 writeModel 要走**同一条路** —— 各写一份的话，
   * HTTP 错误提示、超时判定、连不上的表现迟早会漂移（本项目已有这类教训：
   * 界面文案与实际行为必须走同一入口）。
   * 返回 {ok:true, content} 或 {ok:false, reason, message}，**永不 reject**。 */
  function callChat(cfg, body, timeoutMs) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs);

    var opts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apiKey
      },
      body: JSON.stringify(body)
    };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(endpointOf(cfg), opts).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          var msg = "";
          try { msg = (JSON.parse(text).error || {}).message || ""; } catch (e) {}
          var hint = res.status === 401 || res.status === 403
            ? "API Key 无效或没有权限，请到「家长管理」重新填写。"
            : res.status === 429
              ? "调用太频繁或余额不足，请稍后再试。"
              : "模型服务返回错误（" + res.status + "）。";
          return { ok: false, reason: "http", message: hint + (msg ? " 详情：" + msg : "") };
        }
        var content = "";
        try {
          var outer = JSON.parse(text);
          content = outer && outer.choices && outer.choices[0] &&
            outer.choices[0].message && outer.choices[0].message.content;
        } catch (e) { /* 交给下面统一判空 */ }
        if (!content) return { ok: false, reason: "empty", message: "模型没有返回内容，请重试。" };
        return { ok: true, content: content };
      });
    }).catch(function (err) {
      var aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message || "")));
      return {
        ok: false,
        reason: aborted ? "timeout" : "network",
        message: aborted
          ? "模型响应超时（超过 " + Math.round(timeoutMs / 1000) + " 秒），请检查网络后重试。"
          : "连不上模型服务，请检查网络。"
      };
    }).then(function (r) { clearTimeout(timer); return r; });
  }

  function grade(payload) {
    var cfg = readConfig();
    if (!cfg.apiKey) {
      return Promise.resolve({ ok: false, reason: "nokey", message: "家长还没有配置大模型 API Key。" });
    }
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, reason: "disabled", message: "AI 评分已被家长关闭。" });
    }

    var body = {
      model: modelOf(cfg),
      temperature: 0.3,           // 低温度 = 更稳定的评分，同一篇文章不会一次 70 一次 90
      messages: [
        { role: "system", content: buildSystemPrompt((payload && payload.profile) || {}) },
        { role: "user", content: buildUserPrompt(payload) }
      ],
      response_format: { type: "json_object" }
    };

    return callChat(cfg, body, TIMEOUT_MS).then(function (r) {
      if (!r.ok) return r;
      var parsed;
      try {
        parsed = JSON.parse(extractJson(r.content));
      } catch (e) {
        return { ok: false, reason: "parse", message: "模型返回的内容看不懂，请重试一次。" };
      }
      var feedback = normalize(parsed, payload);
      if (!(feedback.score > 0)) {
        return { ok: false, reason: "badscore", message: "模型给的分不正常，请重试一次。" };
      }
      return { ok: true, feedback: feedback };
    });
  }

  /* ---------------- 范文（对外）----------------
   * 与 grade 同一条链路、同样的失败语义，只是提示词与产物不同。 */
  function writeModel(payload) {
    var cfg = readConfig();
    if (!cfg.apiKey) {
      return Promise.resolve({ ok: false, reason: "nokey", message: "家长还没有配置大模型 API Key。" });
    }
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, reason: "disabled", message: "AI 功能已被家长关闭。" });
    }

    var profile = (payload && payload.profile) || {};
    var body = {
      model: modelOf(cfg),
      /* 温度比评分高得多：0.3 那种低温写出来的范文会干巴巴、句句像模板，
       * 而范文本来就是要给孩子看"可以写得更有味道"。0.85 仍不算放飞，
       * 因为"必须沿用孩子原文"这条约束在提示词里压着。 */
      temperature: 0.85,
      max_tokens: MODEL_MAX_TOKENS,
      messages: [
        { role: "system", content: buildModelSystemPrompt(profile, payload) },
        { role: "user", content: buildModelUserPrompt(payload) }
      ],
      response_format: { type: "json_object" }
    };

    return callChat(cfg, body, TIMEOUT_MS).then(function (r) {
      if (!r.ok) return r;
      var parsed;
      try {
        parsed = JSON.parse(extractJson(r.content));
      } catch (e) {
        return { ok: false, reason: "parse", message: "模型返回的内容看不懂，请重试一次。" };
      }
      var model = normalizeModel(parsed, payload);
      if (!model.text || model.text.length < 40) {
        return { ok: false, reason: "emptymodel", message: "模型没写出范文，请重试一次。" };
      }
      return { ok: true, model: model };
    });
  }

  /* ---------------- 文章补写（对外）----------------
   * 两条：writeFillArticle（出一篇带挖空的文章）、gradeFill（对照原文批改孩子的补写）。
   * 与 grade / writeModel 走**同一条网络链路**（callChat）、同样的失败语义（永不 reject）。 */

  function writeFillArticle(payload) {
    var cfg = readConfig();
    if (!cfg.apiKey) {
      return Promise.resolve({ ok: false, reason: "nokey", message: "家长还没有配置大模型 API Key。" });
    }
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, reason: "disabled", message: "AI 功能已被家长关闭。" });
    }

    var profile = (payload && payload.profile) || {};
    var body = {
      model: modelOf(cfg),
      /* 温度 0.9：题材要多样，孩子在同一个模块反复练习，每次都一样会很闷。
       * 结构约束（挖空位置、字数）靠提示词压着，不靠低温。 */
      temperature: 0.9,
      max_tokens: FILL_MAX_TOKENS,
      messages: [
        { role: "system", content: buildFillSystemPrompt(profile) },
        { role: "user", content: buildFillUserPrompt(payload) }
      ],
      response_format: { type: "json_object" }
    };

    return callChat(cfg, body, TIMEOUT_MS).then(function (r) {
      if (!r.ok) return r;
      var parsed;
      try {
        parsed = JSON.parse(extractJson(r.content));
      } catch (e) {
        return { ok: false, reason: "parse", message: "模型返回的内容看不懂，请重试一次。" };
      }
      var article = normalizeFillArticle(parsed, payload);
      /* ★ 模型挖空不合规时，先按规则重算一次再判失败。
       *   实测这一手能救回一大半：文章本身合格，只是 gapCount 给少了下标算错了。 */
      if (!article) {
        var ps0 = (parsed && Array.isArray(parsed.paragraphs)) ? parsed.paragraphs : [];
        var fixed = pickFillGap(ps0, 280, 0.5);
        if (fixed) {
          var retry = {};
          for (var kk in parsed) if (Object.prototype.hasOwnProperty.call(parsed, kk)) retry[kk] = parsed[kk];
          retry.gapStart = fixed.gapStart;
          retry.gapCount = fixed.gapCount;
          var art2 = normalizeFillArticle(retry, payload);
          if (art2) {
            /* 提示里如果写了「补写两段」，重算后段数变了会让孩子数不对 —— 抹掉。 */
            art2.hint = String(art2.hint || "").replace(/[补写填]?\s*[一两二三四五六]\s*段/g, "空缺的段落");
            article = art2;
          }
        }
      }
      if (!article) {
        /* 三种失败：挖空不足 300 字 / 挖到首尾段 / 篇幅明显超出该年级。
         * 必须明确告诉用户为什么，否则孩子只会看到"生成失败"四个字。 */
        var sc2 = fillScaleFor(profile.grade);
        return {
          ok: false,
          reason: "badarticle",
          message: "模型这次生成的文章不合要求（挖空不足 300 字、挖到开头/结尾，或篇幅超出"
            + (profile.grade || "五年级") + "的 " + sc2.min + "～" + sc2.max + " 字），请再点一次「AI 生成」。"
        };
      }
      return { ok: true, article: article };
    });
  }

  function gradeFill(payload) {
    var cfg = readConfig();
    if (!cfg.apiKey) {
      return Promise.resolve({ ok: false, reason: "nokey", message: "家长还没有配置大模型 API Key。" });
    }
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, reason: "disabled", message: "AI 评分已被家长关闭。" });
    }

    var body = {
      model: modelOf(cfg),
      temperature: 0.3,           // 判"谁更好"要稳，不能一篇文章两次给出相反结论
      max_tokens: MODEL_MAX_TOKENS,
      messages: [
        { role: "system", content: buildFillGradeSystemPrompt((payload && payload.profile) || {}) },
        { role: "user", content: buildFillGradeUserPrompt(payload) }
      ],
      response_format: { type: "json_object" }
    };

    return callChat(cfg, body, TIMEOUT_MS).then(function (r) {
      if (!r.ok) return r;
      var parsed;
      try {
        parsed = JSON.parse(extractJson(r.content));
      } catch (e) {
        return { ok: false, reason: "parse", message: "模型返回的内容看不懂，请重试一次。" };
      }
      var feedback = normalizeFillGrade(parsed, payload);
      if (!(feedback.score > 0)) {
        return { ok: false, reason: "badscore", message: "模型给的分不正常，请重试一次。" };
      }
      return { ok: true, feedback: feedback };
    });
  }

  // 连通性自检：发一句最短的话，验证 Key 和地址是否可用
  function test() {
    var cfg = readConfig();
    if (!cfg.apiKey) return Promise.resolve({ ok: false, message: "还没填 API Key。" });

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    var opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: modelOf(cfg),
        max_tokens: 8,
        messages: [{ role: "user", content: "回复两个字：可以" }]
      })
    };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(endpointOf(cfg), opts).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        if (res.ok) {
          var m = "";
          try {
            m = (JSON.parse(text).choices[0].message.content || "").trim();
          } catch (e) {}
          return { ok: true, message: "连接成功，模型「" + modelOf(cfg) + "」可用。" + (m ? " 模型回话：" + m : "") };
        }
        var msg = "";
        try { msg = (JSON.parse(text).error || {}).message || ""; } catch (e) {}
        return { ok: false, message: "连接失败（" + res.status + "）：" + (msg || text.slice(0, 120)) };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      return { ok: false, message: "连不上：请检查网络和接口地址。" };
    });
  }

  window.AiGrader = {
    PROVIDERS: PROVIDERS,
    RUBRIC: RUBRIC,
    DIM_NAMES: DIM_NAMES,
    DIM_MAX: DIM_MAX,
    isConfigured: function () {
      var c = readConfig();
      return !!(c.apiKey && c.enabled);
    },
    config: function () {
      var c = readConfig();
      return {
        provider: c.provider,
        providerName: (PROVIDERS[c.provider] || {}).name || c.provider,
        apiKeyMasked: maskKey(c.apiKey),
        hasKey: !!c.apiKey,
        model: modelOf(c),          // 最终会用的模型（已解析默认值）
        modelRaw: c.model,          // 家长手填的模型；为空表示"用该服务商的默认"
        defaultModel: (PROVIDERS[c.provider] || {}).model || "",
        endpoint: endpointOf(c),
        customUrl: c.customUrl,
        enabled: c.enabled
      };
    },
    setConfig: function (patch) {
      var c = readConfig();
      var nextProvider = patch && PROVIDERS[patch.provider] ? patch.provider : c.provider;
      // 换了服务商：旧服务商手填的模型名在新服务商那里多半无效，
      // 没显式传 model 就清空，回到新服务商的默认模型，避免"换成智谱却还发 deepseek-chat"。
      var sameProvider = nextProvider === c.provider;
      var nextModel;
      if (patch && typeof patch.model === "string") {
        nextModel = patch.model.trim();
      } else {
        nextModel = sameProvider ? c.model : "";
      }
      var next = {
        provider: nextProvider,
        // apiKey 不传就保留原值（界面上显示的是打码串，不能直接存回去）
        apiKey: patch && typeof patch.apiKey === "string" ? patch.apiKey.trim() : c.apiKey,
        model: nextModel,
        customUrl: patch && typeof patch.customUrl === "string" ? patch.customUrl.trim()
          : (sameProvider ? c.customUrl : ""),
        enabled: patch && typeof patch.enabled === "boolean" ? patch.enabled : c.enabled
      };
      writeConfig(next);
      return true;
    },
    clearKey: function () {
      var c = readConfig();
      c.apiKey = "";
      writeConfig(c);
      return true;
    },
    test: test,
    grade: grade,
    writeModel: writeModel,
    writeFillArticle: writeFillArticle,
    gradeFill: gradeFill,
    /* 给测试用：把内部函数暴露出来，便于离线校验提示词与解析逻辑 */
    __buildSystemPrompt: buildSystemPrompt,
    __buildUserPrompt: buildUserPrompt,
    __normalize: normalize,
    __extractJson: extractJson,
    __buildModelSystemPrompt: buildModelSystemPrompt,
    __buildModelUserPrompt: buildModelUserPrompt,
    __normalizeModel: normalizeModel,
    __modelWordsFor: modelWordsFor,
    __MODEL_MAX_TOKENS: MODEL_MAX_TOKENS,
    // ---- 文章补写 ----
    FILL_BONUS_MAX: FILL_BONUS_MAX,
    __buildFillSystemPrompt: buildFillSystemPrompt,
    __buildFillUserPrompt: buildFillUserPrompt,
    __normalizeFillArticle: normalizeFillArticle,
    __fillScaleFor: fillScaleFor,
    __fillLayoutFor: fillLayoutFor,
    __pickFillGap: pickFillGap,
    __buildFillGradeSystemPrompt: buildFillGradeSystemPrompt,
    __buildFillGradeUserPrompt: buildFillGradeUserPrompt,
    __normalizeFillGrade: normalizeFillGrade
  };
})();
