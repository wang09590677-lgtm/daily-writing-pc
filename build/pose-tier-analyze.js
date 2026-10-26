/* 决定性测试：两档在「真实动作序列」上的稳定性（抖动）
 *
 * 为什么换指标：
 *   最初我用"可见关键点数量"当精度代理，结果自相矛盾 ——
 *   静态图上 lite 33/full 29，视频上 full 又更好。
 *   真因：MediaPipe 的 visibility 是**模型置信度**，不是精度。
 *   full 模型往往更"保守"（给低置信度但坐标更稳），lite 更"乐观"。
 *   拿置信度当精度比，等于拿俩不同东西互比，结论没意义。
 *
 * 体感真正怕的是什么：
 *   不是"某个点置信度低"，而是**关键点抖** —— 同一动作相邻两帧坐标跳来跳去，
 *   引擎会把"一次抬腿"认成两个峰，计次直接翻倍、节奏全乱。
 *   所以正确的指标是 **帧间坐标增量**：同一个动作里，相邻帧的位移该是平滑的。
 *
 * 方法：
 *   取真实动作视频，等间隔采样 N 帧，对每一档算：
 *     - 每帧平均可见度（参考）
 *     - 相邻帧关键点位移的均值/标准差 → 越小越稳
 *     - 位移序列的"毛刺"（相邻位移的变化量）→ 越小越平滑
 *   每档开独立浏览器（规避 wasm 实例复用的顺序效应）。
 *
 * 运行：node build/_probe-jitter.js [视频路径]
 */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIDEO = process.argv[2] || "体能训练动作演示/原地高抬腿跑.mp4";
const SAMPLES = [0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3, 2.5, 2.7, 2.9, 3.1];

async function runTier(complexity) {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + path.join(__dirname, "jit-" + process.pid + "-" + complexity + "-" + Date.now())]
  });
  try {
    const page = await b.newPage();
    await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    await sleep(500);
    await page.waitForFunction("typeof window.Pose === 'function'", { timeout: 20000 });

    return await page.evaluate(async (vid, samples, complexity) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      v.src = vid;
      await new Promise((res, rej) => {
        v.onloadedmetadata = res; v.onerror = () => rej(new Error("视频加载失败"));
        setTimeout(() => rej(new Error("视频加载超时")), 15000);
      });

      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: complexity, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let lm = null;
      pose.onResults(r => { lm = (r && r.poseLandmarks && r.poseLandmarks.length) ? r.poseLandmarks : null; });

      // 预热（把 3.7s 一次性开销付掉，免得污染第一个采样）
      await pose.send({ image: v });
      await new Promise(r => setTimeout(r, 200));

      const JOINT_SET = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];  // 参与抖动的关节
      const series = [];
      for (const t of samples) {
        if (t > v.duration) continue;
        v.currentTime = t;
        await new Promise(res => { v.onseeked = res; setTimeout(res, 1200); });
        await new Promise(r => setTimeout(r, 60));
        await pose.send({ image: v });
        await new Promise(r => setTimeout(r, 90));
        if (!lm) { series.push(null); continue; }
        const pts = {};
        for (const i of JOINT_SET) if (lm[i]) pts[i] = [lm[i].x, lm[i].y, (lm[i].visibility === undefined ? 1 : lm[i].visibility)];
        const vis = lm.filter(p => (p.visibility === undefined ? 1 : p.visibility) >= 0.3).length;
        series.push({ pts, vis });
      }

      // 抖动：相邻两个成功帧之间，各关节的位移
      const moves = [];
      for (let i = 1; i < series.length; i++) {
        const a = series[i - 1], c = series[i];
        if (!a || !c) continue;
        for (const k of Object.keys(c.pts)) {
          if (!a.pts[k]) continue;
          const dx = c.pts[k][0] - a.pts[k][0], dy = c.pts[k][1] - a.pts[k][1];
          moves.push(Math.sqrt(dx * dx + dy * dy));
        }
      }
      const visList = series.filter(Boolean).map(s => s.vis);
      return { frames: series.filter(Boolean).length, total: samples.length, moves, visList, duration: +v.duration.toFixed(2) };
    }, VIDEO, SAMPLES, complexity);
  } finally { await b.close(); }
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };

(async () => {
  console.log("视频: " + VIDEO);
  console.log("采样 " + SAMPLES.length + " 帧\n");

  console.log("--- lite (0) ---");
  const L = await runTier(0);
  console.log("  成功帧 " + L.frames + "/" + L.total + "  时长 " + L.duration + "s");
  console.log("--- full (1) ---");
  const F = await runTier(1);
  console.log("  成功帧 " + F.frames + "/" + F.total + "  时长 " + F.duration + "s");

  console.log("\n============ 关键指标对比 ============");
  console.log("  平均可见关键点:");
  console.log("    lite " + mean(L.visList).toFixed(1) + "   full " + mean(F.visList).toFixed(1));

  console.log("\n  ★ 帧间位移（抖动）— 越小越稳，体感计次最看重这个:");
  console.log("    lite  均值 " + mean(L.moves).toFixed(4) + "  标准差 " + sd(L.moves).toFixed(4) +
    "  最大 " + Math.max(...L.moves).toFixed(4));
  console.log("    full  均值 " + mean(F.moves).toFixed(4) + "  标准差 " + sd(F.moves).toFixed(4) +
    "  最大 " + Math.max(...F.moves).toFixed(4));
  console.log("    换算到 640 宽画面: lite 均值 " + (mean(L.moves) * 640).toFixed(1) +
    "px  full 均值 " + (mean(F.moves) * 640).toFixed(1) + "px");

  console.log("\n  抖动的波动（标准差/均值，越小说明位移越规律）:");
  const cvL = sd(L.moves) / mean(L.moves), cvF = sd(F.moves) / mean(F.moves);
  console.log("    lite " + cvL.toFixed(3) + "   full " + cvF.toFixed(3));
  console.log("    → " + (cvF < cvL ? "full 更规律（优）" : cvF > cvL ? "lite 更规律（优）" : "持平"));

  console.log("\n  可见点序列:");
  console.log("    lite " + JSON.stringify(L.visList));
  console.log("    full " + JSON.stringify(F.visList));
})();
