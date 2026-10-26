// 体感「达标 → 项间休息倒计时 → 自动进下一项」验收（真实 Chrome）
//
// 用户需求原话：
//   「一个动作结束后应该是自动开始中间休息的计时的，休息完成后自动开始下一个
//     动作的，刚才我也没看到」
//
// 这条链路**历史上真坏过**（真机实测复现）：motionAutoNext 这个变量身兼两职 ——
// 「进行中的自动推进把手」和「有没有被取消的标志位」。而进入休息时**从来没有人给它
// 赋过值**（唯一的赋值点 motionAutoAdvance 恰恰被守卫挡住）→ 休息 tick 的首行
//   `if (!motionAutoNext) return;`
// 每一秒都早退：倒计时冻在「休息 10 秒」、motionRestLeft 一路减成负数、
// 永远不切下一项。真因与修法见 app.js 的 motionStartRest() 上方长注释。
//
// 修完之后**只有一次性临时探针**（build/_probe-autonext-verify.js）验过它，
// 没有永久回归 —— 也就是说这个缺陷随时可能悄悄回来，而下一次未必有人在真机上撞见。
// 本文件就是补上这个缺口，把探针升级成带断言、可重复跑的正式验收。
//
// ---- 三个必须知道的测试前提（都踩过）----
//
// A. **本测试用「高频连续（burst）」动作做载体，刻意不用计次（rep）动作**。
//    原因是实测出来的（见 build/_REPORT-计数欠计定性.md）：
//    合成深度人形在**掩码回退链路**下不能可靠计数 —— 掩码的背景学习会把
//    摆动"吸收"成一块静止拖影，质心/包围盒几乎不动，计次信号又平又脏。
//    早期版本的临时探针之所以"能数到 20 次"，是因为它跑在**幅度闸门落地之前**
//    的旧引擎上（尾部重扫在数噪声），纯属假阳性。
//    用 rep 动作 ➜ 数不满目标 ➜ 链路永远不触发 ➜ 测试以"没看到休息"的形式**假失败**。
//
//    改用 burst 后这条依赖就消失了：burst 不看动作计数，只看"画面运动量持续了
//    多少秒"（`live.motion > burstMinEnergy` 时单调累积 activeSeconds）。
//    合成人形的手臂摆动足以持续超过这个很小的能量阈值，所以**能真实达标**。
//    而达标判定与后续流程和 rep 完全同一条路（都是 progressPercent >= 100
//    ➜ motionAutoComplete），所以链路覆盖强度不变。
//
//    ⚠️ 顺带说明为什么**不**用"直接调 motionAutoComplete()"来省事：
//    那会绕过"产线每帧检查达标"这一环，而这一环恰恰是历史上出问题的地方
//    （达标判定条件、进度折算、motionSetDone 防重入）。1~5 节必须走完整真实路径。
//    只有 6 节的分支覆盖才直接驱动入口 —— 那里验的是"达标之后往哪走"，与计数无关。
//
// B. **1~5 节必须走默认 URL（不带 ?motionPrep=0）**。自动进下一项时走的
//    motionStartSet() 会念口令、会亮准备层 .pose-prep;孩子站在两三米外,
//    只有准备层压过角色全屏层(z-index 100)才看得见口令。这正是 5 节要验的东西,
//    用 ?motionPrep=0 捷径就把要验的对象本身跳过了。
//    6 节反过来,**必须**用 ?motionPrep=0:那里只想快速覆盖"末项不再推进""关掉
//    自动推进"两个分支,不想为每次 8 秒口令付钱。
//
// C. **日期必须冻结**。动作序列是按"周几"排的,不冻结的话今天可能是休息日,
//    motionChoices() 会是空的,第一个断言就会莫名其妙地失败。冻结到
//    **2026-10-01（周四）** —— 教案里这一天的 main 段是
//    [开合跳, 原地高抬腿跑, 原地小步跑, 跳绳, 波比跳]，
//    其中「原地高抬腿跑」是 burst 类（本测试的载体），它后面还有动作，
//    所以能考出"自动进下一项"。
//
// D. **本项的目标秒数由测试自己压短**（6 秒，而不是教案里的 20 秒）。
//    这只是缩短"做满目标"要等的时间，不改算法、不进任何文件；
//    目标秒数是纯粹的用户参数（`motionChoice.target`），缩小它不影响
//    我们对"达标→休息→推进"这条链路的验证强度。
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
// 合成视频放系统临时目录:build/ 里不要再堆测试中间产物（历史上曾涨到 300M+）
const Y4M = path.join(os.tmpdir(), "wbc-autonext-" + process.pid + ".y4m");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? "  → " + detail : ""}`);
}

/* ---- 合成人形：躯干 + 双腿固定，双臂横向开合（正好对应开合跳的 signal:"width"）----
 * REP_HZ 取 1.25（真开合跳约 60~75/分），40 秒素材在 --use-file-for-fake-video-capture
 * 下会被循环播放,足够做满 20 次目标。 */
const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 40, REP_HZ = 1.25;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128), cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => {
    for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++)
      for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v;
  };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24), B = 238;
    const spread = 17 + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * 9, cy = Math.round(VH / 2);
    for (const p of [FIG.torso, FIG.legL, FIG.legR]) paint(y, cx + p[0], cy + p[1], cx + p[2], cy + p[3], B);
    paint(y, Math.round(cx - spread), cy - 15, Math.round(cx - 9), cy - 12, B);
    paint(y, Math.round(cx + 9), cy - 15, Math.round(cx + spread), cy - 12, B);
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) {
      const h = Math.round(Math.sqrt(Math.max(0, FIG.headR ** 2 - (yy - hy) ** 2)));
      paint(y, cx - h, yy, cx + h + 1, yy + 1, B);
    }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

/* ---- 页面桩：断掉深度桥 + 冻结日期。每个 page 都要装一遍（evaluateOnNewDocument 是 per-page 的）---- */
async function stubPage(page) {
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) {
      if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("blocked");
      return new RWS(u, ...Array.prototype.slice.call(arguments, 1));
    };
    window.WebSocket.prototype = RWS.prototype;
  });
  await page.evaluateOnNewDocument(() => {
    const RD = Date; const FIXED = new RD(2026, 9, 1, 10, 30, 0).getTime();
    class MD extends RD { constructor(...a) { if (!a.length) super(FIXED); else super(...a); } static now() { return FIXED; } }
    window.Date = MD;
  });
}

/* ---- 进体感页 + 开摄像头 + 跳站位校准。返回后光标停在"可以点开始"的状态 ---- */
async function enterMotionView(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => { try { localStorage.removeItem("dailyWritingPcStateV3"); } catch (e) { } });
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(480);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(420);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  for (let i = 0; i < 25; i++) {
    if (await page.evaluate(() => !!document.getElementById("motionVideo").srcObject)) break;
    await sleep(400);
  }
  await sleep(800);
  await page.evaluate(() => { const b = document.getElementById("poseCalibSkip"); if (b) b.click(); });
  await sleep(600);
}

/* 每次采样都重新读一遍实时状态（都在页面作用域里直读，别写成 window.xxx ——
 * 顶层 let/const 不会变成 window 属性，那样只会静默拿到 undefined）。 */
const SAMPLE_JS = `(function(){
  const dbg = window.__motionDebug();
  const ancHidden = function(el){ if(!el) return true; let c=el; while(c){ const cs=getComputedStyle(c); if(cs.display==='none'||cs.visibility==='hidden') return true; c=c.parentElement; } return false; };
  const txt = function(id){ const e=document.getElementById(id); return e ? e.textContent : null; };
  const eng = (typeof motionEngine!=='undefined' && motionEngine) ? motionEngine.getState() : null;
  const ap = document.getElementById("motionAvatarProgress");
  return {
    pct: dbg.progress ? dbg.progress.percent : null,
    resting: dbg.progress ? !!dbg.progress.resting : false,
    restLeft: dbg.restLeft,
    setDone: dbg.setDone,
    autoNextPending: dbg.autoNextPending,
    autoNextDone: dbg.autoNextDone,
    prepping: dbg.prepping,
    prepShown: dbg.prepShown,
    choice: (typeof motionChoice!=='undefined' && motionChoice) ? motionChoice.exId : null,
    running: dbg.running, previewing: dbg.previewing,
    avatarVisible: !!(window.MotionAvatar && window.MotionAvatar.isVisible()),
    apVisibleToChild: !!ap && !ap.classList.contains("hidden") && !ancHidden(ap),
    gpNum: txt("motionGoalNum"),
    apNum: txt("motionAvatarProgressNum"),
    repGate: eng ? eng.repGate : null, repSpread: eng ? eng.repSpread : null
  };
})()`;

(async () => {
  buildY4M(Y4M);
  const profileDir = path.join(os.tmpdir(), "wbc-autonext-prof-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  // Chrome 关掉后仍会短暂持有 profile 句柄：放系统临时目录 + 关浏览器后重试删除
  const origClose = browser.close.bind(browser);
  browser.close = async function () {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); }
    }
  };

  const errors = [];
  const watch = p => {
    p.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); console.log("PAGEERROR:", e.message); });
    p.on("console", m => { if (m.type() === "error") { errors.push("CONSOLE: " + m.text()); console.log("CONSOLE:", m.text()); } });
    p.on("dialog", async d => { await d.accept(); });
  };

  /* ================= 1~5 节：完整链路（默认 URL,带口令）================= */
  console.log("\n== 1. 前置：选中「原地高抬腿跑」(burst) 并把目标压到 6 秒 ==");
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  watch(page);
  await stubPage(page);
  await enterMotionView(page, INDEX);

  const pre = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const i = [...sel.options].findIndex(o => o.textContent.includes("原地高抬腿跑"));
    sel.value = String(i); sel.dispatchEvent(new Event("change", { bubbles: true }));
    // 目标秒数压短（不改算法、不进文件），只为了少等一会儿；见文件头 D 条
    const targetSec = 6;
    motionChoice.target = targetSec;
    return {
      exId: motionChoice.exId, mode: motionChoice.profile.mode, target: targetSec,
      goalLabel: motionGoalFor(motionChoice).label,
      blockId: motionChoice.blockId, next: (motionNextChoice() || {}).exId,
      prepDisabled: motionPrepDisabled(), restSeconds: motionRestSeconds(),
      autoNextDisabled: motionAutoNextDisabled()
    };
  });
  console.log("SETUP", JSON.stringify(pre));

  check("载体是 burst 动作（不依赖计次精度，见文件头 A 条）",
    pre.exId === "highKnees" && pre.mode === "burst", `${pre.exId} mode=${pre.mode} 目标=${pre.goalLabel}`);
  check("今天序列里确实有下一项（否则考不出「自动进下一项」）", !!pre.next, `next=${pre.next} block=${pre.blockId}`);
  check("休息秒数来自家长设置（不是写死的常量）", pre.restSeconds > 0, `${pre.restSeconds} 秒`);
  check("走的是默认路径,没被测试捷径跳过口令", pre.prepDisabled === false, `prepDisabled=${pre.prepDisabled}`);
  check("自动推进默认是开的", pre.autoNextDisabled === false, `autoNextDisabled=${pre.autoNextDisabled}`);

  console.log("\n== 2. 开练 → 做满目标 → 自动完成 → 进休息 ==");
  await page.evaluate(() => document.getElementById("motionStartBtn").click());

  const samples = [];
  let layering = null, sawPrepDuringAdvance = false;
  for (let i = 0; i < 340; i++) {
    await sleep(250);
    const s = await page.evaluate(SAMPLE_JS);
    samples.push(s);

    // 自动进下一项的口令窗口：实测 .pose-prep(110) 是否真的盖过角色层(100)
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
          prepName: document.getElementById("posePrepName").textContent,
          centerTop: mid ? (mid.id || mid.className || mid.tagName) : null,
          centerHitsPrep: !!(prep && mid && (prep===mid || prep.contains(mid))),
          countTop: hitCnt ? (hitCnt.id || hitCnt.className || hitCnt.tagName) : null,
          countHitsPrep: !!(prep && hitCnt && (prep===hitCnt || prep.contains(hitCnt)))
        };
      })()`);
      sawPrepDuringAdvance = true;
      console.log("LAYERING@advance-prep", JSON.stringify(layering));
    }
    if (s.setDone && s.choice && s.choice !== pre.exId) break;
  }

  const last = samples[samples.length - 1] || {};
  const reached = samples.some(s => s.pct === 100 || !!s.setDone);
  const restSeq = samples.filter(s => s.choice === pre.exId && !!s.setDone).map(s => s.restLeft);
  const restTxt = [...new Set(samples.filter(s => s.choice === pre.exId && !!s.setDone).map(s => s.gpNum).filter(Boolean))];
  const apTxt = [...new Set(samples.filter(s => s.choice === pre.exId && !!s.setDone).map(s => s.apNum).filter(Boolean))];
  const duringRest = samples.filter(s => s.choice === pre.exId && !!s.setDone && typeof s.restLeft === "number" && s.restLeft > 0);
  const restDistinct = [...new Set(restSeq)].filter(v => v > 0);

  check("① 真的达标了（100% / setDone）", reached, `pct 峰值 ${Math.max(...samples.map(s => (s.pct == null ? -1 : s.pct)))} setDone=${last.setDone}`);
  check("① 达标后进入休息态", samples.some(s => s.resting === true), `resting 出现过 ${samples.filter(s => s.resting).length} 次采样`);
  check("① 休息从完整秒数起算", Math.max(...restSeq, 0) === pre.restSeconds, `起点 max=${Math.max(...restSeq, 0)} / 期望 ${pre.restSeconds}`);
  check("① 倒计时真的在刷新（不是冻在首值 —— 历史死锁就是这个症状）",
    restDistinct.length >= 3, `出现过的不同秒数 ${JSON.stringify(restDistinct)}`);
  check("① 倒计时单调不增", restSeq.every((v, i) => i === 0 || v <= restSeq[i - 1]), restSeq.join(","));
  /* 倒计时跑到末尾并归零 —— 但**不能在 restSeq 里找 0**：
   * `restLeft` 从 1 减到 0 的那一次 tick 会**立刻**调 motionAutoAdvance() 切到下一项，
   * 切完 motionRestLeft 被清 0 且 choice 已经不再是原项 → 本 filter 再也看不到 0。
   * 采样间隔 250ms，抓不到这个瞬时。所以正确的判据拆成两条：
   *   (a) restSeq 确实**走到了 1**（不是冻在 10 那种死锁症状）；
   *   (b) 切项之后 restLeft 已经是 0（见下面 ④ 的"休息态已收干净"）。
   * 两者合起来才等价于"倒计时跑完并推进"，任一缺失都说明链路断了。 */
  check("① 倒计时走到了末尾（不是冻在首值）", restSeq.length > 0 && Math.min(...restSeq) <= 1, `min=${Math.min(...restSeq)}`);
  check("① 倒计时不会变成负数（历史死锁的第二个症状）", !restSeq.some(v => v < 0), restSeq.filter(v => v < 0).join(",") || "无负数");

  console.log("\n== 3. 休息期间,孩子站在两三米外也看得见倒计时 ==");
  check("③ 休息期间全屏层（跟练角色）始终可见", duringRest.length > 0 && duringRest.every(s => s.avatarVisible), `${duringRest.length} 次采样`);
  check("③ 全屏层进度面板对孩子可见", duringRest.some(s => s.apVisibleToChild), `apVisibleToChild 出现过 ${duringRest.filter(s => s.apVisibleToChild).length} 次`);
  check("③ 全屏层文案就是「休息 N 秒」", apTxt.some(t => /休息\s*\d+\s*秒/.test(t)), JSON.stringify(apTxt));
  check("③ 页内小字也是「休息 N 秒」（双写,别只画一处）", restTxt.some(t => /休息\s*\d+\s*秒/.test(t)), JSON.stringify(restTxt));

  console.log("\n== 4. 休息结束 → 自动切到下一项并发车 ==");
  check("④ 已切换到下一项", last.choice === pre.next, `choice=${last.choice} / 期望 ${pre.next}`);
  check("④ 新项在跑（不是停在预览态）", last.running === true && last.previewing === false, `running=${last.running} previewing=${last.previewing}`);
  check("④ 休息态已收干净", last.resting === false && last.restLeft === 0, `resting=${last.resting} restLeft=${last.restLeft}`);

  console.log("\n== 5. 自动进下一项走的也是「带孩子口令」的路,且口令压过角色层 ==");
  check("⑤ 切项时确实亮了口令准备层", sawPrepDuringAdvance === true, JSON.stringify(layering && layering.prepName));
  check("⑤ 口令层 z-index 高于猫咪层（否则孩子只看到猫,看不到「准备开始进行…」）",
    !!layering && Number(layering.prepZ) > Number(layering.avatarZ), layering ? `prep=${layering.prepZ} vs avatar=${layering.avatarZ}` : "没采到");
  check("⑤ 画面中心的元素命中的是口令层", !!layering && layering.centerHitsPrep === true, layering ? layering.centerTop : "没采到");
  check("⑤ 倒计时数字也命中的是口令层", !!layering && layering.countHitsPrep === true, layering ? layering.countTop : "没采到");
  check("⑤ 口令文案是下一项的名字", !!layering && /^准备开始进行/.test(layering.prepName || ""), layering ? `"${layering.prepName}"` : "没采到");
  await page.close();

  /* ================= 6 节：两个便宜的分支（?motionPrep=0,直接驱动达标入口）=================
   * 这里不再等真实计数（那要几十秒）。产线每帧检查进度、够目标就调 motionAutoComplete()
   * （app.js:4073）;本节从页面作用域直接调同一个入口,只验"达标之后的分支走向",
   * 与"计数准不准"无关 —— 那件事由计次回归负责。 */
  console.log("\n== 6. 分支覆盖：末项 / 关闭自动推进 ==");

  // 6a. 末项：没有下一项了 → 记 all done,不进休息、不推进
  const lastPage = await browser.newPage();
  lastPage.setDefaultTimeout(25000);
  watch(lastPage);
  await stubPage(lastPage);
  await enterMotionView(lastPage, INDEX + "?motionPrep=0");
  const tie = await lastPage.evaluate(() => {
    const list = motionChoices();
    setMotionChoice(list.length - 1);
    if (motionEngine && motionChoice) motionEngine.setProfile(motionChoice.profile);
    document.getElementById("motionStartBtn").click();
    return { total: list.length, exId: motionChoice.exId, next: motionNextChoice() };
  });
  for (let i = 0; i < 25; i++) { if (await lastPage.evaluate(() => window.__motionDebug().running === true)) break; await sleep(200); }
  const tail = await lastPage.evaluate(() => {
    motionAutoComplete("test-tail");
    const d = window.__motionDebug();
    return { setDone: d.setDone, autoNextDone: d.autoNextDone, autoNextPending: d.autoNextPending, restLeft: d.restLeft, choice: motionChoice.exId };
  });
  await sleep(2500);
  const tail2 = await lastPage.evaluate(() => { const d = window.__motionDebug(); return { autoNextDone: d.autoNextDone, autoNextPending: d.autoNextPending, restLeft: d.restLeft, choice: motionChoice.exId }; });
  check("⑥ 最后一项达标后标记「整套练完」", tie.next === null && tail.autoNextDone === true, `next=${tie.next} autoNextDone=${tail.autoNextDone} (共 ${tie.total} 项)`);
  check("⑥ 末项不进入休息、不排队推进", tail.restLeft === 0 && tail.autoNextPending === false && tail2.restLeft === 0 && tail2.autoNextPending === false,
    `restLeft=${tail.restLeft}/${tail2.restLeft} pending=${tail.autoNextPending}/${tail2.autoNextPending}`);
  check("⑥ 末项达标后仍停在原项（不会越界切）", tail2.choice === tie.exId, `${tail2.choice} / ${tie.exId}`);
  await lastPage.close();

  // 6b. 家长把自动推进关掉（?motionAutoNext=0）→ 达标只报完成,不进休息不推进
  const offPage = await browser.newPage();
  offPage.setDefaultTimeout(25000);
  watch(offPage);
  await stubPage(offPage);
  await enterMotionView(offPage, INDEX + "?motionPrep=0&motionAutoNext=0");
  const offPre = await offPage.evaluate(() => {
    document.getElementById("motionStartBtn").click();
    return { disabled: motionAutoNextDisabled(), exId: motionChoice.exId, next: (motionNextChoice() || {}).exId };
  });
  for (let i = 0; i < 25; i++) { if (await offPage.evaluate(() => window.__motionDebug().running === true)) break; await sleep(200); }
  const offTail = await offPage.evaluate(() => {
    motionAutoComplete("test-off");
    const d = window.__motionDebug();
    return { setDone: d.setDone, restLeft: d.restLeft, autoNextPending: d.autoNextPending, choice: motionChoice.exId };
  });
  await sleep(2500);
  const offTail2 = await offPage.evaluate(() => { const d = window.__motionDebug(); return { resting: d.progress ? !!d.progress.resting : false, restLeft: d.restLeft, autoNextPending: d.autoNextPending, choice: motionChoice.exId }; });
  check("⑥ ?motionAutoNext=0 被识别", offPre.disabled === true, `disabled=${offPre.disabled} next=${offPre.next}`);
  check("⑥ 关掉后达标不进休息、不排队推进", offTail.restLeft === 0 && offTail.autoNextPending === false && offTail2.resting === false && offTail2.autoNextPending === false,
    `restLeft=${offTail.restLeft}/${offTail2.restLeft} pending=${offTail.autoNextPending}/${offTail2.autoNextPending}`);
  check("⑥ 关掉后停在原项", offTail2.choice === offPre.exId, `${offTail2.choice} / ${offPre.exId}`);
  await offPage.close();

  check("全程没有 JS 报错", errors.length === 0, errors.join(" | ") || "无");

  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }

  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(__dirname, "_accept-motion-autonext.json"), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2), "utf8");
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    failed.forEach(f => console.log("  FAIL:", f.name, f.detail || ""));
    process.exit(1);
  }
})().catch(e => {
  console.error("FATAL", e);
  try { fs.unlinkSync(Y4M); } catch (_) { }
  process.exit(1);
});
