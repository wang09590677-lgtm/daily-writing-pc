/* 【产品代码直跑哈内斯】不再"用脚本复刻"，而是**从 motion-engine.js 原文抠出真函数**，
 * 在最小桩环境里跑真 detectReps()。这样验证的是**已落地的代码本身**，
 * 而不是我另写的一份近似实现。
 *
 * 抠取清单（全部来自产品文件原文）：
 *   SIGNALS / clamp / mean / std / signalWindow / signalWindowTimes / detrend / smooth / detectReps
 * 桩：cfg(fps/profile/live/repCounters/reps/repTimes/repGate/repSpread/repHeightBase/series)
 * 用法：node build/_lead-harness.js  （三卷 + 启停 + 相位）
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 30));
  return SRC.slice(i, j);
}
const parts = {
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
};
parts.signalWindowTimes = grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)");
parts.signalWindow = grab("function signalWindow(key, seconds)", "// 去趋势：");
parts.detrend = grab("function detrend(raw, win)", "function smooth(raw, k)");
parts.smooth = grab("function smooth(raw, k)", "// 峰值计次");
parts.detectReps = grab("function detectReps(now)", "/* ---------- 保持类 ---------- */");

/* 组装：把**真函数原文**放进一个可注入上下文的工厂。
 * 注意 signalWindow / detrend / smooth / detectReps 都引用了 series / fps / live /
 * profile 等闭包变量，所以必须放在 makeEngine 内部（与产品文件里的嵌套层级一致）。 */
const FACTORY = `
return function makeEngine(profileIn, fpsInit, liveInit) {
  let fps = fpsInit || 60;
  let profile = profileIn;
  let live = liveInit;
  let series = [], repCounters = {}, reps = 0, repTimes = [], repGate = 0, repSpread = 0, repHeightBase = 0;
  function cfg(k) { return profile && profile[k] !== undefined ? profile[k] : undefined; }
  function signalList() {
    if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
    return [cfg("signal") || "centroidY"];
  }
${parts.SIGNALS}
${parts.clamp}
${parts.mean}
${parts.std}
${parts.signalWindowTimes}
${parts.signalWindow}
${parts.detrend}
${parts.smooth}
${parts.detectReps}
  return {
    run(seq) {
      series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
      for (const s of seq) {
        const dflt = { motion: 0, area: 0, centroidX: .5, centroidY: .5, width: 0, height: 0,
          bottomL: 0, bottomR: 0, left: 0, right: 0, upper: 0, lower: 0 };
        const row = Object.assign(dflt, liveInit, s);   // s 最后并入 → 显式键优先
        live = row;
        series.push(Object.assign({ t: s.t }, dflt, s));
        if (series.length > 60 * 30) series.shift();
        fps = s.__fps || fpsInit || 60;
        detectReps(s.t);
      }
      return { reps, repTimes: repTimes.slice(), repGate, repSpread };
    }
  };
};
`;

let makeEngine;
try {
  makeEngine = new Function(FACTORY)();
  console.log("✓ 从产品文件抠出真函数并组装成功");
  console.log("  抠到的 detectReps 长度 =", parts.detectReps.length, "字符（原文）");
  console.log("  抠到的 detrend 长度    =", parts.detrend.length, "字符（原文）");
} catch (e) {
  console.error("✗ 组装失败：", e.message);
  process.exit(1);
}
console.log("  含水位线 scannedT:", /scannedT/.test(parts.detectReps) ? "是" : "否");
console.log("  含旧的尾部重扫 tail:", /\btail\b/.test(parts.detectReps) ? "是（不该！）" : "否（正确）");
console.log("  含因果均值 acc-=:", /acc -= raw\[i - w\]|acc-=raw\[i-w\]/.test(parts.detrend) ? "是" : "否");

/* ---------- 载入真机与实验序列 ---------- */
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const PLAN = fs.readFileSync(path.join(ROOT, "data", "fitness-plan.js"), "utf8");
const ACTIONS = [];
{ const idRe = /^\s{2}(\w+):\s*\{/gm; const ids = []; let mm;
  while ((mm = idRe.exec(PLAN))) ids.push({ id: mm[1], at: mm.index });
  for (let k = 0; k < ids.length; k++) { const seg = PLAN.slice(ids[k].at, k + 1 < ids.length ? ids[k + 1].at : PLAN.length);
    const mo = seg.match(/motion:\s*\{([^}]*)\}/); if (!mo) continue; const blk = mo[1];
    if (!/mode:\s*"rep"/.test(blk)) continue;
    const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || ids[k].id;
    const sig = (blk.match(/signal:\s*"(\w+)"/) || [])[1];
    const band = (blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/) || []);
    const gap = parseFloat((blk.match(/minRepGap:\s*([\d.]+)/) || [])[1]);
    const ea = parseFloat((blk.match(/expectedAmplitude:\s*([\d.]+)/) || [])[1]);
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea }); } }

const iso = (sig, arr) => arr.map(o => ({ t: o.t, [sig]: o.v, height: 0.6, motion: 0, area: 0.1 }));

/* 造一个"所有信号都有值、且目标信号最后写入"的点。
 * 注意顺序：如果目标信号就是 height，必须**最后**写，否则会被默认的 height:0.6 覆盖
 * （我第一版就踩了这个坑 → 所有 height 类动作恒为 0，是脚本 bug 不是产品缺陷）。 */
function pt(t, sig, v) {
  const o = { t, motion: 0, area: 0.1, centroidX: 0.5, centroidY: 0.5, width: 0.3, height: 0.6 };
  o[sig] = v;
  return o;
}

console.log("\n" + "=".repeat(100));
console.log("【卷1】真机 5 动作（跑的是已落地的真 detectReps）");
console.log("-".repeat(100));
console.log("动作        声明信号   计数   （真值 开合跳 6~7 / 徒手深蹲 5 / 半蹲热身 ? / 跳绳 10 / 波比跳 2）");
for (const k of ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"]) {
  const a = R.acts[k], p = a.profile;
  const eng = makeEngine(p, 60, { height: 0.6 });
  const r = eng.run(a.series.map(s => { const o = Object.assign({}, s); delete o.t; return Object.assign({ t: s.t }, o); })).reps;
  console.log(`${a.cn.padEnd(11)} ${a.signal.padEnd(10)} ${String(r).padStart(4)}`);
}

console.log("\n" + "=".repeat(100));
console.log("【卷2】静止/噪声/小幅/远距离");
console.log("-".repeat(100));
console.log("场景            sig        计数");
for (const k of Object.keys(EXP)) {
  const e = EXP[k], p = e.profile;
  const eng = makeEngine(p, 60, { height: 0.6 });
  const r = eng.run(e.series.map(s => { const o = Object.assign({}, s); delete o.t; return Object.assign({ t: s.t }, o); })).reps;
  console.log(`${k.padEnd(15)} ${p.signal.padEnd(10)} ${String(r).padStart(4)}`);
}

console.log("\n" + "=".repeat(100));
console.log("【卷3】合成栅格 60 格（真 detectReps；比值≈1.00 为正确）");
console.log("-".repeat(100));
const ratesOf = A => [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * .25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * .75), A.band[1]];
const cells = []; let over = [], under = [];
for (const A of ACTIONS) for (const rate of ratesOf(A)) {
  const f = rate / 60, seq = [];
  for (let i = 0; i < 60 * 60; i++) seq.push(pt(i / 60, A.sig, 0.15 * Math.sin(2 * Math.PI * f * i / 60)));
  const p = { mode: "rep", signal: A.sig, tempoBand: A.band, minRepGap: A.gap, expectedAmplitude: A.ea };
  const r = makeEngine(p, 60, { height: 0.6 }).run(seq).reps, e = f * 60, x = r / e;
  cells.push(x); if (x > 1.4) over.push(`${A.cn}@${rate}=${r}/${e.toFixed(0)}`); if (x < .7) under.push(`${A.cn}@${rate}=${r}/${e.toFixed(0)}`);
}
const m = cells.reduce((a, b) => a + b, 0) / cells.length;
console.log(`平均比值=${m.toFixed(3)} 标准差=${Math.sqrt(cells.reduce((a, b) => a + (b - m) ** 2, 0) / cells.length).toFixed(3)} 最小=${Math.min(...cells).toFixed(2)} 最大=${Math.max(...cells).toFixed(2)}`);
console.log(`超计=${over.length} 欠计=${under.length}`);
if (over.length) console.log("  超计: " + over.slice(0, 8).join("  "));
if (under.length) console.log("  欠计: " + under.slice(0, 8).join("  "));

console.log("\n" + "=".repeat(100));
console.log("【卷4】起步相位扫描（N=6，真值 6；前置静止 3s = 对齐 3-2-1 口令）");
console.log("-".repeat(100));
for (const A of ACTIONS.filter(a => ["halfSquatWarm", "jumpingJacks", "jumpRope", "squat", "burpee"].includes(a.id))) {
  const rate = Math.round((A.band[0] + A.band[1]) / 2), got = [];
  for (let ph = 0; ph < 12; ph++) {
    const f = rate / 60, seq = []; let t = 0;
    for (let s = 0; s < 3; s += 1 / 60, t += 1 / 60) seq.push(pt(t, A.sig, 0.0006 * Math.sin(2 * Math.PI * 3 * t)));
    for (let s = 0; s < 6 / f; s += 1 / 60, t += 1 / 60) seq.push(pt(t, A.sig, A.ea * .42 * Math.sin(2 * Math.PI * f * s + 2 * Math.PI * ph / 12)));
    for (let s = 0; s < 2; s += 1 / 60, t += 1 / 60) seq.push(pt(t, A.sig, 0.0006 * Math.sin(2 * Math.PI * 3 * t)));
    got.push(makeEngine({ mode: "rep", signal: A.sig, tempoBand: A.band, minRepGap: A.gap, expectedAmplitude: A.ea }, 60, { height: 0.6 }).run(seq).reps);
  }
  console.log(`${A.cn.padEnd(10)} ${rate}/分  12 相位计数 = [${got.join(" ")}]  均值 ${(got.reduce((a, b) => a + b, 0) / 12).toFixed(2)}（真值 6）`);
}
