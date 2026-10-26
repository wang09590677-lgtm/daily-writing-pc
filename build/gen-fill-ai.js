/* 文章补写素材库 · AI 批量生成（构建期一次性工具，产物是静态 js，运行时不需要 Key）
 *
 * 设计要点：
 *   1｜**提示词不复制**。直接加载产品里的 ai-grader.js，调它导出的
 *      __buildFillSystemPrompt / __buildFillUserPrompt。这样提示词只有一处真相源，
 *      以后改年级标尺，素材库跟着变，不会出现"脚本里还是老提示词"的漂移。
 *   2｜**每篇都过难度闸门**。生成 → 量句长/长句/文言/段长/繁体 → 不合格就重生成。
 *      闸门阈值取人教版 5、6 年级课文的实测区间，宁可少几篇也不要超纲。
 *   3｜**不做"凑够 N 篇"**。合格多少收多少，宁可库小也不塞次品。
 *
 * 用法：
 *   set DEEPSEEK_API_KEY=sk-xxx
 *   node build/gen-fill-ai.js --provider deepseek --grade 五年级 --count 80
 *   node build/gen-fill-ai.js --provider deepseek --grade 六年级 --count 40 --out build/_fill-ai-draft.json
 *
 * 产物：
 *   build/_fill-ai-draft.json   逐篇记录（含难度实测值，便于人工抽检）
 *   data/fill-articles.js       加 --write 才写产品文件
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

/* ---------- 1. 加载产品里的 ai-grader（拿真提示词 + 真校验） ---------- */
function loadGrader() {
  const src = fs.readFileSync(path.join(ROOT, "ai-grader.js"), "utf8");
  const sandbox = {
    window: {}, console,
    setTimeout, clearTimeout, Promise, JSON, Math, Date,
    String, Number, Array, Object, RegExp, Error, Boolean,
    encodeURIComponent, decodeURIComponent,
    fetch: (...a) => fetch(...a)
  };
  sandbox.window.localStorage = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "ai-grader.js" });
  return sandbox.window.AiGrader;
}

/* ---------- 2. 难度闸门（与 build/_probe-article-difficulty.py 同一套口径） ---------- */
const SENT_SPLIT = /[。！？；\n]+/;
const CJK = /[\u4e00-\u9fff]/;
const CLASSICAL = new Set("之其者亦矣焉哉乃遂故虽乎耶夫盖");
/* 高频繁体字：在简体文本里几乎不会出现。用来兜底 opencc 之外的漏网（素材库不经过 opencc，
 * 是模型直接产出，理论上是简体；但模型偶尔会吐繁体，尤其引用古诗时）。 */
const TRAD = new Set("們個這說時會來為國學對開麼過還發經樣現當與從裡點後應該讓給沒種覺聽寫話語讀課師題義認識愛樂書車門馬鳥魚龍鳳華歲萬億農場產業務員錢價買賣東");

function charsOf(s) { return (String(s).match(/[\u4e00-\u9fff]/g) || []).length; }

function measure(paras) {
  const text = paras.join("");
  const chars = text.split("").filter(c => CJK.test(c));
  const n = chars.length;
  if (!n) return null;
  const sents = text.split(SENT_SPLIT).map(x => x.trim()).filter(Boolean);
  const slens = sents.map(x => charsOf(x)).filter(x => x > 0);
  const avgSent = slens.length ? slens.reduce((a, b) => a + b, 0) / slens.length : 0;
  const longRatio = slens.length ? slens.filter(x => x > 50).length / slens.length : 0;
  const classical = chars.filter(c => CLASSICAL.has(c)).length / n;
  const trad = chars.filter(c => TRAD.has(c)).length;
  const avgPara = n / paras.length;
  return { chars: n, avgSent, longRatio, classical, trad, avgPara, maxSent: Math.max.apply(null, slens) };
}

/* 阈值：人教版 5、6 年级课文实测上限。
 * 比"偏难可读"那档更严 —— 素材库是孩子的日常练习材料，不是挑战题。 */
const GATE = {
  "三年级": { avgSent: 20, longRatio: 0.06, classical: 0.008, avgPara: 130 },
  "四年级": { avgSent: 22, longRatio: 0.06, classical: 0.008, avgPara: 140 },
  "五年级": { avgSent: 25, longRatio: 0.06, classical: 0.008, avgPara: 150 },
  "六年级": { avgSent: 27, longRatio: 0.08, classical: 0.010, avgPara: 170 }
};

function gateCheck(paras, grade) {
  const m = measure(paras);
  if (!m) return { ok: false, why: "空文章" };
  const th = GATE[grade] || GATE["五年级"];
  const bad = [];
  if (m.avgSent > th.avgSent) bad.push("句长" + m.avgSent.toFixed(1) + ">" + th.avgSent);
  if (m.longRatio > th.longRatio) bad.push("长句" + (m.longRatio * 100).toFixed(0) + "%>" + (th.longRatio * 100) + "%");
  if (m.classical > th.classical) bad.push("文言" + (m.classical * 1000).toFixed(1) + "‰");
  if (m.avgPara > th.avgPara) bad.push("段长" + m.avgPara.toFixed(0) + ">" + th.avgPara);
  if (m.trad > 0) bad.push("繁体" + m.trad + "字");
  return { ok: bad.length === 0, why: bad.join(" · "), m };
}

/* ---------- 3. 服务商 ---------- */
const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", env: "DEEPSEEK_API_KEY" },
  qwen: { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus", env: "DASHSCOPE_API_KEY" },
  zhipu: { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash", env: "ZHIPU_API_KEY" }
};

function extractJson(s) {
  const t = String(s || "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

/* 挖空重算**不在这里实现** —— 直接调产品里的 `G.__pickFillGap`。
 * 2026-10-18 这里原本有一份本地副本（连续 1~3 段），后来产品的段长从 ~100 字降到 ~65 字，
 * 「3 段」上限就永远凑不够 280 字了，而副本没跟着改 —— 于是批量生成静默掉到 11% 合格率。
 * 教训：这类"规则"只能有一处实现，副本必然漂移。 */

async function callApi(p, key, sys, user) {
  const body = {
    model: p.model,
    temperature: 0.9,
    max_tokens: 5200,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_object" }
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, why: "HTTP " + r.status + " " + txt.slice(0, 160) };
    const j = JSON.parse(txt);
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) return { ok: false, why: "空响应" };
    return { ok: true, content: c };
  } catch (e) {
    return { ok: false, why: e.name === "AbortError" ? "超时" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 4. 主流程 ---------- */
async function main() {
  const argv = process.argv.slice(2);
  function arg(name, def) {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  }
  const providerName = arg("provider", "deepseek");
  const grade = arg("grade", "五年级");
  const want = parseInt(arg("count", "80"), 10);
  const outFile = arg("out", "build/_fill-ai-draft.json");
  const doWrite = argv.indexOf("--write") >= 0;
  const cats = arg("cats", "记事,写景,说理,抒情").split(",");

  const p = PROVIDERS[providerName];
  if (!p) throw new Error("未知服务商：" + providerName);
  const key = process.env[p.env] || "";
  if (!key) {
    console.error("缺 Key：请先设置环境变量 " + p.env);
    console.error("  Windows: set " + p.env + "=sk-xxx");
    process.exit(2);
  }

  const G = loadGrader();
  const profile = { grade: grade, age: 10, targetWords: 350 };
  const sys = G.__buildFillSystemPrompt(profile);

  /* --dry：不花钱的自检。验证三件事 —— 提示词能加载、闸门函数能量、产品校验能调。
   * 这三件任何一件坏了，跑 80 篇都是白烧 token。 */
  if (argv.indexOf("--dry") >= 0) {
    console.log("=== 自检（不调 API）===");
    console.log("提示词长度：" + sys.length + " 字");
    console.log("含年级标尺：" + (sys.indexOf(grade) >= 0 ? "是" : "否"));
    console.log("");
    // 造一篇"刚好合格"和一篇"明显超纲"的，看闸门分不分得开
    const good = [];
    for (let i = 0; i < 6; i++) good.push("他".repeat(20) + "。");
    const bad = ["他".repeat(80) + "之乎者也矣焉哉。"];
    for (let i = 0; i < 5; i++) bad.push("他".repeat(90) + "。");
    const gd = gateCheck(good, grade), bd = gateCheck(bad, grade);
    console.log("合格样本（每句 20 字）：" + (gd.ok ? "放行 ✓" : "被拦 ✗ " + gd.why));
    console.log("超纲样本（每句 80+ 字、带文言）：" + (bd.ok ? "放行 ✗ 闸门失效！" : "拦下 ✓ " + bd.why));
    console.log("");
    console.log("user 提示词预览：");
    console.log(G.__buildFillUserPrompt({ profile: profile, category: "记事" }));
    return;
  }

  const kept = [];
  const rejected = [];
  let attempts = 0;
  const maxAttempts = want * 3;   // 最多试 3 倍次数，防止无限重试

  /* ★ 已用标题要**跨轮次**累积。
   *   第一轮 80 篇里撞了 22 个名（《雨后的荷塘》《傍晚的江边》反复出现），
   *   因为去重列表只在单次运行内累积，第二轮完全不知道第一轮用过什么。
   *   这里把所有草稿里的标题先读进来当种子。 */
  const usedTitles = [];
  fs.readdirSync(__dirname).filter(f => /^_fill-ai-.*\.json$/.test(f)).forEach(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
      (d.kept || []).forEach(k => { if (k && k.title) usedTitles.push(k.title); });
    } catch (e) { /* 草稿坏了不影响生成本身 */ }
  });
  if (usedTitles.length) console.log("已用标题种子：" + usedTitles.length + " 个（跨轮次去重）");

  console.log("目标：" + want + " 篇 · 年级 " + grade + " · 服务商 " + providerName);
  console.log("难度闸门：" + JSON.stringify(GATE[grade] || GATE["五年级"]));
  console.log("");

  while (kept.length < want && attempts < maxAttempts) {
    attempts++;
    const cat = cats[(attempts - 1) % cats.length];
    const user = G.__buildFillUserPrompt({
      profile: profile,
      category: cat,
      avoid: usedTitles.slice(-24)   // 提示词里会取前 12 个；多给一些，它才有得挑
    });
    const r = await callApi(p, key, sys, user);
    if (!r.ok) {
      console.log("[" + attempts + "] 请求失败：" + r.why);
      await sleep(4000);
      continue;
    }
    const parsed = extractJson(r.content);
    if (!parsed) {
      console.log("[" + attempts + "] JSON 解析失败：" + String(r.content).slice(0, 80));
      continue;
    }
    // ① 先用产品的真校验（模型自己算的挖空）
    let art = G.__normalizeFillArticle(parsed, { profile: profile, category: cat });
    // ② 模型挖空不合规时，脚本按规则重算一次 —— 文章本身够长就能救回来
    if (!art) {
      const ps0 = Array.isArray(parsed.paragraphs) ? parsed.paragraphs.filter(Boolean) : [];
      const fixed = G.__pickFillGap(ps0, 280, 0.5);
      if (fixed) {
        const retry = Object.assign({}, parsed, { gapStart: fixed.gapStart, gapCount: fixed.gapCount });
        const art2 = G.__normalizeFillArticle(retry, { profile: profile, category: cat });
        if (art2) {
          console.log("   ↳ 《" + (parsed.title || "无标题") + "》模型挖空不合规，脚本重算为 "
            + fixed.gapCount + " 段 " + fixed.gapChars + " 字");
          /* 提示词已经要求别写段数，但模型偶尔还是写「补写两段」。脚本重算后段数可能变，
           * 提示里留着旧数字会让孩子数不对。兜底把「X段」抹成「空缺的段落」。 */
          art2.hint = String(art2.hint || "").replace(/[补写填]?\s*[一两二三四五]\s*段/g, "空缺的段落");
          art = art2;
        }
      }
    }
    if (!art) {
      /* 失败要能定位到具体哪一条，否则只会看到"校验不过"四个字来回刷屏。
       * 三条硬校验（见 ai-grader.normalizeFillArticle）：
       *   ① 段落 <5  ② 挖空 <280 字  ③ 挖到首/末段  ④ 全文超年级上限 1.5 倍 */
      const ps = Array.isArray(parsed.paragraphs) ? parsed.paragraphs.filter(Boolean) : [];
      const gs = Math.round(Number(parsed.gapStart));
      const gc = Math.round(Number(parsed.gapCount));
      const gParas = ps.slice(gs, gs + gc);
      const gChars = charsOf(gParas.join(""));
      const total = charsOf(ps.join(""));
      const why = [];
      if (ps.length < 5) why.push("段落仅" + ps.length);
      if (!(gc >= 1)) why.push("gapCount=" + parsed.gapCount);
      if (gChars < 280) why.push("挖空仅" + gChars + "字<280");
      if (gs < 1) why.push("挖到首段");
      if (gs + gc > ps.length - 1) why.push("挖到末段");
      if (total > 1800) why.push("全文" + total + "字>1800");
      console.log("[" + attempts + "] 校验不过《" + (parsed.title || "无标题") + "》："
        + (why.join(" · ") || "其他") + "（总" + total + "字/" + ps.length + "段）");
      // 存下来，便于人眼判断"是内容差还是只是短"
      rejected.push({
        title: parsed.title, category: parsed.category, skill: parsed.skill,
        hint: parsed.hint, why: why.join(" · "),
        chars: total, paras: ps, gapStart: gs, gapCount: gc
      });
      continue;
    }
    const g = gateCheck(art.paragraphs, grade);
    if (!g.ok) {
      rejected.push({ title: art.title, category: art.category, why: g.why, m: g.m, paras: art.paragraphs });
      console.log("[" + attempts + "] 难度闸门拦下《" + art.title + "》：" + g.why);
      continue;
    }
    usedTitles.push(art.title);
    kept.push({
      title: art.title, category: art.category, skill: art.skill,
      paragraphs: art.paragraphs, gapStart: art.gapStart, gapCount: art.gapCount,
      hint: art.hint, gapChars: art.gapChars, chars: art.chars,
      metrics: {
        avgSent: +g.m.avgSent.toFixed(2), longRatio: +g.m.longRatio.toFixed(3),
        classical: +g.m.classical.toFixed(4), avgPara: +g.m.avgPara.toFixed(1),
        maxSent: g.m.maxSent
      }
    });
    console.log("[" + attempts + "] ✓ " + kept.length + "/" + want + " 《" + art.title + "》"
      + art.chars + " 字 · 句长" + g.m.avgSent.toFixed(1) + " · 挖" + art.gapCount + "段" + art.gapChars + "字");
    await sleep(1200 + Math.random() * 800);
  }

  const report = { grade: grade, provider: providerName, generatedAt: new Date().toISOString(), kept: kept, rejected: rejected };
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(report, null, 1), "utf8");

  console.log("");
  console.log("=== 完成 ===");
  console.log("合格 " + kept.length + " 篇 / 共尝试 " + attempts + " 次");
  console.log("被难度闸门拦下 " + rejected.length + " 篇");
  if (kept.length) {
    const avg = kept.reduce((a, b) => a + b.metrics.avgSent, 0) / kept.length;
    const ch = kept.reduce((a, b) => a + b.chars, 0) / kept.length;
    console.log("平均句长 " + avg.toFixed(1) + " 字 · 平均篇幅 " + ch.toFixed(0) + " 字");
    const byCat = {};
    kept.forEach(k => { byCat[k.category] = (byCat[k.category] || 0) + 1; });
    console.log("题材分布：" + JSON.stringify(byCat));
  }
  console.log("草稿已写：" + outFile);
  if (doWrite) {
    console.log("（--write 已开：下一步请跑 build/merge-fill-ai.js 落成 data/fill-articles.js）");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
