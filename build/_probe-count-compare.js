"use strict";
/* 探针 9：用**产品 detectReps 原文**，对比各候选信号在真机数据上的计数。
 *
 * 目的：证明
 *   (1) 现有 height / bottomL 在"手臂在动"时会被数（根因证据）；
 *   (2) 候选 kneeUp / kneeAsym 在"手臂在动"时不数；
 *   (3) 候选在"真实动作"下仍能计数（不牺牲灵敏度）。
 *
 * 用法：node build/_probe-count-compare.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const PV = require(path.join(ROOT, "pose-vision.js"));
const LMJ = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
const MP = PV.MP;

function grab(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败：" + a.slice(0, 30));
  return SRC.slice(i, j);
}
const parts = {
  /* 在真 SIGNALS 表末尾补两条候选取值器。产品现在还没有它们，
   * 探针需要先能"独立试算"候选信号，所以用与产品将来**完全一致**的写法补上：
   *   kneeUp: s => s.kneeUp   kneeAsym: s => s.kneeAsym
   * 这只是探针的补丁，不影响产品文件。 */
  SIGNALS: grab("const SIGNALS = {", "function clamp(v, a, b)")
    .replace(/\n\s*\}\s*$/, "\n  ,kneeUp: s => s.kneeUp, kneeAsym: s => s.kneeAsym\n};\n"),
  clamp: grab("function clamp(v, a, b)", "function mean(arr)"),
  mean: grab("function mean(arr)", "function std(arr)"),
  std: grab("function std(arr)", "// 动作参数默认值"),
  signalWindowTimes: grab("function signalWindowTimes(key, seconds)", "function signalWindow(key, seconds)"),
  signalWindow: grab("function signalWindow(key, seconds)", "// 去趋势："),
  detrend: grab("function detrend(raw, win)", "function smooth(raw, k)"),
  smooth: grab("function smooth(raw, k)", "// 峰值计次"),
  detectReps: grab("function detectReps(now)", "/* ---------- 保持类 ---------- */"),
};
const FACTORY = `
return function makeEngine(profileIn, fpsInit) {
  let fps = fpsInit || 60, profile = profileIn;
  let live = { height: 0.6 };
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
  return { run(seq) {
    series = []; repCounters = {}; reps = 0; repTimes = []; repGate = 0; repSpread = 0; repHeightBase = 0;
    const dflt = { motion: 0, area: .1, centroidX: .5, centroidY: .5, width: .3, height: .6,
      bottomL: .9, bottomR: .9, left: 0, right: 0, upper: 0, lower: 0, kind: 0 };
    for (const s of seq) {
      live = Object.assign({}, dflt, s);
      series.push(Object.assign({ t: s.t }, live));
      if (series.length > 60 * 30) series.shift();
      fps = 60;
      detectReps(s.t);
    }
    return { reps, gate: repGate, spread: repSpread };
  } };
};`;
const makeEngine = new Function(FACTORY)();

/* ---- 从真机关键点重建"可用作信号的"逐帧量 ---- */
const vis = p => (p[2] === undefined || p[2] === null) ? 1 : p[2];
const gy = (fr, i) => { const p = fr[i]; return (p && vis(p) >= PV.VIS_MIN) ? p[1] : null; };
function rowOf(t, fr) {
  const m = PV.mapLandmarks(fr.map(p => ({ x: p[0], y: p[1], z: 0, visibility: p[2] })));
  const kl = gy(fr, MP.L_KNEE), kr = gy(fr, MP.R_KNEE);
  const knees = [kl, kr].filter(v => v != null);
  return {
    t,
    height: m.ok ? m.height : null,
    bottomL: m.ok ? m.bottomL : null,
    bottomR: m.ok ? m.bottomR : null,
    kneeUp: knees.length ? Math.max(...knees) : null,
    kneeAsym: (kl != null && kr != null) ? kr - kl : null
  };
}
/* 补齐 null：沿用上一有效值（真实链路里信号源不可用时必须保持，不能当 0）。
 * ⚠️ 必须写到一个**独立的** xxxFilled 键上：不能原地覆盖，
 *    否则 SRC 里那些 `live[key]` / `rows[key]` 的自引用会把自己吃掉。 */
function fill(rows, key) {
  const out = key + "Filled";
  let last = null;
  for (const r of rows) {
    if (r[key] != null) last = r[key];
    r[out] = last;
  }
  const first = rows.find(r => r[out] != null);
  const fv = first ? first[out] : 0;
  for (const r of rows) if (r[out] == null) r[out] = fv;
  return out;
}

/* 用真 detectReps 跑某一路信号的计数。
 * 注意：SIGNALS 表里没有 kneeUp/kneeAsym，所以这里临时给 SIGNALS 补两条
 * **与产品将来实现完全一致**的取值器（s => s.kneeUp 等），再调真 detectReps。 */
function count(rows, key, profile) {
  const seq = rows.map(r => ({ t: r.t, [key]: r[key + "Filled"] }))
    .filter(r => r[key] != null && r[key] !== undefined);
  for (let i = 1; i < seq.length; i++) seq[i].t = Math.max(seq[i].t, seq[i - 1].t + 1e-4);
  const p = Object.assign({}, profile, { signal: key });
  delete p.signals;
  return makeEngine(p, 60).run(seq);
}

const ACT_TMPL = { height: 0.05, bottomL: 0.15, kneeUp: 0.10, kneeAsym: 0.30 };
const KEYS = ["height", "bottomL", "kneeUp", "kneeAsym"];
const LABEL = { height: "height(现)", bottomL: "bottomL(现)", kneeUp: "kneeUp(候选)", kneeAsym: "kneeAsym(候选)" };

/* 把候选信号注进真 SIGNALS 表 —— 已在上面的 parts.SIGNALS 里补过，这里不再需要。 */

console.log("=== 真机数据：各信号在同一动作上的计数（profile 用各候选自己的 expectedAmplitude）===");
console.log("动作            " + KEYS.map(k => LABEL[k].padStart(15)).join(""));
const rowsByAct = {};
for (const key of Object.keys(LMJ.acts)) {
  const act = LMJ.acts[key];
  let rows = act.frames.filter(Boolean).map((fr, i) => rowOf(i / 24, fr));
  for (const k of KEYS) fill(rows, k);
  rowsByAct[key] = rows;
  const out = KEYS.map(k => {
    const p = { mode: "rep", signal: k, tempoBand: [60, 180], minRepGap: 0.2, expectedAmplitude: ACT_TMPL[k] };
    const r = count(rows, k, p);
    return String(r.reps).padStart(15);
  }).join("");
  console.log(`【${act.cn}】`.padEnd(16) + out);
}

/* ---- 构造"只有手臂在动、腿完全不动"的序列 ---- */
/* 物理依据（探针 5 实测）：手臂抬到头顶上方时，bbox 顶边由手（INDEX 指尖）决定；
 * 手臂在髋下时，bbox 底边由手（PINKY）决定。腿完全静止。
 * 这里用一个"直立、腿固定"的骨架，只让手腕/手指在头的上方与髋的下方之间摆动。 */
console.log("\n=== 合成验证：只有手臂上下摆、腿完全不动 ===");
/* 手从「髋下（低于膝）」摆到「头顶」。这个幅度对孩子来说很常见（伸懒腰、挥手）。
 * ⚠️ 中位线定在 0.5：手腕在 image-left 还是 image-right 由**左右手各自**决定，
 *    不能像第一版那样两只手都放同一侧（那样 bottomL/bottomR 一起被污染，与真机不符）。 */
function armOnlyFrame(phase) {
  const a = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);   // 0..1
  const wristY = 0.58 - 0.46 * a;                        // 髋下 0.58 ↔ 头顶上方 0.12
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  const put = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.95 }; };
  put(MP.NOSE, 0.5, 0.14);
  put(MP.L_EYE, 0.48, 0.12); put(MP.R_EYE, 0.52, 0.12);
  put(MP.L_EAR, 0.46, 0.13); put(MP.R_EAR, 0.54, 0.13);
  put(MP.L_SHOULDER, 0.44, 0.24); put(MP.R_SHOULDER, 0.56, 0.24);
  put(MP.L_HIP, 0.46, 0.52); put(MP.R_HIP, 0.54, 0.52);
  /* 腿完全静止 */
  put(MP.L_KNEE, 0.44, 0.68); put(MP.R_KNEE, 0.56, 0.68);
  put(MP.L_ANKLE, 0.44, 0.90); put(MP.R_ANKLE, 0.56, 0.90);
  put(MP.L_HEEL, 0.44, 0.93); put(MP.R_HEEL, 0.56, 0.93);
  put(MP.L_FOOT, 0.44, 0.94); put(MP.R_FOOT, 0.56, 0.94);
  /* 手臂摆动：MediaPipe 的 L_* 是人左侧（画面上靠右），这里让两只手分居中线两侧 */
  const eY = 0.24 + (wristY - 0.24) * 0.55;
  put(MP.L_ELBOW, 0.58, eY); put(MP.R_ELBOW, 0.42, eY);
  put(MP.L_WRIST, 0.59, wristY); put(MP.R_WRIST, 0.41, wristY);
  put(MP.L_INDEX, 0.59, wristY - 0.02); put(MP.R_INDEX, 0.41, wristY - 0.02);
  put(MP.L_PINKY, 0.59, wristY + 0.01); put(MP.R_PINKY, 0.41, wristY + 0.01);
  put(MP.L_THUMB, 0.59, wristY); put(MP.R_THUMB, 0.41, wristY);
  return lm;
}
{
  const fps = 24, secs = 8, rate = 60;
  const rows = [];
  for (let i = 0; i < fps * secs; i++) {
    const lm = armOnlyFrame(rate / 60 * (i / fps));
    rows.push(rowOf(i / fps, lm.map(p => [p.x, p.y, p.visibility])));
  }
  for (const k of KEYS) fill(rows, k);
  const hk = { mode: "rep", signal: "bottomL", signals: ["bottomL", "bottomR"], tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 };
  const jr = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 };
  console.log(`  高抬腿配置(signal=bottomL+bottomR, ea=0.15) → bottomL 计数=${count(rows, "bottomL", hk).reps}  真值 0`);
  console.log(`  跳绳配置  (signal=height,          ea=0.05) → height  计数=${count(rows, "height", jr).reps}  真值 0`);
  const pp = a => Math.max(...a) - Math.min(...a);
  console.log(`  峰峰值: height=${pp(rows.map(r => r.height)).toFixed(4)}  bottomL=${pp(rows.map(r => r.bottomL)).toFixed(4)}` +
    `  bottomR=${pp(rows.map(r => r.bottomR)).toFixed(4)}  kneeUp=${pp(rows.map(r => r.kneeUp)).toFixed(4)}  kneeAsym=${pp(rows.map(r => r.kneeAsym)).toFixed(4)}`);
  for (const k of KEYS) {
    const p = { mode: "rep", signal: k, tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: ACT_TMPL[k] };
    console.log(`  候选 ${k.padEnd(9)}（ea=${ACT_TMPL[k]}）→ 计数 = ${count(rows, k, p).reps}`);
  }
}
