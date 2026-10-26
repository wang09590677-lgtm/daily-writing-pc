/* 核算各 rep 动作的 B1 / B0 窗长与出数延迟，判断延迟是否可接受（UI 上"数数"要跟手）。 */
"use strict";
const fs = require("fs"), path = require("path");
const PLAN = fs.readFileSync(path.join(__dirname, "..", "data", "fitness-plan.js"), "utf8");
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const idRe = /^\s{2}(\w+):\s*\{/gm; const list = []; let m;
while ((m = idRe.exec(PLAN))) list.push({ id: m[1], at: m.index });
console.log("动作          band        | B1窗(s) B1延迟(s) | B0窗(s) B0延迟(s) | 最慢周期(s)");
for (const it of list) {
  const nxt = PLAN.indexOf("\n  },", it.at); const seg = PLAN.slice(it.at, nxt > 0 ? nxt : PLAN.length);
  const mo = seg.match(/motion:\s*\{([^}]*)\}/); if (!mo) continue; const blk = mo[1];
  if (!/mode:\s*"rep"/.test(blk)) continue;
  const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || it.id;
  const b = blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)/); if (!b) continue;
  const b0 = +b[1], b1 = +b[2];
  const w1 = clamp(Math.round(3600 / Math.max(15, b1)), 3, 90);
  const w0 = clamp(Math.round(3600 / Math.max(8, b0)), 3, 210);
  console.log(`${nm.padEnd(11)} ${String(b0 + "-" + b1).padEnd(10)} | ${(w1 / 60).toFixed(2).padStart(7)} ${(w1 / 120).toFixed(2).padStart(8)} | ${(w0 / 60).toFixed(2).padStart(7)} ${(w0 / 120).toFixed(2).padStart(8)} | ${(60 / b0).toFixed(2)}`);
}
