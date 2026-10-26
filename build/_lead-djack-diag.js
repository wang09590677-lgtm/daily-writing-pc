/* 【D_jack08_2m 专诊】这个场景 prod=3、最小改动版=0，而独立峰值法给 10。
 * 三方都不一致，必须查清"0"是修复引入的真回归，还是夹具本身的问题。
 * 逐帧打印：3.5s 窗峰峰 spread、门限 gate、detrend 后 RMS、阈值 k、越阈样本数。 */
"use strict";
const fs = require("fs"), path = require("path");
const E = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const e = E.D_jack08_2m, p = e.profile;
const s = e.series.map(x => ({ t: x.t, v: x[p.signal] }));
console.log(`场景 D_jack08_2m  sig=${p.signal}  ea=${p.expectedAmplitude}  时长=${e.secs}s  n=${s.length}`);
console.log(`信号范围 ${Math.min(...s.map(x => x.v)).toFixed(4)} ~ ${Math.max(...s.map(x => x.v)).toFixed(4)}，总峰峰 ${(Math.max(...s.map(x => x.v)) - Math.min(...s.map(x => x.v))).toFixed(4)}，门限 ${(p.expectedAmplitude * 0.5).toFixed(4)}`);

/* 每 0.5 秒采样一次，看 3.5s 窗峰峰随时间的演化 */
console.log("\n时间(s)  窗内n  3.5s窗峰峰  ≥门限?  该帧前 1 秒信号(每 0.1s 一个点)");
let gateOpenFrames = 0;
for (let f = 0; f < s.length; f++) {
  const now = s[f].t, from = now - 3.5, raw = [];
  for (let i = f; i >= 0; i--) { if (s[i].t < from) break; raw.push(s[i].v); }
  if (raw.length < 10) continue;
  const spread = Math.max(...raw) - Math.min(...raw);
  if (spread >= p.expectedAmplitude * 0.5) gateOpenFrames++;
  if (f % 30 === 0) {
    const sample = [];
    for (let i = Math.max(0, f - 60); i <= f; i += 6) sample.push(s[i].v.toFixed(3));
    console.log(`${now.toFixed(2).padStart(7)} ${String(raw.length).padStart(6)} ${spread.toFixed(4).padStart(11)}  ${spread >= p.expectedAmplitude * .5 ? "  开" : "  关"}    ${sample.join(" ")}`);
  }
}
console.log(`\n门限开启帧数：${gateOpenFrames} / ${s.length}  (${(gateOpenFrames / s.length * 100).toFixed(1)}%)`);

/* 看信号本身是不是"只在开头有一段动作" */
console.log("\n整段信号的分段统计（每 2 秒）：");
for (let a = 0; a < e.secs; a += 2) {
  const seg = s.filter(x => x.t >= a && x.t < a + 2).map(x => x.v);
  if (!seg.length) continue;
  console.log(`  ${a}~${a + 2}s  n=${String(seg.length).padStart(4)}  范围 ${Math.min(...seg).toFixed(4)}~${Math.max(...seg).toFixed(4)}  峰峰 ${(Math.max(...seg) - Math.min(...seg)).toFixed(4)}`);
}

/* 零阶保持检测：相邻不同值的比例 */
let changes = 0;
for (let i = 1; i < s.length; i++) if (Math.abs(s[i].v - s[i - 1].v) > 1e-12) changes++;
console.log(`\n相邻帧有变化的比例：${(changes / s.length * 100).toFixed(1)}%（60fps 采样下若远低于 100%，说明是 24/30fps 升采样的阶梯）`);
