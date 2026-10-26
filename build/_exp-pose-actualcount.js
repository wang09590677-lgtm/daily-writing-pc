/* ==================================================================
 * _exp-pose-actualcount.js — **姿态主链路**下，新门限的实际计次（纯 Node）
 *
 * 目标（对应任务）
 *   把"离线统计"升级成"引擎实际计数"：在**真实 MediaPipe 姿态链路**下，
 *   跑真实 motion-engine.js，读新门限下的真实 reps / repGate / repSpread /
 *   被挡帧比例 —— 回答"新门限会不会挡住真人动作"。
 *
 * 数据来源（两段，全部只读产品文件）
 *   A. 真实演示视频帧的关键点：build/_tmp/_lm.json
 *      （由 build/_dump-pose-lm.js 一次性用真实 MediaPipe 推理落盘；
 *       本脚本本身**不开浏览器**，把 Chrome 让给队友）
 *   B. 合成"真人取景规格"重演：build/_exp-retake-synth.js 的结果
 *      （人占画面高 65%、不裁切；开合跳/跳绳，幅度系数 f 扫描）
 *
 * 复刻真机时序（与 build/_probe-pose-gate.js Part B 一致）
 *   · 引擎主循环 60fps（浏览器 rAF 的真实频度）
 *   · 关键点按 24Hz 刷新（视频抽帧率；真机 MediaPipe 默认 20Hz 同量级）
 *   · poll() 的 holdMs=700 → 两次推理之间沿用上一帧（真机的降级行为）
 *   · 先 preview 1.0s（预热背景），再 start 计数
 *   · profile 一律取 data/fitness-plan.js 真值（逐字抄，含 signal 归属）
 *
 * 运行：node build/_exp-pose-actualcount.js
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
// pose-vision.js 是 UMD：Node 下走 module.exports（不会挂到 globalThis.PoseVision），
// 所以必须接住 require 的返回值；motion-engine.js 相反，是挂到 globalThis.window。
const PV = require(path.join(__dirname, "..", "pose-vision.js"));
require(path.join(__dirname, "..", "motion-engine.js"));
const ME = globalThis.window.MotionEngine;

/* data/fitness-plan.js 真值（逐字抄；signal 归属已核对，勿凭印象改） */
const PROF = {
  jumpingJacks: { cn: "开合跳",     p: { mode: "rep", signal: "width",     tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 } },
  squat:        { cn: "徒手深蹲",   p: { mode: "rep", signal: "height",    tempoBand: [15, 45], minRepGap: 0.9,  expectedAmplitude: 0.12 } },
  halfSquatWarm:{ cn: "半蹲热身",   p: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9,  expectedAmplitude: 0.06 }, useAct: "squat" },
  jumpRope:     { cn: "跳绳",       p: { mode: "rep", signal: "height",    tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.05 } },
  burpee:       { cn: "波比跳",     p: { mode: "rep", signal: "height",    tempoBand: [12, 35], minRepGap: 1.4,  expectedAmplitude: 0.16 } }
};

const lm = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

/* ---------------- 独立几何参考：数"信号自己有几个周期" ----------------
 * 不依赖引擎，只拿 mapLandmarks 出的归一化几何量做迟滞过零计周期，
 * 当作"这段视频里肉眼能看到几个动作"的参考数。 */
function countCycles(vals) {
  const v = vals.filter(Number.isFinite);
  if (v.length < 8) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const d = v.map(x => x - m);
  const rms = Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length) || 1;
  const k = Math.max(0.35 * rms, 1e-9);
  let armed = false, n = 0;
  for (const x of d) { if (x < -k) armed = true; else if (x > k && armed) { n++; armed = false; } }
  return n;
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

/**
 * @param frames  每帧的 33 关键点数组（或 null）
 * @param profile 动作 profile
 * @param opt     { engFps, srcFps, previewSec, countSec, loop }
 */
function runPose(frames, profile, opt) {
  const engFps = opt.engFps || 60, srcFps = opt.srcFps || 24;
  const ratio = engFps / srcFps;
  const sig = profile.signal;

  globalThis.__clock = 0;
  const eng = ME.createEngine();
  eng.attach(fakeCanvas(VW, VH));
  eng.setProfile(profile);
  const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 700 });
  eng.attachVision(pv);

  const rec = { sig: [], h: [], gate: [], spread: [], src: [] };
  let i = 0, srcIdx = -1, lastLm = null, okN = 0, pushN = 0;
  const total = opt.previewFrames + opt.countFrames;
  // preview() 只调一次：它内部 resetCounters()，每帧都调会让背景基线学不起来
  eng.preview();
  for (i = 0; i < total; i++) {
    const counting = i >= opt.previewFrames;
    if (i === opt.previewFrames) { eng.start(); }
    // 每 ratio 帧推一帧关键点（源 24Hz，引擎 60fps）
    if (i === 0 || Math.floor(i / ratio) !== Math.floor((i - 1) / ratio)) {
      srcIdx++;
      const fi = opt.loop ? (srcIdx % frames.length) : srcIdx;
      const lmF = frames[fi];
      if (lmF) { lastLm = lmF; }
      if (lastLm) {
        const mapped = pv.pushLandmarks(lastLm.map(p => ({ x: p[0], y: p[1], visibility: p[2] })));
        pushN++;
        if (mapped && mapped.ok) okN++;
      }
    }
    globalThis.__clock = (i + 1) * (1000 / engFps);
    if (globalThis.__rafCb) globalThis.__rafCb();
    if (counting) {
      const st = eng.getState();
      rec.sig.push(st.live[sig]); rec.h.push(st.live.height);
      rec.gate.push(st.repGate); rec.spread.push(st.repSpread);
      rec.src.push(st.live.visionSource);
    }
  }
  eng.stop();
  const st = eng.getState();

  const poseFrames = rec.src.filter(s => s === "pose").length;
  const vals = rec.sig.filter(Number.isFinite);
  const hs = rec.h.filter(Number.isFinite);
  const gs = rec.gate.filter(g => g > 0);
  let gated = 0;
  for (let k = 0; k < rec.gate.length; k++) if (rec.gate[k] > 0 && rec.spread[k] < rec.gate[k]) gated++;

  const wSrc = Math.round(srcFps * 3.5);
  return {
    reps: st.reps, signal: sig, ea: profile.expectedAmplitude,
    engFrames: rec.sig.length, poseFrames,
    sigMean: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null,
    sigRange: vals.length ? +(Math.max(...vals) - Math.min(...vals)).toFixed(4) : null,
    winMed: winSpreadMed(rec.sig, wSrc),
    heightMean: hs.length ? +(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(4) : null,
    gateEnd: st.repGate, gateMean: gs.length ? +(gs.reduce((a, b) => a + b, 0) / gs.length).toFixed(4) : null,
    gatedFrames: gated, gateFrames: gs.length
  };
}

/* ---------------- A. 真实视频帧（姿态链路） ---------------- */
console.log("=== A. 真实演示视频 → MediaPipe 姿态链路 → 真实 motion-engine.js（纯 Node，60fps 引擎 / 24Hz 关键点）===\n");
console.log("说明：视频是宣传素材（相机在动、人物近景裁切），只用来验证**姿态链路**是否被挡；\n      sigMean 是引擎 live 信号均值，若≈1.0 说明该链路在这段画面上饱和（不可用作幅度证据）。\n");

const FPS_E = 60, FPS_S = 24, PREV = Math.round(1.0 * FPS_E);
const A_ROWS = [];
const A_OUT = {};

function need(name) { const a = PROF[name].useAct || name; return lm.acts[a]; }

const CASES_A = ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"];
for (const name of CASES_A) {
  const act = need(name);
  if (!act) { console.log("跳过（无关键点）", name); continue; }
  const frames = act.frames;

  /* A1：视频原速放一遍（不循环）—— 最贴近"孩子做一遍" */
  const onceSec = frames.length / FPS_S;
  const rOnce = runPose(frames, PROF[name].p,
    { engFps: FPS_E, srcFps: FPS_S, previewFrames: PREV, countFrames: Math.round(onceSec * FPS_E), loop: false });
  /* A2：循环到 20s —— 填满 3.5s 窗，模拟持续跟练（与掩码链路离线跑法对齐） */
  const rLoop = runPose(frames, PROF[name].p,
    { engFps: FPS_E, srcFps: FPS_S, previewFrames: PREV, countFrames: Math.round(20 * FPS_E), loop: true });

  /* A3：独立几何参考周期数（原速一遍 / 20s 循环） */
  const gW = frames.map(f => f ? { w: GV(f, "width"), h: GV(f, "height"), cy: GV(f, "cy") } : null).filter(Boolean);
  const refSeries = { width: gW.map(x => x.w), height: gW.map(x => x.h), centroidY: gW.map(x => x.cy) };
  const cycOnce = countCycles(refSeries[PROF[name].p.signal]);
  const cyc20 = Math.round(cycOnce * (20 / onceSec));

  /* A4：**门限开关对照**（决定性）——只改传入 profile 的 expectedAmplitude，
   * 不动生产文件。ea=1e-6 → gate≈0，等于把门限关掉；ea=99 → gate 巨大，等于全挡。
   * 若「真值 / 门限关」两跑的 reps 完全相同 → 门限没有挡这个动作； */
  const pOff = Object.assign({}, PROF[name].p, { expectedAmplitude: 1e-6 });
  const pOn = Object.assign({}, PROF[name].p, { expectedAmplitude: 99 });
  const rGateOff = runPose(frames, pOff,
    { engFps: FPS_E, srcFps: FPS_S, previewFrames: PREV, countFrames: Math.round(onceSec * FPS_E), loop: false });
  const rGateAll = runPose(frames, pOn,
    { engFps: FPS_E, srcFps: FPS_S, previewFrames: PREV, countFrames: Math.round(onceSec * FPS_E), loop: false });

  A_OUT[name] = { cn: PROF[name].cn, signal: PROF[name].p.signal, ea: PROF[name].p.expectedAmplitude,
    srcFrames: frames.length, srcSecs: +onceSec.toFixed(2), cycOnce, cyc20,
    once: rOnce, loop: rLoop, gateOff: rGateOff, gateAllBlocked: rGateAll };
  const p2 = n => String(n == null ? "-" : n).padEnd(11);
  console.log(`【${PROF[name].cn} · signal=${PROF[name].p.signal} · ea=${PROF[name].p.expectedAmplitude}】源视频 ${frames.length} 帧 / ${onceSec.toFixed(1)}s，独立几何周期数≈${cycOnce}（20s 折算≈${cyc20}）`);
  console.log("  跑法".padEnd(16) + "reps".padEnd(7) + "被挡帧".padEnd(14) + "3.5s窗峰峰中位".padEnd(17) + "末门限".padEnd(12) + "人高均值");
  console.log("  " + "-".repeat(84));
  for (const [tag, r] of [["①真值(原速一遍)", rOnce], ["②真值(循环20s)", rLoop],
    ["③门限≈关闭", rGateOff], ["④门限=全挡", rGateAll]]) {
    console.log("  " + tag.padEnd(16) + p2(r.reps) + p2(r.gatedFrames + "/" + r.gateFrames) + p2(String(r.winMed)) + p2(String(r.gateEnd)) + String(r.heightMean));
  }
  console.log(`  ⇒ 门限影响：关掉门限后 reps ${rGateOff.reps} vs 真值 ${rOnce.reps} → ${rGateOff.reps === rOnce.reps ? "**门限完全没挡**" : (rGateOff.reps > rOnce.reps ? "门限挡掉了 " + (rGateOff.reps - rOnce.reps) + " 次" : "计数未被门限左右")}`);
  console.log("");
}

function GV(f, what) {
  const m = PV.mapLandmarks(f.map(p => ({ x: p[0], y: p[1], visibility: p[2] })));
  if (!m.ok) return NaN;
  return what === "width" ? m.width : (what === "height" ? m.height : m.centroidY);
}

/* ---------------- B. 合成"真人取景规格"重演（已在 _exp-retake-synth.js 跑过） ---------------- */
console.log("\n=== B. 合成真人取景重演（人占画面高 65%、不裁切）—— 转录 build/_exp-retake-synth.json ===\n");
const S = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-retake-synth.json"), "utf8"));
const p2b = n => String(n == null ? "-" : n).padEnd(12);
console.log("动作".padEnd(10) + "幅度f".padEnd(8) + "3.5s窗峰峰".padEnd(14) + "末门限".padEnd(10) + "reps".padEnd(7) + "被挡帧".padEnd(12) + "参考期望");
console.log("-".repeat(84));
const expectOf = { openjump: 16, jumpRope: 30 };
for (const act of ["openjump", "jumpRope"]) {
  for (const r of S[act]) {
    console.log((act === "openjump" ? "开合跳" : "跳绳").padEnd(10) + p2b(r.f) + p2b(r.winMed) + p2b(r.gateEnd) + p2b(r.reps) + p2b(r.gatedFrames + "/" + r.gateFrames) + expectOf[act] + " 次");
  }
}
fs.writeFileSync(path.join(__dirname, "_exp-pose-actualcount.json"),
  JSON.stringify({ meta: { engMd5: "168d6829b0e965be95eb9a99865f5890", engFps: FPS_E, srcFps: FPS_S }, realvideo: A_OUT }, null, 2));
console.log("\n结果已写入 build/_exp-pose-actualcount.json");
