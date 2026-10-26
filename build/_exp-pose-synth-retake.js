/* ==================================================================
 * _exp-pose-synth-retake.js — 「真人取景规格」合成重演，但走**姿态主链路**
 *
 * 为什么要重做一遍（上一版 _exp-retake-synth.js 走的其实是掩码链路）：
 *   真机有 MediaPipe 时引擎**永远优先走姿态链路**（visionSource:"pose"），
 *   掩码只是兜底。所以标定门限必须在**姿态链路**上做。上一版合成重演
 *   只渲染灰度人形喂引擎（没接 PoseVision），量到的是掩码链路 ——
 *   它不会采纳，只能当"掩码兜底链路"的旁证。
 *
 * 本脚本直接合成 **MediaPipe 33 关键点**（归一化坐标），逐帧喂
 * PoseVision.pushLandmarks → 引擎姿态主链路。几何量由 mapLandmarks()
 * 真算（width = 可见点包围盒宽，height = 包围盒高），不再受"渲染像素/
 * 背景差"中间环节干扰，幅度可精确定量。
 *
 * 取景规格（照真机要求）
 *   · 人占画面高 65%（孩子站 2~3 米、站位校准后的推荐中值）
 *   · 脚在 0.88、头顶在 0.23，上下都留边距（**不裁切**）
 *   · 33 关键点全部可见（visibility=0.95），模拟"站得正、光线好"
 *
 * 扫的变量
 *   f = 动作幅度系数（相对"做满幅度"）：0.15 / 0.25 / 0.35 / 0.5 / 0.7 / 0.85 / 1.0
 *   动作：开合跳（width）/ 跳绳（height）/ 深蹲（height）/ 半蹲（centroidY）
 *   另加对照：站立不动 + 亚像素抖动（验证门限仍能挡住"不动也计数"）
 *
 * 引擎时序：60fps 主循环，关键点按 24Hz 推（同真机），先 preview 1.0s。
 *
 * 只读产品文件。运行：node build/_exp-pose-synth-retake.js
 * ================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const W = 96, H = 72, PIX = W * H, VW = 128, VH = 96;

globalThis.__frame = new Float32Array(PIX);
globalThis.__clock = 0; globalThis.__rafCb = null; globalThis.__rafId = 1;
function fakeCanvas(w, h) {
  return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: () => {
    const s = globalThis.__frame, d = new Uint8ClampedArray(PIX * 4);
    for (let i = 0, p = 0; i < PIX; i++, p += 4) { const v = s[i] | 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
    return { data: d };
  } }) };
}
globalThis.window = {}; globalThis.document = { createElement: () => fakeCanvas(W, H) };
globalThis.performance = { now: () => globalThis.__clock };
globalThis.requestAnimationFrame = (cb) => { globalThis.__rafCb = cb; return globalThis.__rafId++; };
globalThis.cancelAnimationFrame = () => {};
try { globalThis.navigator = { userAgent: "node" }; }
catch (e) { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); }
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* ---------------- MediaPipe 33 点合成（归一化坐标，0=左/上） ----------------
 * 只做"能被人形几何正确解读"的骨架：躯干 + 头 + 双臂 + 双腿，全部可见。 */
const MP = PV.MP;
function blank() { const a = new Array(33); for (let i = 0; i < 33; i++) a[i] = { x: 0.5, y: 0.5, visibility: 0.95 }; return a; }

/* opt: { bodyH, feetY, armPhi, legSpread, compress, cx } */
function makeBody(opt) {
  const lm = blank();
  const bodyH = opt.bodyH, feetY = opt.feetY, cx = opt.cx === undefined ? 0.5 : opt.cx;
  const c = opt.compress || 0;                 // 纵向压缩（0=站直，1=压到脚底）
  const Y = y => feetY - (feetY - y) * (1 - c); // 向脚底压缩
  const headTop = Y(feetY - bodyH);
  const headR = 0.055 * bodyH;
  const nose = { x: cx, y: headTop + headR };
  const shoulderY = Y(headTop + 0.20 * bodyH);
  const hipY = Y(headTop + 0.52 * bodyH);
  const kneeY = Y(headTop + 0.75 * bodyH);
  const ankleY = Y(feetY);
  const shOff = 0.085 * bodyH, hipOff = 0.045 * bodyH;
  const shL = { x: cx - shOff, y: shoulderY }, shR = { x: cx + shOff, y: shoulderY };
  const hipL = { x: cx - hipOff, y: hipY }, hipR = { x: cx + hipOff, y: hipY };

  // 手臂：phi=0 垂下，phi=π/2 侧平举，phi=π 举过头顶
  const phi = opt.armPhi || 0, armL = 0.36 * bodyH * (1 - c * 0.5);
  const arm = (sh, side) => {
    const ex = sh.x + side * armL * 0.5 * Math.sin(phi);
    const ey = sh.y + armL * 0.5 * Math.cos(phi);
    const wx = sh.x + side * armL * Math.sin(phi);
    const wy = sh.y + armL * Math.cos(phi);
    return { e: { x: ex, y: ey }, w: { x: wx, y: wy } };
  };
  const aL = arm(shL, -1), aR = arm(shR, 1);

  // 腿：spread 额外横向张开
  const spread = (opt.legSpread || 0) * bodyH;
  const leg = (hip, side) => {
    const kx = hip.x + side * spread * 0.45, ax = hip.x + side * spread;
    return { k: { x: kx, y: kneeY }, a: { x: ax, y: ankleY } };
  };
  const lL = leg(hipL, -1), lR = leg(hipR, 1);

  lm[MP.NOSE] = { ...nose, visibility: 0.95 };
  lm[MP.L_EYE] = { x: cx - 0.012, y: nose.y - 0.006, visibility: 0.95 };
  lm[MP.R_EYE] = { x: cx + 0.012, y: nose.y - 0.006, visibility: 0.95 };
  lm[MP.L_EAR] = { x: cx - 0.028, y: nose.y, visibility: 0.95 };
  lm[MP.R_EAR] = { x: cx + 0.028, y: nose.y, visibility: 0.95 };
  lm[MP.L_SHOULDER] = { ...shL, visibility: 0.95 };
  lm[MP.R_SHOULDER] = { ...shR, visibility: 0.95 };
  lm[MP.L_ELBOW] = { ...aL.e, visibility: 0.95 };
  lm[MP.R_ELBOW] = { ...aR.e, visibility: 0.95 };
  lm[MP.L_WRIST] = { ...aL.w, visibility: 0.95 };
  lm[MP.R_WRIST] = { ...aR.w, visibility: 0.95 };
  lm[MP.L_INDEX] = { x: aL.w.x, y: aL.w.y, visibility: 0.95 };
  lm[MP.R_INDEX] = { x: aR.w.x, y: aR.w.y, visibility: 0.95 };
  lm[MP.L_HIP] = { ...hipL, visibility: 0.95 };
  lm[MP.R_HIP] = { ...hipR, visibility: 0.95 };
  lm[MP.L_KNEE] = { ...lL.k, visibility: 0.95 };
  lm[MP.R_KNEE] = { ...lR.k, visibility: 0.95 };
  lm[MP.L_ANKLE] = { ...lL.a, visibility: 0.95 };
  lm[MP.R_ANKLE] = { ...lR.a, visibility: 0.95 };
  lm[MP.L_HEEL] = { x: lL.a.x, y: ankleY + 0.01, visibility: 0.95 };
  lm[MP.R_HEEL] = { x: lR.a.x, y: ankleY + 0.01, visibility: 0.95 };
  lm[MP.L_FOOT] = { x: lL.a.x + 0.02, y: ankleY + 0.015, visibility: 0.95 };
  lm[MP.R_FOOT] = { x: lR.a.x - 0.02, y: ankleY + 0.015, visibility: 0.95 };
  return lm;
}

const BODY_H = 0.65, FEET_Y = 0.88;

/* 确定性 LCG 抖动（模拟真实 MediaPipe 的亚像素抖） */
function makeRnd(seed0) { let s = seed0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function jitterLM(lm, rnd, j) {
  return lm.map(p => ({ x: p.x + (rnd() - 0.5) * 2 * j, y: p.y + (rnd() - 0.5) * 2 * j, visibility: p.visibility }));
}

/* ---------------- 动作生成（关键点序列） ---------------- */
function genOpenjump(f, freq, n, fps, j) {
  const rnd = makeRnd(4242 + Math.round(f * 1e4)); const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps, p = 0.5 - 0.5 * Math.cos(2 * Math.PI * freq * t);
    const lm = makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: f * Math.PI * p, legSpread: f * 0.11 * p, compress: 0.04 * p });
    out.push(jitterLM(lm, rnd, j));
  }
  return out;
}
function genJumpRope(f, freq, n, fps, j) {
  const rnd = makeRnd(7788 + Math.round(f * 1e4)); const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps, p = 0.5 - 0.5 * Math.cos(2 * Math.PI * freq * t);
    // 跳绳：全身纵向压缩-伸展，压缩量 = f × 体高 × 9%（对照真实视频 8.6%）
    const lm = makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: 0.15, legSpread: 0.01, compress: f * 0.09 * p });
    out.push(jitterLM(lm, rnd, j));
  }
  return out;
}
function genSquat(f, freq, n, fps, j) {
  const rnd = makeRnd(3311 + Math.round(f * 1e4)); const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps, p = 0.5 - 0.5 * Math.cos(2 * Math.PI * freq * t);
    // 深蹲：下蹲时整体变矮（压缩），幅度 = f × 体高 × 33%（真实视频 height 峰峰/体高≈0.50，取保守）
    const lm = makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: 0.5 * p, legSpread: 0.03, compress: f * 0.33 * p });
    out.push(jitterLM(lm, rnd, j));
  }
  return out;
}
function genStandStill(n, fps, j) {
  const rnd = makeRnd(9001); const out = [];
  for (let i = 0; i < n; i++) out.push(jitterLM(makeBody({ bodyH: BODY_H, feetY: FEET_Y, armPhi: 0, legSpread: 0.02 }), rnd, j));
  return out;
}

/* ---------------- 跑引擎（姿态主链路） ---------------- */
function med(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; }
function winSpreadMed(vals, wf) {
  const out = [];
  for (let i = wf - 1; i < vals.length; i++) {
    const seg = vals.slice(i - wf + 1, i + 1).filter(Number.isFinite);
    if (seg.length >= 5) out.push(Math.max(...seg) - Math.min(...seg));
  }
  return med(out);
}
function runPose(frames, profile, opt) {
  const engFps = opt.engFps || 60, srcFps = opt.srcFps || 24, ratio = engFps / srcFps;
  const sig = profile.signal;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 });
  eng.attachVision(pv);
  const rec = { sig: [], h: [], gate: [], spread: [], src: [] };
  let prevSlot = -1, srcIdx = -1, lastLm = null;
  const total = opt.previewFrames + opt.countFrames;
  eng.preview();
  for (let i = 0; i < total; i++) {
    if (i === opt.previewFrames) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prevSlot) {
      prevSlot = slot; srcIdx++;
      const fi = opt.loop ? (srcIdx % frames.length) : srcIdx;
      const f = frames[fi]; if (f) lastLm = f;
      if (lastLm) pv.pushLandmarks(lastLm.map(p => ({ x: p.x, y: p.y, visibility: p.visibility })));
    }
    globalThis.__clock = (i + 1) * (1000 / engFps);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= opt.previewFrames) {
      const st = eng.getState();
      rec.sig.push(st.live[sig]); rec.h.push(st.live.height);
      rec.gate.push(st.repGate); rec.spread.push(st.repSpread); rec.src.push(st.live.visionSource);
    }
  }
  eng.stop();
  const st = eng.getState();
  const vals = rec.sig.filter(Number.isFinite), hs = rec.h.filter(Number.isFinite);
  const gs = rec.gate.filter(g => g > 0);
  let gated = 0;
  for (let k = 0; k < rec.gate.length; k++) if (rec.gate[k] > 0 && rec.spread[k] < rec.gate[k]) gated++;
  return {
    reps: st.reps, signal: sig, poseFrames: rec.src.filter(s => s === "pose").length, engFrames: rec.src.length,
    sigMean: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null,
    winMed: winSpreadMed(rec.sig, Math.round(srcFps * 3.5)),
    heightMean: hs.length ? +(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(4) : null,
    gateEnd: st.repGate, gateMean: gs.length ? +(gs.reduce((a, b) => a + b, 0) / gs.length).toFixed(4) : null,
    gatedFrames: gated, gateFrames: gs.length
  };
}

/* ---------------- 场景 ---------------- */
const ENG_FPS = 60, SRC_FPS = 24, PREV = Math.round(1.0 * ENG_FPS), DUR = 20, N = Math.round(DUR * SRC_FPS);
const PAD = Math.round(SRC_FPS * 3.5);
const PROF = {
  jj: { cn: "开合跳", signal: "width", ea: 0.18, expect: 16, f: 0.8, p: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 } },
  jr: { cn: "跳绳", signal: "height", ea: 0.05, expect: 30, f: 1.5, p: { mode: "rep", signal: "height", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 } },
  sq: { cn: "徒手深蹲", signal: "height", ea: 0.12, expect: 8, f: 0.5, p: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 } },
  hs: { cn: "半蹲热身", signal: "centroidY", ea: 0.06, expect: 10, f: 0.6, p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 } }
};
const FS = [0.15, 0.25, 0.35, 0.5, 0.7, 0.85, 1.0];
/* pad：既补位也**截断**。之前只补不截，长浮点数把后面几列挤串了，
 * 导致控制台表格与 JSON 读数不一致（曾据此误判 reps=1，实际 59）。 */
const pad = (s, n) => { s = String(s == null ? "-" : s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; };
const f3 = v => (v == null ? "-" : Number(v).toFixed(4));
const ONLY = process.env.ONLY || "";   // 诊断用：只跑某个动作，隔离"顺序影响"
const out = { meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: ENG_FPS, srcFps: SRC_FPS, bodyH: BODY_H }, sweep: {}, still: null };
const gens = { jj: genOpenjump, jr: genJumpRope, sq: genSquat, hs: genSquat };

/* ---------------- TRACE：诊断用（TRACE=jj|jr|sq|hs F=1.0）
 * 逐 0.5s 打印引擎信号 / 门限 / 被挡 / 累计 reps / fps，
 * 用来查清扫表里的异常（开合跳 ~2×、跳绳严重欠计）是生成器问题还是引擎行为。 */
if (process.env.TRACE) {
  const key = ["jj", "jr", "sq", "hs"].includes(process.env.TRACE) ? process.env.TRACE : "jr";
  const f = Number(process.env.F || 1.0);
  const P = PROF[key];
  const fr = gens[key](f, P.f, N, SRC_FPS, 0.0025);
  const ratio = ENG_FPS / SRC_FPS;
  globalThis.__clock = 0;
  const eng = ME.createEngine(); eng.attach(fakeCanvas(VW, VH)); eng.setProfile(P.p);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv);
  eng.preview();
  let prev = -1;
  const total = PREV + Math.round(10 * ENG_FPS);
  console.log(`\n=== TRACE ${P.cn} signal=${P.signal} f=${f} freq=${P.f}Hz ===`);
  console.log(`  期望：${P.f}Hz × 10s = ${(P.f * 10).toFixed(0)} 次（若引擎给出≈2×，需排查）`);
  for (let i = 0; i < total; i++) {
    if (i === PREV) eng.start();
    const slot = Math.floor(i / ratio);
    if (slot !== prev) { prev = slot; const ff = fr[slot % fr.length]; pv.pushLandmarks(ff.map(p => ({ x: p.x, y: p.y, visibility: p.visibility }))); }
    globalThis.__clock = (i + 1) * (1000 / ENG_FPS);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (i >= PREV && (i - PREV) % Math.round(ENG_FPS * 0.5) === 0) {
      const st = eng.getState();
      console.log(`  t=${((i - PREV) / ENG_FPS).toFixed(1)}s ${P.signal}=${st.live[P.signal].toFixed(4)} gate=${st.repGate.toFixed(4)} spread=${st.repSpread.toFixed(4)} reps=${st.reps} fps=${st.fps.toFixed(1)}`);
    }
  }
  eng.stop();
  console.log(`  末 reps=${eng.getState().reps}  （每 0.5s 一次快照，可直接看 reps 增长速度）`);
  process.exit(0);
}

console.log("=== 合成「真人取景规格」→ MediaPipe 33 关键点 → 真实姿态主链路 ===\n");
console.log(`取景：人占画面高 ${BODY_H}（65%）、脚在 ${FEET_Y}、不裁切；引擎 60fps / 关键点 24Hz；先 preview 1.0s，再计数 20s。\n`);

for (const key of ["jj", "jr", "sq", "hs"]) {
  if (ONLY && ONLY !== key) continue;
  const P = PROF[key];
  console.log(`【${P.cn} · signal=${P.signal} · ea=${P.ea} · ${P.f}Hz×20s（满幅期望≈${P.expect} 次）】`);
  console.log(["f 幅度".padEnd(8), "窗峰峰".padEnd(11), "末门限".padEnd(10), "reps真值".padEnd(9), "reps门限关".padEnd(11), "门限影响".padEnd(16), "被挡帧", "判定"].join("|"));
  console.log("-".repeat(94));
  out.sweep[key] = [];
  for (const f of FS) {
    const fr = gens[key](f, P.f, N, SRC_FPS, 0.0025);
    if (process.env.DBG) {
      // 关键点指纹：确认扫描路径里的合成帧与"单独跑"是不是同一批
      let h = 0; for (const fp of fr[0]) h = (h * 31 + Math.round(fp.x * 1e6) + Math.round(fp.y * 1e6)) >>> 0;
      const xs = fr[0].map(p => p.x), ys = fr[0].map(p => p.y);
      console.log(`  [DBG] f=${f} nFrames=${fr.length} firstFrameHash=${h} x∈[${Math.min(...xs).toFixed(4)},${Math.max(...xs).toFixed(4)}] y∈[${Math.min(...ys).toFixed(4)},${Math.max(...ys).toFixed(4)}]`);
    }
    const r = runPose(fr, P.p, { engFps: ENG_FPS, srcFps: SRC_FPS, previewFrames: PREV, countFrames: Math.round(DUR * ENG_FPS), loop: false });
    // 门限开关对照：ea=1e-6 → gate≈0（门限变空操作，只剩原有 detrend+迟滞）
    const pOff = Object.assign({}, P.p, { expectedAmplitude: 1e-6 });
    const rOff = runPose(fr, pOff, { engFps: ENG_FPS, srcFps: SRC_FPS, previewFrames: PREV, countFrames: Math.round(DUR * ENG_FPS), loop: false });
    const rWithOff = Object.assign({}, r, { repsGateOff: rOff.reps });
    out.sweep[key].push({ f, ...rWithOff });
    const row = rWithOff;
    const verdict = r.gatedFrames === 0 ? "全程未挡"
      : (r.reps > 0 ? (r.gatedFrames / r.gateFrames > 0.9 ? "大部分被挡但仍有计数" : "部分被挡但有计数") : "★ 全程被挡 0 次");
    const delta = r.reps - rOff.reps;
    const dTxt = delta === 0 ? "门限未挡" : (delta < 0 ? "门限挡了" + (-delta) + "次" : "门限放开+" + delta + "次");
    console.log([pad(f, 8), pad(f3(row.winMed), 11), pad(f3(row.gateEnd), 10), pad(row.reps, 9), pad(rOff.reps, 11), pad(dTxt, 16), pad(row.gatedFrames + "/" + row.gateFrames, 13), verdict].join("|"));
  }
  console.log("");
}

/* 对照：站立不动 + 亚像素抖动 → 门限必须挡住（防"不动也计数"回归） */
console.log("【对照 · 站立不动（人占 65%、不裁切）+ 亚像素抖动】门限应挡住全部（reps=0）");
console.log(pad("抖动幅度", 10) + pad("signal 窗峰峰", 16) + pad("末门限", 10) + pad("reps", 7) + "判定");
console.log("-".repeat(60));
out.still = [];
for (const j of [0.0, 0.002, 0.005, 0.01]) {
  const fr = genStandStill(N, SRC_FPS, j);
  const r = runPose(fr, PROF.jj.p, { engFps: ENG_FPS, srcFps: SRC_FPS, previewFrames: PREV, countFrames: Math.round(DUR * ENG_FPS), loop: false });
  out.still.push({ jitter: j, ...r });
  console.log(pad(j, 10) + pad(r.winMed, 16) + pad(r.gateEnd, 10) + pad(r.reps, 7) + (r.reps === 0 ? "正确挡住" : "★ 误计！"));
}

fs.writeFileSync(path.join(__dirname, "_exp-pose-synth-retake.json"), JSON.stringify(out, null, 2));
console.log("\n结果已写入 build/_exp-pose-synth-retake.json");
