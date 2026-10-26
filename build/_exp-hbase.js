
// 决定性对比：门限尺度用「当前帧高度」vs「慢变高度基线」，在全部场景上的表现。
// 目的：确认"瞬时高度抖动"是否是生产计数与已验证实验不一致的原因。
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
const detectRepsSrc = grab("function detectReps(now) {", "\n    /* ---------- 保持类 ----------", "detectReps");
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const stdSrc = grab("function std(arr)", "// 动作参数默认值");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");

const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));

function run(id, key, mode) {
  const c = all[id];
  const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
  const patched = mode === "instant"
    ? detectRepsSrc
    : detectRepsSrc.replace(
        "const bodyScale = clamp((live.height || 0.6) / 0.6, 1.0, 1.5);",
        "const hNow = live.height || repHeightBase || 0.6;"
        + " repHeightBase = repHeightBase ? repHeightBase + (hNow - repHeightBase) * clamp(1 / Math.max(1, fps * 2), 0.005, 0.2) : hNow;"
        + " const bodyScale = clamp(repHeightBase / 0.6, 1.0, 1.5);");
  if (mode !== "instant" && !patched.includes("repHeightBase = repHeightBase ?")) throw new Error("基线替换失败");

  const body = [
    clampSrc, meanSrc, stdSrc, detrendSrc, smoothSrc,
    'const SIGNALS = { width: s => s.width, height: s => s.height, centroidY: s => s.centroidY };',
    'const DEFAULT_PROFILE = { mode:"rep", signal:"centroidY", tempoBand:[20,60], minRepGap:0.5, expectedAmplitude:0.1 };',
    'const prof = profile;',
    'function cfg(k){ return (prof && prof[k] !== undefined && prof[k] !== null) ? prof[k] : DEFAULT_PROFILE[k]; }',
    'function signalList(){ return [cfg("signal") || "centroidY"]; }',
    'let series = [];',
    'function signalWindow(k2, seconds){ const t = series.length ? series[series.length-1].t : 0; const from = t - seconds; const raw = [];',
    '  for (let i = series.length - 1; i >= 0; i--){ if (series[i].t < from) break; const fn = SIGNALS[k2]; raw.unshift(fn ? fn(series[i]) : series[i].motion); }',
    '  return raw; }',
    'let fps = 60;',
    'let live = { height: 0 };',
    'let repCounters = {}, reps = 0, repTimes = [];',
    'let repGate = 0, repSpread = 0;',
    'let repHeightBase = 0;',
    patched,
    'return { push(r){ series.push(r); }, tick(t,h){ live.height = h; detectReps(t); },',
    '         get(){ return { reps: reps, repGate: repGate, repSpread: repSpread, hb: repHeightBase }; } };'
  ].join("\n");
  const e = new Function("profile", body)(c.profile);
  for (const row of ser) { e.push(row); e.tick(row.t, row.height); }
  return e.get();
}

const CASES = [
  ["J1_static_2m", "width", "静止噪@2m", 0], ["C_noise12_2m", "width", "静止噪1.2@2m", 0],
  ["C2_noise20_2m", "width", "静止噪2.0@2m", 0], ["G_noise12_4m", "width", "静止噪1.2@4m", 0],
  ["J2_full_2m", "width", "全幅开合@2m", 9], ["J3_half_2m", "width", "半幅开合@2m", 9],
  ["J4_full_4m", "width", "全幅开合@4m", 9],
  ["E_squat06", "centroidY", "半蹲@2m(回归)", 9], ["H_squat06_4m", "centroidY", "半蹲@4m", 9]
];
const pad = (s, n) => { s = String(s); while (s.length < n) s += " "; return s; };
console.log(pad("场景", 20) + pad("期望", 6) + pad("瞬时高度", 11) + pad("慢变基线", 11) + "改善");
console.log("-".repeat(60));
for (const [id, key, label, expect] of CASES) {
  const a = run(id, key, "instant").reps;
  const b = run(id, key, "smoothed").reps;
  const okA = expect === 0 ? a === 0 : (a >= 4 && a <= 15);
  const okB = expect === 0 ? b === 0 : (b >= 4 && b <= 15);
  console.log(pad(label, 20) + pad(expect, 6) + pad(a + (okA ? " ✓" : " ✗"), 11)
    + pad(b + (okB ? " ✓" : " ✗"), 11) + (b !== a ? "计数变化" : ""));
}
