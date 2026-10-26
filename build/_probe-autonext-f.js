// 临时探针 F：验证"修复建议"确实能打通链路（**只读生产代码**，仅在本页运行时内
// 用 monkey-patch 替换两个函数来验证假设；不写回任何生产文件）
//
// 修复假设：
//   F1. motionStartRest 的 tick 守卫 `if (!motionAutoNext) return;` 是元凶 —— 休息期间
//       motionAutoNext 恒为 null，守卫每次都提前返回，导致 motionAutoAdvance 永不执行。
//       修法：休息开始就放一个占位把手 motionAutoNext={timer:0,cancelled:false}，
//       并把取消权交给既有的 motionAutoNextAbort()。
//   F2. 休息倒计时必须画在"孩子实际能看到的全屏层"上 —— 即休息期间不能把
//       .motion-avatar 收掉，而要 MotionAvatar.setProgress(resting) 显示倒计时。
//
// 验证目标：
//   * 打完补丁后，休息倒计时是否真的逐秒递减（页面内 + 全屏层两处文本都变）
//   * 休息结束后 motionChoice.exId 是否真的切到下一项（开合跳 → 高抬腿跑）
//   * motionRunning 是否重新变 true（正式计时已开跑）
//   * 全屏层 #motionAvatarProgress 在休息时是否可见（孩子能看到）
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__autonext-f.y4m");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 40, REP_HZ = 1.25;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128), cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => { for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v; };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24), B = 238;
    const spread = 17 + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * 9, cy = Math.round(VH / 2);
    for (const p of [FIG.torso, FIG.legL, FIG.legR]) paint(y, cx + p[0], cy + p[1], cx + p[2], cy + p[3], B);
    paint(y, Math.round(cx - spread), cy - 15, Math.round(cx - 9), cy - 12, B);
    paint(y, Math.round(cx + 9), cy - 15, Math.round(cx + spread), cy - 12, B);
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) { const h = Math.round(Math.sqrt(Math.max(0, FIG.headR ** 2 - (yy - hy) ** 2))); paint(y, cx - h, yy, cx + h + 1, yy + 1, B); }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}
const LOG = [];
const log = (t, o) => { const l = `[${t}] ${typeof o === "string" ? o : JSON.stringify(o)}`; LOG.push(l); console.log(l); };

(async () => {
  buildY4M(Y4M);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.setViewport({ width: 1440, height: 1000 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) { if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("blocked"); return new RWS(u, ...Array.prototype.slice.call(arguments, 1)); };
    window.WebSocket.prototype = RWS.prototype;
  });
  await page.evaluateOnNewDocument(() => {
    const RD = Date; const FIXED = new RD(2026, 9, 1, 10, 30, 0).getTime();
    class MD extends RD { constructor(...a) { if (!a.length) super(FIXED); else super(...a); } static now() { return FIXED; } }
    window.Date = MD;
  });

  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0", { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  for (let i = 0; i < 20; i++) { if (await page.evaluate(() => !!document.getElementById("motionVideo").srcObject)) break; await sleep(400); }
  await sleep(800);
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(600);

  /* ===== 打补丁：只在本页运行时替换 motionStartRest =====
   * 两处修复：(1) 休息开始就放占位把手，让 tick 守卫不再误拦；
   *          (2) 休息期间保持全屏层可见并把倒计时画上去。 */
  const patched = await page.evaluate(() => {
    try {
      motionStartRest = function (seconds, next) {
        motionRestLeft = seconds;
        // 修复(1)：占位把手 —— 休息期间 motionAutoNext 必须非空，否则 tick 误判为"已取消"
        if (motionAutoNext && motionAutoNext.timer) clearTimeout(motionAutoNext.timer);
        motionAutoNext = { timer: 0, cancelled: false, rest: true };
        // 修复(2)：休息倒计时画在孩子能看到的全屏层上（开练时全屏层是主视口）
        if (window.MotionAvatar) window.MotionAvatar.show();
        const tick = () => {
          if (!motionAutoNext) return;         // 被 motionAutoNextAbort() 取消 → 停
          if (motionRestLeft > 0) { renderMotionProgress(null); return; }
          clearInterval(motionRestTimer); motionRestTimer = 0;
          motionAutoAdvance(next);
        };
        if (motionRestTimer) clearInterval(motionRestTimer);
        renderMotionProgress(null);
        motionRestTimer = setInterval(() => { motionRestLeft -= 1; tick(); }, 1000);
      };
      return { ok: true, type: typeof motionStartRest };
    } catch (e) { return { ok: false, err: String(e) }; }
  });
  log("F/patch", patched);

  await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const i = [...sel.options].findIndex(o => o.textContent.includes("开合跳"));
    sel.value = String(i); sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const before = await page.evaluate(() => ({ choice: motionChoice.exId, next: (motionNextChoice() || {}).exId }));
  log("F/before", before);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());

  // 等自然达标
  let hit = false;
  for (let i = 0; i < 40; i++) { await sleep(500); if (await page.evaluate(() => window.__motionDebug().setDone)) { hit = true; break; } }
  log("F/naturalHit", hit);

  // 观察休息倒计时 + 全屏层可见性
  const series = [];
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const d = await page.evaluate(() => {
      const dbg = window.__motionDebug();
      const ap = document.getElementById("motionAvatarProgress");
      const gp = document.getElementById("motionGoalProgress");
      const anc = (function (el) { let cur = el; while (cur) { const cs = getComputedStyle(cur); if (cs.display === "none" || cs.visibility === "hidden") return true; cur = cur.parentElement; } return false; })(ap);
      return { restLeft: dbg.restLeft, choice: motionChoice.exId, running: dbg.running, previewing: dbg.previewing,
        gpNum: document.getElementById("motionGoalNum").textContent,
        apNum: document.getElementById("motionAvatarProgressNum").textContent,
        apHiddenClass: ap.classList.contains("hidden"), apHiddenAncestor: anc,
        apVisibleToChild: !ap.classList.contains("hidden") && !anc };
    });
    series.push(d);
    if (i % 2 === 0) log(`F/t+${(i + 1) * 0.5}s`, { restLeft: d.restLeft, apNum: d.apNum, gpNum: d.gpNum, apVis: d.apVisibleToChild, choice: d.choice, running: d.running });
    if (d.choice !== before.choice) { log("F/ADVANCED", { to: d.choice, restLeft: d.restLeft, running: d.running }); break; }
  }
  await page.screenshot({ path: path.join(SHOT, "autonext-fixed.png") });
  const last = series[series.length - 1];
  log("F/verdict", {
    restLeftSeries: series.map(s => s.restLeft).join(","),
    pageTexts: [...new Set(series.map(s => s.gpNum))],
    avatarTexts: [...new Set(series.map(s => s.apNum))],
    avatarVisibleDuringRest: series.some(s => s.restLeft > 0 && s.apVisibleToChild),
    advanced: last.choice !== before.choice,
    advancedTo: last.choice, runningAfter: last.running, previewingAfter: last.previewing
  });

  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  fs.writeFileSync(path.join(__dirname, "_probe-autonext-f.out.txt"), LOG.join("\n"), "utf8");
  process.exit(0);
})().catch(e => { console.error("崩溃", e); try { fs.writeFileSync(path.join(__dirname, "_probe-autonext-f.out.txt"), LOG.join("\n") + "\nCRASH " + e.message, "utf8"); } catch (_) { } try { fs.unlinkSync(Y4M); } catch (_) { } process.exit(2); });
