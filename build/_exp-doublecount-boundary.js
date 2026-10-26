/* ==================================================================
 * _exp-doublecount-boundary.js — 钉死「2× 多计」的触发边界（只读实验）
 *
 * 背景
 *   上一轮报告发现：合成姿态链路里，纯正弦 height 信号在 1.0~1.5Hz 时引擎
 *   计数 ≈ 2× 肉眼周期数；把门限关掉后 reps 一模一样（与门限无关）。
 *   根因疑为：detrend() 的局部均值窗 win 与信号周期接近时，波形被压出额外过零，
 *   而 minRepGap 又放行了这对过零。
 *
 * 本脚本回答 team-lead 的问题：**什么样的真实输入会踩中它？**
 *   轴 1（频率）：height 信号，0.4→3.0Hz，真人取景（人高 65%），纯正弦。
 *   轴 2（波形）：在踩中的频率上，把波形从纯正弦逐步变成真实形状：
 *                 ① 纯正弦 ② 正弦+二次谐波 ③ 带平台正弦（到位有停顿）④ 加实测抖动
 *   轴 3（可见度）：部分下肢关键点 visibility 降到 VIS_MIN 以下（深色裤/腿检测不稳）。
 *
 * 关键设计
 *   · 全部走**姿态主链路**（PoseVision.pushLandmarks → visionGeometry → 真实 motion-engine.js）
 *   · 门限一律 ea=1e-6（≈关闭），**隔离**出"与门限无关"的那部分行为；同时给 ea=真值 的参照列
 *   · 物理周期数：取引擎自己看到的 live.height，数"过均值的上升沿"（与 team-lead 同法），
 *     避免拿生成器参数自证
 *   · 频率轴额外给出 detrend win(秒) / 信号周期(秒) 的比值，把边界**归因到参数**
 *
 * 纯 Node，不开浏览器。只读产品文件。运行：node build/_exp-doublecount-boundary.js
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fc(w, h) { return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
  const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
  for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
  return { data: d };
} }) }; }
globalThis.window = {}; globalThis.document = { createElement: () => fc(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;
const MP = PV.MP;

/* ---------------- 人体关键点合成（与 _exp-pose-synth-retake.js 同源） ---------------- */
function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: .5, y: .5, visibility: .95 }; return a; }
function makeBody(opt) {
  const lm = blank();
  const bodyH = opt.bodyH, feetY = opt.feetY, cx = .5, c = opt.compress || 0;
  const Y = y => feetY - (feetY - y) * (1 - c);
  const headTop = Y(feetY - bodyH), headR = .055 * bodyH, nose = { x: cx, y: headTop + headR };
  const shoulderY = Y(headTop + .20 * bodyH), hipY = Y(headTop + .52 * bodyH), kneeY = Y(headTop + .75 * bodyH), ankleY = Y(feetY);
  const shOff = .085 * bodyH, hipOff = .045 * bodyH;
  const shL = { x: cx - shOff, y: shoulderY }, shR = { x: cx + shOff, y: shoulderY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY };
  const phi = opt.armPhi || 0, armL = .36 * bodyH * (1 - c * .5);
  const arm = (sh, side) => ({ e: { x: sh.x + side * armL * .5 * Math.sin(phi), y: sh.y + armL * .5 * Math.cos(phi) },
    w: { x: sh.x + side * armL * Math.sin(phi), y: sh.y + armL * Math.cos(phi) } });
  const aL = arm(shL, -1), aR = arm(shR, 1);
  const spread = (opt.legSpread || 0) * bodyH;
  const leg = (hip, side) => ({ k: { x: hip.x + side * spread * .45, y: kneeY }, a: { x: hip.x + side * spread, y: ankleY } });
  const lL = leg(hipL, -1), lR = leg(hipR, 1);
  lm[MP.NOSE] = { ...nose, visibility: .95 }; lm[MP.L_EYE] = { x: cx - .012, y: nose.y - .006, visibility: .95 }; lm[MP.R_EYE] = { x: cx + .012, y: nose.y - .006, visibility: .95 };
  lm[MP.L_EAR] = { x: cx - .028, y: nose.y, visibility: .95 }; lm[MP.R_EAR] = { x: cx + .028, y: nose.y, visibility: .95 };
  lm[MP.L_SHOULDER] = { ...shL, visibility: .95 }; lm[MP.R_SHOULDER] = { ...shR, visibility: .95 };
  lm[MP.L_ELBOW] = { ...aL.e, visibility: .95 }; lm[MP.R_ELBOW] = { ...aR.e, visibility: .95 };
  lm[MP.L_WRIST] = { ...aL.w, visibility: .95 }; lm[MP.R_WRIST] = { ...aR.w, visibility: .95 };
  lm[MP.L_INDEX] = { x: aL.w.x, y: aL.w.y, visibility: .95 }; lm[MP.R_INDEX] = { x: aR.w.x, y: aR.w.y, visibility: .95 };
  lm[MP.L_HIP] = { ...hipL, visibility: .95 }; lm[MP.R_HIP] = { ...hipR, visibility: .95 };
  lm[MP.L_KNEE] = { ...lL.k, visibility: .95 }; lm[MP.R_KNEE] = { ...lR.k, visibility: .95 };
  lm[MP.L_ANKLE] = { ...lL.a, visibility: .95 }; lm[MP.R_ANKLE] = { ...lR.a, visibility: .95 };
  lm[MP.L_HEEL] = { x: lL.a.x, y: ankleY + .01, visibility: .95 }; lm[MP.R_HEEL] = { x: lR.a.x, y: ankleY + .01, visibility: .95 };
  lm[MP.L_FOOT] = { x: lL.a.x + .02, y: ankleY + .015, visibility: .95 }; lm[MP.R_FOOT] = { x: lR.a.x - .02, y: ankleY + .015, visibility: .95 };
  return lm;
}
const BODY_H = .65, FEET_Y = .88;
function makeRnd(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function jitterLM(lm, rnd, j) { return lm.map(p => ({ x: p.x + (rnd() - .5) * 2 * j, y: p.y + (rnd() - .5) * 2 * j, visibility: p.visibility })); }

/* ---------------- 波形族：p(θ) ∈ [0,1]（0=站直，1=压到最低） ---------------- */
function norm01(a) { let mn = Infinity, mx = -Infinity; for (const v of a) { if (v < mn) mn = v; if (v > mx) mx = v; } const d = (mx - mn) || 1; return a.map(v => (v - mn) / d); }
function wavePoints(kind, n, freq, fps, h2, dwell) {
  const th = i => 2 * Math.PI * freq * (i / fps);
  const raw = [];
  if (kind === "sine") for (let i = 0; i < n; i++) raw.push((1 - Math.cos(th(i))) / 2);
  else if (kind === "sine2") for (let i = 0; i < n; i++) raw.push(-.5 * Math.cos(th(i)) - h2 * .5 * Math.cos(2 * th(i)));
  else if (kind === "plateau") {
    // 到位有停顿：把正弦在 [lo,hi] 之外夹住 → 上下各形成平台
    const lo = .5 - dwell / 2, hi = .5 + dwell / 2;   // dwell≈0.5→平台更宽
    for (let i = 0; i < n; i++) { const s = (1 - Math.cos(th(i))) / 2; raw.push(Math.max(0, Math.min(1, (s - lo) / (hi - lo)))); }
  } else throw new Error("unknown wave " + kind);
  return norm01(raw);
}

/* ---------------- 跑引擎（姿态主链路） ---------------- */
const ENG = 60, SRC = 24, RATIO = ENG / SRC;
function runPose(frames, profile, opt) {
  const sig = profile.signal;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fc(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  const prevFrames = opt.previewFrames || ENG;
  const total = prevFrames + Math.round(opt.countSecs * ENG);
  const heightSeries = [];
  let prevSlot = -1, srcIdx = -1, lastLm = null;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === prevFrames) eng.start();
    const slot = Math.floor(i / RATIO);
    if (slot !== prevSlot) {
      prevSlot = slot; srcIdx++;
      const fi = opt.loop === false ? srcIdx : (srcIdx % frames.length);
      const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility })));
    }
    globalThis.__clock = (i + 1) * (1000 / ENG);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= prevFrames) heightSeries.push(eng.getState().live.height);
  }
  eng.stop();
  const st = eng.getState();
  return { reps: st.reps, gateEnd: st.repGate, heightSeries, poseFrames: heightSeries.length };
}

/* 物理周期数：数 live.height 过均值的**上升沿**（与 team-lead 同法） */
function upCrossings(v) {
  const fin = v.filter(Number.isFinite);
  if (!fin.length) return 0;
  const m = fin.reduce((a, b) => a + b, 0) / fin.length;
  let n = 0, below = false;
  for (const x of fin) { if (x < m) below = true; else if (below) { n++; below = false; } }
  return n;
}
const PROF_JR = { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 };
const PROF_JR_OFF = { ...PROF_JR, expectedAmplitude: 1e-6 };
/* 引擎内部窗口（fps=60, band=[60,120]） */
function winSeconds(band, fps) { return Math.min(Math.max(Math.round(fps * 60 / Math.max(15, band[1])), 3), Math.round(fps * 1.5)) / fps; }
const WIN_JR = winSeconds([60, 120], ENG);   // 0.5s

const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const f4 = v => (v == null ? "-" : Number(v).toFixed(4));
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG, srcFps: SRC, bodyH: BODY_H, winJR: WIN_JR }, freq: [], wave: [], vis: [] };

/* ============================================================
 * 轴 1：频率（纯正弦 height，真人取景）
 * ============================================================ */
console.log("=== 轴 1：频率（纯正弦 height，人高 65%，门限关闭 ea=1e-6，各扫 30s）===\n");
console.log("频率Hz | 物理周期数 | 引擎reps | 比值   | win/周期 | gate真值(参照) | 判定");
console.log("-".repeat(88));
const FREQS = [0.4, 0.5, 0.6, 0.75, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0];
for (const freq of FREQS) {
  const n = Math.round(30 * SRC);
  const p = wavePoints("sine", n, freq, SRC);
  const frames = p.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * x }), makeRnd(4242 + Math.round(freq * 1000)), .0025));
  const rOff = runPose(frames, PROF_JR_OFF, { countSecs: 30 });
  const rOn = runPose(frames, PROF_JR, { countSecs: 30 });
  const cyc = upCrossings(rOff.heightSeries);
  const ratio = cyc ? rOff.reps / cyc : 0;
  const wp = WIN_JR / (1 / freq);
  const tag = ratio >= 1.6 ? "★ 2× 区间" : (ratio >= 1.25 ? "偏高" : "正常");
  out.freq.push({ freq, cycles: cyc, repsGateOff: rOff.reps, ratio: +ratio.toFixed(2), winOverPeriod: +wp.toFixed(2), repsGateOn: rOn.reps, gateEnd: +rOn.gateEnd.toFixed(4), tag });
  console.log(pad(freq, 7) + pad(cyc, 11) + pad(rOff.reps, 9) + pad(ratio.toFixed(2), 8) + pad(wp.toFixed(2), 10) + pad(rOn.reps + " (闸=" + rOn.gateEnd.toFixed(3) + ")", 15) + tag);
}

/* ============================================================
 * 轴 2：波形（在踩中 2× 的频率上，逐步变真实）
 * ============================================================ */
const TRIG = 1.2;   // 轴 1 里比值最高的频率
console.log(`\n=== 轴 2：波形（频率 ${TRIG}Hz，门限关闭，各扫 30s）—— 看 2× 在哪一档消失 ===\n`);
console.log("波形                              | 物理周期数 | 引擎reps | 比值   | 判定");
console.log("-".repeat(80));
const WAVES = [
  { key: "① 纯正弦", kind: "sine", h2: 0, dwell: 0, jit: .0025 },
  { key: "② 正弦+二次谐波(h2=0.30)", kind: "sine2", h2: .30, dwell: 0, jit: .0025 },
  { key: "②b 正弦+二次谐波(h2=0.15)", kind: "sine2", h2: .15, dwell: 0, jit: .0025 },
  { key: "③ 带平台(停 33%/33%)", kind: "plateau", h2: 0, dwell: .34, jit: .0025 },
  { key: "③b 带平台(停 20%/20%)", kind: "plateau", h2: 0, dwell: .20, jit: .0025 },
  { key: "④ 纯正弦+实测抖动(j=0.005)", kind: "sine", h2: 0, dwell: 0, jit: .005 },
  { key: "④b 纯正弦+抖动(j=0.010)", kind: "sine", h2: 0, dwell: 0, jit: .010 },
  { key: "⑤ 平台+谐波+抖动(最真实)", kind: "plateau", h2: 0, dwell: .34, jit: .0025, mixHarm: .15 }
];
for (const wv of WAVES) {
  const n = Math.round(30 * SRC);
  let p = wavePoints(wv.kind, n, TRIG, SRC, wv.h2, wv.dwell);
  if (wv.mixHarm) p = norm01(p.map((v, i) => v + wv.mixHarm * (-.5 * Math.cos(2 * 2 * Math.PI * TRIG * (i / SRC)))));
  const frames = p.map(x => jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * x }), makeRnd(777 + Math.round(TRIG * 1000)), wv.jit));
  const r = runPose(frames, PROF_JR_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.heightSeries);
  const ratio = cyc ? r.reps / cyc : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.wave.push({ label: wv.key, kind: wv.kind, h2: wv.h2, dwell: wv.dwell, jit: wv.jit, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(wv.key, 34) + pad(cyc, 11) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
}

/* ============================================================
 * 轴 3：下肢关键点可见度（深色裤/腿检测不稳）
 * ============================================================ */
console.log(`\n=== 轴 3：下肢可见度（频率 ${TRIG}Hz，带平台波形，门限关闭）===\n`);
console.log("可见度设置                        | 物理周期数 | 引擎reps | 比值   | 判定");
console.log("-".repeat(80));
const LOWER = [MP.L_KNEE, MP.R_KNEE, MP.L_ANKLE, MP.R_ANKLE, MP.L_HEEL, MP.R_HEEL, MP.L_FOOT, MP.R_FOOT];
const VIS_CASES = [
  { key: "全部可见(0.95)", vis: .95, blank: false },
  { key: "下肢 vis=0.29（低于 VIS_MIN，剔）", vis: .29, blank: false },
  { key: "下肢 vis=0.5（半可信）", vis: .5, blank: false },
  { key: "下肢整点置空(NaN)", vis: .95, blank: true }
];
for (const vc of VIS_CASES) {
  const n = Math.round(30 * SRC);
  const p = wavePoints("plateau", n, TRIG, SRC, 0, .34);
  const frames = p.map(x => {
    let lm = makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: .15, legSpread: .01, compress: 1.0 * .09 * x });
    lm = jitterLM(lm, makeRnd(555), .0025);
    for (const idx of LOWER) {
      if (vc.blank) lm[idx] = { x: NaN, y: NaN, visibility: .95 };
      else lm[idx] = { ...lm[idx], visibility: vc.vis };
    }
    return lm;
  });
  const r = runPose(frames, PROF_JR_OFF, { countSecs: 30 });
  const cyc = upCrossings(r.heightSeries);
  const ratio = cyc ? r.reps / cyc : 0;
  const tag = ratio >= 1.6 ? "★ 仍 2×" : (ratio >= 1.25 ? "偏高" : "✔ 2× 消失");
  out.vis.push({ label: vc.key, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2), tag });
  console.log(pad(vc.key, 34) + pad(cyc, 11) + pad(r.reps, 9) + pad(ratio.toFixed(2), 8) + tag);
}

/* ============================================================
 * 参照：真实视频关键点（_lm.json）的真实周期数 vs 引擎 reps
 * ============================================================ */
console.log("\n=== 参照：真实视频（_lm.json）的周期数 vs 引擎 reps（姿态链路，门限真值）===\n");
try {
  const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
  const CASES = [
    { act: "jumpingJacks", cn: "开合跳", p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: .45, expectedAmplitude: .18 } },
    { act: "squat", cn: "徒手深蹲", p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: .9, expectedAmplitude: .12 } },
    { act: "jumpRope", cn: "跳绳", p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: .3, expectedAmplitude: .05 } },
    { act: "burpee", cn: "波比跳", p: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: .16 } }
  ];
  console.log("动作     | 信号   | 物理周期数 | 引擎reps | 比值");
  console.log("-".repeat(56));
  out.real = [];
  for (const c of CASES) {
    const a = lm.acts[c.act]; if (!a) continue;
    const frames = a.frames.map(f => f ? f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })) : null).filter(Boolean);
    const r = runPose(frames, c.p, { countSecs: (frames.length / SRC), loop: false });
    const sigSeries = r.heightSeries; // height 序列仅对 height 信号直接可用
    const cyc = upCrossings(sigSeries);
    const ratio = cyc ? r.reps / cyc : 0;
    out.real.push({ cn: c.cn, signal: c.p.signal, cycles: cyc, reps: r.reps, ratio: +ratio.toFixed(2) });
    console.log(pad(c.cn, 9) + pad(c.p.signal, 9) + pad(cyc, 11) + pad(r.reps, 9) + ratio.toFixed(2));
  }
  console.log("（注：此列周期数取自 height 序列；开合跳的计次信号是 width，周期数仅作规模参照）");
} catch (e) { console.log("跳过（读 _lm.json 失败）：" + e.message); }

fs.writeFileSync(path.join(__dirname, "_exp-doublecount-boundary.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-doublecount-boundary.json");
