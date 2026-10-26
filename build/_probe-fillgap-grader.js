#!/usr/bin/env node
/* 文章补写：ai-grader.js 新增链路（writeFillArticle 的规整 + gradeFill 的规整）离线验收。
 *
 * 为什么必须单独验：
 *   · 「挖空 ≥300 字」是用户点名的硬要求，靠提示词是压不住的 —— 模型会挖 120 字就交差。
 *     所以真正兜底的是 normalizeFillArticle 的**拒收**。这里直接喂坏数据，验它敢拒。
 *   · 「孩子写得比原文好」是最容易变成廉价表扬的地方。这里验的是**反向断言**：
 *     模型说 great 但举不出具体优势 → 必须被降档。若测试只验"给了 bonus"，
 *     cheap praise 会被判绿，等于没测。
 *   · 额外分必须真的进 score（当日总分只认 feedback.score），否则界面上写着 +5、
 *     积分榜上纹丝不动 —— 这类"看着对了其实没接上"的坑本项目踩过多次。
 *
 * 用法：node build/_probe-fillgap-grader.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");

// ai-grader.js 是浏览器 IIFE（直接用 window），Node 里搭一个最小 window 跑起来
const sandbox = { window: {} };
function loadGrader() {
  const code = fs.readFileSync(path.join(ROOT, "ai-grader.js"), "utf8");
  const fn = new Function("window", "localStorage", "fetch", "AbortController", "setTimeout", "clearTimeout", "console", code);
  const mem = {};
  fn(sandbox.window, {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  }, () => { throw new Error("本测试不应发网络请求"); }, class {}, () => 0, () => {}, console);
  return sandbox.window.AiGrader;
}

const G = loadGrader();
let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra ? "  → " + extra : ""}`); }
}
function section(t) { console.log(`\n── ${t}`); }

const PROFILE = { name: "小作家", age: 10, grade: "五年级", targetWords: 350 };

/* 造一篇「段落长度可控」的假文章，便于精确控制挖空字数 */
function makeArticle(paraChars, gapStart, gapCount, opts) {
  const o = opts || {};
  const paras = paraChars.map((n, i) => {
    const base = "第" + (i + 1) + "段";
    let s = base;
    while (s.length < n) s += "雨点打在窗上，声音一下一下的，我觉得心里很静。";
    return s.slice(0, n);
  });
  return {
    title: o.title || "那一天的雨",
    category: o.category || "写景",
    skill: o.skill || "环境描写",
    paragraphs: paras,
    gapStart: gapStart,
    gapCount: gapCount,
    hint: "写这一段里最安静的那个片刻。"
  };
}

/* ================================================================== */
section("① normalizeFillArticle：结构基本校验");

{
  // 6 段、每段 120 字，挖第 2~4 段（中间偏后，360 字）→ 合法
  const raw = makeArticle([120, 120, 120, 120, 120, 120], 2, 3);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a && a.gapStart === 2 && a.gapCount === 3, "合法文章被接受，挖空位置保留", a && JSON.stringify([a.gapStart, a.gapCount]));
  ok(a && a.gapChars >= 300, `挖空字数 ≥300（实际 ${a && a.gapChars}）`);
  ok(a && a.gapParas.length === 3, "gapParas 与 gapCount 一致");
  ok(a && a.paragraphs.length === 6, "正文段落完整保留（挖掉的段也在 paragraphs 里）");
  ok(a && a.chars <= 3000, `全文字数 ≤3000（实际 ${a && a.chars}）`);
}

{
  /* 挖第 0 段（开头）→ 必须被挪走，绝不能让孩子补开头。
   * ⚠️ 挪走后只剩那一段，所以这里**同时验"挪到第 1 段且字数仍然够"**：
   *    实现上是「先夹下标 → 再验字数」，夹完之后字数不够就整篇拒掉。
   *
   * ★ 2026-10-18 修夹具（不是改断言）：原来每段 400 字 × 6 段 = 2400 字，
   *   加「年级篇幅上限」后五年级上限 1000×1.5=1500，2400 直接被篇幅判据拒掉，
   *   于是"下标有没有被抬高"这条根本验不到 —— 夹具不小心同时测了两件事。
   *   改成每段 290 字 × 5 段 = 1450 字（在 1500 以内），挖空段 290 ≥280，
   *   这样夹具只留下"下标夹取"这一个变量。 */
  const raw = makeArticle([290, 290, 290, 290, 290], 0, 1);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a !== null && a.gapStart >= 1, "挖开头 → gapStart 被抬到 ≥1", a && String(a.gapStart));
  ok(a !== null && a.gapStart + a.gapCount <= 4, "挖开头后也不会越到结尾", a && `${a.gapStart}+${a.gapCount}`);
}

{
  // 原样把开头挖掉、且挖掉 3 段（合计够字）：下标必须整体后移，不能留在 0
  const raw = makeArticle([290, 290, 290, 290, 290], 0, 3);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a !== null && a.gapStart === 1 && a.gapCount === 3, "挖开头 3 段 → 整体后移为 1~3 段",
    a && `${a.gapStart}/${a.gapCount}`);
}

{
  // 挖到结尾 → 必须被夹回来（不能让"最后一段"变成补写对象）
  const raw = makeArticle([290, 290, 290, 290, 290], 4, 2);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a !== null && a.gapStart + a.gapCount <= 4, "挖空不会越过最后一段",
    a && `${a.gapStart}+${a.gapCount}`);
}

{
  // 挖空字数不够（每段 60 字 ×1 = 60 字）→ 必须拒收
  const raw = makeArticle([100, 60, 100, 100, 100, 100], 1, 1);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a === null, "挖空不足 300 字 → 拒收（返回 null）", a && JSON.stringify(a.gapChars));
}

{
  // 段落太少 → 拒收
  const raw = makeArticle([100, 150, 100], 1, 1);
  const a = G.__normalizeFillArticle(raw, {});
  ok(a === null, "段落少于 5 段 → 拒收");
}

{
  /* ★ 2026-10-18 改写：加了「年级篇幅上限」之后，这里原来的 3 条断言（验 trimTo 裁剪）
   *   已经**永远走不到** —— 五年级上限 1000×1.5=1500，任何 >3000 字的文章在
   *   `total > sc.max*1.5` 那一行就被拒了，根本进不到 `total > 3000` 的裁剪分支。
   *   断言写"被裁到 ≤3000"等于要求一件不可能发生的事，所以改成验**实际行为**：
   *   超长文章被拒收（这才是孩子该看到的：换一篇，而不是读一篇被砍过的残文）。
   *   ⚠️ 若将来放宽 FILL_GRADE_SCALE 到 max>2000，要回来恢复裁剪那 3 条断言。 */
  const n = 900;
  const arr = [n, n, n, 120, 120, 120, n, n, n, n, n, n];
  const raw = makeArticle(arr, 3, 3);
  const a = G.__normalizeFillArticle(raw, {});
  const cap = Math.round(G.__fillScaleFor("五年级").max * 1.5);
  ok(a === null, `8460 字 / 五年级（上限 ${cap}）→ 拒收，不给"被砍过"的残文`);
  ok(G.__fillScaleFor("六年级").max * 1.5 <= 3000,
    "trimTo（>3000 才裁）目前是不可达分支：最高年级上限×1.5 仍 <3000");
}

/* ================================================================== */
section("② normalizeFillGrade：额外加分与廉价表扬防线");

/* 造一份"六维都在及格线以上"的评分（合计 78 分） */
function baseParts() {
  return { "内容与立意": 20, "结构与逻辑": 16, "细节与描写": 16, "语言表达": 16, "词汇与句式": 7, "错别字与标点": 3 };
}
function makeGraderRaw(over) {
  return Object.assign({
    parts: baseParts(),
    strengths: ["你把雨声写得像真的在响。"],
    improvements: ["中间那一段可以再补一个动作。"],
    nextGoal: "补一个看得见的动作。",
    narrative: "整体不错。",
    evidence: [{ quote: "雨点打在窗上", comment: "声音写出来了。" }],
    compare: [],
    betterThan: [],
    bonusTier: "none"
  }, over || {});
}
const PAYLOAD = { text: "孩子补写的段落", charCount: 300, title: "那一天的雨", originalGap: "原文段落", context: "上下文", profile: PROFILE };

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({ bonusTier: "none" }), PAYLOAD);
  ok(fb.score === 78 && fb.extraBonus === 0, "none 档：bonus=0，score=六维之和", `${fb.score}/${fb.extraBonus}`);
  ok(fb.baseScore === 78, "baseScore 记录了不含加分的原始分");
}

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({
    bonusTier: "clear",
    betterThan: [{ quote: "雨点像有人在轻轻敲门", why: "把声音比成敲门，比原文的『沙沙作响』更具体" }]
  }), PAYLOAD);
  ok(fb.extraBonus === 5, "clear 档（有 1 条具体优势）→ +5", String(fb.extraBonus));
  ok(fb.score === 83, "★ 额外分真的并进了 score（78+5）", String(fb.score));
  ok(fb.betterThan.length === 1, "betterThan 被保留（用于表扬区）");
}

{
  /* ★★ 反向断言：模型嘴上说 great，但一条具体优势都举不出来 → 必须降档。
   * 这条如果不写在测试里，"廉价表扬"永远发现不了（因为它看起来是"加分了，符合需求"）。 */
  const fb = G.__normalizeFillGrade(makeGraderRaw({ bonusTier: "great", betterThan: [] }), PAYLOAD);
  ok(fb.extraBonus === 2, "great 但零条优势 → 降到 minor（+2）", String(fb.extraBonus));
  ok(fb.bonusTier === "minor", "档位同步被改写为 minor");
}

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({
    bonusTier: "great",
    betterThan: [{ quote: "雨点像有人在轻轻敲门", why: "比喻具体，声音有了画面" }]   // 只有 1 条
  }), PAYLOAD);
  ok(fb.extraBonus === 5, "great 但只有 1 条优势 → 降到 clear（+5）", String(fb.extraBonus));
}

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({
    bonusTier: "great",
    betterThan: [
      { quote: "雨点像有人在轻轻敲门", why: "比喻具体，声音有了画面" },
      { quote: "我数到第十七下就不数了", why: "多了一个孩子才会有的细节，很真" }
    ]
  }), PAYLOAD);
  ok(fb.extraBonus === G.FILL_BONUS_MAX, "great + 2 条优势 → 顶格加分", String(fb.extraBonus));
  ok(fb.score === 78 + G.FILL_BONUS_MAX, "顶格分也正确并进 score", String(fb.score));
}

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({
    bonusTier: "minor",
    betterThan: [
      { quote: "好", why: "好" },                      // 空话：why 太短
      { quote: "", why: "这句写得不错" }                // 没有原句
    ]
  }), PAYLOAD);
  ok(fb.betterThan.length === 0, "空话型 betterThan 被过滤（quote 空 或 why <4 字）");
  ok(fb.extraBonus === 2, "过滤后仍按 minor 给 +2（档位本身合法）", String(fb.extraBonus));
}

{
  // 模型乱填一个不存在的档位 → 落到 none，不许瞎给分
  const fb = G.__normalizeFillGrade(makeGraderRaw({ bonusTier: "superb" }), PAYLOAD);
  ok(fb.extraBonus === 0, "非法档位 → 0 分兜底");
}

{
  // 额外分绝不突破上限（哪怕模型在别处硬塞了数字）
  const fb = G.__normalizeFillGrade(makeGraderRaw({
    bonusTier: "great",
    bonus: 999,
    extraBonus: 999,
    betterThan: [
      { quote: "a b c d", why: "具体优势一" },
      { quote: "e f g h", why: "具体优势二" }
    ]
  }), PAYLOAD);
  ok(fb.extraBonus <= G.FILL_BONUS_MAX, "额外分不被模型自报的 bonus:999 带跑", String(fb.extraBonus));
}

/* ================================================================== */
section("③ 与既有评分结构的兼容性（历史记录要能一起渲染）");

{
  const fb = G.__normalizeFillGrade(makeGraderRaw({ bonusTier: "clear", betterThan: [{ quote: "x y z w", why: "具体优势说明" }] }), PAYLOAD);
  const dims = Object.keys(fb.parts);
  ok(dims.length === 6, "六维齐全", dims.join("/"));
  ok(dims.every(d => typeof fb.parts[d] === "number"), "六维都是数字（进度条可直接画）");
  ok(typeof fb.weakest === "string" && dims.indexOf(fb.weakest) >= 0, "weakest 落在六维之内");
  ok(fb.parts["错别字与标点"] >= 3, "沿用错别字 3 分地板");
  ok(fb.kind === "fillgap", "打了 kind=fillgap 标记，界面据此决定显示对照区");
  ok(fb.source === "ai", "source=ai（与本地估分区分）");
}

{
  // 老记录（普通作文的 feedback）没有 extraBonus / betterThan 字段 —— 界面必须能读 undefined
  const legacy = G.__normalize(makeGraderRaw({}), PAYLOAD);
  ok(legacy.extraBonus === undefined, "普通评分不带 extraBonus（老记录口径不变）");
  ok(!legacy.betterThan, "普通评分不带 betterThan");
  ok(legacy.score === 78, "普通评分总分仍是六维之和（没被补写逻辑污染）");
}

/* ================================================================== */
section("④ 提示词内容自检（防止以后改坏关键约束）");

{
  const sys = G.__buildFillSystemPrompt(PROFILE);
  ok(sys.indexOf("不少于 300 字") >= 0, "生成提示词写明了挖空 ≥300 字");
  ok(sys.indexOf("绝不许挖第一段或最后一段") >= 0, "生成提示词禁止挖首尾段");
  ok(/不涉及恋爱、暴力、政治/.test(sys), "生成提示词有儿童安全约束");
  ok(/只输出 JSON/.test(sys), "生成提示词要求纯 JSON");
}

{
  const sys = G.__buildFillGradeSystemPrompt(PROFILE);
  ok(sys.indexOf("bonusTier") >= 0, "批改提示词使用档位而非直接给分");
  ok(/不要为了鼓励而抬高/.test(sys), "批改提示词明确禁止廉价表扬");
  ok(sys.indexOf("只评**孩子补写的那几段**") >= 0, "批改提示词限定只评孩子写的部分");
  ok(sys.indexOf(String(G.FILL_BONUS_MAX)) >= 0, "批改提示词里 great 档分数与代码常量一致");

  const usr = G.__buildFillGradeUserPrompt(Object.assign({}, PAYLOAD, { originalGap: "【原文真值段落甲】" }));
  ok(usr.indexOf("【原文真值段落甲】") >= 0, "批改 user prompt 带上了原文真值");
  ok(usr.indexOf("孩子补写的段落") >= 0, "批改 user prompt 带上了孩子补写");
  ok(usr.indexOf("【★ 原文被挖掉的那几段") >= 0, "两个来源被明确分开，不会混淆主体");
}

{
  const p = G.__buildFillUserPrompt({ category: "写景", avoid: ["旧标题一", "旧标题二"], profile: PROFILE });
  ok(p.indexOf("旧标题一") >= 0, "生成时会传「已用过的标题」做去重");
}

/* ================================================================== */
section("⑤ extractJson：加固后仍不误伤正文");

{
  const fenced = "```json\n{\"text\":\"雨点\\n落下\"}\n```";
  ok(JSON.parse(G.__extractJson(fenced)).text.indexOf("雨点") === 0, "剥掉 markdown 围栏");
  const junk = "好的，结果如下：\n{\"a\":1}\n以上。";
  ok(JSON.parse(G.__extractJson(junk)).a === 1, "切掉前后废话");
  // 控制字符（模型偶尔会把换行写成裸 \u0001）
  const ctrl = '{"a":"x\u0001y"}';
  ok(JSON.parse(G.__extractJson(ctrl)).a === "xy", "剔除非法控制字符后仍可解析");
}

/* ================================================================== */
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass}/${pass + fail}`);
if (fail) { console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
