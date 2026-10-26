// UI 渲染体检：不靠肉眼看图，用 computedStyle 检查卡片真的可见、有尺寸、文字正确。
// 这是"截图看不见元素"这类 CSS bug 的可靠替代检查（本模型读不了图）。
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const person = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));

let pass = 0, fail = 0;
function chk(ok, label, detail) {
  if (ok) { pass++; console.log("  ✔ " + label + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  ✘ " + label + "   " + (detail || "")); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "ui-" + process.pid), "--window-size=1280,860"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(() => {
    window.__grid = new Float32Array(96 * 72);
    window.DepthLink = { DEFAULT_URL: "", createLink: () => ({
      available: () => true, grid: () => window.__grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9, device: "Astra", srcW: 640, srcH: 480, minMM: 600, maxMM: 5000 }),
      onStatus: () => {}, connect: () => {}, close: () => {} }) };
  });
  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillStyle = "#0b1220"; cv.getContext("2d").fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1800);

  async function feed(grids, n) {
    for (let i = 0; i < n; i++) {
      const cells = grids[Math.min(i, grids.length - 1)];
      await page.evaluate((g2) => {
        const g = window.__grid; let k = 0;
        for (let y = 0; y < g2.length; y++) { const row = g2[y];
          for (let x = 0; x < row.length; x++) { g[k++] = row[x] || 0; } }
      }, cells);
      await sleep(150);
    }
  }

  console.log("\n===== 扫描卡片渲染体检 =====");
  /* ⚠️ 时序：必须在**扫描还没走完**时测量。预热只要 12 帧、每帧 150ms ≈ 1.8 秒，
   * 而打开摄像头本身已经耗掉一部分帧 —— 上一版只喂 5 帧就以为"还在扫"，
   * 实际 app 早已累计满 12 帧、卡片收起 → 量到 display:none（假失败）。
   * 这里先显式重置扫描，再从 0 开始，确保测的是"扫描进行中"。 */
  await page.evaluate(() => {
    if (motionEngine.roomScanReset) motionEngine.roomScanReset();
    if (motionEngine.beginRoomScan) motionEngine.beginRoomScan();
    const box = document.getElementById("roomScan");
    if (box) box.classList.remove("hidden");
    const panel = document.querySelector(".pose-calib-panel");
    if (panel) panel.classList.add("is-dimmed");
  });
  const info0 = await page.evaluate(() => motionEngine.roomScanInfo());
  console.log("  重置后 samples=" + info0.samples + " need=" + info0.need + " minMs=" + info0.minMs);
  await feed(new Array(2).fill(person.bg), 2);
  const info1 = await page.evaluate(() => motionEngine.roomScanInfo());
  console.log("  喂 2 帧后 samples=" + info1.samples + " elapsedMs=" + info1.elapsedMs + "（须 ready=false 才在扫描中）");
  chk(info1.ready === false, "扫描进行中（时长闸门生效，未被秒过）", "elapsedMs=" + info1.elapsedMs + " minMs=" + info1.minMs);
  const vis = await page.evaluate(() => {
    const box = document.getElementById("roomScan");
    const card = document.querySelector(".room-scan-card");
    const bar = document.getElementById("roomScanBar");
    const cs = getComputedStyle(box), cc = getComputedStyle(card), cb = getComputedStyle(bar);
    const rb = box.getBoundingClientRect(), rc = card.getBoundingClientRect(), rbar = bar.getBoundingClientRect();
    return {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex,
      boxW: Math.round(rb.width), boxH: Math.round(rb.height),
      cardW: Math.round(rc.width), cardH: Math.round(rc.height),
      cardBg: cc.backgroundColor, cardColor: cc.color,
      barW: Math.round(rbar.width), barH: Math.round(rbar.height),
      barBg: cb.backgroundImage.slice(0, 40),
      countText: document.getElementById("roomScanCount").textContent,
      tipText: document.getElementById("roomScanTip").textContent.replace(/\s+/g, " ").trim().slice(0, 30)
    };
  });
  console.log("  " + JSON.stringify(vis, null, 0));
  chk(vis.display !== "none" && vis.visibility !== "hidden", "卡片未被隐藏", "display=" + vis.display);
  chk(Number(vis.opacity) > 0.9, "卡片不透明", "opacity=" + vis.opacity);
  chk(vis.boxW > 1000 && vis.boxH > 600, "遮罩铺满视口", vis.boxW + "×" + vis.boxH);
  chk(vis.cardW > 300 && vis.cardH > 200, "卡片有实际尺寸", vis.cardW + "×" + vis.cardH);
  chk(vis.barH >= 6, "进度条可见（有高度）", vis.barH + "px");
  chk(/正在记录/.test(vis.countText), "计数文案正确", vis.countText);
  chk(/退到画面外|不要出现|拍不到/.test(vis.tipText), "引导文案正确", vis.tipText);
  // 深色卡片上文字必须是浅色（否则读不出来）
  const col = vis.cardColor.match(/\d+/g).map(Number);
  chk(col[0] > 180 && col[1] > 180, "卡片文字为浅色（深底可读）", vis.cardColor);

  console.log("\n===== 扫描完成后卡片消失 =====");
  await feed(new Array(14).fill(person.bg2), 14);
  await sleep(600);
  const after = await page.evaluate(() => {
    const box = document.getElementById("roomScan");
    const cs = getComputedStyle(box);
    return { display: cs.display, hidden: box.classList.contains("hidden"),
      coverage: motionEngine.roomScanInfo().coverage };
  });
  chk(after.hidden && after.display === "none", "卡片已收起", "display=" + after.display);
  chk(after.coverage > 0.8, "基线覆盖达标", (after.coverage * 100).toFixed(1) + "%");

  console.log("\n================ 汇总 ================");
  console.log("  通过 " + pass + " / 失败 " + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
