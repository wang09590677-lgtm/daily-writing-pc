/* ==================================================================
 * accept-pose-vision.js — 真实骨架（MediaPipe）接入验收
 *
 * 它回答三个问题，缺一不可：
 *   1. **真人体**能不能拿到 33 个关键点？（用参考任务的真实照片 fixture）
 *   2. 拿到之后，引擎**确实走了 pose 链路**吗？（不是悄悄退回掩码）
 *   3. **没人在画面里**时会不会报幻影人？（假阳性是体感最致命的错）
 *
 * 为什么必须用真照片而不是合成方块人：
 *   合成方块人 MediaPipe 返回 **0 关键点**（实测确认，无幻觉），
 *   所以它天然只能验证回退路径。要验证主路径，必须喂真实人体图像。
 *   fixture 取自参考任务「基于 Astra Pro 的人体动作识别网页」。
 *
 * 另外验证预热：进入体感页时就该把模型一次性开销付掉，
 * 这样孩子点「开启摄像头」时不会卡（实测 3.2s → 0.33s）。
 *
 * 运行：node build/accept-pose-vision.js
 * ================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 真实人体样本（取自参考任务「基于 Astra Pro 的人体动作识别网页」），
// 放在 build/fixtures/ 下长期保留——合成方块人 MediaPipe 返回 0 关键点，
// 只有真照片才能验证主路径。
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error("缺少真实人体样本：" + FIXTURE);
    process.exit(1);
  }
  const b64 = fs.readFileSync(FIXTURE).toString("base64");

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      // 关键：本项目 start-app.bat 就带这个 flag，没有它 file:// 下
      // fetch 本地 .wasm/.tflite 会被 origin 'null' 拦掉
      "--allow-file-access-from-files",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e && e.message)));

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);

  /* ---------------- 1. 模型与感知层就位 ---------------- */
  console.log("\n== 1. 模型与感知层就位（本地 vendor，不走 CDN）==");
  const boot = await page.evaluate(() => ({
    pose: typeof window.Pose,
    pv: typeof window.PoseVision,
    engine: typeof window.MotionEngine,
    pvJoints: window.PoseVision ? window.PoseVision.JOINT_NAMES.length : 0
  }));
  check("MediaPipe 运行库已加载（window.Pose）", boot.pose === "function", boot.pose);
  check("感知层已加载（window.PoseVision）", boot.pv === "object", boot.pv);
  check("引擎已加载", boot.engine === "object", boot.engine);

  /* ---------------- 2. 预热：一次性开销是否已提前付掉 ---------------- */
  console.log("\n== 2. 预热（进入体感页就备好模型）==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
  });
  // 预热是异步的，给它充足时间（3.2 秒的一次性开销 + 余量）
  let warmMs = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    warmMs += 500;
    const st = await page.evaluate(() => {
      const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
      return d ? { ready: d.ready, failed: d.failed } : null;
    });
    if (st && (st.ready || st.failed)) break;
  }
  const warmed = await page.evaluate(() => {
    const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
    return d ? { ready: d.ready, failed: d.failed } : { ready: false, failed: true };
  });
  check("预热完成（模型已就绪，且不是失败态）", warmed.ready === true && warmed.failed === false,
    `t≈${warmMs}ms ready=${warmed.ready} failed=${warmed.failed}`);

  /* ---------------- 3. 真人体 → 33 关键点 → 引擎关节 ---------------- */
  console.log("\n== 3. 真人体：33 关键点 → 引擎骨架关节 ==");
  const live = await page.evaluate(async (b64) => {
    const PV = window.PoseVision;
    // 造一张真实人体图作为画面源
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = "data:image/png;base64," + b64;
    });
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);

    // 用 MediaPipe 直接跑这张图（不经 video，避免无摄像头依赖）
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({
      modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
      smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5
    });
    let lm = null;
    pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
    await pose.send({ image: cv });
    await new Promise(r => setTimeout(r, 200));

    if (!lm) return { landmarks: 0 };
    const mapped = PV.mapLandmarks(lm);
    return {
      landmarks: lm.length,
      imgW: cv.width, imgH: cv.height,
      ok: mapped.ok, reason: mapped.reason,
      visible: mapped.visible, core: mapped.core,
      jointCount: Object.keys(mapped.joints).length,
      joints: Object.keys(mapped.joints),
      bbox: mapped.bbox,
      centroidX: mapped.centroidX, centroidY: mapped.centroidY,
      leftWrist: mapped.leftWrist, rightWrist: mapped.rightWrist,
      // 关节上下顺序（图的 y 轴向下）必须自洽
      headY: mapped.joints.head ? mapped.joints.head.y : null,
      hipY: mapped.joints.hipMid ? mapped.joints.hipMid.y : null,
      ankleY: mapped.joints.ankleL ? mapped.joints.ankleL.y : null
    };
  }, b64).catch(e => ({ err: String(e && e.message) }));

  check("真人体拿到 33 个关键点（MediaPipe 在 file:// 下确实可用）",
    live.landmarks === 33, `landmarks=${live.landmarks} ${live.err || ""}`);
  check("关键点能映射成引擎关节", !!live.ok, live.reason || "");
  check("关节数 ≥ 20", (live.jointCount || 0) >= 20, `${live.jointCount} 个：${(live.joints || []).join(",")}`);
  check("躯干三点齐全（头/颈/髋中线）",
    (live.joints || []).includes("head") && (live.joints || []).includes("neck") &&
    (live.joints || []).includes("hipMid"));
  check("头在上、髋居中、踝在下（几何自洽）",
    live.headY !== null && live.hipY !== null && live.headY < live.hipY,
    `head=${live.headY && live.headY.toFixed(3)} hip=${live.hipY && live.hipY.toFixed(3)} ankle=${live.ankleY && live.ankleY.toFixed(3)}`);
  check("包围盒落在画面内", live.bbox && live.bbox.x >= -0.05 && live.bbox.x + live.bbox.w <= 1.05,
    live.bbox ? `x=${live.bbox.x.toFixed(3)} w=${live.bbox.w.toFixed(3)}` : "无");

  /* ---------------- 4. 引擎确实走 pose 链路 ---------------- */
  console.log("\n== 4. 引擎走 pose 链路（不是悄悄退回掩码）==");
  const routed = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });

    // 造一个"假 video"：引擎只要求能 drawImage 出画面
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);

    // 用真实感知器（pushLandmarks 走的是同一套 mapLandmarks/geometry 路径）
    const PV = window.PoseVision;
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
      smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lm = null;
    pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
    await pose.send({ image: cv });
    await new Promise(r => setTimeout(r, 200));
    if (!lm) return { err: "未检测到人体" };

    // 直接建引擎 + 建感知器，喂真人体目标点，看引擎的判定。
    // ⚠️ 必须**持续喂**：感知器的 poll() 有 700ms 漏检宽限（这是刻意的设计，
    //    抬手挡脸时不该让骨架闪断）。只喂一次的话，宽限期一过就自然过期、
    //    退回掩码链路 —— 那测的就是"过期行为"，不是主链路，会得出错误结论。
    const eng = window.MotionEngine.createEngine();
    eng.attach(cv);
    const pv = PV.createPoseVision({ modelComplexity: 0 });
    eng.attachVision(pv);
    eng.preview();
    const feeder = setInterval(() => { pv.pushLandmarks(lm); }, 80);
    // 让引擎跑若干帧（rAF 需要真实时间）
    await new Promise(r => setTimeout(r, 1500));
    clearInterval(feeder);

    const st = eng.getState();
    const vs = eng.visionStats ? eng.visionStats() : null;
    const sk = eng.getSkeleton();
    return {
      source: vs ? vs.source : null,
      attached: vs ? vs.attached : null,
      visionOn: vs ? vs.on : null,
      frames: vs ? vs.frames : 0,
      ok: vs ? vs.ok : 0,
      jointCount: sk.jointCount,
      has: sk.has,
      bbox: sk.bbox,
      liveVisionSource: st.live ? st.live.visionSource : null,
      centroidX: st.live ? st.live.centroidX : null,
      centroidY: st.live ? st.live.centroidY : null,
      width: st.live ? st.live.width : null,
      height: st.live ? st.live.height : null,
      bottomL: st.live ? st.live.bottomL : null,
      bottomR: st.live ? st.live.bottomR : null,
      hasPose: !!st.live.pose,
      poseSeen: st.live.pose ? st.live.pose.seen : null
    };
  }, b64).catch(e => ({ err: String(e && e.message) }));

  check("感知器已接入引擎", routed.attached === true, routed.err || "");
  check("引擎判定来源为 pose（主链路生效）", routed.source === "pose", `source=${routed.source}`);
  check("live.visionSource = pose", routed.liveVisionSource === "pose", String(routed.liveVisionSource));
  check("骨架有真实关节（≥20）", routed.has && routed.jointCount >= 20, `${routed.jointCount} 个 has=${routed.has}`);
  check("几何字段被真实骨架接管（宽高非 0）",
    routed.width > 0 && routed.height > 0,
    `w=${routed.width && routed.width.toFixed(3)} h=${routed.height && routed.height.toFixed(3)}`);
  check("站位评分拿得到结果（evaluatePose 未被打断）",
    routed.hasPose && routed.poseSeen === true, `pose.seen=${routed.poseSeen}`);

  /* ---------------- 5. 没人在画面里 → 不许报幻影人 ---------------- */
  console.log("\n== 5. 空画面：不能报幻影人（最致命的假阳性）==");
  const empty = await page.evaluate(async () => {
    const cv = document.createElement("canvas");
    cv.width = 320; cv.height = 240;
    const c = cv.getContext("2d");
    c.fillStyle = "#808080"; c.fillRect(0, 0, 320, 240);   // 纯灰

    const PV = window.PoseVision;
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
      smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lm = null;
    pose.onResults(r => { lm = (r && r.poseLandmarks) ? r.poseLandmarks : null; });
    await pose.send({ image: cv });
    await new Promise(r => setTimeout(r, 200));

    const eng = window.MotionEngine.createEngine();
    eng.attach(cv);
    const pv = PV.createPoseVision({ modelComplexity: 0, holdMs: 0 });
    if (lm) pv.pushLandmarks(lm);
    eng.attachVision(pv);
    eng.preview();
    await new Promise(r => setTimeout(r, 1200));
    const st = eng.getState();
    const vs = eng.visionStats ? eng.visionStats() : null;
    return {
      mpLandmarks: lm ? lm.length : 0,
      source: vs ? vs.source : null,
      skeletonHas: eng.getSkeleton().has,
      poseSeen: st.live.pose ? st.live.pose.seen : null,
      bbox: eng.getSkeleton().bbox
    };
  }).catch(e => ({ err: String(e && e.message) }));

  check("MediaPipe 对纯灰画面返回 0 关键点（无幻觉）", empty.mpLandmarks === 0, `landmarks=${empty.mpLandmarks}`);
  check("引擎判定来源退回 mask（兜底链路接管）", empty.source === "mask", `source=${empty.source}`);

  /* ---------------- 6. 无报错 ---------------- */
  console.log("\n== 6. 页面无异常 ==");
  check("无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "无");

  console.log("\n================ 汇总 ================");
  console.log(`  通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) console.log("失败项：\n  - " + fail.join("\n  - "));
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
