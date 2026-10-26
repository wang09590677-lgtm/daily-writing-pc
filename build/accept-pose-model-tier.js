/* 验收：姿态模型档位切换（lite / full）是否可用、可逆、不崩
 *
 * 背景：vendor 里同时放着 lite(2.8MB) 与 full(6.4MB) 两个模型。
 * 2026-10-05 专门测过"默认该用哪档"，结论是**没有一致优势**：
 *
 *   输入                  指标          lite      full
 *   静态人体 640x480      可见关键点     33        29     ← lite 优
 *                        可用关节       26        23     ← lite 优
 *   高抬腿视频 1280x704    左踝可见度     0.87      0.97   ← full 优
 *   14 帧序列             帧间抖动       0.0634    0.0659 持平
 *
 * ⚠️ 教训：**别拿"可见关键点数量"当精度指标** —— MediaPipe 的 visibility
 *    是模型**置信度**而非坐标准确度。full 更保守、lite 更乐观，比大小无意义。
 *    只看视频会得出"full 更准"，再看静态图结论就反了，说明差异随内容变化。
 *
 * 因此本脚本**不预设哪档更好**，只断言：
 *   1. 全新用户默认是 lite（保持既有行为）
 *   2. 两档都能真的加载并跑出 33 关键点
 *   3. 切换 API 能改档、能持久化、能重建感知器，且可逆
 *   4. 引擎能正常消费真实骨架（source=pose）
 *   5. 页面无异常
 *
 * ⚠️ 两个踩过的坑（已规避，勿改回去）：
 *   坑 1 · 顺序效应：同页面里连建 lite/full 两个 Pose 会共享 wasm runtime
 *      互相干扰，实测出现过 full 反而更差这种荒谬结果。
 *      → 精度对比必须每档开**独立 browser 进程**。
 *   坑 2 · 700ms 宽限：感知器 poll() 有 700ms 漏检宽限（刻意设计）。
 *      只喂一次关键点就断言，宽限过期后自然失效、退回掩码链路。
 *      → 必须用 setInterval **持续喂**（照 build/accept-pose-vision.js）。
 *
 * 运行：node build/accept-pose-model-tier.js
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

async function launch() {
  /* 每档开独立浏览器是为了避开顺序效应（先测的那一档承担全部一次性
   * wasm/模型初始化开销，后测的复用已初始化的 runtime —— 同页面 A/B
   * 会得出完全相反的结论）。
   *
   * 但 `--user-data-dir` 必须记下来并在关闭后删掉：
   * Windows 上 Chrome 关掉后仍会短暂持文件句柄，所以放系统 temp 目录、
   * 失败就重试几次。不清理的话每跑一次就留下十几个 17MB 的 profile
   * （实测把 build/ 从 38M 撑到 305M）。 */
  const profileDir = path.join(os.tmpdir(),
    "wbtier-" + process.pid + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = b.close.bind(b);
  b.close = async function () {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); }
    }
  };
  const page = await b.newPage();
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(500);
  await page.waitForFunction("typeof window.Pose === 'function'", { timeout: 20000 });
  await page.waitForFunction("typeof window.PoseVision === 'object'", { timeout: 15000 });
  return { b, page };
}

/* 独立浏览器测某一档的精度（彻底避开顺序效应） */
async function measureTier(b64, complexity) {
  const { b, page } = await launch();
  try {
    return await page.evaluate(async (b64, complexity) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
      const cv = document.createElement("canvas");
      cv.width = 640; cv.height = 480;
      cv.getContext("2d").drawImage(img, 0, 0, 640, 480);

      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({ modelComplexity: complexity, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      let lm = null;
      pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
      await pose.send({ image: cv });
      await new Promise(r => setTimeout(r, 250));
      if (!lm) return { landmarks: 0 };
      const vis = lm.filter(p => (p.visibility === undefined ? 1 : p.visibility) >= 0.3).length;
      const map = window.PoseVision.mapLandmarks(lm);
      const pick = i => lm[i] ? +((lm[i].visibility === undefined ? 1 : lm[i].visibility)).toFixed(3) : 0;
      return {
        landmarks: lm.length, visible: vis,
        jointCount: Object.keys(map.joints || {}).length,
        ankles: [pick(27), pick(28)],
        knees: [pick(25), pick(26)],
        hips: [pick(23), pick(24)],
        wrists: [pick(15), pick(16)],
        bboxW: map.bbox ? +map.bbox.w.toFixed(4) : 0
      };
    }, b64, complexity);
  } finally { await b.close(); }
}

(async () => {
  if (!fs.existsSync(FIXTURE)) { console.error("缺少样本 " + FIXTURE); process.exit(1); }
  const b64 = fs.readFileSync(FIXTURE).toString("base64");

  /* ============ A. 默认档位 + 切换 API（主浏览器） ============ */
  console.log("\n== 1. 默认档位（全新用户）==");
  const main = await launch();
  const page = main.page;
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e && e.message)));

  // 清掉残留选择，验证"全新"默认值
  await page.evaluate(() => localStorage.removeItem("motionVisionComplexity"));
  await page.reload({ waitUntil: "load" });
  await sleep(800);
  await page.evaluate(() => {
    const fit = [...document.querySelectorAll(".chooser-card")].find(c => c.dataset.module === "fitness");
    if (fit) fit.click();
  });
  await sleep(700);
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion");
    if (nav) nav.click();
  });
  await sleep(9000);   // 等 full 档预热（首帧 ~3.8s）

  const st1 = await page.evaluate(() => {
    const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
    return d ? { complexity: d.complexity, label: d.complexityLabel, ready: d.ready, failed: d.failed } : null;
  });
  check("调试出口可用", !!st1);
  check("全新用户默认是 lite（保持既有行为）", st1 && st1.complexity === 0,
    `complexity=${st1 && st1.complexity} (${st1 && st1.label})`);
  check("默认档预热成功", st1 && st1.ready === true && st1.failed === false,
    `ready=${st1 && st1.ready} failed=${st1 && st1.failed}`);

  console.log("\n== 2. 切换 API ==");
  const sw = await page.evaluate(() => {
    if (typeof window.motionVisionSetComplexity !== "function") return { api: false };
    const r = window.motionVisionSetComplexity(1);
    return { api: true, result: r, stored: localStorage.getItem("motionVisionComplexity") };
  });
  check("切换 API 存在", sw.api === true);
  check("切到 full 档成功且已持久化",
    sw.result && sw.result.ok && sw.result.changed === true && sw.stored === "1",
    `stored=${sw.stored}`);
  await sleep(8000);
  const st2 = await page.evaluate(() => {
    const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
    return d ? { complexity: d.complexity, label: d.complexityLabel, ready: d.ready } : null;
  });
  check("切换后档位变为 full", st2 && st2.complexity === 1, `${st2 && st2.label}`);
  check("切换后新档位预热成功", st2 && st2.ready === true, `ready=${st2 && st2.ready}`);

  await page.evaluate(() => window.motionVisionSetComplexity(0));
  await sleep(8000);
  const st3 = await page.evaluate(() => {
    const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
    return d ? { complexity: d.complexity, ready: d.ready } : null;
  });
  check("可切回 lite 档且预热成功（可逆）",
    st3 && st3.complexity === 0 && st3.ready === true,
    `complexity=${st3 && st3.complexity} ready=${st3 && st3.ready}`);
  await main.b.close();

  /* ============ B. 两档都能跑（各自独立浏览器） ============ */
  console.log("\n== 3. 两档都能加载并跑出 33 关键点（各自独立浏览器）==");
  const lite = await measureTier(b64, 0);
  const full = await measureTier(b64, 1);
  check("lite 档能跑（33 关键点）", lite.landmarks === 33, `landmarks=${lite.landmarks}`);
  check("full 档能跑（33 关键点）", full.landmarks === 33, `landmarks=${full.landmarks}`);
  check("两档都能映射出可用关节（≥20）",
    lite.jointCount >= 20 && full.jointCount >= 20,
    `lite=${lite.jointCount} full=${full.jointCount}`);
  /* 这里刻意**不**断言"full ≥ lite"：实测两档各有胜负、随内容变化，
   * 详见表头说明。把不存在的优势写成断言，会让测试变成误导。 */

  /* ============ C. 引擎确实消费了真实骨架（持续喂） ============ */
  console.log("\n== 4. 引擎消费真实骨架（持续喂，避开 700ms 宽限）==");
  const engRes = await (async () => {
    const { b, page } = await launch();
    try {
      return await page.evaluate(async (b64) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);

        const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
        pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false,
          smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        let lm = null;
        pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
        await pose.send({ image: cv });
        await new Promise(r => setTimeout(r, 250));
        if (!lm) return { err: "未检测到人体" };

        const eng = window.MotionEngine.createEngine();
        eng.attach(cv);
        const pv = window.PoseVision.createPoseVision({ modelComplexity: 1 });
        eng.attachVision(pv);
        eng.preview();
        // ⚠️ 必须持续喂（见文件头坑 2）
        const feeder = setInterval(() => { pv.pushLandmarks(lm); }, 80);
        await new Promise(r => setTimeout(r, 1500));
        clearInterval(feeder);

        const vs = eng.visionStats ? eng.visionStats() : null;
        const sk = eng.getSkeleton();
        const st = eng.getState();
        return {
          attached: vs ? vs.attached : null, source: vs ? vs.source : null,
          jointCount: sk.jointCount, has: sk.has,
          liveSource: st.live ? st.live.visionSource : null,
          width: st.live ? st.live.width : 0, height: st.live ? st.live.height : 0,
          hasPose: !!st.live.pose
        };
      }, b64);
    } finally { await b.close(); }
  })();
  check("感知器已接入引擎", engRes.attached === true, engRes.err || "");
  check("引擎判定来源为 pose（真实骨架主链路）", engRes.source === "pose", `source=${engRes.source}`);
  check("骨架有真实关节（≥20）", engRes.has && engRes.jointCount >= 20, `${engRes.jointCount} 个`);
  check("几何字段被真实骨架接管", engRes.width > 0 && engRes.height > 0,
    `w=${engRes.width && engRes.width.toFixed(3)} h=${engRes.height && engRes.height.toFixed(3)}`);
  check("站位评分拿得到结果", engRes.hasPose === true, `pose=${engRes.hasPose}`);

  console.log("\n== 5. 页面无异常 ==");
  check("无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "无");

  console.log("\n================ 汇总 ================");
  console.log(`  通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) console.log("失败项：\n  - " + fail.join("\n  - "));
  console.log("\n  两档实测明细（独立浏览器冷启动，仅供记录，不作优劣断言）:");
  console.log("    lite: 可见=" + lite.visible + " 关节=" + lite.jointCount +
    " 踝=" + JSON.stringify(lite.ankles) + " 膝=" + JSON.stringify(lite.knees));
  console.log("    full: 可见=" + full.visible + " 关节=" + full.jointCount +
    " 踝=" + JSON.stringify(full.ankles) + " 膝=" + JSON.stringify(full.knees));

  process.exit(fail.length ? 1 : 0);
})();
