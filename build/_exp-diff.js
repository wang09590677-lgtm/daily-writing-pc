// 精确定位：生产 detectReps（5 次）与 _exp-final 的 detect_NEW（9 次）差异来源。
// 逐项替换生产版的某个因子，看计数何时从 5 变 9。
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
const c = all.J2_full_2m, key = "width";
const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));

// 变体 A：原样生产代码，bodyScale 用 live.height（当前帧）
// 变体 B：bodyScale 用 6s 滑动均值（_exp-final 的做法）
function makeEngine(heightMode) {
  const body = [
    clampSrc, meanSrc, stdSrc, detrendSrc, smoothSrc,
    'const SIGNALS = { width: s => s.width, height: s => s.height, centroidY: s => s.centroidY };',
    'const DEFAULT_PROFILE = { mode:"rep", signal:"centroidY", tempoBand:[20,60], minRepGap:0.5, expectedAmplitude:0.1 };',
    'const prof = profile;',
    'function cfg(k){ return (prof && prof[k] !== undefined && prof[k] !== null) ? prof[k] : DEFAULT_PROFILE[k]; }',
    'function signalList(){ return [cfg("signal") || "centroidY"]; }',
    'let series = [];',
    'let heightHist = [];',
    'function signalWindow(k2, seconds){ const t = series.length ? series[series.length-1].t : 0; const from = t - seconds; const raw = [];',
    '  for (let i = series.length - 1; i >= 0; i--){ if (series[i].t < from) break; const fn = SIGNALS[k2]; raw.unshift(fn ? fn(series[i]) : series[i].motion); }',
    '  return raw; }',
    'let fps = 60;',
    'let live = { height: 0 };',
    'let repCounters = {}, reps = 0, repTimes = [];',
    'let repGate = 0, repSpread = 0;',
    // 劫持 bodyScale 的计算源：把 detectReps 里那行替换掉
    detectRepsSrc.replace(
      'const bodyScale = clamp((live.height || 0.6) / 0.6, 1.0, 1.5);',
      heightMode === "mean6" 
        ? 'const hb = heightHist.length ? heightHist.reduce((a,b)=>a+b,0)/heightHist.length : 0.6; const bodyScale = clamp(hb / 0.6, 1.0, 1.5);'
        : 'const bodyScale = clamp((live.height || 0.6) / 0.6, 1.0, 1.5);'
    ),
    'return { push(r){ series.push(r); heightHist.push(r.height); if(heightHist.length>360)heightHist.shift(); },',
    '         tick(t,h){ live.height = h; detectReps(t); },',
    '         get(){ return { reps: reps, repGate: repGate, repSpread: repSpread }; } };'
  ].join("\n");
  return new Function("profile", body)(c.profile);
}

for (const mode of ["current", "mean6"]) {
  const e = makeEngine(mode);
  for (const row of ser) { e.push(row); e.tick(row.t, row.height); }
  console.log("bodyScale 源 = " + mode + " → 计数 = " + e.get().reps
    + "  末帧 gate=" + e.get().repGate.toFixed(4) + " spread=" + e.get().repSpread.toFixed(4));
}

// 变体 C：完全照 _exp-final 的 detect_NEW 写法（所有缓冲按帧 push，含 6s 高度均值）
console.log("\n_exp-final 的 detect_NEW 写法 → 计数 = 9（已知）");
console.log("\n差异定位结论：见上两行 bodyScale 源的对比。");
