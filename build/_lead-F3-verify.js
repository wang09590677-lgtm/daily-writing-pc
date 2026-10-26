/* 【F 漏样本假说 + 改良版 F3 验证】
 *
 * 假说：F（每帧只处理「最后一个样本」）与幅度闸门 `if (spread < gate) return;` 组合时，
 *       被闸门挡掉的帧其样本**永久丢失**（下一帧只看新的最后一个样本，永不回头）。
 *       跳绳 height 幅度小（ea=0.05 → gate≈0.025×bodyScale），spread 频繁贴近 gate，
 *       于是整拍被吃掉 → F 在跳绳只有 6 次（真值 10）。
 *
 * 改良 F3：样本**永不丢**——把闸门从「前置 return」改成「计数时的同步附加条件」：
 *       armed 状态照常推进，只是 gate 未通过时不允许把 +k 落成一次计数。
 *       配合 F 的「只处理新样本」，理论上既消 2× 又不漏拍。
 *
 * 在真机实测序列（_realseries.json 60fps）上对比：现状 / F / F3，并统计被闸门挡掉的帧数。
 * 只读产品文件 + _realseries.json + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const ENG_FPS = 60, WIN_SECS = 3.5, TAIL_SECS = 0.35;

/* MODE:
 *   prod = 现状（重扫尾部 21 帧 + 闸门前置 return）
 *   F    = 只处理最后 1 个样本 + 闸门前置 return        （队友首选）
 *   F3   = 只处理最后 1 个样本 + 闸门改为同步附加条件   （本实验改良）
 *   F3b  = 只处理最后 1 个样本 + 闸门同步 + 尾部 2 帧   （F3 的稳妥变体）
 *   prodSync = 现状尾部重扫 + 闸门同步（隔离闸门时机的单独影响）
 */
function counter(win, gap, mode, gate) {
  const env = `${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${gap}, MODE = "${mode}", GATE = ${gate};
      let reps = 0, lastAt = -1, armed = false, gatedFrames = 0, gateChecks = 0;
      const hits = [];
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const spread = Math.max(...raw) - Math.min(...raw);
        const gateOk = GATE <= 0 ? true : spread >= GATE;
        if (MODE === "prod" && !gateOk) { gatedFrames++; armed = false; continue; }
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        let start;
        if (MODE === "prod" || MODE === "prodSync") start = Math.max(0, d.length - tailN);
        else if (MODE === "F3b") start = Math.max(0, d.length - 2);
        else start = Math.max(0, d.length - 1);
        for (let i = start; i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) {
            gateChecks++;
            if (gateOk && (lastAt < 0 || now - lastAt >= gapN)) { reps += 1; hits.push(+now.toFixed(2)); lastAt = now; }
            armed = false;
          }
        }
        if (!gateOk) gatedFrames++;
      }
      return { reps, hits, gatedFrames, gateChecks };
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

console.log("=== 假说验证：幅度闸门挡帧数 & 各修法在真机序列上的计数 ===");
console.log("（真值 = 单峰关节量极小值个数；gate = ea×0.5，bodyScale 记 1.0）\n");
console.log("动作      真值 | 闸门挡帧 | 现状 | F  | F3 | F3b | prodSync | F3 偏差 | F3b 偏差");
console.log("-".repeat(96));
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band);
  const gate = ea * 0.5;                // bodyScale 取 1.0（序列身高≈0.77~0.83，实测 bodyScale 上限 1.5；此处给下界口径）
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const rp = counter(win, gap, "prod", gate)(series, 60);
  const rf = counter(win, gap, "F", gate)(series, 60);
  const r3 = counter(win, gap, "F3", gate)(series, 60);
  const r3b = counter(win, gap, "F3b", gate)(series, 60);
  const rps = counter(win, gap, "prodSync", gate)(series, 60);
  const [lmName, idxs, axis, tgap, tprom] = TRUTHMAP[name];
  const tv = smoothArr(fill(lmCol(lmName, idxs, axis)), 3);
  const tMin = extremaCount(tv, tgap, tprom, true).length;
  const bar = (r, t) => `${String(r).padStart(3)}${Math.abs(r - t) <= 1 ? "·" : Math.abs(r - t) <= 2 ? "~" : "✗"}`;
  console.log(
    `${a.cn.padEnd(7)} ${String(tMin).padStart(3)}  | ${String(rp.gatedFrames).padStart(6)} |  ${bar(rp.reps, tMin)} | ${bar(rf.reps, tMin)} | ${bar(r3.reps, tMin)} | ${bar(r3b.reps, tMin)} |   ${String(rps.reps).padStart(4)}   |   ${(r3.reps - tMin) >= 0 ? "+" : ""}${r3.reps - tMin}    |   ${(r3b.reps - tMin) >= 0 ? "+" : ""}${r3b.reps - tMin}`
  );
}
console.log("\n（图例：· = 与真值差 ≤1 拍；~ = 差 2 拍；✗ = 差 >2 拍）");

console.log("\n=== 跳绳 / 开合跳 详细（计数帧号 + 间隔）===");
for (const name of ["jumpRope", "jumpingJacks"]) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
  const win = engWin(band), gate = ea * 0.5;
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const [lmName, idxs, axis, tgap, tprom] = TRUTHMAP[name];
  const tv = smoothArr(fill(lmCol(lmName, idxs, axis)), 3);
  const tMin = extremaCount(tv, tgap, tprom, true).length;
  console.log(`\n--- ${a.cn}（${name}） 信号=${sig} band=[${band}] gap=${gap} ea=${ea} gate=${gate.toFixed(4)} 真值=${tMin} ---`);
  for (const mode of ["prod", "F", "F3", "F3b"]) {
    const r = counter(win, gap, mode, gate)(series, 60);
    const gaps = r.hits.slice(1).map((h, i) => (h - r.hits[i]).toFixed(2));
    console.log(`  ${mode.padEnd(5)} reps=${String(r.reps).padStart(3)}  闸门挡帧=${String(r.gatedFrames).padStart(3)}  帧号: ${r.hits.join(", ")}`);
    console.log(`        间隔: ${gaps.join(", ")}${gaps.length ? `   中位=${gaps.map(Number).sort((a, b) => a - b)[Math.floor(gaps.length / 2)]}` : ""}`);
  }
}
