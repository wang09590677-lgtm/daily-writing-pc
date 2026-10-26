// 验证「画面区」几何：全屏校准时画面不再被裁切、白框落在真实画面区内。
//
// 断言（两种摄像头分辨率都测）：
//   1) --motion-cw/ch 等于按 object-fit:contain 算出来的画面尺寸
//   2) 白框完整落在画面区内（不出黑边）
//   3) 画面区不被裁切：cw/ch == 摄像头比例
// 出图：outputs/motion-stage-4x3.png / motion-stage-16x9.png
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const OUT = path.join(__dirname, "..", "..", "outputs");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  → " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  → " + detail : ""}`); }
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-stage"),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1440,980"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => console.log("  [page]", m.text()));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(900);
  // 先选"体能"模块，体感页的导航项才会出现
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);

  for (const [cw, ch, tag] of [[640, 480, "4x3"], [1280, 720, "16x9"]]) {
    // 用一块指定尺寸的画布当摄像头：videoWidth/Height 就是这块画布的尺寸
    await page.evaluate(async (cw, ch) => {
      const cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      const c = cv.getContext("2d");
      c.fillStyle = "#1b2430"; c.fillRect(0, 0, cw, ch);
      // 画一个"人形"，方便肉眼看画面有没有被裁
      c.fillStyle = "#7dd3fc";
      c.fillRect(cw * 0.45, ch * 0.10, cw * 0.10, ch * 0.80);
      window.__fakeStream = cv.captureStream(30);
      setInterval(() => {
        c.fillStyle = "#1b2430"; c.fillRect(0, 0, cw, ch);
        c.fillStyle = "#7dd3fc";
        c.fillRect(cw * 0.45, ch * 0.10, cw * 0.10, ch * 0.80);
        c.fillRect((Date.now() / 40) % cw, 0, 2, 2);
      }, 33);
      navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
      [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
      await motionCamRefresh();
      await motionCamEnsureDefault();
    }, cw, ch);
    await sleep(400);

    await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
    await sleep(1600);

    /* 这块 harness 里的假流上报不了可靠的分辨率（track settings 里连
     * width/height 都没有，videoWidth 会读成 2×2）。几何逻辑本身与被测的
     * 是"画面尺寸 → 画面区"，所以这里直接把 videoWidth/Height 钉成目标值，
     * 再走一遍正式同步流程。 */
    await page.evaluate((cw, ch) => {
      const v = document.getElementById("motionVideo");
      Object.defineProperty(v, "videoWidth", { configurable: true, get: () => cw });
      Object.defineProperty(v, "videoHeight", { configurable: true, get: () => ch });
      motionSyncOverlaySize(v);
      motionUpdateStage();
    }, cw, ch);
    await sleep(300);

    const geo = await page.evaluate(() => {
      const s = document.getElementById("motionScreen");
      const t = document.getElementById("poseTarget");
      const v = document.getElementById("motionVideo");
      const ov = document.getElementById("motionOverlay");
      const tr0 = window.__fakeStream && window.__fakeStream.getVideoTracks()[0];
      console.log("  [diag] srcObject===fake:", v.srcObject === window.__fakeStream,
        "readyState:", v.readyState,
        "trackSettings:", tr0 && tr0.getSettings ? JSON.stringify(tr0.getSettings()) : "n/a",
        "overlay:", ov.width + "x" + ov.height);
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      const num = k => parseFloat(cs.getPropertyValue(k)) || 0;
      const tr = t.getBoundingClientRect();
      return {
        calib: s.classList.contains("is-calib"),
        screen: { w: r.width, h: r.height },
        vw: v.videoWidth, vh: v.videoHeight,
        cw: num("--motion-cw"), ch: num("--motion-ch"),
        cx: num("--motion-cx"), cy: num("--motion-cy"),
        box: { x: tr.left - r.left, y: tr.top - r.top, w: tr.width, h: tr.height },
        fit: getComputedStyle(v).objectFit
      };
    });

    console.log(`\n--- 摄像头 ${cw}×${ch} ---`);
    console.log(`  容器 ${Math.round(geo.screen.w)}×${Math.round(geo.screen.h)} 全屏校准=${geo.calib}` +
      ` videoWidth/Height=${geo.vw}×${geo.vh}` +
      ` 画面区 ${Math.round(geo.cw)}×${Math.round(geo.ch)} @(${Math.round(geo.cx)},${Math.round(geo.cy)})`);

    // 1) 画面区尺寸 = contain 的正确结果
    const fit = Math.min(geo.screen.w / geo.vw, geo.screen.h / geo.vh);
    check(`${tag} 画面区尺寸等于 contain 的计算值`,
      Math.abs(geo.cw - geo.vw * fit) < 1.5 && Math.abs(geo.ch - geo.vh * fit) < 1.5,
      `得到 ${Math.round(geo.cw)}×${Math.round(geo.ch)}，应为 ${Math.round(geo.vw * fit)}×${Math.round(geo.vh * fit)}`);

    // 2) 画面区比例 = 摄像头比例（没被裁切）
    check(`${tag} 画面区比例与摄像头一致（未裁切）`,
      Math.abs((geo.cw / geo.ch) - (geo.vw / geo.vh)) < 0.01,
      `${(geo.cw / geo.ch).toFixed(3)} vs ${(geo.vw / geo.vh).toFixed(3)}`);

    // 3) 白框完整落在画面区内
    const inside = geo.box.x >= geo.cx - 1 && geo.box.y >= geo.cy - 1 &&
      geo.box.x + geo.box.w <= geo.cx + geo.cw + 1 &&
      geo.box.y + geo.box.h <= geo.cy + geo.ch + 1;
    check(`${tag} 白框完整落在画面区内（不出黑边）`, inside,
      `框 [${Math.round(geo.box.x)},${Math.round(geo.box.y)}] ${Math.round(geo.box.w)}×${Math.round(geo.box.h)}` +
      ` 画面区 [${Math.round(geo.cx)},${Math.round(geo.cy)}]+${Math.round(geo.cw)}×${Math.round(geo.ch)}`);

    check(`${tag} 媒体用 object-fit: contain`, geo.fit === "contain", geo.fit);

    // 出图：停掉引擎（它每帧会清画布），把画面区的边界和"人形"画在叠加层上，
    // 这样截图能直接看出画面区在哪、白框有没有落在里面
    await page.evaluate(() => {
      if (motionEngine) motionEngine.stop();
      const ov = document.getElementById("motionOverlay");
      const g = ov.getContext("2d");
      g.clearRect(0, 0, ov.width, ov.height);
      g.fillStyle = "#0d1626"; g.fillRect(0, 0, ov.width, ov.height);
      g.strokeStyle = "#22d3ee"; g.lineWidth = Math.max(4, ov.width * 0.012);
      g.strokeRect(0, 0, ov.width, ov.height);
      g.fillStyle = "#22d3ee";
      g.fillRect(ov.width * 0.45, ov.height * 0.10, ov.width * 0.10, ov.height * 0.80);
    });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, `motion-stage-${tag}.png`) });

    // 退出校准，回到页面内小窗：白框按设计是隐藏的，这里只验证画面区变量跟着容器更新
    await page.evaluate(() => motionCalibClose(false));
    await sleep(700);
    const geo2 = await page.evaluate(() => {
      const s = document.getElementById("motionScreen");
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      const num = k => parseFloat(cs.getPropertyValue(k)) || 0;
      return { w: r.width, h: r.height, cw: num("--motion-cw"), ch: num("--motion-ch"),
        cx: num("--motion-cx"), cy: num("--motion-cy"),
        boxHidden: document.getElementById("poseTarget").classList.contains("hidden") };
    });
    const fit2 = Math.min(geo2.w / geo.vw, geo2.h / geo.vh);
    check(`${tag} 退出全屏后画面区变量跟着容器更新`,
      Math.abs(geo2.cw - geo.vw * fit2) < 1.5 && Math.abs(geo2.ch - geo.vh * fit2) < 1.5,
      `容器 ${Math.round(geo2.w)}×${Math.round(geo2.h)} → 画面区 ${Math.round(geo2.cw)}×${Math.round(geo2.ch)}`);
    check(`${tag} 退出全屏后白框按设计隐藏`, geo2.boxHidden === true);

    // 关摄像头，准备下一轮
    await page.evaluate(() => { if (motionStream) motionStopCamera(); });
    await sleep(500);
  }

  await browser.close();
  console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
