/* 探针：**关键点抖动**有多大，以及它通过 IK 的"平方根放大"能造出多大的**幻影弯曲**。
 *
 * 为什么留这个脚本（它是"否决 `IK_REF`"的决定性证据，也是第 16 条那个结论的依据）：
 *   `A = acos(d/(2L))` 对距离是**开平方敏感**的：
 *       d/(2L) = 1 − ε  ⇒  A ≈ √(2ε)  ⇒  关节弯曲角 ≈ 2√(2ε)
 *   于是**任何**基于"位置距离"的方法（旧的"目标到模型根的世界距离"、以及被否决的
 *   `IK_REF`）都会把关键点抖动放大 —— 抖动本身就能造出十几度的幻影弯曲。
 *
 *   MediaPipe 对同一张**静止**照片每次跑出来的 33 点都不一样（平滑器内部状态），
 *   所以抖动是真实存在的、而且可以就在这里量出来。
 *
 * 本脚本（**不依赖运行时钩子**，纯自证）：
 *   1) 对真实照片跑 N 次 MediaPipe，得到 N 组互相独立的关节；
 *   2) 量关键点抖动的标准差 σ（归一化单位）与像素当量；
 *   3) 用这 N 组算每条 IK 链的**引擎侧距离** `dEng`，得到它的相对离散度
 *      ⇒ 这就是"取最大值当参考"会偏高多少（ε）；
 *   4) 用 2√(2ε) 换算成幻影弯曲角。
 *      ⚠️ 这一步是**解析估计**（用 L1≈L2 近似），不是端到端实测 —— 端到端实测
 *         当年跑出的是**肘R 最大 24.0°、膝R 每帧 ≈10°**（`IK_REF` 已因此整段回退）。
 *
 * 用法：node build/_probe-real-jitter.js [N]     （N 默认 12）
 */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
const N = Math.max(4, parseInt(process.argv[2] || "12", 10));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(FIXTURE)) { console.error("缺少样本：" + FIXTURE); process.exit(1); }
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"),
    { waitUntil: "load", timeout: 40000 });
  await sleep(900);

  /* ---- 1) 跑 N 次 MediaPipe，拿 N 组关节（每次都重新建 Pose，避免平滑器状态被复用）---- */
  const runs = await page.evaluate(async (b64, N) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    const out = [];
    for (let k = 0; k < N; k++) {
      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let lm = null;
      pose.onResults(x => { if (x && x.poseLandmarks && x.poseLandmarks.length) lm = x.poseLandmarks; });
      for (let i = 0; i < 3; i++) { await pose.send({ image: cv }); await new Promise(r => setTimeout(r, 90)); }
      if (!lm) { out.push(null); continue; }
      const m = window.PoseVision.mapLandmarks(lm);
      out.push(m.ok ? { joints: m.joints, raw: lm } : null);
    }
    return out;
  }, b64, N);

  const good = runs.filter(r => r);
  if (good.length < 2) { console.log("有效次数不足：" + good.length); await browser.close(); process.exit(2); }
  console.log("\n真实照片跑 " + N + " 次，有效 " + good.length + " 次（每次都新建 Pose 实例）");

  /* ---- 2) 关键点抖动（33 点 × (x,y) 的标准差，归一化单位）---- */
  const keys = ["x", "y"];
  let maxSd = 0, meanSd = 0, cnt = 0;
  const perLm = [];
  for (let i = 0; i < 33; i++) {
    let sd = 0;
    keys.forEach(k => {
      const vals = good.map(g => g.raw[i][k]);
      const mu = vals.reduce((a, v) => a + v, 0) / vals.length;
      const varr = vals.reduce((a, v) => a + (v - mu) * (v - mu), 0) / vals.length;
      sd = Math.max(sd, Math.sqrt(varr));
    });
    perLm.push(sd); maxSd = Math.max(maxSd, sd); meanSd += sd; cnt++;
  }
  meanSd /= cnt;
  console.log("关键点抖动：平均 σ=" + meanSd.toFixed(5) + "  最大 σ=" + maxSd.toFixed(5) +
    "（归一化单位；1σ ≈ " + (meanSd * 800).toFixed(2) + " px @800）");
  const worst = perLm.map((s, i) => [i, s]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log("  抖动最大的 5 个关键点：" + worst.map(w => "#" + w[0] + " σ=" + w[1].toFixed(5)).join("  "));

  /* ---- 3) 每条 IK 链的引擎侧距离 dEng 的相对离散度 ----
   * 链定义与 motion-avatar.js 的 `IK_CHAINS` 一致（引擎侧用 *L / *R 关节名）。
   * dEng = |末端 − 根|（归一化图像单位）。"取最大值当参考"⇒ 参考偏高 ε = 1 − mean/max。 */
  const CHAINS = [
    ["腿L", "hipL", "ankleL"], ["腿R", "hipR", "ankleR"],
    ["臂L", "shoulderL", "wristL"], ["臂R", "shoulderR", "wristR"]
  ];
  const dist = (j, a, b) => (j[a] && j[b]) ? Math.hypot(j[a].x - j[b].x, j[a].y - j[b].y) : null;

  console.log("\n================ 引擎侧链长 dEng 的抖动 ⇒ 「取最大值当参考」会偏高多少 ================");
  console.log("链      mean      max       min      极差/mean   ε=1−mean/max   ⇒ 幻影弯曲 2√(2ε)");
  let worstBend = 0;
  for (const [name, a, b] of CHAINS) {
    const vs = good.map(g => dist(g.joints, a, b)).filter(v => v != null);
    if (vs.length < 2) { console.log(name.padEnd(6) + " —"); continue; }
    const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
    const mx = Math.max(...vs), mn = Math.min(...vs);
    const eps = Math.max(0, 1 - mean / mx);
    const bend = 2 * Math.sqrt(2 * eps) * 180 / Math.PI;
    worstBend = Math.max(worstBend, bend);
    console.log(name.padEnd(6) + " " + mean.toFixed(4).padStart(8) + "  " + mx.toFixed(4).padStart(8) + "  " +
      mn.toFixed(4).padStart(8) + "  " + ((mx - mn) / mean * 100).toFixed(2).padStart(9) + "%  " +
      eps.toFixed(5).padStart(12) + "  " + bend.toFixed(1).padStart(13) + "°");
  }

  console.log("\n★ 抖动通过 IK 的**平方根放大**造出的最大幻影弯曲（解析估计）= " + worstBend.toFixed(1) + "°" +
    (worstBend < 3 ? "  ⇒ 抖动不足以制造弯曲" :
     worstBend < 8 ? "  ⇒ 偏大，需要留安全余量" :
     "  ⇒ **不可接受**：基于位置距离的方法会重现「我伸直它却弯」"));
  console.log("  ⚠️ 历史端到端实测（`IK_REF` 版）：肘R 最大 **24.0°**、膝R 每帧 ≈10°。");
  console.log("     这正是 `IK_REF` 被整段回退的原因 —— 见 motion-avatar.js 文件头第 16 条。");
  console.log("  ⇒ 结论：**别再用位置距离驱动 IK**；要用无量纲的内角（当前实现）。");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
