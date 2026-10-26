/* 真机验收探针：**Astra 深度 → 关节 z** 在真实房间、真人身上到底成不成立。
 *
 * 为什么必须单独做这一步（R2）
 * ---------------------------
 * `_probe-depthz.js` 是密闭的，它证明的是"公式 / 方向 / 安全闸门 / 接线"对。
 * 它**一个字都不能**证明"D2C 对齐在真实相机上真的对齐了" ——
 * 而后者才是这条链路能不能用的**唯一判据**。
 * 对齐一旦有偏差，采样到的就是**别的物理位置**的深度（比如人旁边的墙），
 * 表现会是"z 有值但乱跳"，而不是"没值"。所以这里要同时看两件事：
 *   ① 数值：每个关节的 z 有没有**合理量级**、**跟动作同向**变化；
 *   ② 合理性：采样到的**绝对深度**是不是"人所在的那一层"（1.5~4m、且稳定），
 *      而不是跳到墙/家具上（那是没对齐的典型症状）。
 *
 * ⚠️ R0：跑之前必须**单独醒目地**喊「要开始测试了」并说清三要素
 *    （何时 / 站哪 / 做什么多久）。没喊 = 数据作废。
 *
 * 用法：node build/_probe-real-depthz.js [秒数]
 *   前置：桥在跑且 **D2C=on**（`tools/orbbec/start-depth-bridge.bat`，
 *         启动日志里要有「D2C 已开启」）。
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "shots");
const VIEW = { width: 1280, height: 800 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DUR = (parseInt(process.argv[2] || "60", 10)) * 1000;

/* 关心的关节：能体现"前后方向"的那几个 */
const WATCH = ["wristL", "wristR", "handL", "handR", "elbowL", "elbowR",
  "kneeL", "kneeR", "ankleL", "ankleR", "hipMid", "head"];

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-realdepthz-" + process.pid + "-" + Date.now());
  /* ⚠️ 必须 headful：本项目实测 headless 下设备枚举不可靠（见 build/camera-probe.js 顶部）。
   * `--use-fake-ui-for-media-stream` 只是自动同意摄像头权限，**不是**假摄像头。 */
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  await page.setViewport(VIEW);
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(INDEX, { waitUntil: "load", timeout: 45000 });
  await sleep(1200);

  // 进体感页 + 开真摄像头
  await page.evaluate(() => { setView("fitnessMotion"); });
  await sleep(400);
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  // 等摄像头 + MediaPipe 就绪（冷启动可能要十几秒）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await page.evaluate(() => {
      const v = document.getElementById("motionVideo");
      return {
        cam: !!(v && v.srcObject && v.videoWidth > 0),
        w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
        eng: typeof motionEngine !== "undefined" && !!motionEngine
      };
    });
    if (r.cam && r.eng) { ready = true; console.log("摄像头已开：" + r.w + "×" + r.h); break; }
    await sleep(500);
  }
  if (!ready) { console.log("[X] 摄像头/引擎没起来，退出"); await browser.close(); process.exit(1); }

  // 等深度桥 + 骨架链路真的在跑
  console.log("\n等待深度与骨架链路就绪（最多 40 秒）...");
  let linkInfo = null;
  for (let i = 0; i < 80; i++) {
    linkInfo = await page.evaluate(() => {
      const eng = (typeof motionEngine !== "undefined") ? motionEngine : null;
      const ds = eng ? eng.depthStats() : null;
      const vs = eng ? eng.visionStats() : null;
      return { depth: ds, vision: vs ? { on: vs.on, depthZ: vs.depthZ, ok: vs.ok, miss: vs.miss } : null };
    });
    if (linkInfo.depth && linkInfo.depth.status === "open" &&
      linkInfo.depth.frameIndex > 5 && linkInfo.vision && linkInfo.vision.on) break;
    await sleep(500);
  }
  console.log("深度：" + JSON.stringify(linkInfo.depth));
  console.log("骨架：" + JSON.stringify(linkInfo.vision));

  if (!linkInfo.depth || !linkInfo.depth.registered) {
    console.log("\n[X] 深度**没有 D2C 对齐**（registered=" +
      (linkInfo.depth && linkInfo.depth.registered) + "）⇒ 这条链路不成立。");
    console.log("    先确认桥的启动日志里有「D2C 已开启」，再重跑。");
    await browser.close();
    process.exit(2);
  }

  console.log("\n开始采集 " + (DUR / 1000) + " 秒。");
  console.log("请按口令做：① 原地跑 10 秒 ② 双臂前平举起落 10 秒 ③ 正对镜头高抬腿 10 秒 ④ 静止站 10 秒\n");

  const series = [];   // {t, depthZ, joints:{name:{z, mm?}}, live}
  const t0 = Date.now();
  let shots = 0;
  while (Date.now() - t0 < DUR) {
    const s = await page.evaluate((watch) => {
      const eng = (typeof motionEngine !== "undefined") ? motionEngine : null;
      if (!eng) return null;
      const vs = eng.visionStats();
      const sk = eng.getSkeleton();
      const j = (sk && sk.joints) || {};
      const out = { depthZ: !!vs.depthZ, seen: !!(sk && sk.has), z: {}, live: {} };
      watch.forEach(n => { out.z[n] = (j[n] && typeof j[n].z === "number") ? j[n].z : null; });
      const lv = eng.getLive() || {};
      out.live = { depthOn: !!lv.depthOn, depthNear: lv.depthNear || 0, fps: lv.fps || 0 };
      out.zOn = (j.__depthZ === true);
      return out;
    }, WATCH);
    if (s) series.push(Object.assign({ t: (Date.now() - t0) / 1000 }, s));

    // 在"前后分量明显"的时刻抓角色截图（R7：必须真的看一眼）
    const strong = s && s.z && s.z.wristL !== null &&
      (Math.abs(s.z.wristL) > 0.09 || Math.abs(s.z.kneeL || 0) > 0.09);
    if (strong && shots < 6) {
      const p = path.join(SHOTS, "realdepthz-" + (shots + 1) + ".png");
      await page.screenshot({ path: p });
      console.log("  抓图 " + p + "  (wristL z=" + s.z.wristL + ")");
      shots++;
    }
    await sleep(150);
  }

  // ---------- 汇总 ----------
  console.log("\n================ 结果 ================");
  console.log("采样 " + series.length + " 次；有骨架 " + series.filter(s => s.seen).length +
    "；depthZ=true " + series.filter(s => s.depthZ).length);
  console.log("\n各关节 z 的范围（MediaPipe 口径：负 = 靠近相机）：");
  console.log("  " + "关节".padEnd(10) + "  最小     最大     幅度     非空/总");
  const summary = {};
  WATCH.forEach(n => {
    const vals = series.map(s => s.z[n]).filter(v => v !== null && v !== undefined);
    if (!vals.length) { console.log("  " + n.padEnd(10) + "  （全空）"); return; }
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    summary[n] = { mn: mn, mx: mx, span: mx - mn, n: vals.length };
    console.log("  " + n.padEnd(10) + "  " + mn.toFixed(3).padStart(7) + "  " +
      mx.toFixed(3).padStart(7) + "  " + (mx - mn).toFixed(3).padStart(7) + "   " +
      vals.length + "/" + series.length);
  });

  console.log("\n判定（阈值按「能不能看出前后动作」定，不是按「有没有值」）：");
  const checks = [];
  const need = (n, minSpan, label) => {
    const s = summary[n];
    const ok = !!s && s.span >= minSpan;
    checks.push([label, ok]);
    console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label +
      (s ? "  → 幅度 " + s.span.toFixed(3) : "  → 无数据"));
  };
  need("wristL", 0.10, "左腕有可观测的前后位移（前平举/跑步摆臂）");
  need("wristR", 0.10, "右腕有可观测的前后位移");
  need("kneeL", 0.06, "左膝有可观测的前后位移（高抬腿）");
  need("kneeR", 0.06, "右膝有可观测的前后位移");
  const dzn = series.filter(s => s.depthZ).length / Math.max(1, series.length);
  checks.push(["depthZ 稳定为真", dzn > 0.6]);
  console.log("  " + (dzn > 0.6 ? "PASS" : "FAIL") + "  depthZ 稳定为真  → " +
    (dzn * 100).toFixed(0) + "% 的采样");

  const pass = checks.filter(c => c[1]).length;
  console.log("\n===== " + pass + "/" + checks.length + " 通过 =====");
  console.log("⚠️ 数值只是**必要条件**；「前后方向像不像」最终要**看截图**（R7）");
  console.log("   截图：build/shots/realdepthz-*.png");
  if (errs.length) console.log("JS 报错：" + errs.slice(0, 3).join(" | "));

  await browser.close();
  process.exit(pass === checks.length ? 0 : 1);
})().catch(e => { console.error("探针异常：", e); process.exit(3); });
