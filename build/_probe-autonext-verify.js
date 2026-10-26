// 临时验收探针：验证「达标 → 休息倒计时 → 自动进下一项」修复（只读生产代码，
// 唯一在页面运行时内做的写操作是【临时放宽 expectedAmplitude】，用于隔离测试 —— 见下）。
//
// 为什么必须放宽：另一个 teammate 并行给 motion-engine.js 的计次加了绝对幅度门限
//   gate = expectedAmplitude × 0.5 × bodyScale（motion-engine.js:2596-2611）。
//   本探针的合成人形摆幅偏小，门限落盘后很可能达不了标 → 链路根本触发不了。
//   这不是修复没生效。为了把"验 autonext 链路"与"验计次精度"隔离开，探针在页面运行时
//   内把当前动作期望幅度调到极小（0.005），模拟"孩子做的是大幅动作"。
//   **不写回任何生产文件**，只在本次浏览器会话内生效。
//
// 用**默认 URL（不带 ?motionPrep=0）**，让自动进下一项时走真实的 motionStartSet()
//   口令路径，从而能真实验证 .pose-prep（z-index 110）有没有被猫层（z-index 100）盖住。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__autonext-verify.y4m");
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
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => { if (m.type() === "error") { errors.push("CONSOLE: " + m.text()); console.log("CONSOLE:", m.text()); } });
  page.on("dialog", async d => { await d.accept(); });

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

  // 默认 URL：不跳口令，让自动进下一项走真实 motionStartSet()（才能验层级）
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  for (let i = 0; i < 25; i++) { if (await page.evaluate(() => !!document.getElementById("motionVideo").srcObject)) break; await sleep(400); }
  await sleep(800);
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(600);

  /* ---- 选开合跳 + 【临时放宽 expectedAmplitude，隔离计次门限】---- */
  const pre = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const i = [...sel.options].findIndex(o => o.textContent.includes("开合跳"));
    sel.value = String(i); sel.dispatchEvent(new Event("change", { bubbles: true }));
    const before = motionChoice.profile.expectedAmplitude;
    motionChoice.profile.expectedAmplitude = 0.005;   // ← 隔离测试专用，仅本会话
    return { exId: motionChoice.exId, target: motionGoalFor(motionChoice).reps,
      blockId: motionChoice.blockId, next: (motionNextChoice() || {}).exId,
      ampBefore: before, ampNow: motionChoice.profile.expectedAmplitude,
      prepDisabled: motionPrepDisabled(), restSeconds: motionRestSeconds() };
  });
  log("SETUP", pre);

  await page.evaluate(() => document.getElementById("motionStartBtn").click());

  /* ---- 连续采样：口令 → 计时 → 达标 → 休息 → 自动进下一项 ---- */
  const samples = [];
  let sawPrepDuringAdvance = false, layering = null;
  for (let i = 0; i < 220; i++) {
    await sleep(300);
    const s = await page.evaluate(`(function(){
      const dbg = window.__motionDebug();
      const gp = document.getElementById("motionGoalProgress");
      const ap = document.getElementById("motionAvatarProgress");   // 猫层未 init 前为 null
      const ancHidden = function(el){ if(!el) return true; let c=el; while(c){ const cs=getComputedStyle(c); if(cs.display==='none'||cs.visibility==='hidden') return true; c=c.parentElement; } return false; };
      const txt = function(id){ const e=document.getElementById(id); return e ? e.textContent : null; };
      const eng = window.motionEngine ? window.motionEngine.getState() : null;
      return {
        pct: dbg.progress ? dbg.progress.percent : null,
        resting: dbg.progress ? !!dbg.progress.resting : false,
        restLeft: dbg.restLeft,
        setDone: dbg.setDone,
        prepping: dbg.prepping,
        prepShown: dbg.prepShown,
        prepText: dbg.prepText,
        choice: (typeof motionChoice!=='undefined' && motionChoice) ? motionChoice.exId : null,
        running: dbg.running, previewing: dbg.previewing,
        avatarVisible: !!(window.MotionAvatar && window.MotionAvatar.isVisible()),
        apHiddenClass: ap ? ap.classList.contains("hidden") : "no-el",
        apVisibleToChild: !!ap && !ap.classList.contains("hidden") && !ancHidden(ap),
        gpNum: txt("motionGoalNum"),
        apNum: txt("motionAvatarProgressNum"),
        repGate: eng ? eng.repGate : null, repSpread: eng ? eng.repSpread : null
      };
    })()`);
    samples.push(s);

    // 自动进下一项的口令窗口：测层级（.pose-prep z110 是否已盖过猫层 z100）
    if (s.prepping && s.prepShown && s.avatarVisible && !layering) {
      layering = await page.evaluate(`(function(){
        const av = document.getElementById("motionAvatar");
        const prep = document.getElementById("posePrep");
        const mid = document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
        const cnt = document.getElementById("posePrepCount");
        const r = cnt.getBoundingClientRect();
        const hitCnt = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
        return {
          avatarZ: getComputedStyle(av).zIndex, prepZ: getComputedStyle(prep).zIndex,
          avatarVisible: av && !av.classList.contains("hidden"),
          prepVisible: prep && !prep.classList.contains("hidden"),
          prepName: document.getElementById("posePrepName").textContent,
          prepCount: cnt.textContent,
          centerTop: mid ? (mid.id || mid.className || mid.tagName) : null,
          centerHitsPrep: !!(prep && mid && (prep===mid || prep.contains(mid))),
          countTop: hitCnt ? (hitCnt.id || hitCnt.className || hitCnt.tagName) : null,
          countHitsPrep: !!(prep && hitCnt && (prep===hitCnt || prep.contains(hitCnt)))
        };
      })()`);
      sawPrepDuringAdvance = true;
      log("LAYERING@advance-prep", layering);
      await page.screenshot({ path: path.join(SHOT, "autonext-verify-prep.png") });
    }

    const advanced = s.setDone && s.choice && s.choice !== pre.exId;
    if (advanced) { log("ADVANCED", { to: s.choice, restLeft: s.restLeft, running: s.running, previewing: s.previewing, avatarVisible: s.avatarVisible }); break; }
    if (i % 8 === 0) log("poll", { pct: s.pct, resting: s.resting, restLeft: s.restLeft, prepping: s.prepping, choice: s.choice, running: s.running, avatarVisible: s.avatarVisible, apNum: s.apNum, repGate: s.repGate, repSpread: s.repSpread });
  }

  /* ---- 汇总实测数据 ---- */
  const restSamples = samples.filter(s => s.resting || (s.restLeft !== 0 && s.restLeft != null && s.choice === pre.exId && s.setDone));
  const restLeftSeries = [];
  for (const s of samples) if (s.choice === pre.exId && s.setDone && s.setDone === pre.exId) restLeftSeries.push(s.restLeft);
  const restTexts = [...new Set(samples.filter(s => s.choice === pre.exId && s.setDone).map(s => s.gpNum))];
  const avatarTexts = [...new Set(samples.filter(s => s.choice === pre.exId && s.setDone).map(s => s.apNum))];
  const duringRest = samples.filter(s => s.choice === pre.exId && s.setDone && typeof s.restLeft === "number" && s.restLeft > 0);
  const last = samples[samples.length - 1];
  const reached100 = samples.some(s => s.pct === 100 || s.setDone);

  const verdict = {
    "① restLeft 序列": restLeftSeries.join(","),
    "① restLeft 最小/最大": restLeftSeries.length ? `${Math.min(...restLeftSeries)} / ${Math.max(...restLeftSeries)}` : "n/a",
    "① 是否出现过负数": restLeftSeries.some(v => v < 0),
    "② 页内倒计时文本(去重)": restTexts,
    "② 全屏倒计时文本(去重)": avatarTexts,
    "③ 休息期间 MotionAvatar.isVisible 全为 true": duringRest.length > 0 && duringRest.every(s => s.avatarVisible),
    "③ 休息期间全屏进度面板对孩子可见": duringRest.some(s => s.apVisibleToChild),
    "④ 休息结束切换到": last.choice,
    "④ 是否真的切换": !!(last.choice && last.choice !== pre.exId),
    "④ 切换后 running/previewing": `${last.running} / ${last.previewing}`,
    "⑤ 自动进下一项时见过 prep 窗口": sawPrepDuringAdvance,
    "⑤ 层级实测": layering
  };
  log("=== VERDICT ===", verdict);
  log("控制台错误", errors.length ? errors : "无");

  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  fs.writeFileSync(path.join(__dirname, "_probe-autonext-verify.out.txt"), LOG.join("\n"), "utf8");
  fs.writeFileSync(path.join(__dirname, "_probe-autonext-verify.verdict.json"), JSON.stringify(verdict, null, 2), "utf8");
  process.exit(0);
})().catch(e => {
  console.error("崩溃", e);
  try { fs.writeFileSync(path.join(__dirname, "_probe-autonext-verify.out.txt"), LOG.join("\n") + "\nCRASH " + e.message, "utf8"); } catch (_) { }
  try { fs.unlinkSync(Y4M); } catch (_) { }
  process.exit(2);
});
