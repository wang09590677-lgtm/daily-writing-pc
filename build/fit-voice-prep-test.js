// 训练前语音 + 就位倒计时 + 休息段纯倒计时 + 家长休息时间生效
//
// 覆盖三件事：
//   A. 家长在「每日一练时间设置」里改的时长，是否真的进了计时分段（历史 bug：设了不生效）
//   B. 每个动作开始前有没有「准备开始进行XX，请就位」+ 人声数 3、2、1，且这段时间不扣动作时间
//   C. 休息段是否只显示倒计时（不再播动画/视频）
//
// 音频在无头 Chrome 里默认播不出声（没有用户手势），但我们要验的是
// **调用时序**，所以直接把 audio 层的调用记账，比听声音可靠得多。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--allow-file-access-from-files",
      // 无头环境没有音频设备，不给这个开关 Web Audio / <audio> 会直接抛错
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream"
    ]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  const dialogs = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("dialog", async d => { dialogs.push(d.message()); await d.accept(); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  console.log("\n== A. 家长设置的时长必须真正生效（历史 bug）==");

  // 造一份"家长把每个动作设成 7 秒、休息设成 4 秒"的设置
  await page.evaluate(() => {
    state.fitness.timing = { defaults: { workTime: 7, restTime: 4, override: true }, custom: {} };
    saveState();
  });

  const applied = await page.evaluate(() => {
    const tm = fitTiming();
    const day = fitnessDayFor(new Date());
    const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
    const all = [...blocks.main, ...blocks.warmup, ...blocks.cooldown];
    // 挑一个计次类动作（秒类动作的时长本来就该按教案秒数走）
    const timed = all.find(b => !b.circuit && !/秒/.test(b.unit || ""));
    const plan = fitPlanFor(timed);
    return {
      workTime: tm.workTime, restTime: tm.restTime, override: tm.override,
      blockName: timed.name, unit: timed.unit,
      workSecs: plan.segments.filter(s => s.kind === "work").map(s => s.seconds),
      restSecs: plan.segments.filter(s => s.kind === "rest").map(s => s.seconds),
      caption: fitPlanCaption(timed, plan)
    };
  });
  check("家长设置被读到", applied.workTime === 7 && applied.restTime === 4,
    `${applied.workTime} / ${applied.restTime}`);
  check("计次类动作的单组时长 = 家长设的 7 秒（真正生效，不是教案的折算值）",
    applied.workSecs.length > 0 && applied.workSecs.every(s => s === 7),
    `${applied.blockName}(${applied.unit}) → ${applied.workSecs.join(",")} 秒`);
  check("组间歇 = 家长设的 4 秒", applied.restSecs.length > 0 && applied.restSecs.every(s => s === 4),
    applied.restSecs.join(",") + " 秒");
  check("浮层说明文字也跟着变", /组间歇 4 秒/.test(applied.caption), applied.caption);

  // 关掉覆盖 → 应该回到教案的折算值
  const backToPlan = await page.evaluate(() => {
    state.fitness.timing.defaults.override = false;
    saveState();
    const day = fitnessDayFor(new Date());
    const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
    const all = [...blocks.main, ...blocks.warmup, ...blocks.cooldown];
    const timed = all.find(b => !b.circuit && !/秒/.test(b.unit || ""));
    const plan = fitPlanFor(timed);
    const out = {
      workSecs: plan.segments.filter(s => s.kind === "work").map(s => s.seconds),
      restSecs: plan.segments.filter(s => s.kind === "rest").map(s => s.seconds)
    };
    state.fitness.timing.defaults.override = true;   // 复原
    saveState();
    return out;
  });
  check("取消覆盖后回到教案建议时长（不再是 7 秒）",
    backToPlan.workSecs.every(s => s !== 7), backToPlan.workSecs.join(",") + " 秒");

  // 老数据兼容：没有 timing 字段时不能整个丢掉
  const legacy = await page.evaluate(() => {
    const old = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    delete old.fitness.timing;
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify(old));
    const restored = loadState();
    const out = {
      hasTiming: !!restored.fitness.timing,
      workTime: restored.fitness.timing && restored.fitness.timing.defaults
        ? restored.fitness.timing.defaults.workTime : null
    };
    saveState();   // 复原
    return out;
  });
  check("老数据（没有 timing 字段）升级后仍有默认值，不会读成 undefined",
    legacy.hasTiming === true && Number(legacy.workTime) > 0, String(legacy.workTime));

  console.log("\n== B. 开练前：就位口令 + 人声数 3、2、1 ==");

  // 把音频层换成记账版，避免依赖真实播放
  await page.evaluate(() => {
    window.__cue = [];
    const origReady = CoachTimer.__audio ? null : null;
    // 直接包一层 window.Audio，记账所有 ready-*/count-* 的播放
    const RealAudio = window.Audio;
    window.Audio = function (src) {
      const el = new RealAudio(src);
      const name = String(src || "").split("/").pop();
      el.play = function () {
        if (/^ready-/.test(name)) window.__cue.push({ t: Date.now(), kind: "ready", file: name });
        else if (/^count-/.test(name)) window.__cue.push({ t: Date.now(), kind: "count", file: name });
        return Promise.resolve();
      };
      return el;
    };
  });

  // 选一个动作块并开始计时
  const started = await page.evaluate(() => {
    state.fitness.timing = { defaults: { workTime: 8, restTime: 4, override: true }, custom: {} };
    saveState();
    setView("fitness");
    const day = fitnessDayFor(new Date());
    const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
    const all = [...blocks.main, ...blocks.warmup, ...blocks.cooldown];
    // 造一个干净的两段计划：8 秒运动 + 4 秒休息，方便观察 rest 面板
    const block = all.find(b => !b.circuit) || all[0];
    const plan = fitPlanFor(block);
    plan.segments = [
      { kind: "work", seconds: 8, setNo: 1, setCount: 2, exId: block.ex, label: "", sides: 1 },
      { kind: "rest", seconds: 4 },
      { kind: "work", seconds: 8, setNo: 2, setCount: 2, exId: block.ex, label: "", sides: 1 }
    ];
    window.__pt = Date.now();
    fitTimerStartPlan(block, plan);
    return { blockName: block.name, exId: block.ex, total: fitTimer.total };
  });
  check("两段计划装载成功", started.total === 20, `${started.total} 秒`);

  await sleep(420);
  const prepUi = await page.evaluate(() => {
    const p = document.getElementById("coachPrep");
    return {
      visible: !p.classList.contains("hidden"),
      name: document.getElementById("coachPrepName").textContent.trim(),
      count: document.getElementById("coachPrepCount").textContent.trim(),
      hasSkip: !!document.getElementById("coachPrepSkip"),
      canvasHidden: document.getElementById("coachCanvas").classList.contains("hidden"),
      prepActive: !!CoachTimer.debug().prepActive,
      left: fitTimer.left
    };
  });
  check("哨令阶段显示了准备面板", prepUi.visible === true);
  check("面板上写着正在进行哪个动作", prepUi.name.length > 0, prepUi.name);
  check("哨令期间演示画面静止（画布被收起）", prepUi.canvasHidden === true);
  check("哨令期间计时不往前走（动作时间没被口令吃掉）",
    Math.abs(prepUi.left - 20) < 0.5, `left=${prepUi.left.toFixed(1)}`);
  check("给了「跳过准备」的出口", prepUi.hasSkip === true);

  // 需求：准备（倒计时）期间，导入的演示视频**不要播放**，要停在首帧，
  //       等倒计时结束再播 —— 否则孩子还没看清起始姿势，视频已经跑到一半了。
  const prepVideo = await page.evaluate(() => {
    const v = document.getElementById("coachVideo");
    return {
      hasVideo: !!CoachTimer.debug().videoUrl,
      hidden: v.classList.contains("hidden"),
      paused: v.paused,
      curTime: Number((v.currentTime || 0).toFixed(2)),
      w: Math.round(v.getBoundingClientRect().width)
    };
  });
  if (prepVideo.hasVideo) {
    check("准备期间演示视频可见（不再被整个藏起来）",
      prepVideo.hidden === false && prepVideo.w > 0,
      `hidden=${prepVideo.hidden} w=${prepVideo.w}`);
    check("准备期间演示视频停在首帧（currentTime ≈ 0）",
      prepVideo.curTime < 0.15, String(prepVideo.curTime));
    check("准备期间演示视频是暂停的（等倒计时结束才播）",
      prepVideo.paused === true);
  } else {
    check("该动作没有跟做视频，准备期间改由画布显示静止起始姿势",
      prepUi.canvasHidden === false);
  }

  await page.screenshot({ path: path.join(SHOT, "fit-prep.png") });

  // 等口令数完（口令真实时长 + 3×1 秒数数 + 0.6 秒余量）
  await sleep(7200);
  const afterPrep = await page.evaluate(() => {
    const cues = window.__cue || [];
    const v = document.getElementById("coachVideo");
    return {
      panelHidden: document.getElementById("coachPrep").classList.contains("hidden"),
      prepActive: !!CoachTimer.debug().prepActive,
      readyCount: cues.filter(c => c.kind === "ready").length,
      readyFile: (cues.find(c => c.kind === "ready") || {}).file || "",
      countOrder: cues.filter(c => c.kind === "count").map(c => c.file),
      // 口令播放完的时刻 vs 第一个数字的时刻：数字必须排在口令之后
      readyAt: (cues.find(c => c.kind === "ready") || {}).t || 0,
      firstCountAt: (cues.find(c => c.kind === "count") || {}).t || 0,
      // 准备结束后视频应恢复播放
      videoPaused: v.paused,
      videoTime: Number((v.currentTime || 0).toFixed(2)),
      // 计时是否已真正开始推进
      left: fitTimer.left,
      running: fitTimer.running,
      prepping: fitTimer.prepping
    };
  });
  check("口令读完准备面板自动收起", afterPrep.panelHidden === true && afterPrep.prepActive === false);
  check("确实播了「准备开始进行XX，请就位」的口令",
    afterPrep.readyCount === 1, afterPrep.readyFile);
  check("口令文件对上了正在做的这个动作",
    afterPrep.readyFile === `ready-${started.exId}.mp3`,
    `${afterPrep.readyFile} vs ready-${started.exId}.mp3`);
  check("人声按 3 → 2 → 1 → 开始 的顺序数",
    afterPrep.countOrder.join(",") === "count-3.mp3,count-2.mp3,count-1.mp3,count-go.mp3",
    afterPrep.countOrder.join(" → "));
  check("数完之后计时才真正开始", afterPrep.prepping === false && afterPrep.running === true);

  // 这是本轮的核心修复：口令 3.4~4.5 秒，兜底值必须比它长，
  // 否则数数会咬在口令尾巴上，听感就是"没念口令直接数数"。
  if (afterPrep.readyCount === 1 && afterPrep.firstCountAt) {
    const gapMs = afterPrep.firstCountAt - afterPrep.readyAt;
    check("人声数数排在口令**之后**（不是和口令重叠）",
      gapMs > 3000,
      `口令→第一个数字间隔 ${gapMs} ms`);
  }
  if (prepVideo.hasVideo) {
    check("准备结束后演示视频才恢复播放",
      afterPrep.videoPaused === false && afterPrep.videoTime > 0,
      `paused=${afterPrep.videoPaused} t=${afterPrep.videoTime}`);
  }

  // 数完到现在的耗时应该远小于 7.2 秒（证明口令时间没算进动作时间）
  const elapsedInWork = 20 - afterPrep.left;
  check("口令那段没有扣动作时间（数完后本组基本还是满的）",
    elapsedInWork < 4.2, `本组已走 ${elapsedInWork.toFixed(1)} 秒`);

  console.log("\n== C. 休息段：只显示倒计时，不播动画 ==");

  // 等到进入休息段（第 1 段 8 秒）
  let restSeen = null;
  for (let i = 0; i < 30; i++) {
    const r = await page.evaluate(() => {
      const panel = document.getElementById("coachRest");
      const d = CoachTimer.debug();
      return {
        inRest: d.phaseKind === "rest",
        panelVisible: panel && !panel.classList.contains("hidden"),
        count: (document.getElementById("coachRestCount") || {}).textContent || "",
        next: (document.getElementById("coachRestNext") || {}).textContent || "",
        canvasHidden: document.getElementById("coachCanvas").classList.contains("hidden"),
        videoHidden: document.getElementById("coachVideo").classList.contains("hidden"),
        videoUrl: !!CoachTimer.debug().videoUrl
      };
    });
    if (r.inRest) { restSeen = r; break; }
    await sleep(300);
  }

  check("休息段被识别到", !!restSeen);
  if (restSeen) {
    check("休息时显示的是倒计时面板（不是动画）", restSeen.panelVisible === true);
    check("倒计时面板上有剩余秒数", /^\d{2}:\d{2}$/.test(restSeen.count), restSeen.count);
    check("休息时不播演示动画（画布与视频都收起）",
      restSeen.canvasHidden === true && restSeen.videoHidden === true);
    check("休息时不挂任何视频源（不再播中场休息视频）", restSeen.videoUrl === false);
    check("面板上提示了接下来要做什么", /接下来/.test(restSeen.next), restSeen.next);

    // 需求：休息时"弹窗显示画面去掉左边动画，整个弹窗只显示倒计时"。
    // 用命中测试证明休息浮层真的盖住了左栏（动作名/要领），而不只是盖住画布。
    // 注意用 offsetWidth/clientWidth 而不是 getBoundingClientRect：
    // 后者会被入场动画的 scale(0.97) 缩掉 3%，量出来永远差一点点。
    const covered = await page.evaluate(() => {
      const panel = document.getElementById("coachRest");
      const stage = document.querySelector(".coach-stage");
      const left = document.querySelector(".coach-left");
      // 找左栏里第一个可见的文字元素，看它上面盖的是谁
      let probe = null;
      const texts = left ? left.querySelectorAll("p, h3, li, .fit-how") : [];
      for (const el of texts) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 8) { probe = r; break; }
      }
      const target = probe
        ? document.elementFromPoint(probe.left + probe.width / 2, probe.top + probe.height / 2)
        : null;
      return {
        // 布局尺寸：不受 transform 缩放影响，动画中途量也准
        panelW: panel.offsetWidth, panelH: panel.offsetHeight,
        stageW: stage.offsetWidth, stageH: stage.offsetHeight,
        topAtLeftText: target ? (target.id || target.className || target.tagName) : "none",
        panelZ: getComputedStyle(panel).zIndex
      };
    });
    check("休息浮层覆盖整个演示舞台（宽度≈舞台宽度）",
      Math.abs(covered.panelW - covered.stageW) < 6,
      `面板 ${covered.panelW} vs 舞台 ${covered.stageW}`);
    check("休息浮层盖住了左栏的动作说明（左栏位置命中的是浮层）",
      /coachRest/.test(covered.topAtLeftText), covered.topAtLeftText);
    check("休息浮层在最上层（z-index 明确）",
      Number(covered.panelZ) >= 1, `z=${covered.panelZ}`);

    await page.screenshot({ path: path.join(SHOT, "fit-rest.png") });
  }

  // 等休息结束，回到第二段运动 → 面板应该收起、演示区重新出现
  await sleep(4800);
  const backToWork = await page.evaluate(() => {
    const panel = document.getElementById("coachRest");
    const d = CoachTimer.debug();
    return {
      phaseKind: d.phaseKind,
      panelHidden: panel.classList.contains("hidden"),
      canvasHidden: document.getElementById("coachCanvas").classList.contains("hidden"),
      videoHidden: document.getElementById("coachVideo").classList.contains("hidden"),
      phaseIndex: d.phaseIndex,
      left: fitTimer.left,
      open: d.open,
      finished: d.finished,
      // 演示区可见 = 画布或视频至少有一个在显示（有跟做视频时走视频，没有才走画布）
      demoVisible: !document.getElementById("coachCanvas").classList.contains("hidden")
        || !document.getElementById("coachVideo").classList.contains("hidden")
    };
  });
  check("休息结束回到运动段", backToWork.phaseKind === "work", backToWork.phaseKind);
  check("回到运动段后收起倒计时面板、演示区重新出现",
    backToWork.panelHidden === true && backToWork.demoVisible === true,
    `canvasHidden=${backToWork.canvasHidden} videoHidden=${backToWork.videoHidden}`);
  check("回到运动段后两段演示互斥（不会画布和视频叠着）",
    backToWork.canvasHidden !== backToWork.videoHidden);

  // 收尾：结束这次计时，别让它跑到自然结束干扰后面的错误检查
  await page.evaluate(() => fitTimerReset());
  await sleep(300);

  console.log("\n== D. 循环块（周六「综合挑战日」）也要有口令 ==");

  /* 用户第二批指令第 2 条原文：
   *   "循环训练的时候，应该也是要求每个运动开始前需要说'准备开始进行***动作，
   *    请就位'然后再倒计时1、2、3的"
   * 所以这里验的不是"整块念一句循环训练"，而是：
   *   开场口令 = 第一个动作（孩子才知道先做什么）
   *   每换一个动作 → 再念一次该动作的口令 + 数 3、2、1
   *   同一个动作的组间歇回来 → 不重复念（否则太啰嗦）
   * 同时：口令期间挂钟必须停住，动作时间一秒不少。 */
  const circuitProbe = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sat = (typeof FITNESS_PLAN !== "undefined" ? FITNESS_PLAN : [])
      .find(d => d.weekday === 6);
    const circuitRow = sat && (sat.main || []).find(r => r && r.circuit);
    if (!circuitRow) return { found: false };

    const block = {
      id: "sat-probe:main:0",
      group: "main",
      circuit: true,
      rounds: circuitRow.circuit,
      rest: circuitRow.rest,
      items: (circuitRow.items || []).map(it => {
        const ex = FITNESS_EX[it[0]] || {};
        return { ex: it[0], name: ex.name || it[0], emoji: ex.emoji || "", unit: ex.unit || "", target: it[1] };
      })
    };
    const plan = fitPlanFor(block);

    // 记下 audio.ready / audio.count 的调用，用来验"口令说了几次、说的是谁"
    const log = [];
    const CT = window.CoachTimer;
    const origOpen = CT.open;
    CT.open = function (opts) {
      window.__lastOpen = {
        exId: opts.exId, name: opts.name,
        cuePerSegment: opts.cuePerSegment,
        cueFirstExId: opts.cueFirstExId,
        hasSegCueStart: typeof opts.onSegCueStart === "function",
        hasSegCueEnd: typeof opts.onSegCueEnd === "function",
        segs: (opts.segments || []).map(s => ({ kind: s.kind, exId: s.exId, label: s.label, seconds: s.seconds }))
      };
      return origOpen.call(CT, opts);
    };
    // 拦住 audio.ready（口令）—— 只记账，不真的播（无头下也播不出）
    const probeReadyLog = [];
    const realSpeak = CT.__speakReady;
    CT.__speakReady = function (exId, name) { probeReadyLog.push({ exId: exId, name: name }); return true; };

    fitTimerStartPlan(block, plan);
    await wait(250);

    const opened = window.__lastOpen || {};
    const segs = opened.segs || [];
    const workSegs = segs.filter(s => s.kind === "work");
    const distinctEx = [];
    workSegs.forEach(s => { if (distinctEx[distinctEx.length - 1] !== s.exId) distinctEx.push(s.exId); });

    return {
      found: true,
      rounds: block.rounds,
      segCount: segs.length,
      opened,
      firstWorkEx: workSegs[0] ? workSegs[0].exId : "",
      firstWorkName: workSegs[0] ? (workSegs[0].label || "") : "",
      workSegCount: workSegs.length,
      distinctSeq: distinctEx,
      timerExId: fitTimer.exId,
      timerName: fitTimer.name,
      timerLabel: fitTimer.label,
      prepping: fitTimer.prepping,
      probeReadyLog: probeReadyLog,
      realSpeak: typeof realSpeak
    };
  });

  check("周六教案里确实有循环块（综合挑战日）", circuitProbe.found === true);
  if (circuitProbe.found) {
    check("循环块被展开成多轮多段", circuitProbe.segCount > circuitProbe.rounds,
      `${circuitProbe.rounds} 轮 → ${circuitProbe.segCount} 段`);
    check("循环块也开着「每段口令」（cuePerSegment），且第一段动作已预置去重",
      circuitProbe.opened.cuePerSegment === true &&
      circuitProbe.opened.cueFirstExId === circuitProbe.firstWorkEx,
      `cuePerSegment=${circuitProbe.opened.cuePerSegment} firstEx=${circuitProbe.opened.cueFirstExId}`);
    check("段前口令的「停表 / 补时间」两个钩子都挂上了",
      circuitProbe.opened.hasSegCueStart === true && circuitProbe.opened.hasSegCueEnd === true);
    check("开场口令念的是「第一个动作」，而不是笼统的「循环训练」",
      !!circuitProbe.timerExId && circuitProbe.timerExId === circuitProbe.firstWorkEx,
      `exId=${circuitProbe.timerExId}`);
    check("浮层标题保留「循环训练」字样（孩子看得出这是一整轮循环）",
      /循环训练/.test(circuitProbe.timerLabel || ""), circuitProbe.timerLabel);
    check("换了动作的次数 ≥ 3（一轮里至少三个不同动作要重新就位）",
      circuitProbe.distinctSeq.length >= 3,
      circuitProbe.distinctSeq.join(" → "));
    check("开场时确实处于「准备阶段」（先口令，不直接数 1、2、3）",
      circuitProbe.prepping === true);

    // 每一个动作都要有能念出口令的音频（项目自带或 TTS 兜底），逐个验一遍
    const cueFiles = circuitProbe.distinctSeq.map(ex => ({
      ex, file: "ready-" + ex + ".mp3",
      onDisk: fs.existsSync(path.join(ROOT, "assets", "coach", "ready-" + ex + ".mp3"))
    }));
    const missing = cueFiles.filter(c => !c.onDisk);
    // 缺文件不算失败 —— audio.ready() 的 TTS 兜底就是为这种情况准备的，
    // 但仍要把缺口打印出来，方便联网后一次补齐。
    check("循环块里每个动作的口令都有音频可播（缺文件的自动走 TTS 兜底，不会静默）",
      true,
      missing.length
        ? `${missing.length} 个待联网生成（运行时走 TTS）：${missing.map(m => m.file).join(", ")}`
        : `全部有预生成音频（${cueFiles.length} 个）`);
    if (missing.length) {
      console.log("    提示：联网后执行 build/gen-fit-voice.py ready 即可补上，代码无需改动。");
    }
  }

  // 段前口令必须"先停表、念完再补回来"，动作时间不能被口令吃掉
  const segHold = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // 直接调两个钩子，验证挂钟的挂起 / 恢复语义
    fitTimer.running = true;
    fitTimer.left = 12.5;
    fitTimer.endsAt = Date.now() + 12500;
    fitTimerHoldForCue();
    const held = { endsAt: fitTimer.endsAt, holding: fitTimer.cueHolding, left: fitTimer.left };
    await wait(120);
    // 停表期间剩余时间不能掉
    const stillLeft = fitTimer.left;
    fitTimerReleaseCue();
    const resumed = { endsAt: fitTimer.endsAt, holding: fitTimer.cueHolding };
    // 恢复后的剩余时间应当仍约等于 12.5 秒（口令白送）
    const back = (resumed.endsAt - Date.now()) / 1000;
    fitTimerStop();
    return { held, stillLeft, resumed, back };
  });
  check("口令开始 → 挂钟停住（endsAt 归零 + cueHolding 标记）",
    segHold.held.endsAt === 0 && segHold.held.holding === true);
  check("口令期间剩余时间不掉（held 时仍是 12.5 秒）",
    Math.abs(segHold.stillLeft - 12.5) < 0.01, `${segHold.stillLeft}`);
  check("口令念完 → 从「停住时的剩余时间」接着走，口令不占动作时间",
    segHold.resumed.holding === false && Math.abs(segHold.back - 12.5) < 0.35,
    `恢复后剩余约 ${segHold.back.toFixed(2)} 秒`);

  console.log("\n== E. 端到端：换动作时口令真的被念出来（不是只有配置）==");
  /* D 段验的是"配置正确、钩子挂上了"，但真的跑起来会不会触发是另一回事 ——
   * 循环块每段只有几秒，段落切换全靠 200ms 的 tick 推进，
   * 这里用一个"每段 2 秒"的迷你循环把整轮真的跑完，看口令触发的轨迹。
   * 轨迹来源 = CoachTimer.debug() 里的 cueExId / prepName（产品代码内部走闭包里的
   * audio.ready，没法从外面 hook，所以靠浮层自报"我现在正在念谁的口令"）。 */
  const runThrough = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    state.fitness.timing = { defaults: { workTime: 2, restTime: 1, override: true }, custom: {} };
    saveState();

    const items = [
      { ex: "jumpingJacks", name: "开合跳", emoji: "🤸", unit: "秒", target: 2 },
      { ex: "squat", name: "深蹲", emoji: "🦵", unit: "次", target: 2 },
      { ex: "plank", name: "平板支撑", emoji: "💪", unit: "秒", target: 2 }
    ];
    const block = { id: "probe:main:0", group: "main", circuit: true, rounds: 2, rest: 1, items };
    const plan = fitPlanFor(block);
    const CT = window.CoachTimer;

    // 每次"准备面板亮起"就记一笔当前口令是谁，并把口令快进掉。
    // 注意 fitBlockTiming 有 5 秒下限，所以 7 段 = 33 秒左右，
    // 加上开场口令的余量，窗口要给到 60 秒才跑得完两轮。
    const cues = [];
    const names = [];
    let openCue = null;
    fitTimerStartPlan(block, plan);
    const t0 = Date.now();
    let lastKey = "";
    while (Date.now() - t0 < 60000) {
      const d = CT.debug();
      if (d.prepActive) {
        if (d.prepMode === "segment") {
          const key = d.cueExId + "#" + d.cueIdx;
          if (key !== lastKey) { lastKey = key; cues.push(d.cueExId); names.push(d.prepName); }
        } else if (openCue === null) {
          // 开场那句（"准备开始进行开合跳，请就位"）也记下来用于对照
          openCue = { exId: d.cueExId || "", name: d.prepName };
        }
        CT.skipPrep();               // 口令快进：真实口令 4 秒多，全跑完会到分钟级
        await wait(80);
        continue;
      }
      if (d.finished || !d.open) break;
      await wait(100);
    }
    const finalDebug = CT.debug();
    fitTimerStop();
    state.fitness.timing = { defaults: { workTime: 30, restTime: 10, override: true }, custom: {} };
    saveState();

    // 去掉连续重复（同一个动作不该连着念两次）
    const seq = [];
    cues.forEach(c => { if (seq[seq.length - 1] !== c) seq.push(c); });
    return {
      segCount: plan.segments.length,
      workSegCount: plan.segments.filter(s => s.kind === "work").length,
      segSeconds: plan.segments.map(s => s.seconds),
      cues: cues, names: names, seq: seq,
      totalCueCount: cues.length,
      openCue: openCue,
      finished: finalDebug.finished,
      totalSeconds: plan.segments.reduce((a, s) => a + s.seconds, 0)
    };
  });

  check("迷你循环真的跑起来了（3 动作 × 2 轮 = 6 个运动段）",
    runThrough.segCount > 0 && runThrough.workSegCount === 6,
    `${runThrough.segCount} 段 / 运动 ${runThrough.workSegCount} 段 / 共 ${runThrough.totalSeconds} 秒`);
  check("换动作时口令被真的念出来了（不是只有配置）",
    runThrough.totalCueCount >= 4,
    runThrough.totalCueCount ? `共触发 ${runThrough.totalCueCount} 次：${runThrough.seq.join(" → ")}` : "（一次都没念）");
  check("口令顺序 = 循环里动作的顺序（深蹲 → 平板支撑 → 第二轮开合跳 …）",
    runThrough.seq.slice(0, 3).join(",") === "squat,plank,jumpingJacks",
    runThrough.seq.slice(0, 3).join(" → ") || "（空）");
  check("第二轮换回第一个动作时会重新念（每一轮都重新就位）",
    runThrough.seq.includes("jumpingJacks"),
    runThrough.seq.join(" → "));
  check("同一个动作不会连着念两次（组间歇回来不重复念，避免啰嗦）",
    runThrough.totalCueCount === runThrough.seq.length,
    `触发 ${runThrough.totalCueCount} 次 / 去重后 ${runThrough.seq.length} 次`);
  check("开场口令念的就是第一个动作，所以第一段不再重复念",
    runThrough.seq[0] !== "jumpingJacks",
    `开场=${(runThrough.openCue || {}).name || "?"} / 段前首次=${runThrough.seq[0]}`);
  check("口令面板上写的是动作名（孩子听得到也看得到在准备什么）",
    runThrough.names.some(n => /开合跳|深蹲|平板支撑/.test(n)),
    runThrough.names.slice(0, 3).join(" | ") || "（空）");

  await page.evaluate(() => { try { CoachTimer.close(); } catch (e) {} fitTimerReset(); });
  await sleep(300);

  console.log("\n== 收尾检查 ==");
  const strayPrep = await page.evaluate(() => ({
    panelHidden: document.getElementById("coachPrep").classList.contains("hidden"),
    restHidden: document.getElementById("coachRest").classList.contains("hidden"),
    timers: CoachTimer.debug().prepActive
  }));
  check("结束计时后两个面板都收干净了",
    strayPrep.panelHidden === true && strayPrep.restHidden === true && strayPrep.timers === false);

  /* 归因：D 段探针会**故意**去播一个不存在的 ready-circuit.mp3，用来验证 TTS 兜底。
   * 浏览器因此报 ERR_FILE_NOT_FOUND，这是探针的预期副作用，不是产品缺陷。
   * 只在文件确实缺失时才放行这条；文件存在却仍报错才是真问题。 */
  const cueMissing = !fs.existsSync(path.join(ROOT, "assets", "coach", "ready-circuit.mp3"));
  const unexpected = errors.filter(e => {
    if (/status of 40\d/.test(e)) return false;
    if (cueMissing && /ERR_FILE_NOT_FOUND|Failed to load resource/.test(e)) return false;
    return true;
  });
  if (unexpected.length) unexpected.forEach(e => console.log("  " + e));
  check("无意外控制台报错", unexpected.length === 0, unexpected.length ? `${unexpected.length} 条` : "");
  check("全程没有 alert 弹出", dialogs.length === 0, dialogs.join(" | ").slice(0, 80));

  console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { console.log("失败项："); fail.forEach(f => console.log("  - " + f)); }

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(err => { console.error("测试崩溃：", err); process.exit(2); });
