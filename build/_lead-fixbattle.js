/* 【修法对决】在**真机序列**上比较 4 个候选，找出"既消 2×、又不丢拍"的修法。
 *
 * 已确证的事实（本会话）：
 *   · 真值：开合跳 ≈6（四独立物理量+FFT 一致）、跳绳 ≈10（关节极小值+FFT 一致）
 *   · 现状(prod) 开合跳 10（1.56×超计）、跳绳 12~13（1.2~1.3×超计）
 *   · F（只处理最新样本）开合跳 5（✓）但跳绳仅 6（0.6×严重欠计）→ F 不能用
 *   · 合成长弦上 F 在 60~180/分完全准确 → 不是拍速问题
 *   → 结论：F 的漏拍来自「最新样本的 detrend 居中窗被右边缘截断」，
 *     而 prod 靠重扫尾部用"更完整的窗"补回这些拍，却也把同一拍数了两次。
 *
 * 候选：
 *   prod = 重扫尾部 21 帧（现状）
 *   F    = 只处理最新 1 个样本
 *   Fp   = 延迟半窗后处理（居中窗完整），每样本一次
 *   H    = 重扫尾部，但**同一物理样本最多触发一次计数**（按样本时刻去重）★new
 *
 * 评估三张卷：
 *   卷1 真机 5 动作（真值已知）—— 看准不准
 *   卷2 静止/噪声/小幅 序列（_exp-series.json）—— 看误计
 *   卷3 纯正弦 30~240/分 —— 看拍速鲁棒性
 * 只读产品文件 + _realseries.json + _lm.json + _exp-series.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(arr){ if(arr.length<2) return 0; const m=arr.reduce((s,x)=>s+x,0)/arr.length; return Math.sqrt(arr.reduce((s,x)=>s+(x-m)*(x-m),0)/arr.length); }";
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const WIN_SECS = 3.5, TAIL_SECS = 0.35;

/* 统一计数器：series = [{t,v}]
 * 返回 {reps, hits:[t...], gatedFrames}
 * 关键实现细节：
 *   - raw 与 rawT 同步构建（含时间戳），供 H 的"样本时刻去重"
 *   - detrendC = 居中窗（原版）；detrendL = 截至当前的因果窗
 */
function counter(win, gap, mode, gate) {
  const env = `${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw, win) {
    const out = new Array(raw.length), half = Math.max(1, Math.floor(win / 2));
    const gstd = std(raw) || 1;
    for (let i = 0; i < raw.length; i++) { let s = 0, n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) { s += raw[j]; n++; }
      out[i] = (raw[i] - s / n) / gstd; }
    return out;
  }
  return function (series, fps) {
    const smoothK = Math.max(1, Math.round(fps * 0.06));
    const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
    const winN = ${win}, gapN = ${gap}, MODE = "${mode}", GATE = ${gate};
    let reps = 0, lastAt = -1, armed = false, gatedFrames = 0;
    let lastHitT = -1e9;              // H: 上次计数所依据的"样本时刻"
    const hits = [];
    for (let f = 0; f < series.length; f++) {
      const now = series[f].t, from = now - ${WIN_SECS};
      const raw = [], rawT = [];
      for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if (raw.length < 10) continue;
      const spread = Math.max(...raw) - Math.min(...raw);
      const gateOk = GATE <= 0 ? true : spread >= GATE;
      if (!gateOk) gatedFrames++;
      if (MODE === "prod" && !gateOk) { armed = false; continue; }
      const d = smooth(detrendC(raw, winN), smoothK);
      const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
      const k = clamp(rms * 0.85, 0.45, 2.2);
      let start, stop;
      if (MODE === "prod" || MODE === "H") { start = Math.max(0, d.length - tailN); stop = d.length; }
      else if (MODE === "Fp") { start = Math.max(0, d.length - 1 - Math.floor(winN / 2)); stop = Math.max(0, d.length - Math.floor(winN / 2)); }
      else { start = Math.max(0, d.length - 1); stop = d.length; }   // F
      for (let i = start; i < stop; i++) {
        const v = d[i];
        if (v < -k) armed = true;
        else if (v > k && armed) {
          const tSample = rawT[i];
          let allow = gateOk;
          if (MODE === "H" && tSample <= lastHitT) allow = false;    // 同一物理样本不重复计
          if (allow && (lastAt < 0 || now - lastAt >= gapN)) {
            reps += 1; hits.push(+now.toFixed(3)); lastAt = now; lastHitT = tSample;
          }
          armed = false;
        }
      }
      if (!gateOk) armed = false;
    }
    return { reps, hits, gatedFrames };
  };`;
  return new Function(env)();
}
const engWin = band => Math.max(3, Math.min(Math.round(60 * 60 / Math.max(15, band[1])), Math.round(60 * 1.5)));
const MODES = ["prod", "F", "Fp", "H"];

function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function extremaCount(a, gapF, prom, wantMin) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) {
    const is = wantMin ? (a[i] <= a[i - 1] && a[i] < a[i + 1]) : (a[i] >= a[i - 1] && a[i] > a[i + 1]);
    if (!is) continue;
    if (idx.length && i - idx[idx.length - 1] < gapF) { const b = wantMin ? a[i] < a[idx[idx.length - 1]] : a[i] > a[idx[idx.length - 1]]; if (b) idx[idx.length - 1] = i; } else idx.push(i);
  }
  return idx.filter(i => { const lo = Math.max(0, i - 30), hi = Math.min(a.length, i + 30); const sl = a.slice(lo, hi); const ref = wantMin ? Math.max(...sl) : Math.min(...sl); return Math.abs(ref - a[i]) >= prom; });
}
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } let o = out.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n2 = i + 1; while (n2 < o.length && !Number.isFinite(o[n2])) n2++; o[i] = (p >= 0 && n2 < o.length) ? (out[p] + out[n2]) / 2 : (p >= 0 ? out[p] : 0); } return o; };
const TRUTHMAP = { jumpingJacks: ["jumpingJacks", [15, 16], 1, 4, 0.02], jumpRope: ["jumpRope", [27, 28], 1, 3, 0.01], squat: ["squat", [27, 28], 1, 6, 0.02], halfSquatWarm: ["squat", [23, 24], 1, 6, 0.02], burpee: ["burpee", [27, 28], 1, 6, 0.02] };

console.log("############ 卷1：真机 5 动作（真值 = 单峰关节量极小值；bodyScale=1 口径）############\n");
console.log("动作       真值 | prod |  F  | F′  |  H");
console.log("-".repeat(52));
const vol1 = {};
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band), gate = ea * 0.5;
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const [lmName, idxs, axis, tgap, tprom] = TRUTHMAP[name];
  const tMin = extremaCount(smoothArr(fill(lmCol(lmName, idxs, axis)), 3), tgap, tprom, true).length;
  vol1[name] = { tMin, prof: a.profile, sig };
  const o = {};
  for (const m of MODES) o[m] = counter(win, gap, m, gate)(series, 60);
  const mark = (r) => { const e = Math.abs(r - tMin); return `${String(r).padStart(3)}${e <= 1 ? "·" : e <= 2 ? "~" : "✗"}`; };
  console.log(`${a.cn.padEnd(8)} ${String(tMin).padStart(3)} |  ${mark(o.prod.reps)} | ${mark(o.F.reps)} | ${mark(o.Fp.reps)} | ${mark(o.H.reps)}`);
}
console.log("\n（· 差≤1拍  ~ 差2拍  ✗ 差>2拍）");

console.log("\n############ 卷2：静止/噪声/小幅（_exp-series.json）—— 误计必须为 0 ############\n");
console.log("场景                     描述                            | prod |  F  | F′  |  H");
console.log("-".repeat(84));
const DESC = {
  A_static_2m: "静止 2m", B_noise06_2m: "静止+0.6px抖 2m", C_noise12_2m: "噪0.12 2m", C2_noise20_2m: "噪0.20 2m",
  D_jack08_2m: "真人开合0.8 2m", F_jack08_4m: "真人开合0.8 4m", G_noise12_4m: "噪0.12 4m",
  E_squat06: "真人深蹲0.6", H_squat06_4m: "真人深蹲0.6 4m"
};
for (const key of Object.keys(EXP)) {
  const e = EXP[key], p = e.profile;
  const win = engWin(p.tempoBand), gate = (p.expectedAmplitude || 0.1) * 0.5;
  const series = e.series.map(s => ({ t: s.t, v: s[p.signal] }));
  const o = {};
  for (const m of MODES) o[m] = counter(win, p.minRepGap, m, gate)(series, 60).reps;
  const isFalse = /static|noise/i.test(key);
  const flag = (r) => isFalse ? (r === 0 ? " 0·" : `${String(r).padStart(3)}✗`) : String(r).padStart(3);
  console.log(`${key.padEnd(14)} ${(DESC[key] || "").padEnd(30)} | ${flag(o.prod)} | ${flag(o.F)} | ${flag(o.Fp)} | ${flag(o.H)}`);
}

console.log("\n############ 卷3：纯正弦拍速扫描 30~240/分（数值无限分辨率）############\n");
console.log("场景 | 期望 | prod(比值) | F(比值) | F′(比值) | H(比值)");
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
for (const [winF, gap, label] of [[30, 0.3, "跳绳档 win0.5s/gap0.3"], [40, 0.45, "开合档 win0.67s/gap0.45"], [80, 0.9, "深蹲档 win1.33s/gap0.9"]]) {
  console.log(`\n-- ${label} --`);
  for (const rate of [30, 60, 90, 120, 150, 180, 240]) {
    const f = rate / 60, s = sineDs(f, 30), e = f * 30;
    const o = {};
    for (const m of MODES) o[m] = counter(winF, gap, m, 0)(s, 60).reps;
    const g = (r) => { const x = r / e; return `${String(r).padStart(3)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗欠" : ""}`; };
    console.log(`  ${String(rate).padStart(3)}/分 期望${String(e.toFixed(0)).padStart(3)} | ${g(o.prod)} | ${g(o.F)} | ${g(o.Fp)} | ${g(o.H)}`);
  }
}

console.log("\n############ 卷4：H 的详细（真机 5 动作计数时刻）############");
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band), gate = ea * 0.5;
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const t = vol1[name].tMin;
  const h = counter(win, gap, "H", gate)(series, 60);
  const p = counter(win, gap, "prod", gate)(series, 60);
  console.log(`\n${a.cn}  真值=${t}`);
  console.log(`  prod(${p.reps}): ${p.hits.join(", ")}`);
  console.log(`  H   (${h.reps}): ${h.hits.join(", ")}`);
}
