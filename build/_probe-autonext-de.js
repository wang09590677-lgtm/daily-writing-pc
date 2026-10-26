// 临时探针 D/E：休息倒计时的"可见性"与"口令层 vs 全屏猫层"层级（只读）
//
// E. 自然达标（开合跳 width 运动）后，完整观察休息倒计时：
//    - restLeft 内部值 / 页面内 #motionGoalProgress / 全屏 #motionAvatarProgress 的显示
//    - 逐级祖先的 display，判断"孩子到底能不能看到"
//    - 截图
//    - 休息结束后 motionChoice.exId 有没有变（自动下一项）
// D. 同时显示 .pose-prep 与 .motion-avatar，读 z-index 与 elementFromPoint，判断谁盖住谁。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__autonext-de.y4m");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 40, REP_HZ = 1.25;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128);
  const cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => {
    for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++)
      for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v;
  };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24);
    const B = 238;
    const ph = Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ);
    const spread = 17 + ph * 9;
    const cy = Math.round(VH / 2);
    for (const part of [FIG.torso, FIG.legL, FIG.legR]) paint(y, cx + part[0], cy + part[1], cx + part[2], cy + part[3], B);
    paint(y, Math.round(cx - spread), cy - 15, Math.round(cx - 9), cy - 12, B);
    paint(y, Math.round(cx + 9), cy - 15, Math.round(cx + spread), cy - 12, B);
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) {
      const half = Math.round(Math.sqrt(Math.max(0, FIG.headR * FIG.headR - (yy - hy) * (yy - hy))));
      paint(y, cx - half, yy, cx + half + 1, yy + 1, B);
    }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

const LOG = [];
const log = (t, o) => { const l = `[${t}] ${typeof o === "string" ? o : JSON.stringify(o)}`; LOG.push(l); console.log(l); };

// 逐级祖先可见性判定
const ANCESTOR_FN = `(function(el){
  const chain=[]; let cur=el, blockedBy=null;
  while(cur){
    const cs=getComputedStyle(cur);
    chain.push((cur.id||cur.className||cur.tagName)+":"+cs.display+"/z"+cs.zIndex);
    if(blockedBy===null && (cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)===0)) blockedBy=(cur.id||cur.className||cur.tagName);
    cur=cur.parentElement;
  }
  return {chain, blockedBy};
})`;

(async () => {
  buildY4M(Y4M);
  const y4mWin = Y4M.replace(/\//g, "\\");
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + y4mWin,
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", e => { errors.push(e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });

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

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
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
  await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const i = [...sel.options].findIndex(o => o.textContent.includes("开合跳"));
    sel.value = String(i); sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1000);
  log("E/start", await page.evaluate(() => window.__motionDebug().progress));

  /* -------- 等自然达标 -------- */
  let hit = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const d = await page.evaluate(() => window.__motionDebug());
    if (d.setDone) { hit = true; break; }
  }
  log("E/naturalHit", hit);
  log("E/atHit", await page.evaluate(() => {
    const d = window.__motionDebug();
    return { setDone: d.setDone, restLeft: d.restLeft, autoNextPending: d.autoNextPending,
      choice: motionChoice.exId, running: d.running, previewing: d.previewing };
  }));

  /* -------- 观察整个休息过程 -------- */
  const restSeries = [];
  for (let i = 0; i < 30; i++) {  // ~15s
    await sleep(500);
    const d = await page.evaluate(`(function(){
      const dbg = window.__motionDebug();
      const gp = document.getElementById("motionGoalProgress");
      const ap = document.getElementById("motionAvatarProgress");
      const av = document.getElementById("motionAvatar");
      const gpNum = document.getElementById("motionGoalNum").textContent;
      const apNum = document.getElementById("motionAvatarProgressNum").textContent;
      return {
        restLeft: dbg.restLeft, resting: dbg.progress && dbg.progress.resting,
        choice: motionChoice.exId, running: dbg.running, autoNextPending: dbg.autoNextPending,
        restTimerId: (typeof motionRestTimer !== "undefined") ? motionRestTimer : "n/a",
        gpNum, apNum,
        gpVisibleToChild: (!gp.classList.contains("hidden")) && !${ANCESTOR_FN}(gp).blockedBy,
        apVisibleToChild: (!ap.classList.contains("hidden")) && !${ANCESTOR_FN}(ap).blockedBy,
        avatarHidden: av.classList.contains("hidden")
      };
    })()`);
    restSeries.push(d);
    if (i % 2 === 0) log(`E/rest+${(i + 1) * 0.5}s`, { restLeft: d.restLeft, restTimerId: d.restTimerId, gpNum: d.gpNum, apNum: d.apNum, avatarHidden: d.avatarHidden, gpVis: d.gpVisibleToChild, apVis: d.apVisibleToChild, choice: d.choice });
  }
  const eLast = restSeries[restSeries.length - 1];
  const gpTexts = [...new Set(restSeries.map(r => r.gpNum))];
  const apTexts = [...new Set(restSeries.map(r => r.apNum))];
  log("E/verdict", {
    restLeftSeries: restSeries.map(r => r.restLeft).join(","),
    pageProgressTextUnique: gpTexts,
    avatarProgressTextUnique: apTexts,
    pageProgressVisibleToChild: eLast.gpVisibleToChild,
    avatarProgressVisibleToChild: eLast.apVisibleToChild,
    avatarHidden: eLast.avatarHidden,
    advancedTo: eLast.choice, finalRunning: eLast.running
  });
  await page.screenshot({ path: path.join(SHOT, "autonext-rest.png") });

  /* -------- D. 同时显示 .pose-prep 与 .motion-avatar -------- */
  log("=== D. 口令层 vs 全屏猫层 层级 ===");
  await page.evaluate(() => {
    // 先停掉残留状态，避免干扰
    if (typeof motionAutoNextAbort === "function") motionAutoNextAbort();
    if (typeof motionStopSet === "function") motionStopSet(true);
    // 1) 显示全屏猫层
    if (window.MotionAvatar) window.MotionAvatar.show();
    // 2) 走口令路径，显示 .pose-prep（本页 motionPrep=0，用 motionStartSet 会被短路，
    //    所以这里直接手动还原口令层可见态，模拟真实自动推进里的 prep 时刻）
    const box = document.getElementById("posePrep");
    box.classList.remove("hidden");
    document.getElementById("posePrepName").textContent = "准备开始进行开合跳";
    document.getElementById("posePrepCount").textContent = "3";
    document.getElementById("posePrepSub").textContent = "准备…";
  });
  await sleep(400);
  const dStack = await page.evaluate(`(function(){
    const av = document.getElementById("motionAvatar");
    const prep = document.getElementById("posePrep");
    const csAv = getComputedStyle(av), csPrep = getComputedStyle(prep);
    const pt = {x: Math.round(innerWidth/2), y: Math.round(innerHeight/2)};
    const mid = document.elementFromPoint(pt.x, pt.y);
    return {
      avatarZ: csAv.zIndex, avatarDisplay: csAv.display,
      prepZ: csPrep.zIndex, prepDisplay: csPrep.display,
      prepCountText: document.getElementById("posePrepCount").textContent,
      topElementAtCenter: mid ? (mid.id || mid.className || mid.tagName) : null,
      centerHitsAvatar: !!(av && mid && (av===mid || av.contains(mid))),
      centerHitsPrep: !!(prep && mid && (prep===mid || prep.contains(mid))),
      // prep 大字（数 3）所在位置的命中元素
      prepCountHit: (function(){
        const el = document.getElementById("posePrepCount");
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
        return hit ? (hit.id || hit.className || hit.tagName) : null;
      })()
    };
  })()`);
  log("D/verdict", dStack);
  await page.screenshot({ path: path.join(SHOT, "autonext-layering.png") });

  log("控制台错误", errors.length ? errors : "无");
  fs.writeFileSync(path.join(__dirname, "_probe-autonext-de.out.txt"), LOG.join("\n"), "utf8");
  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  process.exit(0);
})().catch(err => {
  console.error("崩溃", err);
  try { fs.writeFileSync(path.join(__dirname, "_probe-autonext-de.out.txt"), LOG.join("\n") + "\nCRASH: " + err.message, "utf8"); } catch (e) { }
  try { fs.unlinkSync(Y4M); } catch (e) { }
  process.exit(2);
});
