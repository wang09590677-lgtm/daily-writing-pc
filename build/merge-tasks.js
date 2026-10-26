// 合并所有每日任务种子 -> data/tasks.js
const fs = require("fs");
const path = require("path");

const B = __dirname;
const OUT = path.join(B, "..", "data", "tasks.js");

function load(f) {
  try { return require(path.join(B, f)); } catch (e) { console.log("跳过", f, e.message); return null; }
}

const s1 = load("task-seeds-1.js") || {};
const s2 = load("task-seeds-2.js") || [];
const s3 = load("task-seeds-3.js") || [];
const s4 = load("task-seeds-4.js") || [];
const s5 = load("task-seeds-5.js") || [];
const s6 = load("task-seeds-6.js") || [];
const s7 = load("task-seeds-7.js") || [];
const s8 = load("task-seeds-8.js") || [];

const fragment = [...(s1.fragment || []), ...s5];
const picture = [...(s1.picture || []), ...s6];
const expand = [...s2, ...s7];
const words = [...s3];
const news = [...s4, ...s8];

const lib = { fragment, picture, expand, words, news };

const header = `/* 每日任务素材库（自动生成，勿手改）
 * fragment 故事补全  : [标题, 开头片段, [追问...]]
 * picture  看图编故事: [标题, 画面描述, [追问...]]
 * expand   文字扩写  : [原句, 提示, 能力, 建议字数]
 * words    词语编文  : [词语数组, 提示, 能力, 建议字数]
 * news     热点感想  : [领域, 标题, 素材, 要求, [追问...]]
 */\n`;

fs.writeFileSync(OUT, header + "window.DAILY_TASK_LIBRARY = " + JSON.stringify(lib) + ";\n", "utf8");

console.log("已生成", OUT);
console.log("fragment 故事补全 :", fragment.length);
console.log("picture  看图编故事:", picture.length);
console.log("expand   文字扩写  :", expand.length);
console.log("words    词语编文  :", words.length);
console.log("news     热点感想  :", news.length);
const dom = {};
news.forEach(x => dom[x[0]] = (dom[x[0]] || 0) + 1);
console.log("news 领域分布:", dom);
console.log("大小:", (fs.statSync(OUT).size / 1024).toFixed(1), "KB");
