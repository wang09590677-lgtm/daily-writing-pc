// 范文库清洗补丁 v2：剔除损坏正文 + 不适合儿童的题材（艳情/赠妓/狎妓/男女情爱折子戏）
// 用法：node patch-classics.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "data", "models-classics.js");
const BACKUP = path.join(__dirname, "models-classics.backup.js");

// 若存在备份，从备份还原后再清洗（保证可重复执行）
const readFrom = fs.existsSync(BACKUP) ? BACKUP : SRC;

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(readFrom, "utf8"), ctx, { filename: readFrom });
const list = ctx.window.MODEL_LIBRARY_CLASSICS || [];

// 1) 正文损坏（抓取失败留下的 [objectObject] 等）
const CORRUPT = /\[object|undefined|NaN|&nbsp;|&amp;|<[a-z]+>/i;

// 2) 篇目黑名单：[标题, 作者] —— 艳情、赠妓、狎妓、男女情爱
const DROP_ITEMS = [
  // 柳永 艳情 / 赠妓 / 狎妓
  ["合欢带", "柳永"],
  ["夏云峰", "柳永"],
  ["惜春郎", "柳永"],
  ["斗百花", "柳永"],
  ["柳腰轻", "柳永"],
  ["西江月", "柳永"],
  ["归去来", "柳永"],
  ["燕归梁", "柳永"],
  ["浪淘沙令", "柳永"],
  ["木兰花・玉楼春", "柳永"],
  ["迎春乐", "柳永"],
  ["思归乐", "柳永"],
  ["凤栖梧・蝶恋花", "柳永"],
  ["秋蕊香引", "柳永"],
  ["凤衔杯", "柳永"],
  ["人娇", "柳永"],
  ["荔枝香", "柳永"],
  ["八六子", "柳永"],
  ["采莲令", "柳永"],
  ["望远行", "柳永"],
  ["征部乐", "柳永"],
  ["秋夜月・相见欢", "柳永"],
  ["竹马子・竹马儿", "柳永"],
  ["曲玉管", "柳永"],
  ["长相思", "柳永"],
  // 元曲 男女情爱折子戏
  ["诈妮子调风月・天净沙", "关汉卿"],
  ["诈妮子调风月・殿前欢", "关汉卿"],
  ["董秀英花月东墙记・水仙子", "白朴"],
  ["董秀英花月东墙记・折桂令", "白朴"],
  ["草桥店梦莺莺(第四本)・清江引", "王实甫"],
  ["山神庙裴度还带・水仙子", "关汉卿"],
  ["双调・折桂令赠千金奴", "孔文升"],
  // 其他词人 闺情（偏情爱，保守剔除）
  ["鹧鸪天", "夏竦"]
];

// 3) 正文黑名单（只保留会造成严重误判的极少数硬词）
const DROP_TEXT = /(平康款辔|昵欢邀宠|偶同鸳被|鸾凤窝巢|风月排场|赠千金|合欢树|连理枝比目鱼)/;

const kept = [];
const removed = [];

list.forEach(item => {
  const title = item.title || "";
  const author = item.author || "";
  const text = item.text || "";
  let reason = "";
  if (CORRUPT.test(text)) reason = "正文损坏";
  else if (DROP_ITEMS.some(([t, a]) => title === t && author === a)) reason = "题材不宜";
  else if (DROP_TEXT.test(text)) reason = "题材不宜";
  if (reason) removed.push({ title, author, category: item.category, reason, text: text.replace(/\n/g, " ").slice(0, 34) });
  else kept.push(item);
});

kept.forEach((item, index) => { item.id = "cls-" + String(index + 1).padStart(4, "0"); });

// 4) 标题规范化：修正「截断后带标点」「过长」「无题」的标题
function normalizeTitle(item) {
  let t = (item.title || "").trim();
  const needFix = !t || t === "无题" || /[，、。；：,]$/.test(t) || t.length > 18;
  if (!needFix) return t;
  const text = (item.text || "").replace(/\s/g, "");
  // 曲牌类标题（含「・」）：保留曲牌 + 首个短句
  if (t.includes("・")) {
    const [head, rest] = t.split("・");
    const tail = (rest || "").split(/[，。；！？、]/)[0] || "";
    return tail ? `${head}・${tail.slice(0, 8)}` : head;
  }
  // 其他：取正文第一个短句
  const first = text.split(/[，。；！？、]/)[0] || "";
  if (first && first.length <= 16) return `${first}…`;
  if (first) return `${first.slice(0, 16)}…`;
  return t.slice(0, 16) || "无题";
}

const renamed = [];
kept.forEach(item => {
  const before = item.title;
  const after = normalizeTitle(item);
  if (after !== before) {
    item.title = after;
    renamed.push(`《${before}》 -> 《${after}》`);
  }
});

const header = "/* 自动生成，请勿手改。来源：chinese-poetry 公开数据集 + 维基文库公版文本 */\n";
fs.writeFileSync(SRC, header + "window.MODEL_LIBRARY_CLASSICS = " + JSON.stringify(kept) + ";\n", "utf8");

console.log("来源:", path.basename(readFrom), "| 原篇数:", list.length);
console.log("剔除:", removed.length);
removed.forEach(r => console.log(`  [${r.reason}] ${r.category}《${r.title}》${r.author} -> ${r.text}`));
console.log("保留:", kept.length);
console.log("标题规范化:", renamed.length);
renamed.forEach(r => console.log("  " + r));
const dist = {};
kept.forEach(i => dist[i.category] = (dist[i.category] || 0) + 1);
console.log("分类分布:", dist);
