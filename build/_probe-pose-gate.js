/* ==================================================================
 * _probe-pose-gate.js — 姿态链路（MediaPipe）计次幅度门限标定探针
 *
 * 回答的问题
 *   Q1 姿态链路下 live.width / live.height / live.centroidY 的典型绝对值
 *      与波动范围是多少？与掩码链路差多少倍？
 *   Q2 用现有门限（expectedAmplitude × 0.5 × bodyScale）卡姿态链路的信号，
 *      会不会把真实动作挡掉？
 *   Q3 0.5 这个系数 / bodyScale 公式在姿态链路下是否需要调整？给数值建议。
 *
 * 方法（三段，全部只读生产代码，绝不改任何生产文件）
 *   A. 真实动作视频 → cv2 抽帧（build/_frames2/<ascii>/f*.jpg）
 *      → 页面内真实 MediaPipe Pose 逐帧推理 → PoseVision.mapLandmarks
 *      → 得到姿态链路下 width / height / centroidY 的绝对值与波动。
 *      ★关键：detectReps 的闸门比的是 **signalWindow(key, 3.5) 的峰峰值**
 *        （最近 3.5 秒），所以这里同时算「3.5s 滑动窗峰峰值」的最大值/中位数，
 *        而不是只算整段范围 —— 整段范围会高估真实通过的拍数。
 *      同时把每帧 33 关键点存进页面全局，供 B 段复用（不重复推理）。
 *   B. 引擎端到端（真实 motion-engine.js）：
 *      · 姿态链路：真实帧画到 canvas，逐帧把对应关键点喂 PoseVision.pushLandmarks
 *        → 引擎走 pose 主链路；读 getState().reps / repGate / repSpread。
 *      · 掩码链路：同一组真实帧，不喂关键点 → 引擎退回掩码链路；读同样字段。
 *   C. 掩码链路离线复刻：cv2 中值背景 + 阈值前景，在同批真实帧上量出
 *      掩码链路的 width/height/centroidY，与姿态 bbox 同图对比（差值/倍数）。
 *
 * 运行：node build/_probe-pose-gate.js   （先跑 python build/_extract-vidframes.py）
 * ================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FR = path.join(__dirname, "_frames2");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ascii 目录名 → 中文动作名（用于报告）
const CN = { jumpingJacks: "开合跳", squat: "深蹲", jumpRope: "跳绳", highKnees: "原地高抬腿跑", burpee: "波比跳" };
const ACTIONS = Object.keys(CN);

// 动作库真实 profile（data/fitness-plan.js），逐字抄
const PROFILES = {
  jumpingJacks: { cn: "开合跳",   profile: { mode: "rep", signal: "width",     tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 } },
  squat:        { cn: "深蹲",     profile: { mode: "rep", signal: "height",    tempoBand: [15, 45], minRepGap: 0.9,  expectedAmplitude: 0.12 } },
  halfSquat:    { cn: "半蹲热身", profile: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9,  expectedAmplitude: 0.06 }, useAct: "squat" },
  jumpRope:     { cn: "跳绳",     profile: { mode: "rep", signal: "width",     tempoBand: [20, 55], minRepGap: 0.7,  expectedAmplitude: 0.045 } }
};

const FPS = 24;
const out = { meta: {}, frames: {}, engine: {}, mask: {} };
function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }
function stat(arr) {
  if (!arr.length) return null;
  const mn = Math.min(...arr), mx = Math.max(...arr), m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  return { min: +mn.toFixed(4), max: +mx.toFixed(4), mean: +m.toFixed(4), std: +sd.toFixed(4), range: +(mx - mn).toFixed(4) };
}
// 3.5s 滑动窗峰峰值（= detectReps 真正比的那个量）
function winSpread(arr, winFrames) {
  const w = Math.min(winFrames, arr.length);
  if (w < 10) return null;
  const sp = [];
  for (let i = w - 1; i < arr.length; i++) {
    const seg = arr.slice(i - w + 1, i + 1);
    sp.push(Math.max(...seg) - Math.min(...seg));
  }
  sp.sort((a, b) => a - b);
  const q = p => sp[Math.min(sp.length - 1, Math.floor(p * sp.length))];
  return { min: +sp[0].toFixed(4), med: +q(0.5).toFixed(4), p90: +q(0.9).toFixed(4), max: +sp[sp.length - 1].toFixed(4) };
}

const frameDirs = {};
for (const a of ACTIONS) {
  const d = path.join(FR, a);
  if (fs.existsSync(d)) frameDirs[a] = fs.readdirSync(d).filter(f => /^f\d+\.jpg$/.test(f)).sort()
    .map(f => "file:///" + path.join(d, f).replace(/\\/g, "/"));
}

(async () => {
  if (!fs.existsSync(FR)) { console.error("缺少抽帧目录：" + FR + "（先跑 build/_extract-vidframes.py）"); process.exit(1); }
  out.meta = JSON.parse(fs.readFileSync(path.join(FR, "_meta.json"), "utf8"));

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  const perrs = [];
  page.on("pageerror", e => perrs.push(String(e && e.message)));
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(600);
  await page.evaluate(() => { window.__LM = {}; window.__GEO = {}; });

  /* ============================================================
   * A. 真实动作帧 → MediaPipe → 姿态链路几何量级
   * ============================================================ */
  console.log("\n================ A. 真实动作帧的姿态链路几何量级（MediaPipe 实测）================");
  for (const act of ACTIONS) {
    if (!frameDirs[act]) { console.log("跳过（无帧）", act); continue; }
    const urls = frameDirs[act];
    const r = await page.evaluate(async (act, urls) => {
      const cv = document.createElement("canvas"); const g = cv.getContext("2d");
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let cur = null; pose.onResults(res => { cur = (res && res.poseLandmarks) ? res.poseLandmarks : null; });
      const lms = [], geo = [];
      let detected = 0, mapped = 0;
      for (const u of urls) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
        cv.width = img.naturalWidth; cv.height = img.naturalHeight; g.drawImage(img, 0, 0);
        cur = null; await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 0));
        if (cur) {
          detected++;
          const m = window.PoseVision.mapLandmarks(cur);
          if (m.ok) {
            mapped++;
            lms.push(cur.map(p => [p.x, p.y, (p.visibility === undefined || p.visibility === null) ? 1 : p.visibility]));
            geo.push({ w: m.width, h: m.height, cy: m.centroidY, cx: m.centroidX, top: m.top, vis: m.visible });
          } else { lms.push(null); }
        } else { lms.push(null); }
      }
      window.__LM[act] = lms; window.__GEO[act] = geo;
      return { total: urls.length, detected, mapped };
    }, act, urls).catch(e => ({ err: String(e && e.message) }));

    if (r.err || !r.mapped) { console.log(`${CN[act]}: 失败/无映射`, r.err || ""); out.frames[act] = r; continue; }
    const geo = await page.evaluate(a => window.__GEO[a], act);
    const W = geo.map(p => p.w), Hh = geo.map(p => p.h), CY = geo.map(p => p.cy);
    const winF = Math.round(FPS * 3.5);   // detectReps 的 3.5s 观察窗
    const res = { total: r.total, detected: r.detected, mapped: r.mapped,
      width: stat(W), height: stat(Hh), centroidY: stat(CY), vis: stat(geo.map(p => p.vis)),
      widthWin: winSpread(W, winF), heightWin: winSpread(Hh, winF), centroidYWin: winSpread(CY, winF) };
    out.frames[act] = res;
    console.log(`\n【${CN[act]} (${act})】帧 ${r.total}，检出 ${r.detected}，映射 ${r.mapped}`);
    console.log(`  live.width     整段均值=${res.width.mean}  范围 ${res.width.min}~${res.width.max} (峰峰 ${res.width.range})`);
    console.log(`  live.height    整段均值=${res.height.mean} 范围 ${res.height.min}~${res.height.max} (峰峰 ${res.height.range})`);
    console.log(`  live.centroidY 整段均值=${res.centroidY.mean} 范围 ${res.centroidY.min}~${res.centroidY.max} (峰峰 ${res.centroidY.range})`);
    console.log(`  ▶ 3.5s 滑窗峰峰值 width:      中位=${res.widthWin.med} p90=${res.widthWin.p90} 最大=${res.widthWin.max}`);
    console.log(`  ▶ 3.5s 滑窗峰峰值 height:     中位=${res.heightWin.med} p90=${res.heightWin.p90} 最大=${res.heightWin.max}`);
    console.log(`  ▶ 3.5s 滑窗峰峰值 centroidY:  中位=${res.centroidYWin.med} p90=${res.centroidYWin.p90} 最大=${res.centroidYWin.max}`);

    // 用该动作真实 profile 算门限并判定
    const key = act === "squat" ? "squat" : act;
    const prof = PROFILES[act] || PROFILES[key];
    if (prof) {
      const p = prof.profile;
      const bodyScale = Math.max(1.0, Math.min(1.5, res.height.mean / 0.6));
      const gate = p.expectedAmplitude * 0.5 * bodyScale;
      const ws = p.signal === "width" ? res.widthWin : (p.signal === "height" ? res.heightWin : res.centroidYWin);
      const whole = p.signal === "width" ? res.width.range : (p.signal === "height" ? res.height.range : res.centroidY.range);
      const passMed = ws.med >= gate, passP90 = ws.p90 >= gate, passMax = ws.max >= gate;
      console.log(`  ▶ 该动作计次信号=${p.signal}  expectedAmplitude=${p.expectedAmplitude}  bodyScale=${bodyScale.toFixed(3)}  门限=${gate.toFixed(4)}`);
      console.log(`     · 整段峰峰 ${whole} vs 门限 ${gate.toFixed(4)} → ${whole >= gate ? "过" : "挡"}`);
      console.log(`     · 3.5s 窗 中位 ${ws.med} → ${passMed ? "过" : "挡"}；p90 ${ws.p90} → ${passP90 ? "过" : "挡"}；最大 ${ws.max} → ${passMax ? "过" : "挡"}`);
      res.gateCheck = { signal: p.signal, expectedAmplitude: p.expectedAmplitude, bodyScale: +bodyScale.toFixed(3),
        gate: +gate.toFixed(4), wholeSpread: whole, winMed: ws.med, winP90: ws.p90, winMax: ws.max,
        passMed, passP90, passMax };
    }
  }

  /* ============================================================
   * A2. 距离扫描：把真实身体在画面里缩小 k 倍（=站得更远），
   *     看姿态链路信号 spread 与门限 gate 各自怎么变 —— 直接回答 Q2/Q3。
   *     画布放大 k 倍、把原帧贴到中央：人的归一化高度 → h/k。
   * ============================================================ */
  console.log("\n================ A2. 距离扫描：人变小后，信号 spread vs 门限 gate ================");
  const SCALE_ACTIONS = ["jumpingJacks", "jumpRope", "squat"];
  const KS = [1.0, 1.5, 2.0, 2.6, 3.4];
  out.scaleSweep = {};
  for (const act of SCALE_ACTIONS) {
    if (!frameDirs[act]) continue;
    const urls = frameDirs[act];
    out.scaleSweep[act] = [];
    for (const k of KS) {
      const r = await page.evaluate(async (urls, k) => {
        const cv = document.createElement("canvas"); const g = cv.getContext("2d");
        const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
        pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
          smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        let cur = null; pose.onResults(res => { cur = (res && res.poseLandmarks) ? res.poseLandmarks : null; });
        let base = null, geo = [], detected = 0, mapped = 0;
        for (const u of urls) {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
          if (!base) { base = { w: img.naturalWidth, h: img.naturalHeight }; }
          cv.width = Math.round(base.w * k); cv.height = Math.round(base.h * k);
          g.fillStyle = "#101010"; g.fillRect(0, 0, cv.width, cv.height);
          // 画布放大 k 倍、原帧居中贴上（原始像素数不变）→ 人的归一化尺寸 → 1/k
          g.drawImage(img, Math.round((cv.width - base.w) / 2), Math.round((cv.height - base.h) / 2), base.w, base.h);
          cur = null; await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 0));
          if (cur) {
            detected++;
            const m = window.PoseVision.mapLandmarks(cur);
            if (m.ok) { mapped++; geo.push({ w: m.width, h: m.height, cy: m.centroidY }); }
          }
        }
        return { detected, mapped, geo };
      }, urls, k).catch(e => ({ err: String(e && e.message) }));

      if (r.err || !r.geo || r.geo.length < 10) { out.scaleSweep[act].push({ k, err: r.err || "no-geo" }); continue; }
      const geo = r.geo;
      const stat2 = a => { const mn = Math.min(...a), mx = Math.max(...a), m = a.reduce((x, y) => x + y, 0) / a.length;
        const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
        return { mean: +m.toFixed(4), range: +(mx - mn).toFixed(4), std: +sd.toFixed(4) }; };
      const W = geo.map(p => p.w), Hh = geo.map(p => p.h), CY = geo.map(p => p.cy);
      const hStat = stat2(Hh), wStat = stat2(W), cyStat = stat2(CY);
      const p = PROFILES[act].profile;
      const bodyScale = Math.max(1.0, Math.min(1.5, hStat.mean / 0.6));
      const gate = p.expectedAmplitude * 0.5 * bodyScale;
      const sig = p.signal === "width" ? wStat.range : (p.signal === "height" ? hStat.range : cyStat.range);
      const ratio = sig / gate;
      out.scaleSweep[act].push({ k, detected: r.detected, mapped: r.mapped,
        heightMean: hStat.mean, signal: p.signal, signalSpread: sig, bodyScale: +bodyScale.toFixed(3),
        gate: +gate.toFixed(4), ratio: +ratio.toFixed(2), passes: ratio >= 1 });
      console.log(`  ${pad(CN[act], 12)} k=${pad(k, 4)} 人高均值=${pad(hStat.mean, 7)} ${pad(p.signal, 9)}峰峰=${pad(sig, 7)} bodyScale=${pad(bodyScale.toFixed(2), 5)} 门限=${pad(gate.toFixed(4), 7)} 信号/门限=${ratio.toFixed(2)}× ${ratio >= 1 ? "过" : "✗挡"}`);
    }
  }

  /* ============================================================
   * B. 引擎端到端：姿态主链路 vs 掩码链路
   * ============================================================ */
  console.log("\n================ B. 引擎端到端：姿态主链路 vs 掩码链路（真实 motion-engine.js）================");
  async function engineRun(act, profile, feedVision, secs) {
    const urls = frameDirs[act];
    return await page.evaluate(async (act, urls, profile, feedVision, secs) => {
      const imgs = [];
      for (const u of urls) { const im = new Image(); await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = u; }); imgs.push(im); }
      const cv = document.createElement("canvas"); const g = cv.getContext("2d");
      cv.width = imgs[0].naturalWidth; cv.height = imgs[0].naturalHeight; g.drawImage(imgs[0], 0, 0);

      const eng = window.MotionEngine.createEngine();
      eng.attach(cv); eng.setProfile(profile);
      let pv = null;
      if (feedVision) { pv = window.PoseVision.createPoseVision({ modelComplexity: 0, holdMs: 700 }); eng.attachVision(pv); }

      const samples = [];
      const t0 = performance.now();
      eng.onTick(st => samples.push({ t: (performance.now() - t0) / 1000, w: st.live.width, h: st.live.height,
        cy: st.live.centroidY, src: st.live.visionSource, gate: st.repGate, spread: st.repSpread, reps: st.reps }));
      eng.start();

      const LMs = window.__LM[act] || [];
      let fi = 0, lastLm = null;
      const tick = () => {
        if (fi >= imgs.length) fi = 0;
        g.drawImage(imgs[fi], 0, 0, cv.width, cv.height);
        if (feedVision) {
          const lm = LMs[fi] || lastLm;
          if (lm) { pv.pushLandmarks(lm.map(p => ({ x: p[0], y: p[1], visibility: p[2] }))); lastLm = lm; }
        }
        fi++;
      };
      const timer = setInterval(tick, 1000 / 24);
      await new Promise(r => setTimeout(r, secs * 1000));
      clearInterval(timer); eng.stop();
      const st = eng.getState();
      const vs = eng.visionStats ? eng.visionStats() : null;

      // ⚠️ 所有统计必须在本函数内算：Node 侧的 stat() 在页面里不可见
      const S = a => { if (!a.length) return null; const mn = Math.min(...a), mx = Math.max(...a), m = a.reduce((x, y) => x + y, 0) / a.length;
        const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
        return { mean: +m.toFixed(4), min: +mn.toFixed(4), max: +mx.toFixed(4), range: +(mx - mn).toFixed(4), std: +sd.toFixed(4) }; };
      // 只统计"该链路真正生效"的帧：开头的掩码预热帧会把峰峰值撑到近乎全屏（假大）
      const srcs = {}; samples.forEach(s => srcs[s.src] = (srcs[s.src] || 0) + 1);
      const own = samples.filter(s => (feedVision ? s.src === "pose" : s.src === "mask") &&
        isFinite(s.w) && s.w > 0 && isFinite(s.cy));
      const gs = own.filter(s => s.gate > 0 && isFinite(s.spread));
      const gated = gs.filter(s => s.spread < s.gate).length;
      return { reps: st.reps, fps: +st.fps.toFixed(1), n: samples.length, nOwn: own.length, srcCount: srcs,
        visionStats: vs ? { frames: vs.frames, ok: vs.ok, miss: vs.miss, lastReason: vs.lastReason } : null,
        width: S(own.map(s => s.w)), height: S(own.map(s => s.h)), centroidY: S(own.map(s => s.cy)),
        gate: gs.length ? +gs[gs.length - 1].gate.toFixed(4) : null,
        gateMean: gs.length ? +(gs.reduce((a, b) => a + b.gate, 0) / gs.length).toFixed(4) : null,
        spreadMean: gs.length ? +(gs.reduce((a, b) => a + b.spread, 0) / gs.length).toFixed(4) : null,
        spreadMed: (() => { if (!gs.length) return null; const a = gs.map(s => s.spread).sort((x, y) => x - y); return +a[Math.floor(a.length / 2)].toFixed(4); })(),
        gatedFrames: gated, gateTotal: gs.length };
    }, act, urls, profile, feedVision, secs).catch(e => ({ err: String(e && e.message) }));
  }

  const CASES = [
    { key: "jumpingJacks", label: "开合跳/width",     profile: PROFILES.jumpingJacks.profile },
    { key: "squat",        label: "深蹲/height",      profile: PROFILES.squat.profile },
    { key: "squat",        label: "半蹲热身/centroidY", profile: PROFILES.halfSquat.profile },
    { key: "jumpRope",     label: "跳绳/width",       profile: PROFILES.jumpRope.profile }
  ];
  for (const c of CASES) {
    if (!frameDirs[c.key]) continue;
    const rv = await engineRun(c.key, c.profile, true, 7);
    const rm = await engineRun(c.key, c.profile, false, 7);
    out.engine[c.label] = rv; out.mask[c.label] = rm;
    const fmt = (r, who) => `  ${who}: 源=${JSON.stringify(r.srcCount)} 自身帧=${r.nOwn} reps=${r.reps} fps=${r.fps}` +
      `${r.visionStats ? ` vision{帧${r.visionStats.frames} ok${r.visionStats.ok} miss${r.visionStats.miss}}` : ""}\n` +
      `       width 峰峰=${r.width && r.width.range}  height 峰峰=${r.height && r.height.range}  centroidY 峰峰=${r.centroidY && r.centroidY.range}\n` +
      `       repGate(末)${r.gate} 均值${r.gateMean}  实测spread均值${r.spreadMean}/中位${r.spreadMed}  被挡帧 ${r.gatedFrames}/${r.gateTotal}`;
    console.log(`\n【${c.label} · signal=${c.profile.signal} · expectedAmplitude=${c.profile.expectedAmplitude}】`);
    console.log(fmt(rv, "姿态链路"));
    console.log(fmt(rm, "掩码链路"));
  }

  console.log("\n页面异常:", perrs.length ? perrs.slice(0, 3) : "无");
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "_probe-pose-gate.json"), JSON.stringify(out, null, 2));
  console.log("\n结果已写入 build/_probe-pose-gate.json");
})().catch(e => { console.error("崩溃", e); process.exit(2); });
