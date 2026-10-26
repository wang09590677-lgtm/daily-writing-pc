/* 【F 漏拍机制定位 + 正确修法搜索】
 *
 * 已确证：
 *   · F3（闸门改同步条件）== F  → 闸门前置 return 不是漏拍原因
 *   · 合成正弦上 F 在 60~180/分 完全准确（1.00）→ 不是重采样伪影、不是拍速问题
 *   · 但真实跳绳（99/分，真值10）F 只给 6
 * 结论指向：**真实信号的幅度/形态**与合成正弦不同 → 需逐帧看 F 到底在哪一拍判空。
 *
 * 本脚本：
 *   1) 逐帧 dump 跳绳：d 值、±k、gateOk、armed，标出"本该计数却没计"的拍；
 *   2) 检验一个关键变量：真实 height 信号是**平滑连续振荡**还是**台阶/双峰**？
 *   3) 测试候选修法：
 *      G  = 因果 detrend（只用"截至当前样本"的窗口，无右边缘偏置）+ 只处理新样本
 *      G2 = 因果 detrend + 只处理新样本 + 窗口用引擎 win
 *      F′ = 居中窗延迟半窗 + 只处理新样本（队友次选，查其黑洞）
 *   目标：找到一个"跳绳≈10、开合跳≈6、且静止不误计"的修法。
 * 只读产品文件 + _realseries.json + _lm.json。 */
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
const WIN_SECS = 3.5, TAIL_SECS = 0.35, ENG_FPS = 60;

/* 统一计数器：mode 决定 detrend 形态 + 扫描范围
 *   prod  : 居中窗 + 重扫尾部（现状）
 *   F     : 居中窗 + 只处理新样本
 *   Fp    : 居中窗延迟 half + 只处理"半窗前排"样本
 *   G     : 因果窗(截至当前) + 只处理新样本
 *   Gtail : 因果窗 + 重扫尾部
 */
function counter(win, gap, mode, gate) {
  const env = `${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
    function detrendC(raw, win) {          // 居中窗（原版）
      const out = new Array(raw.length), half = Math.max(1, Math.floor(win / 2));
      const gstd = std(raw) || 1;
      for (let i = 0; i < raw.length; i++) { let s = 0, n = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) { s += raw[j]; n++; }
        out[i] = (raw[i] - s / n) / gstd; }
      return out;
    }
    function detrendL(raw, win) {          // 因果窗（只取截至 i 的 win 个样本）
      const out = new Array(raw.length), gstd = std(raw) || 1;
      for (let i = 0; i < raw.length; i++) { let s = 0, n = 0;
        for (let j = Math.max(0, i - win + 1); j <= i; j++) { s += raw[j]; n++; }
        out[i] = (raw[i] - s / n) / gstd; }
      return out;
    }
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${gap}, MODE = "${mode}", GATE = ${gate};
      let reps = 0, lastAt = -1, armed = false; const hits = [];
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const spread = Math.max(...raw) - Math.min(...raw);
        const gateOk = GATE <= 0 ? true : spread >= GATE;
        const useLocal = (MODE === "G" || MODE === "Gtail");
        const d = smooth(useLocal ? detrendL(raw, winN) : detrendC(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        let start;
        if (MODE === "prod" || MODE === "Gtail") start = Math.max(0, d.length - tailN);
        else if (MODE === "Fp") start = Math.max(0, d.length - 1 - Math.floor(winN / 2));
        else start = Math.max(0, d.length - 1);
        const stop = MODE === "Fp" ? Math.max(0, d.length - Math.floor(winN / 2)) : d.length;
        for (let i = start; i < stop; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) {
            if (gateOk && (lastAt < 0 || now - lastAt >= gapN)) { reps += 1; hits.push(+now.toFixed(2)); lastAt = now; }
            armed = false;
          }
        }
        if (!gateOk) armed = false;
      }
      return { reps, hits };
    };`;
  return new Function(env)();
}
const engWin = band => Math.max(3, Math.min(Math.round(60 * 60 / Math.max(15, band[1])), Math.round(60 * 1.5)));
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

console.log("=== 候选修法在真机序列上的表现 ===");
console.log("gate 按 bodyScale=1.0 计；真值=单峰关节量极小值个数\n");
console.log("动作       真值 | prod |  F  | F′  |  G  | Gtail");
console.log("-".repeat(64));
const res = {};
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band), gate = ea * 0.5;
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const [lmName, idxs, axis, tgap, tprom] = TRUTHMAP[name];
  const tv = smoothArr(fill(lmCol(lmName, idxs, axis)), 3);
  const tMin = extremaCount(tv, tgap, tprom, true).length;
  const out = {};
  for (const mode of ["prod", "F", "Fp", "G", "Gtail"]) out[mode] = counter(win, gap, mode, gate)(series, 60);
  res[name] = { tMin, out, a };
  const f = v => String(v).padStart(4);
  console.log(`${a.cn.padEnd(8)} ${String(tMin).padStart(3)} | ${f(out.prod.reps)} | ${f(out.F.reps)} | ${f(out.Fp.reps)} | ${f(out.G.reps)} | ${f(out.Gtail.reps)}`);
}

console.log("\n=== 跳绳逐拍诊断（谁漏了哪一拍）===");
{
  const a = R.acts.jumpRope, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band), gate = ea * 0.5;
  const series = a.series.map(s => ({ t: s.t, v: s.height }));
  console.log(`win=${win}帧 gap=${gap}s gate=${gate.toFixed(4)} 真值=10 期望间隔≈0.60s`);
  for (const mode of ["prod", "F", "G", "Gtail"]) {
    const r = res.jumpRope.out[mode];
    console.log(`  ${mode.padEnd(6)} reps=${String(r.reps).padStart(2)}  ${r.hits.join(", ")}`);
  }
  // 打印 height 序列的稳定段（0.4~2.6s），看每拍形态
  console.log("\nheight 原值（每 2 帧一行，0.4s~2.6s）：");
  for (let t = 0.4; t <= 2.6; t += 0.0333 * 2) {
    const i = Math.round(t * 60);
    if (i >= series.length) break;
    const v = series[i].v;
    const bar = "█".repeat(Math.round((v - 0.79) / 0.07 * 50));
    console.log(`  t=${t.toFixed(2)} i=${String(i).padStart(3)} h=${v.toFixed(4)} ${bar}`);
  }
}

console.log("\n=== 判定 ===");
for (const name of Object.keys(res)) {
  const { tMin, out } = res[name], a = res[name].a;
  const ok = m => { const r = out[m].reps; return Math.abs(r - tMin) <= 1 ? "✅" : Math.abs(r - tMin) <= 2 ? "~" : "❌"; };
  console.log(`${a.cn.padEnd(8)} 真值${String(tMin).padStart(3)}  prod${ok("prod")} F${ok("F")} F′${ok("Fp")} G${ok("G")} Gtail${ok("Gtail")}   → ${["prod", "F", "Fp", "G", "Gtail"].filter(m => ok(m) === "✅").join("/") || "无"}`);
}
