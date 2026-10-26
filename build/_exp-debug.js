// 排查：为什么生产版 detectReps 与 _exp-final.js 的 detect_NEW 在 J2_full_2m 上计数不同（5 vs 9）。
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
const detectRepsSrc = grab("function detectReps(now) {", "\n    /* ---------- 保持类 ----------", "detectReps");
// 注入探针，看看每条分支到底走没走
const probeSrc = detectRepsSrc
  .replace("const k = clamp(rms * 0.85, 0.45, 2.2);",
           "const k = clamp(rms * 0.85, 0.45, 2.2); dbg.maxK=Math.max(dbg.maxK,k); dbg.dLen=d.length;")
  .replace("if (v < -k) st.armed = true;",
           "if (v < -k) { st.armed = true; dbg.negCross++; if(v<dbg.minD)dbg.minD=v; }")
  .replace("else if (v > k && st.armed) {",
           "else if (v > k && st.armed) { dbg.posCross++;")
  .replace("if (spread < gate) { st.armed = false; return; }",
           "if (spread < gate) { st.armed = false; dbg.gated++; return; }");
if (!probeSrc.includes("dbg.maxK")) throw new Error("探针注入失败");

const all = Object.assign({},
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series-jack.json"), "utf8")));
const c = all.J2_full_2m;
const key = "width";
const ser = c.series.filter(r => isFinite(r[key]) && isFinite(r.height));
console.log("J2_full_2m: 帧数", ser.length, " 首t", ser[0].t.toFixed(3), " 末t", ser[ser.length - 1].t.toFixed(3));
const ts = ser.map(r => r.t);
let dtSum = 0; for (let i = 1; i < ts.length; i++) dtSum += ts[i] - ts[i - 1];
console.log("平均帧间隔", (dtSum / (ts.length - 1)).toFixed(5), "→ 等效 fps", (1 / (dtSum / (ts.length - 1))).toFixed(2));

// ---- 生产版 ----
const FPS = 60;
const env = new Function("profile", `
  ${grab("function clamp(v, a, b)", "function mean(arr)")}
  ${grab("function mean(arr)", "function std(arr)")}
  ${grab("function std(arr)", "// 动作参数默认值")}
  ${grab("function detrend(raw, win)", "function smooth(raw, k)")}
  ${grab("function smooth(raw, k)", "// 峰值计次")}
  const SIGNALS = { width: s => s.width, height: s => s.height, centroidY: s => s.centroidY };
  const DEFAULT_PROFILE = { mode:"rep", signal:"centroidY", tempoBand:[20,60], minRepGap:0.5, expectedAmplitude:0.1 };
  const prof = profile;
  function cfg(k){ return (prof && prof[k] !== undefined && prof[k] !== null) ? prof[k] : DEFAULT_PROFILE[k]; }
  function signalList(){ return [cfg("signal") || "centroidY"]; }
  let series = [];
  function signalWindow(key, seconds){ const t = series.length? series[series.length-1].t:0; const from=t-seconds; const raw=[];
    for (let i=series.length-1;i>=0;i--){ if (series[i].t<from) break; const fn=SIGNALS[key]; raw.unshift(fn?fn(series[i]):series[i].motion);} return raw; }
  let fps = ${FPS};
  let live = { height: 0 };
  let repCounters = {}, reps = 0, repTimes = [];
  let repGate = 0, repSpread = 0;
  let dbg = { negCross: 0, posCross: 0, armedSet: 0, maxD: 0, minD: 0, maxK: 0, dLen: 0, gated: 0 };
  ${probeSrc}
  return { push(r){ series.push(r); }, tick(t,h){ live.height=h; detectReps(t); },
           get(){ return { reps, repGate, repSpread, dbg }; } };
`)();
env.push && 0;
let wins = [];
for (const row of ser) {
  env.push(row);
  env.tick(row.t, row.height);
  const g = env.get();
  wins.push({ t: row.t, gate: g.repGate, spread: g.repSpread, reps: g.reps });
}
console.log("生产版计数 =", env.get().reps);
console.log("  调试：negCross( v<-k 次数)=" + env.get().dbg.negCross
  + " posCross(v>k&&armed 次数)=" + env.get().dbg.posCross
  + " 被门限挡下帧数=" + env.get().dbg.gated
  + " d范围[" + env.get().dbg.minD.toFixed(3) + "," + env.get().dbg.maxD.toFixed(3) + "]"
  + " maxK=" + env.get().dbg.maxK.toFixed(3)
  + " 末帧d长度=" + env.get().dbg.dLen);
const openFrames = wins.filter(w => w.spread >= w.gate).length;
console.log("  门限打开帧数 =", openFrames, "/", wins.length, "=", (openFrames / wins.length * 100).toFixed(0) + "%");
// 打印计数发生的位置
let prev = 0;
for (const w of wins) { if (w.reps > prev) { console.log("   计数 +1 @ t=" + w.t.toFixed(2) + " gate=" + w.gate.toFixed(4) + " spread=" + w.spread.toFixed(4)); prev = w.reps; } }

// ---- _exp-final 的 detect_NEW（同参数）----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const SMOOTH_K = Math.max(1, Math.round(FPS * 0.06)), REF_HEIGHT = 0.6;
const detrendBody = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothBody = grab("function smooth(raw, k)", "// 峰值计次");
const detrend = new Function("return (" + detrendBody.replace("function detrend", "function detrend") + ")")();
const smooth = new Function("return (" + smoothBody.replace("function smooth", "function smooth") + ")")();
function detectNEW(ser, band, minGap, key, ea, ratio) {
  const w = clamp(Math.round((FPS * 60) / Math.max(15, band[1])), 3, Math.round(FPS * 1.5));
  const tail = Math.max(2, Math.round(FPS * 0.35)), maxBuf = Math.round(FPS * 3.5);
  const ampMax = maxBuf, hMax = Math.round(FPS * 6);
  let armed = false, lastAt = -1, reps = 0;
  const buf = [], ampBuf = [], hBuf = [];
  for (const row of ser) {
    buf.push(row[key]); if (buf.length > maxBuf) buf.shift();
    ampBuf.push(row[key]); if (ampBuf.length > ampMax) ampBuf.shift();
    hBuf.push(row.height); if (hBuf.length > hMax) hBuf.shift();
    if (buf.length < 10 || ampBuf.length < 10) continue;
    const sc = clamp(mean(hBuf) / REF_HEIGHT, 1.0, 1.5);
    const gate = ea * ratio * sc;
    const spread = Math.max(...ampBuf) - Math.min(...ampBuf);
    if (spread < gate) { armed = false; continue; }
    const d = smooth(detrend(buf.slice(), w), SMOOTH_K);
    const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
    const k = clamp(rms * 0.85, 0.45, 2.2), t = row.t;
    for (let i = d.length - Math.min(d.length, tail); i < d.length; i++) {
      const v = d[i];
      if (v < -k) armed = true;
      else if (v > k && armed) { if (lastAt < 0 || t - lastAt >= minGap) { reps++; lastAt = t; } armed = false; }
    }
  }
  return reps;
}
console.log("_exp-final 版计数 =", detectNEW(ser, c.profile.tempoBand, c.profile.minRepGap, key, c.profile.expectedAmplitude, 0.5));

// 关键差异排查：生产 live.height 是"当前帧"，_exp-final 用 6s 均值。看两者差多少
console.log("\nheight 统计：min=" + Math.min(...ser.map(r => r.height)).toFixed(4)
  + " max=" + Math.max(...ser.map(r => r.height)).toFixed(4)
  + " mean6s末=" + mean(ser.slice(-360).map(r => r.height)).toFixed(4));
console.log("末帧 live.height（当前帧）= " + ser[ser.length - 1].height.toFixed(4));
