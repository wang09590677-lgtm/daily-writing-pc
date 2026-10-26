// 临时探针：诊断「达标后自动休息 + 自动进下一项」链路（只读，不改生产代码）
//
// 做法：
//   A. 真实浏览器 + 合成 Y4M 假摄像头（人形**横向开合**，喂 开合跳 的 width 信号）
//      → 看 progress.percent 到底会不会爬到 100、motionAutoComplete 会不会被自然调用。
//   B. 直接调用全局 motionAutoComplete("reached")（该函数是经典脚本的顶层函数，
//      在页面里以裸标识符可见）→ 强制走一遍「打分落库 → 休息 → 自动下一项」下游链路，
//      观察 restLeft 是否真的递减、exId 是否真的切走、两块进度 DOM 的可见性。
//   C. ?motionAutoNext=0 条件下重跑 B，验证「开关拦不住清零」这条可疑点。
//   D. 让 MotionAvatar 与 .pose-prep 同时显示，读 z-index 与 elementFromPoint，
//      验证「口令层被猫层挡住」这条可疑点。
//
// 日期冻结到 2026-10-01（周四 = 速度爆发日）：开合跳在 today 计划里，
// 目标 20 次（main[0] = ["jumpingJacks", 2, 20, 40]），有真实 blockId，
// 且后面还有下一项 → 正好测「自动下一项」。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__autonext-probe.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 合成假摄像头：竖直人形，双臂横向开合（模拟开合跳），频率 REP_HZ ----
const FIG = {
  headR: 6, headDy: -27,
  torso: [-10, -19, 10, 9],
  legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30]
};
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
    // 双臂开合：spread 在 8 → 26 像素之间摆动（0.5 相位差让两条手臂交替补偿，整体宽度同步变化）
    const ph = Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ);
    const spread = 17 + ph * 9;
    const cy = Math.round(VH / 2);
    for (const part of [FIG.torso, FIG.legL, FIG.legR]) paint(y, cx + part[0], cy + part[1], cx + part[2], cy + part[3], B);
    // 手臂：从躯干上缘向两侧伸出，长度随 spread 变化（水平细条）
    paint(y, Math.round(cx - spread), cy - 15, Math.round(cx - 9), cy - 12, B);   // 左臂
    paint(y, Math.round(cx + 9), cy - 15, Math.round(cx + spread), cy - 12, B);   // 右臂
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
function log(tag, obj) {
  const line = `[${tag}] ${typeof obj === "string" ? obj : JSON.stringify(obj)}`;
  LOG.push(line); console.log(line);
}

async function snapshot(page, tag) {
  const d = await page.evaluate(() => {
    const dbg = window.__motionDebug ? window.__motionDebug() : null;
    const el = id => document.getElementById(id);
    const vis = e => {
      if (!e) return { exists: false };
      const cs = getComputedStyle(e);
      return { exists: true, hiddenClass: e.classList.contains("hidden"), display: cs.display,
        zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity };
    };
    const eng = window.motionEngine ? window.motionEngine.getState() : null;
    return {
      progress: dbg ? dbg.progress : null,
      setDone: dbg ? dbg.setDone : null,
      restLeft: dbg ? dbg.restLeft : null,
      autoNextPending: dbg ? dbg.autoNextPending : null,
      autoNextDone: dbg ? dbg.autoNextDone : null,
      running: dbg ? dbg.running : null,
      previewing: dbg ? dbg.previewing : null,
      prepping: dbg ? dbg.prepping : null,
      engineReps: eng ? eng.reps : null,
      engineActive: eng ? eng.activeSeconds : null,
      motionChoiceExId: (typeof motionChoice !== "undefined" && motionChoice) ? motionChoice.exId : null,
      nextChoiceExId: (typeof motionNextChoice === "function" && motionNextChoice()) ? motionNextChoice().exId : null,
      goalProgress: vis(el("motionGoalProgress")),
      avatarProgress: vis(el("motionAvatarProgress")),
      avatar: vis(el("motionAvatar")),
      posePrep: vis(el("posePrep")),
      posePrepName: el("posePrepName") ? el("posePrepName").textContent : null,
      posePrepCount: el("posePrepCount") ? el("posePrepCount").textContent : null,
      goalNumText: el("motionGoalNum") ? el("motionGoalNum").textContent : null,
      avatarNumText: el("motionAvatarProgressNum") ? el("motionAvatarProgressNum").textContent : null
    };
  });
  log(tag, d);
  return d;
}

(async () => {
  buildY4M(Y4M);
  const y4mWin = Y4M.replace(/\//g, "\\");
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=" + y4mWin,
      "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") { errors.push("CONSOLE: " + m.text()); console.log("CONSOLE:", m.text()); } });
  page.on("dialog", async d => { await d.accept(); });

  // 屏蔽本机深度桥接，保证走纯彩色通路（可复现）
  await page.evaluateOnNewDocument(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url) {
      if (String(url).indexOf("127.0.0.1:8765") >= 0) throw new Error("depth bridge blocked in test");
      return new RealWS(url, ...Array.prototype.slice.call(arguments, 1));
    };
    window.WebSocket.prototype = RealWS.prototype;
  });
  // 冻结日期到 2026-10-01 周四（速度爆发日，开合跳目标 20 次）
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    const FIXED = new RealDate(2026, 9, 1, 10, 30, 0).getTime();
    class MockDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
      static now() { return FIXED; }
    }
    window.Date = MockDate;
  });

  const baseUrl = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

  async function setup(url, selectName) {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
    await page.reload({ waitUntil: "load" });
    await sleep(900);
    await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
    await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
    await sleep(400);
    await page.evaluate(() => document.getElementById("motionCameraBtn").click());
    // 等真实挂上流
    for (let i = 0; i < 20; i++) {
      const ok = await page.evaluate(() => !!document.getElementById("motionVideo").srcObject);
      if (ok) break;
      await sleep(400);
    }
    await sleep(800);
    await page.evaluate(() => document.getElementById("poseCalibSkip").click());
    await sleep(600);
    const picked = await page.evaluate((nm) => {
      const sel = document.getElementById("motionExSelect");
      const idx = [...sel.options].findIndex(o => o.textContent.includes(nm));
      if (idx < 0) return null;
      sel.value = String(idx);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { idx, text: sel.options[idx].textContent.trim(),
        goal: document.getElementById("motionGoalHint").textContent.trim() };
    }, selectName);
    log("SETUP", { url: url.split("?")[1] || "(default)", picked });
    return picked;
  }

  /* ================= A. 真实合成运动：看达标闸门会不会自然触发 ================= */
  log("=== A. 自然达标（开合跳·喂 width 开合运动）===");
  await setup(baseUrl + "?motionPrep=0", "开合跳");
  const beforeStart = await page.evaluate(() => {
    const list = motionChoices();
    const c = motionChoice;
    return { choices: list.length, pickedIndex: list.findIndex(x => x.exId === c.exId && x.blockId === c.blockId),
      exId: c.exId, target: c.target, blockId: c.blockId, goal: motionGoalFor(c),
      restSeconds: motionRestSeconds() };
  });
  log("A/choice", beforeStart);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1200);
  await snapshot(page, "A/t+1.2s start");

  let naturalHit = false;
  for (let i = 0; i < 40; i++) {  // 最多 20 秒
    await sleep(500);
    const d = await page.evaluate(() => {
      const dbg = window.__motionDebug();
      return { pct: dbg.progress ? dbg.progress.percent : null, cur: dbg.progress ? dbg.progress.current : null,
        setDone: dbg.setDone, restLeft: dbg.restLeft, running: dbg.running };
    });
    if (i % 4 === 0) log("A/poll", d);
    if (d.setDone) { naturalHit = true; log("A/HIT", "自然达标触发 motionAutoComplete"); break; }
  }
  await snapshot(page, "A/after-run");
  if (naturalHit) {
    log("A/result", "达标闸门自然触发（说明 progressPercent 能到 100、motionAutoComplete 会被调用）");
  } else {
    log("A/result", "20 秒窗口内未自然达标（可能只是计数不够，不代表闸门坏）");
  }

  /* ================= B. 强制走一遍下游链路：休息 + 自动下一项 ================= */
  log("=== B. 强制 motionAutoComplete → 观察休息与自动下一项 ===");
  await page.evaluate(() => { if (typeof motionAutoNextAbort === "function") motionAutoNextAbort(); });
  // 保证处于 running 且 motionSetDone 为空：重新开一组
  await page.evaluate(() => {
    if (typeof motionResetSet === "function") motionResetSet();
  });
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1000);
  const bBefore = await snapshot(page, "B/before-force");
  await page.evaluate(() => { motionAutoComplete("reached"); });
  log("B/call", "已调用 motionAutoComplete('reached')");
  const bSeries = [];
  for (let i = 0; i < 26; i++) {  // ~13 秒
    await sleep(500);
    const d = await snapshot(page, i % 4 === 0 ? `B/t+${(i + 1) * 0.5}s` : "B/poll-silent");
    if (d.restLeft != null) bSeries.push(d.restLeft);
  }
  log("B/restLeft-series", bSeries.join(","));
  const bAfter = await snapshot(page, "B/after");
  log("B/verdict", {
    restStarted: (bSeries.some(v => v > 0)),
    restLeftEverNegative: bSeries.some(v => v < 0),
    restLeftEnd: bSeries[bSeries.length - 1],
    autoAdvanced: bAfter.motionChoiceExId !== bBefore.motionChoiceExId,
    runningBack: bAfter.running
  });

  /* ================= C. ?motionAutoNext=0 能不能拦住「清零」 ================= */
  log("=== C. ?motionAutoNext=0 语义验证 ===");
  await setup(baseUrl + "?motionPrep=0&motionAutoNext=0", "开合跳");
  const cDisabledFlag = await page.evaluate(() => motionAutoNextDisabled());
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1000);
  const cBefore = await snapshot(page, "C/before-force");
  await page.evaluate(() => { motionAutoComplete("reached"); });
  await sleep(1200);
  const cAfter = await snapshot(page, "C/after-force");
  const cScores = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("dailyWritingPcStateV3") || "{}");
    const arr = (st.fitness && st.fitness.motion && st.fitness.motion.scores) || [];
    return { count: arr.length, lastReps: arr.length ? arr[arr.length - 1].reps : null,
      lastExId: arr.length ? arr[arr.length - 1].exId : null };
  });
  log("C/verdict", {
    autoNextDisabledFlag: cDisabledFlag,
    repsBefore: cBefore.engineReps, repsAfter: cAfter.engineReps,
    restLeftAfter: cAfter.restLeft, autoNextPending: cAfter.autoNextPending,
    scores: cScores
  });

  /* ================= D. .pose-prep vs .motion-avatar 的层级 ================= */
  log("=== D. 口令层与全屏猫层同时显示时的层级 ===");
  const dTop = await page.evaluate(() => {
    if (window.MotionAvatar) window.MotionAvatar.show();
    if (typeof motionStartSet === "function") motionStartSet();   // 走口令路径（本页无 ?motionPrep=0 时应显示 prep）
    return true;
  });
  await sleep(700);
  const dStack = await page.evaluate(() => {
    const av = document.getElementById("motionAvatar");
    const prep = document.getElementById("posePrep");
    const csAv = av ? getComputedStyle(av) : null;
    const csPrep = prep ? getComputedStyle(prep) : null;
    const mid = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    return {
      avatar: av ? { hidden: av.classList.contains("hidden"), display: csAv.display, zIndex: csAv.zIndex } : null,
      posePrep: prep ? { hidden: prep.classList.contains("hidden"), display: csPrep.display, zIndex: csPrep.zIndex,
        name: document.getElementById("posePrepName").textContent } : null,
      prepShown: prep ? !prep.classList.contains("hidden") : false,
      topElementAtCenter: mid ? (mid.id || mid.className || mid.tagName) : null,
      topIsPrepLayer: !!(prep && mid && (prep === mid || prep.contains(mid))),
      topIsAvatarLayer: !!(av && mid && (av === mid || av.contains(mid))),
      prepping: (window.__motionDebug && window.__motionDebug().prepping)
    };
  });
  log("D/verdict", dStack);

  log("=== 控制台错误 ===", errors.length ? errors : "无");
  fs.writeFileSync(path.join(__dirname, "_probe-autonext.out.txt"), LOG.join("\n"), "utf8");
  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  process.exit(0);
})().catch(err => {
  console.error("探针崩溃：", err);
  try { fs.writeFileSync(path.join(__dirname, "_probe-autonext.out.txt"), LOG.join("\n") + "\nCRASH: " + err.message, "utf8"); } catch (e) { }
  try { fs.unlinkSync(Y4M); } catch (e) { }
  process.exit(2);
});
