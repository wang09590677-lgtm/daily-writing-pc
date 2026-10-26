/* 诊断：从 dump 的真实关键点里，量出各动作的取景裁切情况 + 信号的周期数，
 * 判定「深蹲是不是近景裁切」「开合跳 width 是不是一拍两个峰」。 */
"use strict";
const fs = require("fs");
const path = require("path");
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

function cycles(vals) {
  const v = vals.filter(Number.isFinite);
  if (v.length < 8) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length, dd = v.map(x => x - m);
  const rms = Math.sqrt(dd.reduce((a, b) => a + b * b, 0) / dd.length) || 1;
  const k = Math.max(0.45 * rms, 1e-9);
  let armed = false, n = 0;
  for (const x of dd) { if (x < -k) armed = true; else if (x > k && armed) { n++; armed = false; } }
  return n;
}
console.log("动作".padEnd(14) + "帧".padEnd(6) + "bbox顶(y最小)".padEnd(14) + "bbox底(y最大)".padEnd(14) + "左右是否出画".padEnd(14) + "width周期".padEnd(11) + "height周期");
console.log("-".repeat(96));
for (const [k, a] of Object.entries(d.acts)) {
  let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, n = 0;
  const W = [], H = [], CY = [];
  for (const f of a.frames) {
    if (!f) continue;
    const m = PV.mapLandmarks(f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })));
    if (!m.ok) continue;
    n++;
    minY = Math.min(minY, m.top); maxY = Math.max(maxY, m.bottom);
    minX = Math.min(minX, m.bbox.x); maxX = Math.max(maxX, m.bbox.x + m.bbox.w);
    W.push(m.width); H.push(m.height); CY.push(m.centroidY);
  }
  const topCrop = minY <= 0.005 ? "★顶出画" : "", botCrop = maxY >= 0.995 ? "★底出画" : "";
  const sideCrop = (minX <= 0.005 || maxX >= 0.995) ? "★左右出画" : "否";
  console.log(a.cn.padEnd(14) + String(n).padEnd(6) +
    (minY.toFixed(3) + (topCrop ? " " + topCrop : "")).padEnd(14) +
    (maxY.toFixed(3) + (botCrop ? " " + botCrop : "")).padEnd(14) +
    sideCrop.padEnd(14) +
    String(cycles(W)).padEnd(11) + String(cycles(H)));
}
