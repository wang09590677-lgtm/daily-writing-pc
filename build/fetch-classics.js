/**
 * 构建脚本：抓取公开古籍语料（chinese-poetry 数据集）+ 少量维基文库公版散文，
 * 清洗、繁简转换、挑选、补充训练提示，输出 data/models-classics.js
 *
 * 用法：NODE_PATH=<workspace>/node_modules node fetch-classics.js
 */
const fs = require("fs");
const path = require("path");
const OpenCC = require("opencc-js");

const OUT_DIR = path.resolve(__dirname, "..", "data");
const RAW_DIR = path.resolve(__dirname, "raw");
const BASE = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/";

let toSimplified;
try {
  toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
} catch (e) {
  toSimplified = (s) => s;
}

const SKILLS = ["语言表达", "细节描写", "故事结构", "环境描写", "想象能力", "内容与立意", "人物描写", "观察描写"];

// 名篇优先清单（提高孩子熟悉度）
const FAMOUS = new Set([
  "静夜思", "春晓", "登鹳雀楼", "相思", "杂诗", "鹿柴", "竹里馆", "送别", "杂诗三首", "宿建德江", "春思", "秋夜寄邱员外",
  "江雪", "寻隐者不遇", "登乐游原", "弹琴", "送上人", "八阵图", "秋日湖上", "过三闾庙", "易水送别", "送朱大入秦",
  "回乡偶书", "咏柳", "凉州词", "出塞", "芙蓉楼送辛渐", "送元二使安西", "九月九日忆山东兄弟", "春夜洛城闻笛",
  "早发白帝城", "望庐山瀑布", "赠汪伦", "黄鹤楼送孟浩然之广陵", "望天门山", "枫桥夜泊", "寒食", "乌衣巷",
  "泊秦淮", "山行", "清明", "江南春", "赤壁", "夜雨寄北", "嫦娥", "贾生", "瑶池", "春词", "竹枝词", "浪淘沙",
  "秋词", "乌衣巷", "题都城南庄", "春雪", "晚春", "早春呈水部张十八员外", "游子吟", "登科后", "城东早春",
  "望月怀远", "春望", "月夜", "旅夜书怀", "登岳阳楼", "送友人", "赠孟浩然", "渡荆门送别", "蜀道难",
  "归园田居", "饮酒", "过故人庄", "岁暮归南山", "题破山寺后禅院", "望洞庭湖赠张丞相", "辋川闲居赠裴秀才迪",
  "山居秋暝", "终南别业", "鸟鸣涧", "山中", "秋夜曲", "渭川田家", "青溪", "西施咏", "桃源行",
  "陋室铭", "爱莲说", "岳阳楼记", "醉翁亭记", "三峡", "小石潭记", "桃花源记", "五柳先生传", "马说", "师说",
  "兰亭集序", "陈情表", "滕王阁序", "阿房宫赋", "前赤壁赋", "后赤壁赋", "秋声赋", "卖柑者言", "项脊轩志",
  "郑伯克段于鄢", "曹刿论战", "烛之武退秦师", "邹忌讽齐王纳谏", "唐雎不辱使命", "谏逐客书", "过秦论",
  "关雎", "蒹葭", "桃夭", "木瓜", "采薇", "硕鼠", "伐檀", "无衣", "子衿", "静女", "淇奥", "鹿鸣", "鹤鸣"
]);

const CATEGORY_META = {
  "古诗词": { skill: "语言表达", tips: ["先大声读两遍，注意节奏和停顿。", "找出诗里最会“动”或最会“变色”的那个词。", "想一想诗人当时站在哪里、看到了什么。"], prompt: "选一个你熟悉的场景，仿照它的写法写一段话或一首小诗。" },
  "古文": { skill: "语言表达", tips: ["不必逐字翻译，先读顺、读懂大意。", "注意它怎样用很短的话讲清一件事。", "找出你认为最有力的一句。"], prompt: "用现代的话，把这篇里的一件事讲给你的同学听，再写下你自己的看法。" },
  "诗经": { skill: "语言表达", tips: ["注意它反复出现的句子，那是它的节奏。", "感受它写自然景物时的心情。", "读出声来，会更容易懂。"], prompt: "学它借自然景物表达心情的写法，写一段你自己的心情文字。" },
  "论语": { skill: "内容与立意", tips: ["一句话就是一个小道理，先想它在说什么。", "联系自己的一件小事来理解。", "试着用今天的话重新说一遍。"], prompt: "选一句最有感触的话，结合自己的一件小事写一段感想。" },
  "蒙学": { skill: "语言表达", tips: ["注意句子的对仗和节奏，读起来很有味道。", "里面藏着很多做人和学习的道理。", "摘抄你最喜欢的一句。"], prompt: "模仿它的句式，写几句你自己的“对子”或格言。" },
  "宋词": { skill: "环境描写", tips: ["注意词里写了哪些景、哪些心情。", "上阕多写景，下阕多写情，注意这个变化。", "找一找有没有一句让你一下子看见画面的。"], prompt: "选一个你经历过的天气或季节，写一段带心情的描写。" },
  "元曲": { skill: "语言表达", tips: ["元曲比诗更接近说话，读起来更口语。", "注意它描写人物动作的方式。"], prompt: "用口语化的短句，写一段发生在你身边的小场景。" },
  "清言小品": { skill: "内容与立意", tips: ["短短一句，常常是一个生活发现。", "想一想作者为什么会这样想。"], prompt: "学它写一句你对生活的小发现。" },
  "现代散文": { skill: "细节描写", tips: ["注意作者是按什么顺序观察的。", "找出一个写得很细的句子，看它用了哪些感官。", "注意开头和结尾是怎样呼应的。"], prompt: "学它的观察顺序，写一个你熟悉的场景或物品。" }
};

function simplify(text) {
  if (!text) return "";
  try { return toSimplified(String(text)); } catch (e) { return String(text); }
}

function cleanText(text) {
  return simplify(text)
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t\u3000]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// 蒙学类需要保留断句空格
function cleanSpaced(text) {
  return simplify(text)
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map(line => line.trim().replace(/[ \t\u3000]+/g, " ").replace(/([\u4e00-\u9fa5])(?=[\u4e00-\u9fa5])/g, "$1 "))
    .join("\n")
    .trim();
}

// 不适合儿童阅读的题材过滤
const BLOCK = /鸳鸯|洞房|云雨|佳人|妓|狎|风流|欢会|枕|衾|罗帐|相思债|花酒|宿柳|烟花|巫山|云鬓|酥胸|金莲|薄幸|偷情|妾身|奴家|薄情|盟言|香暖|鬓云|雨魄云魂|偎|醉拥|平康|昵欢|妍歌艳舞|凤楼深处|鸾凤窝巢|风月排场|檀郎|千金酬一笑|妖娆|妖艳|艳舞|歌席|金屋|阿娇|百媚千娇|倾国倾城|春宵/;

function isKidSafe(text) {
  return !BLOCK.test(text);
}

function countChars(text) {
  return (text || "").replace(/\s/g, "").length;
}

async function download(relPath, cacheName) {
  const cachePath = path.join(RAW_DIR, cacheName);
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const res = await fetch(BASE + encodeURI(relPath));
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + relPath);
  const json = await res.json();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(json), "utf8");
  return json;
}

async function downloadText(url, cacheName) {
  const cachePath = path.join(RAW_DIR, cacheName);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");
  const res = await fetch(url, { redirect: "follow" });
  const txt = await res.text();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(cachePath, txt, "utf8");
  return txt;
}

const models = [];
let seq = 0;

function push(category, type, title, author, source, rawText, extra = {}) {
  const text = extra.keepSpaces ? cleanSpaced(rawText) : cleanText(rawText);
  const chars = countChars(text);
  if (chars < 8 || chars > 1200) return;
  if (/Wikimedia Error|404|NotFound/.test(text)) return;
  if (/\[object|undefined|NaN|&nbsp;|&amp;|<[a-z]+>/i.test(text)) return; // 抓取损坏保护
  if (!isKidSafe(text)) return;
  const meta = CATEGORY_META[category] || CATEGORY_META["现代散文"];
  seq += 1;
  models.push({
    id: "cls-" + String(seq).padStart(4, "0"),
    category,
    type,
    title: cleanText(title) || "无题",
    author: cleanText(author) || "",
    source,
    text,
    chars,
    skill: extra.skill || meta.skill,
    tips: extra.tips || meta.tips,
    prompt: extra.prompt || meta.prompt,
    famous: FAMOUS.has(cleanText(title))
  });
}

/* ---------- 1. 唐诗三百首 / 千家诗 ---------- */
function readPoemGroup(json, category, sourceName) {
  const groups = json.content || [];
  for (const group of groups) {
    const type = simplify(group.type || "诗");
    for (const item of (group.content || [])) {
      const author = simplify(item.author || "");
      push(category, type, simplify(item.chapter || ""), author, sourceName, (item.paragraphs || []).join("\n"), {
        skill: /绝句|律诗/.test(type) ? "语言表达" : "环境描写"
      });
    }
  }
}

/* ---------- 2. 宋词 ---------- */
async function loadSongCi() {
  const files = ["ci.song.0.json", "ci.song.1000.json", "ci.song.2000.json", "ci.song.3000.json", "ci.song.4000.json", "ci.song.5000.json"];
  const famousPoets = /苏轼|辛弃疾|李清照|柳永|欧阳修|晏殊|晏几道|秦观|周邦彦|陆游|岳飞|王安石|范仲淹|张孝祥|贺铸|姜夔|朱敦儒|李煜|黄庭坚|晁补之|叶梦得|陈亮|刘过|史达祖|王沂孙|张炎/;
  const famousTune = /水调歌头|念奴娇|声声慢|如梦令|雨霖铃|蝶恋花|青玉案|破阵子|满江红|虞美人|卜算子|鹊桥仙|醉花阴|一剪梅|定风波|江城子|渔家傲|浣溪沙|菩萨蛮|临江仙|苏幕遮|相见欢|浪淘沙|清平乐|西江月|鹧鸪天|踏莎行|少年游|玉楼春|木兰花|南乡子|望江南|忆江南|生查子|点绛唇|诉衷情|武陵春|醉太平|小重山|眼儿媚|减字木兰花|长相思/;
  const seen = new Set();
  for (const file of files) {
    try {
      const json = await download("宋词/" + file, "ci-" + file);
      for (const item of json) {
        const author = simplify(item.author || "");
        const title = simplify(item.rhythmic || item.title || "");
        if (!famousPoets.test(author) && !famousTune.test(title)) continue;
        const paragraphs = (item.paragraphs || []).join("\n");
        const key = author + "|" + title;
        if (seen.has(key)) continue;
        if (countChars(paragraphs) > 320) continue;
        seen.add(key);
        push("宋词", "词", title, author, "全宋词", paragraphs, { famous: true });
        if (models.filter(m => m.category === "宋词").length >= 80) break;
      }
    } catch (e) { /* ignore */ }
    if (models.filter(m => m.category === "宋词").length >= 80) break;
  }
  console.log("宋词入选 " + models.filter(m => m.category === "宋词").length + " 首");
}

/* ---------- 3. 古文观止（节选） ---------- */
function readGuwen(json) {
  const volumes = json.content || [];
  for (const volume of volumes) {
    for (const piece of (volume.content || [])) {
      const title = simplify(piece.chapter || "");
      const source = simplify(piece.source || "");
      const author = simplify(piece.author || "").replace(/[：:]\s*$/, "");
      const paragraphs = (piece.paragraphs || []).map(cleanText).filter(Boolean);
      if (!paragraphs.length) continue;
      let excerpt = paragraphs.join("\n");
      if (countChars(excerpt) > 460) {
        const keep = [];
        let total = 0;
        for (const p of paragraphs) {
          if (total + countChars(p) > 380) break;
          keep.push(p);
          total += countChars(p);
        }
        excerpt = (keep.length ? keep : [paragraphs[0]]).join("\n") + "\n（节选）";
      }
      push("古文", "古文", title, author, source || "古文观止", excerpt);
    }
  }
}

/* ---------- 4. 蒙学 ---------- */
function readParagraphObj(json, title, author, source, category, type, limit) {
  const chapters = json.content || [{ chapter: "", paragraphs: json.paragraphs || [] }];
  let taken = 0;
  for (const chapter of chapters) {
    if (taken >= limit) break;
    const paragraphs = (chapter.paragraphs || []).map(cleanText).filter(Boolean);
    const chunk = paragraphs.join("\n");
    if (countChars(chunk) < 8) continue;
    const text = countChars(chunk) > 400 ? chunk.slice(0, 380) + "……" : chunk;
    push(category, type, (chapter.chapter ? title + "·" + simplify(chapter.chapter) : title), author, source, text, { skill: "语言表达", keepSpaces: true });
    taken += 1;
  }
}

/* ---------- 5. 维基文库公版现代散文 ---------- */
const WIKI_PAGES = [
  ["春 (朱自清)", "春", "朱自清", "现代散文", "写景散文"],
  ["槳聲燈影裏的秦淮河", "桨声灯影里的秦淮河", "朱自清", "现代散文", "游记散文"],
  ["從百草園到三味書屋", "从百草园到三味书屋", "鲁迅", "现代散文", "回忆散文"],
  ["社戲", "社戏", "鲁迅", "现代散文", "叙事散文"],
  ["藤野先生", "藤野先生", "鲁迅", "现代散文", "写人散文"],
  ["落花生", "落花生", "许地山", "现代散文", "哲理散文"],
  ["秋夜紀遊", "秋夜纪游", "鲁迅", "现代散文", "写景散文"],
  ["差不多先生傳", "差不多先生传", "胡适", "现代散文", "讽刺小品"]
];

async function loadWikiProse() {
  for (const [pageTitle, title, author, category, type] of WIKI_PAGES) {
    try {
      const raw = await downloadText(
        "https://zh.wikisource.org/w/index.php?title=" + encodeURIComponent(pageTitle) + "&action=raw",
        "wiki-" + encodeURIComponent(pageTitle) + ".txt"
      );
      if (/<pages index=/.test(raw)) continue;
      let body = raw.replace(/\{\{header[\s\S]*?\}\}/g, "").replace(/\{\{[^}]*\}\}/g, "");
      body = cleanText(body);
      if (countChars(body) < 200) continue;
      if (countChars(body) > 1100) {
        const cut = body.slice(0, 1000);
        const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
        body = (lastStop > 500 ? cut.slice(0, lastStop + 1) : cut) + "\n（节选）";
      }
      push(category, type, title, author, "维基文库·公版", body, { famous: true });
    } catch (e) { /* ignore */ }
  }
}

async function main() {
  console.log("开始抓取公开语料…");

  try { readPoemGroup(await download("蒙学/tangshisanbaishou.json", "tangshisanbaishou.json"), "古诗词", "唐诗三百首"); } catch (e) { console.log("唐诗三百首失败:", e.message); }
  try { readPoemGroup(await download("蒙学/qianjiashi.json", "qianjiashi.json"), "古诗词", "千家诗"); } catch (e) { console.log("千家诗失败:", e.message); }

  try {
    const shijing = await download("诗经/shijing.json", "shijing.json");
    for (const item of shijing) {
      push("诗经", simplify(item.chapter || "国风") + "·" + simplify(item.section || ""), item.title, "佚名", "诗经", (item.content || []).join("\n"), { famous: FAMOUS.has(item.title) });
    }
  } catch (e) { console.log("诗经失败:", e.message); }

  try {
    const lunyu = await download("论语/lunyu.json", "lunyu.json");
    for (const chapter of lunyu) {
      const paragraphs = (chapter.paragraphs || []).map(cleanText).filter(Boolean).slice(0, 6);
      if (!paragraphs.length) continue;
      push("论语", "格言", simplify(chapter.chapter || ""), "孔子及其弟子", "论语", paragraphs.join("\n"), { skill: "内容与立意" });
    }
  } catch (e) { console.log("论语失败:", e.message); }

  try { readGuwen(await download("蒙学/guwenguanzhi.json", "guwenguanzhi.json")); } catch (e) { console.log("古文观止失败:", e.message); }

  try { readParagraphObj(await download("蒙学/shenglvqimeng.json", "shenglvqimeng.json"), "声律启蒙", "车万育", "声律启蒙", "蒙学", "对韵", 6); } catch (e) { console.log("声律启蒙失败:", e.message); }
  try { readParagraphObj(await download("蒙学/youxueqionglin.json", "youxueqionglin.json"), "幼学琼林", "程登吉", "幼学琼林", "蒙学", "典故蒙书", 12); } catch (e) { console.log("幼学琼林失败:", e.message); }
  try { readParagraphObj(await download("蒙学/zengguangxianwen.json", "zengguangxianwen.json"), "增广贤文", "佚名", "增广贤文", "蒙学", "格言", 8); } catch (e) { console.log("增广贤文失败:", e.message); }
  try { readParagraphObj(await download("蒙学/sanzijing-new.json", "sanzijing.json"), "三字经", "王应麟", "三字经", "蒙学", "蒙学经典", 4); } catch (e) { console.log("三字经失败:", e.message); }
  try { readParagraphObj(await download("蒙学/dizigui.json", "dizigui.json"), "弟子规", "李毓秀", "弟子规", "蒙学", "蒙学经典", 5); } catch (e) { console.log("弟子规失败:", e.message); }
  try { readParagraphObj(await download("蒙学/qianziwen.json", "qianziwen.json"), "千字文", "周兴嗣", "千字文", "蒙学", "蒙学经典", 4); } catch (e) { console.log("千字文失败:", e.message); }

  try {
    const youmeng = await download("幽梦影/youmengying.json", "youmengying.json");
    for (const item of youmeng.slice(0, 40)) {
      const text = cleanText(item.content || "");
      if (countChars(text) < 8) continue;
      push("清言小品", "清言", text.slice(0, 14), "张潮", "幽梦影", text, { skill: "内容与立意" });
    }
  } catch (e) { console.log("幽梦影失败:", e.message); }

  try {
    const yuanqu = await download("元曲/yuanqu.json", "yuanqu.json");
    const picked = yuanqu.filter(item => /天净沙|山坡羊|沉醉东风|水仙子|四块玉|清江引|塞鸿秋|一半儿|殿前欢|折桂令/.test(item.title || "")).slice(0, 25);
    for (const item of picked) {
      push("元曲", "散曲", simplify(item.title || ""), simplify(item.author || ""), "全元曲", (item.paragraphs || []).join("\n"));
    }
  } catch (e) { console.log("元曲失败:", e.message); }

  await loadSongCi();
  await loadWikiProse();

  // 排序：名篇优先，短篇优先
  models.sort((a, b) => {
    if (a.famous !== b.famous) return a.famous ? -1 : 1;
    return a.chars - b.chars;
  });

  // 按类别限量，保证类型均衡、适合儿童阅读
  const CAP = { "古诗词": 170, "诗经": 32, "古文": 65, "宋词": 70, "元曲": 20, "清言小品": 25, "蒙学": 9, "论语": 20, "现代散文": 8 };
  const counters = {};
  const kept = [];
  for (const m of models) {
    const cap = CAP[m.category];
    counters[m.category] = (counters[m.category] || 0) + 1;
    if (cap && counters[m.category] > cap) continue;
    kept.push(m);
  }
  models.length = 0;
  models.push(...kept);
  models.forEach((m, i) => { m.id = "cls-" + String(i + 1).padStart(4, "0"); });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = "/* 自动生成，请勿手改。来源：chinese-poetry 公开数据集 + 维基文库公版文本 */\nwindow.MODEL_LIBRARY_CLASSICS = " + JSON.stringify(models, null, 0) + ";\n";
  fs.writeFileSync(path.join(OUT_DIR, "models-classics.js"), out, "utf8");

  const byCat = {};
  models.forEach(m => { byCat[m.category] = (byCat[m.category] || 0) + 1; });
  console.log("完成，共 " + models.length + " 篇：", byCat);
}

main().catch(e => { console.error(e); process.exit(1); });
