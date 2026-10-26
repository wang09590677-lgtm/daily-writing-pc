// 抽取 picture 类素材，输出 JSON，供生图流程使用
const path = require("path");
global.window = global;
require(path.join(__dirname, "..", "data", "tasks.js"));
const lib = global.window.DAILY_TASK_LIBRARY;
const pics = lib.picture || [];
const out = pics.map((row, i) => ({
  idx: i + 1,
  id: "pic" + String(i + 1).padStart(3, "0"),
  title: row[0],
  desc: row[1],
  ask: row[2] || []
}));
const fs = require("fs");
fs.writeFileSync(path.join(__dirname, "pictures.json"), JSON.stringify(out, null, 1), "utf8");
console.log("picture total:", out.length);
out.slice(0, 8).forEach(o => console.log(o.id, "|", o.title, "|", o.desc.slice(0, 60)));
