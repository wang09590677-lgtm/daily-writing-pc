const fs=require("fs"),path=require("path");
const src=fs.readFileSync(path.join(__dirname,"..","motion-engine.js"),"utf8");
function grab(a,b){const i=src.indexOf(a),j=src.indexOf(b,i);return src.slice(i,j);}
const detectRepsSrc=grab("function detectReps(now) {","\n    /* ---------- 保持类 ----------","detectReps");
console.log("=== detectReps 源码首 40 行 ===");
console.log(detectRepsSrc.split("\n").slice(0,40).join("\n"));
console.log("\n=== signalWindow 出现在 detectReps 里的次数 ===");
console.log((detectRepsSrc.match(/signalWindow/g)||[]).length);
console.log("\n=== detectReps 是否 self-contained（尾部）===");
console.log(detectRepsSrc.split("\n").slice(-8).join("\n"));
