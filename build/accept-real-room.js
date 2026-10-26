// D1+D2 联合验收：真实空房 → 必须"没人"；三个真实姿势 → 必须"有人"且张臂显著。
// 这是本项目唯一可信的验收标准（合成数据全绿不代表真实房间可用）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const person = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));
const empty = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-empty.json"), "utf8"));
/* ⚠️ 会话隔离（踩过的坑）：
 *   real-depth-empty.json（20:48）与 real-depth-person.json（21:39）是**两次独立采集**，
 *   相机位置/朝向已经变了 —— 实测两会话的 bg 逐格差：中位 113mm、p90 3162mm、均值 745mm。
 *   拿 A 会话的空房当 B 会话的基线 → 整幅都"和人不一样" → 判定全乱。
 *   real-depth-person.json 自带同会话的 bg / bg2（自检：中位差 0、均值 11mm，干净）。
 *   => 每个会话必须用自己的空房帧建基线，这也正是 app 里"每次开始前先扫一遍空房"的原因。 */
const emptyGrids = empty.frames.map(f => f.grid);   // A 会话（仅用于测 D1）

let pass = 0, fail = 0;
function chk(ok, label, detail) {
  if (ok) { pass++; console.log("  ✔ " + label + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  ✘ " + label + "   " + (detail || "")); }
}

async function boot() {
  // ⚠️ 专用 profile 必须每次新建（复用会带脏状态），但**不能放在项目目录里**：
  //    每个约 21MB，而 Windows 上 Chrome 关闭后仍会短暂持有文件句柄，
  //    立刻删往往失败 → 跑几轮就攒几百 MB（实测攒到过 320MB）。
  //    改放系统临时目录，即使删不掉也污染不到项目。
  const profileDir = path.join(os.tmpdir(), "wbc-acc-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + profileDir,
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  // 关浏览器后延迟重试删除（等 Chrome 释放句柄），best-effort，删不掉也不影响结论
  const origClose = browser.close.bind(browser);
  browser.close = async function () {
    try { await origClose(); } catch (e) { /* 忽略 */ }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); }
    }
  };
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(async () => {
    /* ★★ 必须让 **app 自己那条**深度链路也是假的，否则本测试**不密闭**。
     *   app 的空房扫描超时闸读的是 **app 级** `motionDepth`（app.js:4124），它由
     *   `motionDepthLink()`（app.js:2580-2588）经 `window.DepthLink.createLink()` 创建，
     *   并在 app.js:2848 交给引擎。本测试原先只在**相机流程之后**替换**引擎**的链路
     *   （`motionEngine.attachDepth`），app 级 `motionDepth` 仍是**真的** DepthLink
     *   → 会去连真桥 `ws://127.0.0.1:8765`。于是结果取决于**外部桥进程的偶然状态**：
     *     · 桥没跑        → status≠"open" → noFrames=false → 扫描照常 → 12/12
     *     · 桥在跑但不出帧 → status=="open" 且 frameIndex==0 → 闸判"连上但收不到画面"
     *                      → 3 秒就掐掉扫描 → coverage 恒 0 → 9/12
     *   这就是它 10-06 绿、10-08 红的原因（桥被留在后台了）。
     *   => 在**相机流程之前**把工厂换掉，让 app 级与引擎用的是**同一个假链路**，
     *      与外部桥彻底解耦。**断言一字不改**（改夹具 ≠ 放宽断言）。 */
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    window.__depthFrameIdx = 0;
    window.__fakeDepth = {
      connect: () => {}, close: () => {}, onStatus: () => {},
      available: () => true,
      grid: () => grid,
      // 字段与真实 depth-link.js:197-205 的 stats() 对齐（★含 frameIndex）
      stats: () => ({
        status: "open", fps: 15, valid: 6912, cells: 6912, validRatio: 0.9,
        minMM: 400, maxMM: 4000, frameIndex: window.__depthFrameIdx,
        device: "FakeAstra", serial: "", srcW: 640, srcH: 480, note: ""
      }),
      url: "ws://127.0.0.1:8765", width: 96, height: 72
    };
    window.DepthLink = { createLink: () => window.__fakeDepth, DEFAULT_URL: "ws://127.0.0.1:8765" };

    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    // app.js:2848 已把同一个假链路交给引擎；这里显式再挂一次，保证引擎用的就是它
    motionEngine.attachDepth(window.__fakeDepth);
    motionEngine.attach(cv); motionEngine.preview();
  });
  return { browser, page };
}

async function feed(page, arr, n) {
  for (let i = 0; i < n; i++) {
    const cells = arr[Math.min(i, arr.length - 1)];
    await page.evaluate((g2) => {
      window.__depthFrameIdx++;   // ★ 与真实链路对齐：每投喂一帧，frameIndex 自增一次
      const g = window.__grid; let k = 0;
      for (let y = 0; y < g2.length; y++) { const row = g2[y];
        for (let x = 0; x < row.length; x++) { g[k++] = row[x] || 0; } }
    }, cells);
    await sleep(170);
  }
}

async function snapshot(page) {
  return page.evaluate(() => {
    const d = motionEngine.depthDebug(), sk = motionEngine.getSkeleton();
    return { has: sk.has, bbox: sk.bbox || null, structPath: d && d.structPath,
      chosen: d && d.chosen, st: motionEngine.structureInfo() };
  });
}

(async () => {
  console.log("\n===== A. 真实空房间（D1 幻影人）· A 会话 =====");
  const A = await boot();
  await A.page.evaluate(() => motionEngine.beginRoomScan());
  await feed(A.page, emptyGrids, 20);
  let stA = (await snapshot(A.page)).st;
  console.log("  结构基线: 就绪=" + stA.ready + " 覆盖=" + (stA.coverage * 100).toFixed(1) + "%");
  chk(stA.ready && stA.coverage > 0.8, "结构基线就绪且覆盖 >80%",
    "coverage=" + (stA.coverage * 100).toFixed(1) + "%");
  await feed(A.page, emptyGrids, 10);
  let rA = await snapshot(A.page);
  chk(!rA.has, "空房判「没人」（原 D1：报幻影人 0.458×0.903）",
    "has=" + rA.has + " structPath=" + rA.structPath);
  await A.browser.close();

  console.log("\n===== B. 真人三姿势（D2 张臂）· B 会话 =====");
  const B = await boot();
  // 用**同会话**的 bg / bg2 建基线（这才是"人进来之前的空房"）
  const bgA = person.bg, bgB = person.bg2;
  await B.page.evaluate(() => motionEngine.beginRoomScan());
  await feed(B.page, new Array(10).fill(bgA).concat(new Array(10).fill(bgB)), 20);
  let stB = (await snapshot(B.page)).st;
  console.log("  结构基线: 就绪=" + stB.ready + " 覆盖=" + (stB.coverage * 100).toFixed(1) + "%");
  chk(stB.ready && stB.coverage > 0.8, "结构基线就绪（B 会话）",
    "coverage=" + (stB.coverage * 100).toFixed(1) + "%");

  // 先确认"人不在"时判没人（用同会话空房帧）
  await feed(B.page, new Array(8).fill(bgB), 8);
  const sEmpty = await snapshot(B.page);
  chk(!sEmpty.has, "B 会话空房帧判「没人」", "has=" + sEmpty.has);

  const widths = {};
  for (const p of person.poses) {
    await feed(B.page, p.frames.map(f => f.grid), p.frames.length);
    const s = await snapshot(B.page);
    widths[p.name] = s.bbox ? s.bbox.w : 0;
    console.log("  " + p.name.padEnd(11) + " has=" + s.has +
      " bbox=" + (s.bbox ? s.bbox.w.toFixed(3) + "x" + s.bbox.h.toFixed(3) : "--") +
      " path=" + s.structPath);
    chk(s.has, p.name + " 识别到人");
    chk(!!s.structPath, p.name + " 走结构差分路线");
    // 回到空房，避免姿势间互相污染
    await feed(B.page, new Array(6).fill(bgB), 6);
  }
  const ratio = widths.t_pose / widths.arms_down;
  console.log("\n  张臂倍率 t_pose/arms_down = " + ratio.toFixed(2) + "x   (真人剪影真值 3.75x)");
  chk(widths.t_pose > 0.35, "T-pose bbox 宽 > 0.35", "w=" + widths.t_pose.toFixed(3));
  chk(ratio >= 2.0, "张臂倍率 ≥ 2.0x", ratio.toFixed(2) + "x（修复前仅 1.24x）");
  await B.browser.close();

  console.log("\n================ 汇总 ================");
  console.log("  通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
