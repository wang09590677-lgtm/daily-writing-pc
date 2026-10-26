/* 验证补写提示词真的带上了年级标尺。
 * 做法：mock 一个最小 window，直接加载真 ai-grader.js，调它导出的真函数。
 * ★ 不复制提示词片段来断言 —— 那只能证明"我抄对了"，证明不了"文件里是这样"。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "ai-grader.js"), "utf8");

const sandbox = { window: {}, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent, fetch: function () { return Promise.reject(new Error("no net")); } };
sandbox.window.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "ai-grader.js" });

const G = sandbox.window.AiGrader;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  [PASS] " + name); }
  else { fail++; console.log("  [FAIL] " + name + (extra ? "  → " + extra : "")); }
}

console.log("== 1. 各年级标尺都进提示词 ==");
/* 2026-10-18 放宽：下限从 650/700/800/900 降到 600/600/600/650。
 * 原因不是"凑数"，是数学上必须：挖空 ≥280 字且 ≤全文 50% ⇒ 全文 ≥560 字；
 * 而模型稳定只写到 550～650 字，原下限 800 导致 9 次生成全部作废。 */
const expect = {
  "三年级": { min: 600, max: 800, sent: 18 },
  "四年级": { min: 600, max: 900, sent: 20 },
  "五年级": { min: 600, max: 1000, sent: 22 },
  "六年级": { min: 650, max: 1150, sent: 24 }
};
Object.keys(expect).forEach(g => {
  const s = G.__buildFillSystemPrompt({ grade: g });
  const e = expect[g];
  ok(g + " 篇幅区间写进提示词", s.indexOf(e.min + "～" + e.max + " 字") >= 0, "找不到 " + e.min + "～" + e.max);
  ok(g + " 单句上限写进提示词", s.indexOf("不超过 " + e.sent + " 个字") >= 0, "找不到 " + e.sent);
  ok(g + " 年级名写进提示词", s.indexOf(g) >= 0);
});

console.log("\n== 2. 关键约束一条都不能少 ==");
const s5 = G.__buildFillSystemPrompt({ grade: "五年级" });
[
  ["禁文言虚词", "禁止使用文言虚词"],
  ["列出虚词清单", "之、乎、者、也、矣、焉、哉、乃、遂、故、虽、亦"],
  ["禁堆成语", "不要堆四字成语"],
  ["禁典故古诗", "不用典故、不引古诗"],
  ["口语对话", "不要写「曰」「云」"],
  ["禁抒情腔", "抒情腔"],
  ["常用字范围", "3500 常用字"],
  ["自检环节", "输出前自检"],
  ["不许挖首尾", "绝不许挖第一段或最后一段"],
  ["挖空≥300字", "不少于 300 字"],
  ["挖空≤50%", "50%"]
].forEach(([name, needle]) => ok(name, s5.indexOf(needle) >= 0, "缺：" + needle));

console.log("\n== 2b. 段数 × 每段字数必须与篇幅区间自洽 ==");
/* ★★ 这是 2026-10-18 那次事故的守卫。
 * 老算法 `段数 = max(6, round(min/para))` 给五年级算出「6 段 × 90 字 = 540 字」，
 * 与同一份提示词里"不少于 600 字"直接矛盾，模型服从具体的段数 ⇒ 46 次生成 41 次作废。
 * 断言口径：nPara×pMin ≥ min 且 nPara×pMax ≤ max，两端都不能越界。 */
Object.keys(expect).forEach(g => {
  const lay = G.__fillLayoutFor(g);
  const e = expect[g];
  ok(g + " 段数×每段下限 ≥ 篇幅下限",
    lay.nPara * lay.pMin >= e.min, lay.nPara + "×" + lay.pMin + "=" + (lay.nPara * lay.pMin) + " < " + e.min);
  ok(g + " 段数×每段上限 ≤ 篇幅上限",
    lay.nPara * lay.pMax <= e.max, lay.nPara + "×" + lay.pMax + "=" + (lay.nPara * lay.pMax) + " > " + e.max);
  ok(g + " 段数写进提示词",
    G.__buildFillSystemPrompt({ grade: g }).indexOf("写满 " + lay.nPara + " 段") >= 0,
    "找不到 写满 " + lay.nPara + " 段");
});

console.log("\n== 3. 没有年级时兜底五年级（不是「小学」）==");
const sNo = G.__buildFillSystemPrompt({});
ok("空 profile 兜底到五年级", sNo.indexOf("五年级") >= 0);
ok("不再出现泛化的「小学」年级词", sNo.indexOf("为小学的孩子") < 0);

console.log("\n== 4. user prompt 也带硬指标 ==");
const u = G.__buildFillUserPrompt({ profile: { grade: "六年级" } });
const lay6 = G.__fillLayoutFor("六年级");
ok("user 带年级", u.indexOf("六年级") >= 0);
/* 2026-10-18 起 user 里不再写「900～1400」这种区间，改成"数得出来"的硬线：
 * 段数 + 每段区间 + 全文下限。区间是模型"取下界"的温床，已全部换成具体数字。 */
ok("user 带段数硬线", u.indexOf("写满 " + lay6.nPara + " 段") >= 0, "找不到 写满 " + lay6.nPara + " 段");
ok("user 带全文下限", u.indexOf("全文不少于 " + lay6.floor + " 字") >= 0, "找不到 " + lay6.floor);
ok("user 带句长上限", u.indexOf("每句 ≤24 字") >= 0);
ok("user 带禁文言", u.indexOf("不用文言虚词") >= 0);
ok("user 不再出现篇幅区间（防止模型取下界）", u.indexOf("650～1150") < 0);

console.log("\n== 5. 篇幅超标的文章会被拒收 ==");
function fakeArticle(chars, grade) {
  /* 造一篇总字数约 chars 的文章，中间挖 1 段。
   * ★ 挖空段必须 ≥280 字（normalizeFillArticle 的硬校验），否则被拒是**正确行为**，
   *   会把这个用例测成"篇幅判据失灵"的假象 —— 第一版就是这么踩的：
   *   1000 字的文章按 1/3 均分，挖空段只剩 89 字，两个用例全红。
   */
  const gapLen = 320;
  const rest = Math.max(200, chars - gapLen);
  const per = Math.max(60, Math.round(rest / 6));
  const paras = [];
  for (let i = 0; i < 3; i++) paras.push("他".repeat(per));
  paras.push("他".repeat(gapLen));
  for (let i = 0; i < 3; i++) paras.push("他".repeat(per));
  return { title: "测试", category: "记事", paragraphs: paras, gapStart: 3, gapCount: 1, hint: "写一段" };
}
const okArt = G.__normalizeFillArticle(fakeArticle(1000), { profile: { grade: "五年级" } });
ok("1000 字 / 五年级 → 通过", !!okArt, okArt ? "" : "被拒了");
/* 五年级上限 1000，拒收线 = 1000 × 1.5 = 1500。
 * （旧断言写的是 1200×1.5=1800，标尺一改就失效了 —— 所以这里直接用函数算，不写死。） */
const cap5 = Math.round(G.__fillScaleFor("五年级").max * 1.5);
const tooLong = G.__normalizeFillArticle(fakeArticle(1600), { profile: { grade: "五年级" } });
ok("1600 字 / 五年级（>" + cap5 + "）→ 拒收", tooLong === null);
const borderline = G.__normalizeFillArticle(fakeArticle(1400), { profile: { grade: "五年级" } });
ok("1400 字 / 五年级（<" + cap5 + "）→ 放行", !!borderline, "正常波动不该拦");

console.log("\n=== 提示词全文（五年级）===");
console.log(s5);

console.log("\n合计 " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
