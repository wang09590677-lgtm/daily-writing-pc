// 验证：把**生产版 motion-engine.js 里真实的 detectReps 函数源码**原样抠出来，
// 配上它依赖的闭包环境，逐帧重放已采集的真实信号，直接读计数器。
// 与 _exp-final.js 不同：这里跑的就是**已落地的生产代码**，不是复刻版。
const fs = require("fs");
const path = require("path");

const SRC_PATH = path.join(__dirname, "..", "motion-engine.js");
const src = fs.readFileSync(SRC_PATH, "utf8");

function grab(a, b, label) {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("截取失败 " + label);
  return src.slice(i, j);
}
// 原样抠出生产函数（含新增的注释与闸门）
const detectRepsSrc = grab("function detectReps(now) {", "\n    /* ---------- 保持类 ----------", "detectReps");
if (!detectRepsSrc.includes("const gate = refAmp * 0.5 * bodyScale;")) {
  throw new Error("生产 detectReps 里没有幅度闸门 —— 改动未生效？");
}

// 语法检查：确认抠出来的确实是完整函数
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)", "clamp");
const meanSrc = grab("function mean(arr)", "function std(arr)", "mean");
const stdSrc = grab("function std(arr)", "// 动作参数默认值", "std");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)", "detrend");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次", "smooth");

/* ---- 用生产源码搭建闭包环境，构造一个可调用的 detectReps ---- */
function makeEngine(profile, fps) {
  const env = new Function("profile", `
    ${clampSrc}
    ${meanSrc}
    ${stdSrc}
    ${detrendSrc}
    ${smoothSrc}
    const SIGNALS = {
      centroidY: s => s.centroidY, width: s => s.width, height: s => s.height,
      bottomL: s => s.bottomL, bottomR: s => s.bottomR, area: s => s.area,
      motion: s => s.motion, upper: s => s.upper, lower: s => s.lower
    };
    const DEFAULT_PROFILE = { mode:"rep", signal:"centroidY", tempoBand:[20,60],
      minRepGap:0.5, expectedAmplitude:0.1, holdSeconds:30 };
    const prof = profile;
    function cfg(key){ if (prof && prof[key] !== undefined && prof[key] !== null) return prof[key]; return DEFAULT_PROFILE[key]; }
    function signalList(){ if (prof && Array.isArray(prof.signals) && prof.signals.length) return prof.signals; return [cfg("signal") || "centroidY"]; }
    let series = [];
    function signalWindow(key, seconds) {
      const t = series.length ? series[series.length-1].t : 0; const from = t - seconds;
      const raw = [];
      for (let i = series.length-1; i>=0; i--){ if (series[i].t < from) break; const fn = SIGNALS[key]; raw.unshift(fn ? fn(series[i]) : series[i].motion); }
      return raw;
    }
    let fps = ${fps};
    let live = { height: 0 };
    let repCounters = {}, reps = 0, repTimes = [];
    let repGate = 0, repSpread = 0, repHeightBase = 0;

    ${detectRepsSrc}

    return {
      pushRow(row){ series.push(row); if (series.length>4000) series.shift(); },
      tick(now, liveHeight){ live.height = liveHeight; detectReps(now); },
      getReps(){ return reps; },
      getDiag(){ return { repGate, repSpread, rawLen: series.length }; },
      setSeries(a){ series = a; }
    };
  `);
  return env(profile);
}

const FPS = 60;
const data = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));

const CASES = [
  ["J1_static_2m", "width", "静止+噪1.2px@2m", 0],
  ["C_noise12_2m", "width", "静止+噪1.2px@2m(窄人形)", 0],
  ["C2_noise20_2m", "width", "静止+噪2.0px@2m", 0],
  ["G_noise12_4m", "width", "静止+噪1.2px@4m", 0],
  ["J2_full_2m", "width", "全幅开合跳@2m", 9],
  ["J3_half_2m", "width", "半幅开合跳@2m", 9],
  ["J4_full_4m", "width", "全幅开合跳@4m", 9],
  ["E_squat06", "centroidY", "半蹲0.6Hz@2m(回归硬约束)", 9],
  ["H_squat06_4m", "centroidY", "半蹲0.6Hz@4m", 9]
];

const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
console.log("=== 生产版 detectReps 逐帧重放（直接调用已落地代码）===");
console.log("源码取证：detectReps 含 'const gate = refAmp * 0.5 * bodyScale;' →", detectRepsSrc.includes("const gate = refAmp * 0.5 * bodyScale;"));
console.log("");
console.log(pad("场景", 30) + pad("信号", 10) + pad("时长", 7) + pad("计数", 6) + pad("末帧gate", 11) + pad("末帧spread", 11) + "判定");
console.log("-".repeat(96));

let allOk = true;
for (const [id, key, label, expect] of CASES) {
  const c = data[id];
  if (!c || !c.series) { console.log("缺数据 " + id); allOk = false; continue; }
  const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
  const eng = makeEngine(c.profile, FPS);
  eng.setSeries([]);
  let lastGate = 0, lastSpread = 0;
  for (const row of ser) {
    eng.pushRow(row);
    eng.tick(row.t, row.height);
    const dg = eng.getDiag();
    lastGate = dg.repGate; lastSpread = dg.repSpread;
  }
  const reps = eng.getReps();
  const dur = ser[ser.length - 1].t;
  /* 逐帧统计"被门限挡住的比例"与"跨窗峰峰值"，用来判断某个场景是
   * "稳定通过 / 稳定挡住" 还是 "擦边"（擦边才是脆弱的）。 */
  const eng2 = makeEngine(c.profile, FPS);
  let gatedFrames = 0, totalFrames = 0, maxSpreadAll = 0;
  eng2.setSeries([]);
  for (const row of ser) {
    eng2.pushRow(row);
    eng2.tick(row.t, row.height);
    const dg = eng2.getDiag();
    totalFrames++;
    if (dg.repSpread < dg.repGate) gatedFrames++;
    if (dg.repSpread > maxSpreadAll) maxSpreadAll = dg.repSpread;
  }
  const gatedPct = totalFrames ? (gatedFrames / totalFrames * 100) : 0;

  // 判定：静止场景必须为 0；动作场景落在 [4, 15]（与 motion-browser-test.js 断言区间一致）
  let ok;
  if (expect === 0) ok = (reps === 0);
  else ok = (reps >= 4 && reps <= 15);
  if (!ok) allOk = false;
  console.log(pad(label, 30) + pad(key, 10) + pad(dur.toFixed(1) + "s", 7) + pad(reps, 6)
    + pad(lastGate.toFixed(4), 11) + pad(lastSpread.toFixed(4), 11)
    + pad(gatedPct.toFixed(0) + "%", 7) + pad(maxSpreadAll.toFixed(4), 11) + (ok ? "✓" : "✗"));
}

console.log("\n全部场景（按 motion-browser-test.js 的 4~15 区间判定）：" + (allOk ? "通过 ✓" : "存在不合格 ✗"));
console.log("\n说明：");
console.log("  · 「末帧gate / 末帧spread」= 生产 detectReps 暴露的 repGate / repSpread（真机调参就看这两个）");
console.log("  · 「挡下%」= 全程有多少比例帧因幅度不足被闸门拦掉。100% = 全程稳定挡住（静止场景应如此）");
console.log("  · 「最大spread」= 全程观测到的原始峰峰值峰值。它若远高于 gate，说明动作确实够大、非擦边");

/* 额外：确认 getState 暴露了 repGate / repSpread（静态检查） */
const gs = grab("function getState() {", "function emit()", "getState");
console.log("\n静态检查 getState() 暴露诊断字段：");
console.log("  repGate   →", /\brepGate,/.test(gs));
console.log("  repSpread →", /\brepSpread,/.test(gs));

/* 额外：确认模块级声明存在 */
console.log("\n静态检查模块级声明：");
console.log("  let repGate   →", /let repGate = 0;/.test(src));
console.log("  let repSpread →", /let repSpread = 0;/.test(src));

process.exit(allOk ? 0 : 1);
