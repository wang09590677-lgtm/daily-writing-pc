/* 【裁定实验】F 修法的"高速欠计"是真缺陷，还是我时间加速脚本的伪影？
 *
 * 背景：
 *   我在 _lead-sweep-real.js 里用「零阶保持 + 时间缩放」把 24fps 真实关键点加快，
 *   测出 F 在 120~160/分欠计（开合跳 0.50、跳绳 0.60），据此怀疑 F 有高速缺陷。
 *   但零阶保持上采样会**减少每周期内的有效台阶数**（原始只有 24fps），
 *   拍速越快、每周期台阶越少 → 检测法本身失效 → **可能是伪影**。
 *
 * 本实验两条独立证据：
 *   甲) 合成正弦（数值上无限时间分辨率），拍速 60~240/分：若 F 在此不欠计 → 伪影。
 *   乙) 真实信号改用**线性插值**上采样到 60fps（保留亚帧时间信息）再加速：
 *       与零阶保持结果对比。若插值版不欠计 → 证实伪影。
 *
 * 只读产品文件 + _lm.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const ENG_FPS = 60, SRC_FPS = 24, WIN_SECS = 3.5, TAIL_SECS = 0.35;
function counter(win, gap, mode) {
  const env = `${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${gap}, MODE = "${mode}";
      let reps = 0, lastAt = -1, armed = false;
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        const start = MODE === "prod" ? Math.max(0, d.length - tailN) : Math.max(0, d.length - 1);
        for (let i = start; i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= gapN) { reps += 1; lastAt = now; } armed = false; }
        }
      }
      return reps;
    };`;
  return new Function(env)();
}
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }

// ---- 甲) 合成正弦：把时间分辨率与拍速解耦 ----
console.log("=== 甲) 合成正弦（数值无限分辨率），拍速 60~240/分 ===");
console.log("跳绳档 win=30 gap=0.3 ；开合跳档 win=40 gap=0.45");
console.log("\n/min   Hz   | 跳绳: 期望 现状(比值)   F(比值) | 开合: 期望 现状(比值)   F(比值)");
const sine = (f, secs) => { const a = []; for (let i = 0; i < secs * ENG_FPS; i++) a.push({ t: i / ENG_FPS, v: 0.15 * Math.sin(2 * Math.PI * f * i / ENG_FPS) }); return a; };
const SECS = 30;
for (const rate of [60, 80, 100, 120, 140, 160, 180, 200, 240]) {
  const f = rate / 60;
  const s = sine(f, SECS), e = f * SECS;
  const rp1 = counter(30, 0.3, "prod")(s, ENG_FPS), rf1 = counter(30, 0.3, "F")(s, ENG_FPS);
  const rp2 = counter(40, 0.45, "prod")(s, ENG_FPS), rf2 = counter(40, 0.45, "F")(s, ENG_FPS);
  const flag = (r, ee) => { const x = r / ee; return `${String(r).padStart(4)}(${x.toFixed(2)})${x > 1.5 ? "★" : x < 0.7 ? "✗欠" : ""}`; };
  console.log(`${String(rate).padStart(4)}  ${f.toFixed(2)} |        ${String(e.toFixed(0)).padStart(4)} ${flag(rp1, e)}      ${flag(rf1, e)} |       ${String(e.toFixed(0)).padStart(4)} ${flag(rp2, e)}      ${flag(rf2, e)}`);
}

// ---- 乙) 真实信号：零阶保持 vs 线性插值 上采样 ----
function rawSignal(name) {
  const sig = name === "jumpingJacks" ? "width" : "height";
  const out = [];
  for (const f of LM.acts[name].frames) {
    if (!f) { out.push(NaN); continue; }
    const pts = f.filter(p => p && p.length > 2 && p[2] > 0.5);
    if (pts.length < 3) { out.push(NaN); continue; }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    out.push(sig === "width" ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys));
  }
  return fill(out);
}
const to60ZOH = (v, scale) => { const o = [], step = 1 / ENG_FPS, T = (v.length / SRC_FPS) * scale; for (let t = 0; t < T; t += step) o.push({ t, v: v[Math.min(v.length - 1, Math.floor((t / scale) * SRC_FPS))] }); return o; };
const to60LIN = (v, scale) => {
  const o = [], step = 1 / ENG_FPS, T = (v.length / SRC_FPS) * scale;
  for (let t = 0; t < T; t += step) {
    const src = (t / scale) * SRC_FPS;          // 源序号（可为小数）
    const i0 = Math.min(v.length - 1, Math.floor(src)), i1 = Math.min(v.length - 1, i0 + 1), fr = src - i0;
    o.push({ t, v: v[i0] * (1 - fr) + v[i1] * fr });   // 线性插值，保留亚帧信息
  }
  return o;
};
const ACT = { jumpRope: { cn: "跳绳", win: 30, gap: 0.3, truth: 10 }, jumpingJacks: { cn: "开合跳", win: 40, gap: 0.45, truth: 6.5 } };
console.log("\n=== 乙) 真实关键点：零阶保持(ZOH, 我上轮用的) vs 线性插值(LIN) ===");
console.log("（真值取自决定性实验：跳绳=10（周期14帧/0.583s）、开合跳=6.5（周期23帧/0.958s））");
console.log("\n动作    目标/min | ZOH: 现状(比值)  F(比值)  | LIN: 现状(比值)  F(比值)");
for (const name of Object.keys(ACT)) {
  const v = rawSignal(name), baseRate = (name === "jumpRope" ? 99 : 119);
  const c = ACT[name];
  for (const target of [40, 60, 80, 100, 120, 160]) {
    const scale = baseRate / target;
    const z = to60ZOH(v, scale), l = to60LIN(v, scale);
    const rz_p = counter(c.win, c.gap, "prod")(z, ENG_FPS), rz_f = counter(c.win, c.gap, "F")(z, ENG_FPS);
    const rl_p = counter(c.win, c.gap, "prod")(l, ENG_FPS), rl_f = counter(c.win, c.gap, "F")(l, ENG_FPS);
    const T = c.truth;
    const flag = (r) => { const x = r / T; return `${String(r).padStart(3)}(${x.toFixed(2)})${x > 1.5 ? "★" : x < 0.7 ? "✗欠" : ""}`; };
    console.log(`${c.cn.padEnd(6)} ${String(target).padStart(6)}    |     ${flag(rz_p)}    ${flag(rz_f)}   |     ${flag(rl_p)}    ${flag(rl_f)}`);
  }
  console.log("");
}
