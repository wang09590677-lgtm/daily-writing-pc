// 调试：为什么手搭的闭包环境下 raw 窗长度异常。用 Write 写文件避免 shell 转义。
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

const probe = detectRepsSrc
  .replace("const raw = signalWindow(key, 3.5);",
    "const raw = signalWindow(key, 3.5); dbg.calls++; if(raw.length>dbg.maxRaw)dbg.maxRaw=raw.length;")
  .replace("if (raw.length < 10) return;",
    "if (raw.length < 10) { dbg.early++; return; }")
  .replace("const k = clamp(rms * 0.85, 0.45, 2.2);",
    "const k = clamp(rms * 0.85, 0.45, 2.2); dbg.kReached++;")
  .replace("if (spread < gate) { st.armed = false; return; }",
    "if (spread < gate) { st.armed = false; dbg.gated++; return; }");
if (!probe.includes("dbg.calls")) throw new Error("探针注入失败");

const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));

function run(id, key) {
  const c = all[id];
  const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
  const body = [
    clampSrc, meanSrc, stdSrc, detrendSrc, smoothSrc,
    'const SIGNALS = { width: s => s.width, height: s => s.height, centroidY: s => s.centroidY };',
    'const DEFAULT_PROFILE = { mode: "rep", signal: "centroidY", tempoBand: [20,60], minRepGap: 0.5, expectedAmplitude: 0.1 };',
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
    'let dbg = { calls: 0, maxRaw: 0, early: 0, kReached: 0, gated: 0 };',
    probe,
    'return { push(r){ series.push(r); }, tick(t,h){ live.height = h; detectReps(t); },',
    '         get(){ return { reps: reps, dbg: dbg, seriesLen: series.length }; } };'
  ].join("\n");

  const env = new Function("profile", body)(c.profile);
  for (const row of ser) { env.push(row); env.tick(row.t, row.height); }
  const r = env.get();
  console.log(id + " (key=" + key + ", " + ser.length + " 帧): reps=" + r.reps
    + " | calls=" + r.dbg.calls + " maxRaw=" + r.dbg.maxRaw
    + " earlyReturn=" + r.dbg.early + " kReached=" + r.dbg.kReached + " gated=" + r.dbg.gated
    + " | seriesLen=" + r.seriesLen);
}

run("J2_full_2m", "width");
run("E_squat06", "centroidY");
run("C_noise12_2m", "width");
