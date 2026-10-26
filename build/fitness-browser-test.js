// 真实浏览器验证：模块选择 / 体能训练 / 计时器 / 奖牌结算 / 家长规则
// 把浏览器日期冻结到 2026-09-28（周一 = 心肺耐力日），才能测到完整训练流程。
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
    // 自动播放策略要放开，否则 <audio>.play() 会被拦，测不到滴答声
    args: ["--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("dialog", async d => { await d.accept(); });

  // 冻结日期到 2026-09-28 周一（不在这里清 localStorage：reload 时这个脚本会重跑）
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    const FIXED = new RealDate(2026, 8, 28, 10, 30, 0).getTime();
    class MockDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
      static now() { return FIXED; }
    }
    window.Date = MockDate;
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  // 清一次历史数据，拿到干净的"第一次打开"状态
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  /* ---------------- 1. 模块选择页 ---------------- */
  console.log("\n== 1. 模块选择页 ==");
  const chooser = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".chooser-card")];
    return {
      chooserVisible: !document.getElementById("moduleChooser").classList.contains("hidden"),
      shellHidden: document.getElementById("appShell").classList.contains("hidden"),
      count: cards.length,
      modules: cards.map(c => c.dataset.module),
      titles: cards.map(c => c.querySelector("h2").textContent.trim()),
      tags: cards.map(c => c.querySelector(".chooser-tag").textContent.trim()),
      imgs: cards.map(c => {
        const img = c.querySelector("img");
        return { src: img.getAttribute("src"), ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth, alt: img.getAttribute("alt") };
      })
    };
  });
  check("首次打开显示模块选择页", chooser.chooserVisible && chooser.shellHidden);
  check("两张模块卡片（写作 / 体能训练）", chooser.count === 2 && chooser.modules.join(",") === "write,fitness", chooser.titles.join(" | "));
  check("两张猫咪配图都已加载", chooser.imgs.every(i => i.ok), chooser.imgs.map(i => `${i.src} ${i.w}px`).join(" ; "));
  check("配图有 alt 描述", chooser.imgs.every(i => i.alt && i.alt.length > 4), chooser.imgs.map(i => i.alt).join(" / "));
  await page.screenshot({ path: path.join(SHOT, "fit-01-chooser.png") });

  /* ---------------- 2. 进入体能训练 ---------------- */
  console.log("\n== 2. 进入体能训练模块 ==");
  await page.evaluate(() => document.querySelector(".chooser-card[data-module='fitness']").click());
  await sleep(600);
  const fit = await page.evaluate(() => {
    const navs = [...document.querySelectorAll(".nav-item")];
    return {
      chooserHidden: document.getElementById("moduleChooser").classList.contains("hidden"),
      shellVisible: !document.getElementById("appShell").classList.contains("hidden"),
      brand: document.getElementById("brandTitle").textContent.trim(),
      brandSub: document.getElementById("brandSub").textContent.trim(),
      visibleNav: navs.filter(n => !n.classList.contains("hidden")).map(n => n.dataset.view),
      hiddenNav: navs.filter(n => n.classList.contains("hidden")).map(n => n.dataset.view),
      activeView: [...document.querySelectorAll(".view")].filter(v => v.classList.contains("active")).map(v => v.id),
      bodyClass: document.body.classList.contains("module-fitness"),
      title: document.getElementById("fitDayTitle").textContent.trim(),
      phase: document.getElementById("fitPhaseLabel").textContent.trim(),
      why: document.getElementById("fitDayWhy").textContent.trim().slice(0, 40)
    };
  });
  check("选择后进入应用外壳", fit.chooserHidden && fit.shellVisible);
  check("侧边栏标题切换为体能", /每日一练/.test(fit.brand), `${fit.brand} · ${fit.brandSub}`);
  check("写作导航已隐藏、体能导航显示", fit.hiddenNav.length === 9 && fit.visibleNav.includes("fitnessToday"), `隐藏 ${fit.hiddenNav.length} 项 · 显示 ${fit.visibleNav.join(",")}`);
  check("默认落在「今日训练」", fit.activeView.includes("fitnessToday"), fit.activeView.join(","));
  check("主题日按星期自动匹配（周一=心肺耐力日）", /心肺耐力日/.test(fit.title), fit.title);
  check("显示训练阶段", /第 1 周/.test(fit.phase), fit.phase);
  check("显示「为什么练这个」", fit.why.length > 10, `「${fit.why}…」`);

  /* ---------------- 3. 训练清单 ---------------- */
  console.log("\n== 3. 训练清单 ==");
  const plan = await page.evaluate(() => ({
    warmup: document.querySelectorAll("#fitWarmup .fit-block").length,
    main: document.querySelectorAll("#fitMain .fit-block").length,
    cooldown: document.querySelectorAll("#fitCooldown .fit-block").length,
    mainNames: [...document.querySelectorAll("#fitMain .fit-block-name")].map(e => e.textContent.trim()),
    firstDose: document.querySelector("#fitMain .fit-dose") ? document.querySelector("#fitMain .fit-dose").textContent.trim() : "",
    hasCheck: document.querySelectorAll(".fit-check").length,
    hasTimerBtn: document.querySelectorAll("[data-action='time-block']").length,
    disabledTimers: document.querySelectorAll("[data-action='time-block']:disabled").length,
    hasHow: document.querySelectorAll(".fit-how").length,
    ringText: document.querySelector("#fitRing .donut-center") ? document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "") : ""
  }));
  check("热身 / 主训练 / 放松 三组都已渲染", plan.warmup > 0 && plan.main > 0 && plan.cooldown > 0, `${plan.warmup}/${plan.main}/${plan.cooldown}`);
  check("主训练含波比跳等高强度动作", plan.mainNames.some(n => /波比跳/.test(n)), plan.mainNames.join("、"));
  check("每个动作块有组次剂量", /\d+\s*组\s*×/.test(plan.firstDose), plan.firstDose);
  check("每个动作块有要领说明", plan.hasHow === plan.hasCheck, `${plan.hasHow}/${plan.hasCheck}`);
  check("每个动作块可勾选 + 可计时", plan.hasCheck > 0 && plan.hasTimerBtn === plan.hasCheck, `${plan.hasCheck} 块`);
  check("没勾选之前所有「计时」都是禁用的",
    plan.disabledTimers === plan.hasTimerBtn, `${plan.disabledTimers}/${plan.hasTimerBtn} 个禁用`);
  check("完成度环形从 0% 开始", /^0%/.test(plan.ringText), plan.ringText);
  await page.screenshot({ path: path.join(SHOT, "fit-02-today.png") });

  /* ---------------- 4. 勾选（选中）后才能计时 ---------------- */
  console.log("\n== 4. 勾选选中 → 才能计时 ==");
  const before = await page.evaluate(() => ({
    picked: document.querySelectorAll(".fit-block.is-picked").length,
    done: document.querySelectorAll(".fit-block.is-done").length,
    ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "")
  }));
  check("初始时没有任何块被选中或完成", before.picked === 0 && before.done === 0 && /^0%/.test(before.ring), `完成度 ${before.ring}`);

  const blocked = await page.evaluate(() => {
    const btn = document.querySelector("#fitMain [data-action='time-block']");
    btn.click();                       // disabled 的按钮 click 不会派发事件
    return {
      disabled: btn.disabled,
      title: btn.getAttribute("title") || "",
      overlay: !document.getElementById("coachTimer").classList.contains("hidden"),
      running: fitTimer.running
    };
  });
  check("未勾选时点「计时」不会开始（按钮禁用 + 有提示）",
    blocked.disabled && /先勾选/.test(blocked.title) && !blocked.overlay && !blocked.running,
    `disabled=${blocked.disabled} title「${blocked.title}」`);

  const bypass = await page.evaluate(() => {
    const id = document.querySelector("#fitMain .fit-block").dataset.blockId;
    window.timeFitBlock(id);           // 绕过按钮直接调，也应该被挡下
    return {
      running: fitTimer.running,
      overlay: !document.getElementById("coachTimer").classList.contains("hidden"),
      toast: document.getElementById("toast") ? document.getElementById("toast").textContent.trim() : ""
    };
  });
  check("绕过按钮直接调也会被挡下", !bypass.running && !bypass.overlay, bypass.toast);

  const afterOne = await page.evaluate(() => {
    const box = document.querySelector("#fitWarmup .fit-check");
    box.click();
    const block = box.closest(".fit-block");
    const stored = JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness;
    return {
      picked: document.querySelectorAll(".fit-block.is-picked").length,
      done: document.querySelectorAll(".fit-block.is-done").length,
      ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, ""),
      blockPicked: block.classList.contains("is-picked"),
      timerDisabled: block.querySelector(".fit-timer-btn").disabled,
      checked: box.getAttribute("aria-pressed"),
      pickedSaved: (stored.picked["2026-09-28"] || []).length,
      doneSaved: (stored.done["2026-09-28"] || []).length
    };
  });
  check("勾选后这一块变成「已选中」、计时按钮解锁",
    afterOne.picked === 1 && afterOne.blockPicked && afterOne.timerDisabled === false && afterOne.checked === "true",
    `已选中 ${afterOne.picked} 块，计时按钮 disabled=${afterOne.timerDisabled}`);
  check("光勾选还不算完成（完成度仍是 0）",
    afterOne.done === 0 && /^0%/.test(afterOne.ring) && afterOne.doneSaved === 0 && afterOne.pickedSaved === 1,
    `完成度 ${afterOne.ring} · 已选中 ${afterOne.pickedSaved} / 已完成 ${afterOne.doneSaved}`);
  await page.screenshot({ path: path.join(SHOT, "fit-02b-picked.png") });

  // 刷新后勾选状态要还在
  await page.reload({ waitUntil: "load" });
  await sleep(700);
  const afterReload = await page.evaluate(() => ({
    picked: document.querySelectorAll(".fit-block.is-picked").length,
    done: document.querySelectorAll(".fit-block.is-done").length,
    timerDisabled: document.querySelector("#fitWarmup .fit-timer-btn").disabled,
    ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "")
  }));
  check("刷新后勾选状态保留、计时按钮仍是解锁的",
    afterReload.picked === 1 && afterReload.done === 0 && afterReload.timerDisabled === false,
    `已选中 ${afterReload.picked} · 完成度 ${afterReload.ring}`);

  /* ---------------- 5. 点「计时」直接开始 ---------------- */
  console.log("\n== 5. 点动作块「计时」直接开始 ==");
  const sidebar = await page.evaluate(() => {
    const card = document.querySelector(".fit-timer-card");
    return {
      exists: !!card,
      hidden: card ? card.classList.contains("hidden") : false,
      display: card ? getComputedStyle(card).display : "",
      aria: card ? card.getAttribute("aria-hidden") : ""
    };
  });
  check("侧边「训练计时器」已隐藏（不再需要它了）",
    sidebar.exists && sidebar.hidden && sidebar.display === "none",
    `display=${sidebar.display} aria-hidden=${sidebar.aria}`);

  // 热身第一块（关节绕环 1 组 × 30 秒）：点一次「计时」就该直接跑起来
  const oneShot = await page.evaluate(() => {
    const btn = document.querySelector("#fitWarmup [data-action='time-block']");
    const card = btn.closest(".fit-block");
    btn.click();
    const d = window.CoachTimer.debug();
    return {
      name: card.querySelector(".fit-block-name").textContent.trim(),
      overlay: !document.getElementById("coachTimer").classList.contains("hidden"),
      running: fitTimer.running,
      paused: fitTimer.paused,
      count: document.getElementById("coachCount").textContent.trim(),
      total: d.total, phases: d.phaseCount, kind: d.phaseKind,
      pauseLabel: document.getElementById("coachPauseBtn").textContent.trim(),
      stripHidden: getComputedStyle(document.getElementById("coachPhases")).display === "none",
      display: document.getElementById("fitTimerDisplay").textContent.trim()
    };
  });
  check("点「计时」立即弹出教练浮层并开跑（不用再点继续）",
    oneShot.overlay && oneShot.running && !oneShot.paused && oneShot.pauseLabel === "暂停",
    `${oneShot.name} · running=${oneShot.running} 按钮「${oneShot.pauseLabel}」`);
  check("单组动作就是一段倒计时",
    oneShot.phases === 1 && oneShot.kind === "work" && oneShot.total === 30,
    `${oneShot.phases} 段 / 共 ${oneShot.total} 秒 / 当前 ${oneShot.count}`);
  check("只有一段时不显示阶段条（免得跟总进度条重复）", oneShot.stripHidden);

  const highlight = await page.evaluate(() => {
    const el = document.querySelector(".fit-block.is-timing");
    const btn = el ? el.querySelector(".fit-timer-btn") : null;
    return {
      count: document.querySelectorAll(".fit-block.is-timing").length,
      name: el ? el.querySelector(".fit-block-name").textContent.trim() : "",
      btn: btn ? btn.textContent.trim() : ""
    };
  });
  check("清单上高亮出正在计时的项目",
    highlight.count === 1 && /关节绕环/.test(highlight.name) && /计时中/.test(highlight.btn),
    `${highlight.name} · 按钮「${highlight.btn}」`);

  await page.screenshot({ path: path.join(SHOT, "fit-03-timer.png") });
  await page.evaluate(() => window.fitTimerReset());
  await sleep(200);
  check("归零后高亮随之撤掉",
    (await page.evaluate(() => document.querySelectorAll(".fit-block.is-timing").length)) === 0);

  /* ---------------- 5b. 多组自动串组间歇 ---------------- */
  console.log("\n== 5b. 多组自动串组间歇（原地小步跑 3 组 × 30 秒 · 间歇 30 秒）==");
  const plan5b = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".fit-block")].find(el => /原地小步跑/.test(el.textContent));
    const box = card.querySelector(".fit-check");
    if (box.getAttribute("aria-pressed") === "false") box.click();   // 先勾选，才能计时
    card.querySelector("[data-action='time-block']").click();
    // 跳过「就位口令 + 数 3、2、1」：本用例只验分段计时，准备阶段另有用例专门验
    window.CoachTimer.skipPrep();
    // 真实循环停掉，改由测试手动推进浮层，好在几毫秒里看完 150 秒
    if (fitTimer.handle) { clearInterval(fitTimer.handle); fitTimer.handle = null; }
    fitTimer.running = false;
    const d = window.CoachTimer.debug();
    return {
      dose: card.querySelector(".fit-dose").textContent.trim(),
      total: d.total,
      segs: d.segments,
      phases: d.phaseCount,
      strip: {
        all: document.querySelectorAll("#coachPhases .ph").length,
        work: document.querySelectorAll("#coachPhases .ph.work").length,
        rest: document.querySelectorAll("#coachPhases .ph.rest").length
      },
      kind: d.phaseKind, setNo: d.setNo, setCount: d.setCount,
      count: document.getElementById("coachCount").textContent.trim(),
      label: document.getElementById("coachPhaseLabel").textContent.trim(),
      setline: document.getElementById("coachSetLine").textContent.trim(),
      caption: document.getElementById("coachCaption").textContent.trim(),
      tag: document.getElementById("coachTag").textContent.trim(),
      restCls: document.getElementById("coachTimer").classList.contains("is-rest"),
      animKey: d.animKey, view: d.view,
      bg: getComputedStyle(document.querySelector(".coach-stage")).backgroundColor,
      tick: d.audio.tick && !d.audio.tick.paused,
      audioRaw: d.audio
    };
  });
  // 时长以家长设置为准（timing.defaults，本用例是 30 秒运动 / 10 秒休息），
  // 教案里写的 30 秒组间歇会被覆盖——这正是"家长设了要生效"的验收点。
  const expectTiming = await page.evaluate(() => window.fitTiming());
  check(`多组动作点「计时」= 全部组 + 组间歇（3 组 × ${expectTiming.workTime} 秒 + 2 段 ${expectTiming.restTime} 秒）`,
    plan5b.total === expectTiming.workTime * 3 + expectTiming.restTime * 2 &&
    plan5b.segs.length === 5 &&
    plan5b.segs.map(s => s.kind).join(",") === "work,rest,work,rest,work" &&
    plan5b.segs.filter(s => s.kind === "work").every(s => s.seconds === expectTiming.workTime) &&
    plan5b.segs.filter(s => s.kind === "rest").every(s => s.seconds === expectTiming.restTime),
    `${plan5b.dose} → ${plan5b.segs.map(s => s.kind + s.seconds).join(" + ")} = ${plan5b.total} 秒`);
  check("卡片上的剂量文案和实际跑的时间一致（不会再出现「写 30 秒实际 10 秒」）",
    plan5b.dose.indexOf(`组间歇 ${expectTiming.restTime} 秒`) >= 0, plan5b.dose);
  check("阶段条画出 3 段运动 + 2 段休息",
    plan5b.strip.work === 3 && plan5b.strip.rest === 2 && plan5b.strip.all === 5,
    `${plan5b.strip.work} 段运动 / ${plan5b.strip.rest} 段休息`);
  check("从第 1 组 30 秒开始倒计时",
    plan5b.kind === "work" && plan5b.setNo === 1 && plan5b.setCount === 3 &&
    plan5b.count === "00:30" && !plan5b.restCls && /本组剩余/.test(plan5b.label),
    `第 ${plan5b.setNo}/${plan5b.setCount} 组 · ${plan5b.count} · 「${plan5b.label}」`);
  check("浮层标出这一块的剂量与配速", /3\s*组/.test(plan5b.caption) && /30\s*秒/.test(plan5b.caption), plan5b.caption);
  check("另外显示「全程还剩」总时间", /全程还剩/.test(plan5b.setline), plan5b.setline);

  // 等入场动画（coachPop，0.955 → 1）跑完再量尺寸，否则量到的是动画中间态
  await sleep(700);
  const geo = await page.evaluate(() => {
    const el = document.getElementById("coachTimer");
    const rect = el.querySelector(".coach-stage").getBoundingClientRect();
    const left = el.querySelector(".coach-left").getBoundingClientRect();
    const right = el.querySelector(".coach-right").getBoundingClientRect();
    const cv = document.getElementById("coachCanvas");
    const c = document.createElement("canvas");
    c.width = cv.width; c.height = cv.height;
    const g = c.getContext("2d");
    g.drawImage(cv, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4 * 31) if (px[i] > 12) painted++;
    // 有跟做视频的项目（含项目自带）现在由视频接管左半演示区，画布会被隐藏。
    // 所以"演示有没有出来"要看两条路：画布画出来了，或者视频在放。
    const vid = document.getElementById("coachVideo");
    const videoShown = !vid.classList.contains("hidden") && !!vid.getAttribute("src");
    return {
      stageW: Math.round(rect.width), stageH: Math.round(rect.height),
      vw: window.innerWidth, vh: window.innerHeight,
      leftCx: left.left + left.width / 2, rightCx: right.left + right.width / 2,
      stageCx: rect.left + rect.width / 2,
      cols: getComputedStyle(el.querySelector(".coach-stage")).gridTemplateColumns,
      painted, videoShown, videoSrc: vid.getAttribute("src") || "",
      canvasHidden: document.getElementById("coachCanvas").classList.contains("hidden")
    };
  });
  const wRatio = geo.stageW / geo.vw, hRatio = geo.stageH / geo.vh;
  check("浮层仍占屏幕 80%", Math.abs(wRatio - 0.8) < 0.02 && Math.abs(hRatio - 0.8) < 0.02,
    `${geo.stageW}×${geo.stageH} / ${geo.vw}×${geo.vh} = ${(wRatio * 100).toFixed(1)}% × ${(hRatio * 100).toFixed(1)}%`);
  check("左半演示 / 右半计时，且演示真的出来了（画布动画或跟做视频）",
    geo.leftCx < geo.stageCx && geo.rightCx > geo.stageCx && (geo.painted > 40 || geo.videoShown),
    `左 ${geo.leftCx | 0}px 右 ${geo.rightCx | 0}px，列 = ${geo.cols} · 采样命中 ${geo.painted}`
    + ` · 视频=${geo.videoShown ? geo.videoSrc : "无"}`);
  check("画面半透明（背后页面还看得见）", /rgba\([^)]*,\s*0?\.\d+\)/.test(plan5b.bg), plan5b.bg);
  check("演示动画与所选动作匹配（原地小步跑）",
    plan5b.animKey === "fastFeet" && plan5b.view === "side" && plan5b.tick,
    `动画=${plan5b.animKey} 视角=${plan5b.view} 滴答=${plan5b.tick} audio=${JSON.stringify(plan5b.audioRaw)}`);

  // 推到第 1 个组间歇（elapsed 落在 rest 段中间）
  const rest1 = await page.evaluate(() => {
    const d0 = window.CoachTimer.debug();
    const w = window.fitTiming().workTime;
    window.CoachTimer.update(d0.total - (w + 0.2));   // 第 1 组刚结束一点点
    const d = window.CoachTimer.debug();
    return {
      kind: d.phaseKind, idx: d.phaseIndex,
      count: document.getElementById("coachCount").textContent.trim(),
      label: document.getElementById("coachPhaseLabel").textContent.trim(),
      tag: document.getElementById("coachTag").textContent.trim(),
      setline: document.getElementById("coachSetLine").textContent.trim(),
      hint: document.getElementById("coachHint").textContent.trim(),
      restCls: document.getElementById("coachTimer").classList.contains("is-rest"),
      animKey: d.animKey,
      restPanelShown: !document.getElementById("coachRest").classList.contains("hidden"),
      restPanelCount: document.getElementById("coachRestCount").textContent.trim(),
      restPanelNext: document.getElementById("coachRestNext").textContent.trim(),
      canvasHidden: document.getElementById("coachCanvas").classList.contains("hidden"),
      videoHidden: document.getElementById("coachVideo").classList.contains("hidden"),
      nowCls: document.querySelectorAll("#coachPhases .ph.is-now").length,
      doneCls: document.querySelectorAll("#coachPhases .ph.is-done").length
    };
  });
  check("到点自动切进「组间休息」（不用手动点）",
    rest1.kind === "rest" && rest1.idx === 1 && rest1.restCls &&
    /组间休息/.test(rest1.label) && /组间休息/.test(rest1.tag),
    `第 ${rest1.idx + 1} 段 · ${rest1.count} · 「${rest1.label}」/「${rest1.tag}」`);
  check(`休息段也有自己的倒计时（${expectTiming.restTime} 秒）`,
    rest1.count === `00:${String(expectTiming.restTime).padStart(2, "0")}`, rest1.count);
  check("休息时不播演示动画（画面换成纯倒计时面板）",
    rest1.restPanelShown && rest1.canvasHidden && rest1.videoHidden,
    `面板=${rest1.restPanelShown} 画布hidden=${rest1.canvasHidden} 视频hidden=${rest1.videoHidden}`);
  check("休息面板上的倒计时数字和右上角一致", rest1.restPanelCount === rest1.count,
    `${rest1.restPanelCount} vs ${rest1.count}`);
  check("休息面板提示了接下来做什么", /接下来/.test(rest1.restPanelNext), rest1.restPanelNext);
  check("休息时提示语换成放松引导", /呼吸|喝两口水/.test(rest1.hint), rest1.hint);
  check("阶段条标出已完成与当前段", rest1.doneCls === 1 && rest1.nowCls === 1,
    `已完成 ${rest1.doneCls} 段 / 当前 ${rest1.nowCls} 段`);
  await page.screenshot({ path: path.join(SHOT, "fit-05-coach-rest.png") });

  // 再推到第 2 组（elapsed 落在第 3 段 work 里）：倒计时要重新从满的一组开始
  const work2 = await page.evaluate(() => {
    const d0 = window.CoachTimer.debug();
    const tm = window.fitTiming();
    window.CoachTimer.update(d0.total - (tm.workTime + tm.restTime + 0.2));
    const d = window.CoachTimer.debug();
    return {
      kind: d.phaseKind, setNo: d.setNo,
      count: document.getElementById("coachCount").textContent.trim(),
      restCls: document.getElementById("coachTimer").classList.contains("is-rest"),
      animKey: d.animKey,
      restPanelHidden: document.getElementById("coachRest").classList.contains("hidden"),
      label: document.getElementById("coachPhaseLabel").textContent.trim(),
      setline: document.getElementById("coachSetLine").textContent.trim(),
      nowCls: document.querySelectorAll("#coachPhases .ph.is-now").length,
      doneCls: document.querySelectorAll("#coachPhases .ph.is-done").length
    };
  });
  check(`间歇结束自动进第 2 组，倒计时重新从 ${expectTiming.workTime} 秒开始`,
    work2.kind === "work" && work2.setNo === 2 &&
    work2.count === `00:${String(expectTiming.workTime).padStart(2, "0")}` &&
    !work2.restCls && /本组剩余/.test(work2.label),
    `第 ${work2.setNo} 组 · ${work2.count} · 「${work2.label}」`);
  check("回到运动段演示切回原动作", work2.animKey === "fastFeet", work2.animKey);
  check("回到运动段时收起休息倒计时面板",
    work2.restPanelHidden === true, String(work2.restPanelHidden));
  check("组数行跟着更新", /第 2 组 \/ 共 3 组/.test(work2.setline), work2.setline);
  check("阶段条上已完成 2 段（运动 + 休息），当前在第 3 段", work2.doneCls === 2 && work2.nowCls === 1,
    `已完成 ${work2.doneCls} 段 / 当前 ${work2.nowCls} 段`);
  await page.screenshot({ path: path.join(SHOT, "fit-04-coach-work.png") });

  // 中途改练另一个动作：旧浮层让位，新项目直接接管（不用先"结束"再"开始"）
  const switched = await page.evaluate(() => {
    const pick = re => [...document.querySelectorAll(".fit-block")].find(el => re.test(el.textContent));
    const arm = el => { const b = el.querySelector(".fit-check"); if (b.getAttribute("aria-pressed") === "false") b.click(); };
    const a = pick(/高抬腿/), b = pick(/波比跳/);
    arm(a); arm(b);
    a.querySelector("[data-action='time-block']").click();
    const d1 = window.CoachTimer.debug();
    const s1 = {
      name: document.getElementById("coachExName").textContent.trim(),
      total: d1.total, anim: d1.animKey,
      highlighted: document.querySelectorAll(".fit-block.is-timing").length,
      onBlock: a.classList.contains("is-timing")
    };
    b.querySelector("[data-action='time-block']").click();
    const d2 = window.CoachTimer.debug();
    const s2 = {
      name: document.getElementById("coachExName").textContent.trim(),
      total: d2.total, anim: d2.animKey, segs: d2.phaseCount,
      highlighted: document.querySelectorAll(".fit-block.is-timing").length,
      onBlock: b.classList.contains("is-timing"),
      oldCleared: !a.classList.contains("is-timing")
    };
    return { s1, s2 };
  });
  check("中途改练另一个动作时浮层与高亮一起换过去",
    switched.s1.onBlock && switched.s1.highlighted === 1 && /高抬腿/.test(switched.s1.name) &&
    switched.s2.onBlock && switched.s2.oldCleared && switched.s2.highlighted === 1 &&
    /波比跳/.test(switched.s2.name) && switched.s2.anim === "burpee",
    `${switched.s1.name}(${switched.s1.total}s/${switched.s1.anim}) → ${switched.s2.name}(${switched.s2.total}s/${switched.s2.anim})`);
  check("计次类动作按该动作的推荐节奏折算出单组时长",
    switched.s2.total > 0 && switched.s2.segs === 5,
    `波比跳 3 组 × 6 次 · 间歇 45 秒 → ${switched.s2.segs} 段 / 共 ${switched.s2.total} 秒`);
  await page.evaluate(() => window.fitTimerReset());
  await sleep(200);

  /* ---------------- 5c. 过半提示只在运动段说 ---------------- */
  console.log("\n== 5c. 过半提示只落在「运动」段 ==");
  const halfTrace = await page.evaluate(() => {
    window.CoachTimer.close();
    window.CoachTimer.open({
      exId: "jumpingJacks", name: "开合跳", emoji: "⭐", how: "落地要轻，用前脚掌缓冲。",
      segments: [
        { kind: "work", seconds: 20, setNo: 1, setCount: 2 },
        { kind: "rest", seconds: 10 },
        { kind: "work", seconds: 20, setNo: 2, setCount: 2 }
      ]
    });
    const fired = [];
    let prevKey = window.CoachTimer.debug().halfKey;
    for (let left = 50; left >= 0; left -= 1) {
      window.CoachTimer.update(left);
      const d = window.CoachTimer.debug();
      if (d.halfKey !== prevKey) { fired.push({ halfKey: d.halfKey, kind: d.phaseKind, left }); prevKey = d.halfKey; }
    }
    const d = window.CoachTimer.debug();
    return {
      total: d.total, phases: d.phaseCount, fired,
      hint: document.getElementById("coachHint").textContent.trim(),
      halfPaused: d.audio.half.paused, halfT: d.audio.half.currentTime,
      tickVol: d.audio.tick.volume
    };
  });
  check("两段运动各提示一次「坚持，还剩一半」，休息段不打扰",
    halfTrace.fired.length === 2 &&
    halfTrace.fired[0].halfKey === 0 && halfTrace.fired[0].kind === "work" &&
    halfTrace.fired[1].halfKey === 2 && halfTrace.fired[1].kind === "work",
    halfTrace.fired.map(f => `第${f.halfKey + 1}段(${f.kind}) 剩${f.left}秒`).join(" / "));
  check("过半语音正在播、且滴答声被压低", halfTrace.halfPaused === false && halfTrace.tickVol < 0.2,
    `half paused=${halfTrace.halfPaused} 滴答音量 ${halfTrace.tickVol}`);
  check("浮层文字同步显示「坚持，还剩一半」", /坚持，还剩一半/.test(halfTrace.hint), halfTrace.hint);

  const doneAll = await page.evaluate(() => {
    window.CoachTimer.update(0);
    window.CoachTimer.finish();
    const d = window.CoachTimer.debug();
    return {
      finished: d.finished, tickPaused: d.audio.tick.paused, finishPaused: d.audio.finish.paused,
      hint: document.getElementById("coachHint").textContent.trim(),
      cls: document.getElementById("coachTimer").classList.contains("is-done"),
      stripDone: document.querySelectorAll("#coachPhases .ph.is-done").length,
      pauseDisabled: document.getElementById("coachPauseBtn").disabled
    };
  });
  check("全部段跑完播「完美结束」并停掉滴答",
    doneAll.finished && doneAll.tickPaused && doneAll.finishPaused === false && doneAll.cls,
    `提示「${doneAll.hint}」`);
  check("结束时阶段条全部点亮、暂停按钮禁用",
    doneAll.stripDone === 3 && doneAll.pauseDisabled, `点亮 ${doneAll.stripDone} 段`);

  const closed = await page.evaluate(() => {
    window.CoachTimer.close();
    const d = window.CoachTimer.debug();
    return {
      open: d.open, hidden: document.getElementById("coachTimer").classList.contains("hidden"),
      tickPaused: d.audio.tick.paused, finishPaused: d.audio.finish.paused,
      bodyCls: document.body.classList.contains("coach-timer-open")
    };
  });
  check("关闭浮层后所有声音停下、页面恢复可滚动",
    !closed.open && closed.hidden && closed.tickPaused && closed.finishPaused && !closed.bodyCls);

  /* ---------------- 5d. 真跑一遍：跑完算完成 + 自动收浮层 ---------------- */
  console.log("\n== 5d. 计时跑完 → 这个项目算完成 ==");
  const autoStart = await page.evaluate(() => {
    window.fitTimerReset();
    const card = [...document.querySelectorAll(".fit-block")].find(el => /原地小步跑/.test(el.textContent));
    const box = card.querySelector(".fit-check");
    if (box.getAttribute("aria-pressed") === "false") box.click();   // 先勾选
    const id = card.dataset.blockId;
    const doneBefore = card.classList.contains("is-done");
    window.timeFitBlock(id);
    window.CoachTimer.skipPrep();          // 跳过「就位口令 + 数 3、2、1」（本用例只验计时流程）
    fitTimer.endsAt = Date.now() - 1;      // 让它下一拍就归零
    return { id, doneBefore, running: fitTimer.running };
  });
  check("勾选后能开始计时，此时该块还没完成",
    autoStart.running && autoStart.doneBefore === false, `blockId=${autoStart.id}`);

  await sleep(900);
  const autoDone = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".fit-block")].find(el => /原地小步跑/.test(el.textContent));
    const badge = card.querySelector(".fit-done-badge");
    return {
      finished: window.CoachTimer.debug().finished,
      hint: document.getElementById("coachHint").textContent.trim(),
      overlayOpen: window.CoachTimer.isOpen(),
      done: card.classList.contains("is-done"),
      badgeShown: !!badge && !badge.classList.contains("hidden"),
      badgeText: badge ? badge.textContent.trim() : "",
      stillPicked: card.querySelector(".fit-check").getAttribute("aria-pressed"),
      timerLabel: card.querySelector(".fit-timer-btn").textContent.trim(),
      stored: (JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.done["2026-09-28"] || []).length,
      ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "")
    };
  });
  check("计时走完自动播「完美结束」", autoDone.finished && /完美结束/.test(autoDone.hint), autoDone.hint);
  check("计时跑完这个项目算完成（出现「✓ 已完成」角标、计入完成度）",
    autoDone.done && autoDone.badgeShown && /已完成/.test(autoDone.badgeText) && autoDone.stored >= 1 && !/^0%/.test(autoDone.ring),
    `角标「${autoDone.badgeText}」· 完成度 ${autoDone.ring} · 本机已存 ${autoDone.stored} 条`);
  check("完成后仍然保持勾选、按钮恢复可用",
    autoDone.stillPicked === "true" && /计时/.test(autoDone.timerLabel),
    `aria-pressed=${autoDone.stillPicked} 按钮「${autoDone.timerLabel}」`);

  await sleep(2400);
  const autoClosed = await page.evaluate(() => ({
    open: window.CoachTimer.isOpen(),
    hidden: document.getElementById("coachTimer").classList.contains("hidden")
  }));
  check("说完「完美结束」后浮层自动收起", !autoClosed.open && autoClosed.hidden);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".fit-block")].find(el => /原地小步跑/.test(el.textContent));
    card.scrollIntoView({ block: "center" });
  });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "fit-02c-done.png") });

  // 取消勾选 → 完成标记也要一起撤销（保证"完成度不会算在没选中的项目上"）
  const unpick = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".fit-block")].find(el => /原地小步跑/.test(el.textContent));
    card.querySelector(".fit-check").click();
    return {
      done: card.classList.contains("is-done"),
      picked: card.classList.contains("is-picked"),
      aria: card.querySelector(".fit-check").getAttribute("aria-pressed"),
      disabled: card.querySelector(".fit-timer-btn").disabled,
      badgeHidden: card.querySelector(".fit-done-badge").classList.contains("hidden"),
      storedDone: (JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.done["2026-09-28"] || []).length,
      ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "")
    };
  });
  check("取消勾选会连带撤销完成标记、并重新锁上「计时」",
    !unpick.done && !unpick.picked && unpick.aria === "false" && unpick.disabled && unpick.badgeHidden,
    `完成度回到 ${unpick.ring} · 本机剩 ${unpick.storedDone} 条`);
  await page.evaluate(() => window.fitTimerReset());
  await sleep(200);

  /* ---------------- 6. 全部完成并结算 ---------------- */
  console.log("\n== 6. 全勤提交 → 奖牌 + 金币 ==");
  // 先全部勾选，再逐个把计时跑完（把剩余时间直接推到 0，秒级完成）
  const allDone = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelectorAll(".fit-check").forEach(btn => {
      if (btn.getAttribute("aria-pressed") === "false") btn.click();
    });
    const picked = document.querySelectorAll(".fit-block.is-picked").length;
    const ids = [...document.querySelectorAll(".fit-block")].map(el => el.dataset.blockId);
    for (const id of ids) {
      window.timeFitBlock(id);
      window.CoachTimer.skipPrep();        // 同上：跳过开练准备，只跑计时
      fitTimer.endsAt = Date.now() - 1;
      await wait(280);
      window.fitTimerReset();
    }
    return {
      picked,
      done: document.querySelectorAll(".fit-block.is-done").length,
      total: document.querySelectorAll(".fit-block").length,
      locked: document.querySelectorAll("[data-action='time-block']:disabled").length,
      ring: document.querySelector("#fitRing .donut-center").textContent.replace(/\s+/g, "")
    };
  });
  check("勾选的项目都进入「已选中」状态", allDone.picked === allDone.total, `${allDone.picked}/${allDone.total}`);
  check("逐个计时跑完 → 全部算完成、完成度 100%",
    allDone.done === allDone.total && /^100%/.test(allDone.ring),
    `${allDone.done}/${allDone.total} · ${allDone.ring}`);
  check("已完成的块计时按钮依然可用（可以再练一次）", allDone.locked === 0, `禁用 ${allDone.locked} 个`);

  await page.evaluate(() => document.querySelector("[data-action='submit-fitness']").click());
  await sleep(800);
  const settled = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    const w = document.getElementById("statWidget");
    return {
      sessions: s.fitness.sessions.length,
      last: s.fitness.sessions[s.fitness.sessions.length - 1],
      startDate: s.fitness.startDate,
      statText: w.textContent.replace(/\s+/g, " ").trim(),
      statCls: w.className,
      toast: document.querySelector("#toastBar") ? document.querySelector("#toastBar").textContent.trim() : ""
    };
  });
  check("提交后写入训练记录", settled.sessions === 1, JSON.stringify({ completion: settled.last.completion, medal: settled.last.medal, coins: settled.last.coins }));
  check("完成度 100% → 金牌 + 5 金币", settled.last.completion === 100 && settled.last.medal === "gold" && settled.last.coins === 5);
  check("首次训练自动记录起始日期", settled.startDate === "2026-09-28", settled.startDate);
  check("右上角统计图切换为体能口径", /完成度%/.test(settled.statText) && /medal-gold/.test(settled.statCls), settled.statText.slice(0, 70));
  check("统计图显示已获金牌（不是「待完成」）", /金牌/.test(settled.statText) && !/待完成/.test(settled.statText), settled.statText.slice(0, 40));
  check("提交后给出奖牌提示", /金牌/.test(settled.toast), `「${settled.toast}」`);
  await page.screenshot({ path: path.join(SHOT, "fit-04-settled.png") });

  /* ---------------- 7. 体能自测 ---------------- */
  console.log("\n== 7. 体能自测 ==");
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "fitnessTest").click());
  await sleep(500);
  const testView = await page.evaluate(() => ({
    cards: document.querySelectorAll(".fit-test-card").length,
    names: [...document.querySelectorAll(".fit-test-card h3")].map(e => e.textContent.trim()),
    inputs: document.querySelectorAll("[data-fit-test-input]").length,
    empty: (document.getElementById("fitTestHistory").textContent || "").includes("还没有")
  }));
  check("四个自测项目已渲染", testView.cards === 4, testView.names.join(" / "));
  check("自测项目含「30 秒高抬腿」（对应步频）", testView.names.some(n => /高抬腿/.test(n)));
  check("每项都有成绩输入框", testView.inputs === 4, String(testView.inputs));

  await page.evaluate(() => {
    const input = document.querySelector("[data-fit-test-input='highKnees30']");
    input.value = "48";
    document.querySelector("[data-action='save-fit-test'][data-test='highKnees30']").click();
  });
  await sleep(500);
  const testSaved = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    return {
      tests: s.fitness.tests.length,
      value: s.fitness.tests[0] && s.fitness.tests[0].value,
      historyRows: document.querySelectorAll(".fit-test-row").length,
      numbers: document.querySelector(".fit-test-card .fit-test-numbers").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("自测成绩已记录", testSaved.tests === 1 && testSaved.value === 48, `48 次`);
  check("自测记录列表已刷新", testSaved.historyRows === 1, testSaved.numbers);
  await page.screenshot({ path: path.join(SHOT, "fit-05-test.png") });

  /* ---------------- 8. 体能积分 ---------------- */
  console.log("\n== 8. 体能积分 ==");
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "fitnessBoard").click());
  await sleep(700);
  const board = await page.evaluate(() => {
    const canvas = document.getElementById("fitMonthChart");
    let painted = 0;
    try {
      const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    } catch (e) { painted = -1; }
    return {
      pool: document.getElementById("fitCoinPool").textContent.replace(/\s+/g, " ").trim().slice(0, 110),
      rankRows: document.querySelectorAll("#fitWeekRank .rank-row").length,
      todayRow: document.querySelectorAll("#fitWeekRank .rank-row.is-today").length,
      legend: document.getElementById("fitMonthLegend").textContent.replace(/\s+/g, " ").trim(),
      painted
    };
  });
  check("体能金币池已渲染", /体能累计金币/.test(board.pool), `「${board.pool}」`);
  check("本周榜单 7 行", board.rankRows === 7, String(board.rankRows));
  check("榜单高亮今天", board.todayRow === 1);
  check("月度完成度曲线已绘制", board.painted > 500, "已绘制像素 " + board.painted);
  check("图例显示奖牌完成度线", /金牌/.test(board.legend), board.legend.slice(0, 80));

  // 奖牌只可能拿一个：按完成度取最高那一档，不叠加
  const medalMath = await page.evaluate(() => {
    const day = window.fitnessDayDetail("2026-09-28");
    return {
      m100: window.fitnessMedalOf(100), m85: window.fitnessMedalOf(85),
      m70: window.fitnessMedalOf(70), m69: window.fitnessMedalOf(69),
      coinsGold: window.fitnessCoinsForMedal("gold"),
      coinsSilver: window.fitnessCoinsForMedal("silver"),
      coinsBronze: window.fitnessCoinsForMedal("bronze"),
      day: { completion: day.completion, medal: day.medal, coins: day.coins },
      earned: window.fitnessCoinsEarned(),
      pool: document.getElementById("fitCoinPool").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("完成度只对应一个牌（取最高那一档）",
    medalMath.m100 === "gold" && medalMath.m85 === "silver" &&
    medalMath.m70 === "bronze" && medalMath.m69 === "none",
    `100→${medalMath.m100} · 85→${medalMath.m85} · 70→${medalMath.m70} · 69→${medalMath.m69}`);
  check("100% 只拿金牌那一档的金币，不叠加银牌铜牌",
    medalMath.day.completion === 100 && medalMath.day.medal === "gold" &&
    medalMath.day.coins === medalMath.coinsGold &&
    medalMath.day.coins !== medalMath.coinsGold + medalMath.coinsSilver + medalMath.coinsBronze,
    `完成度 ${medalMath.day.completion}% → ${medalMath.day.medal} ${medalMath.day.coins} 🪙（若叠加会是 ${medalMath.coinsGold + medalMath.coinsSilver + medalMath.coinsBronze}）`);
  check("累计金币也只按最高档算（1 天 100% → 5，不是 9）",
    medalMath.earned === medalMath.coinsGold,
    `累计 ${medalMath.earned} 🪙`);
  check("积分页写明「同一天只发一个牌、不叠加」",
    /只发一个牌/.test(medalMath.pool) && /叠加/.test(medalMath.pool) && !/\+\d+ 🪙/.test(medalMath.pool),
    medalMath.pool.slice(medalMath.pool.indexOf("同一天只发一个牌")).slice(0, 110));
  await page.screenshot({ path: path.join(SHOT, "fit-06-board.png") });
  await page.evaluate(() => document.getElementById("fitMonthChart").scrollIntoView({ block: "center" }));
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT, "fit-06b-month.png") });

  /* ---------------- 9. 家长管理：体能规则 ---------------- */
  console.log("\n== 9. 家长管理 · 体能奖励规则 ==");
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "admin").click());
  await sleep(400);
  await page.evaluate(() => {
    document.getElementById("adminPasswordInput").value = "09590677";
    document.querySelector("[data-action='admin-login']").click();
  });
  await sleep(500);
  const adminView = await page.evaluate(() => ({
    panel: !document.getElementById("adminPanel").classList.contains("hidden"),
    fitGold: document.getElementById("fitGoldScore").value,
    fitSilver: document.getElementById("fitSilverScore").value,
    fitBronze: document.getElementById("fitBronzeScore").value,
    balance: document.getElementById("adminBalance").textContent.trim()
  }));
  check("家长管理内含体能奖励规则", adminView.panel && adminView.fitGold === "100", `金 ${adminView.fitGold} / 银 ${adminView.fitSilver} / 铜 ${adminView.fitBronze}`);
  check("奖金池余额已合并体能金币", Number(adminView.balance) === 5, adminView.balance);

  await page.evaluate(() => {
    document.getElementById("fitGoldScore").value = "100";
    document.getElementById("fitSilverScore").value = "75";
    document.getElementById("fitBronzeScore").value = "50";
    document.getElementById("fitGoldCoin").value = "10";
    document.getElementById("fitSilverCoin").value = "5";
    document.getElementById("fitBronzeCoin").value = "2";
    document.querySelector("[data-action='save-fitness-rewards']").click();
  });
  await sleep(400);
  const fitRules = await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.rewards);
  check("体能奖励规则已持久化", fitRules.thresholds.silver === 75 && fitRules.coins.gold === 10, JSON.stringify(fitRules));

  // 非法规则应被拒绝
  await page.evaluate(() => {
    document.getElementById("fitGoldScore").value = "40";
    document.getElementById("fitSilverScore").value = "90";
    document.querySelector("[data-action='save-fitness-rewards']").click();
  });
  await sleep(400);
  const afterBad = await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.rewards.thresholds.gold);
  check("非法完成度线（金 < 银）被拒绝", afterBad === 100, "金牌线仍为 " + afterBad);
  await page.screenshot({ path: path.join(SHOT, "fit-07-admin.png") });

  /* ---------------- 10. 切回写作模块 ---------------- */
  console.log("\n== 10. 切回写作模块 ==");
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(500);
  const backToChooser = await page.evaluate(() => ({
    chooser: !document.getElementById("moduleChooser").classList.contains("hidden"),
    shell: document.getElementById("appShell").classList.contains("hidden")
  }));
  check("「切换模块」回到选择页", backToChooser.chooser && backToChooser.shell);

  await page.evaluate(() => document.querySelector(".chooser-card[data-module='write']").click());
  await sleep(600);
  const backWrite = await page.evaluate(() => {
    const navs = [...document.querySelectorAll(".nav-item")];
    const w = document.getElementById("statWidget");
    return {
      brand: document.getElementById("brandTitle").textContent.trim(),
      visibleNav: navs.filter(n => !n.classList.contains("hidden")).map(n => n.dataset.view),
      activeView: [...document.querySelectorAll(".view")].filter(v => v.classList.contains("active")).map(v => v.id),
      fitnessClass: document.body.classList.contains("module-fitness"),
      statText: w.textContent.replace(/\s+/g, " ").trim(),
      lockedViews: navs.filter(n => n.classList.contains("locked")).map(n => n.dataset.view)
    };
  });
  check("写作模块导航恢复", backWrite.visibleNav.includes("dashboard") && !backWrite.visibleNav.includes("fitnessToday"), backWrite.visibleNav.join(","));
  check("回到写作首页", backWrite.activeView.includes("dashboard") && /每日一写/.test(backWrite.brand));
  check("右上角统计图切回写作口径", /今日分/.test(backWrite.statText), backWrite.statText.slice(0, 70));
  check("写作门禁仍然生效（未写每日必写）", backWrite.lockedViews.length === 3, backWrite.lockedViews.join(","));

  // 写作积分榜与「体能积分」同模板：只算写作部分；共用奖金池挪到了模块选择页（首页）
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "scoreboard").click());
  await sleep(600);
  const writeCoins = await page.evaluate(() => document.getElementById("writeCoinPool").textContent.replace(/\s+/g, " ").trim());
  check("写作积分榜只算写作部分（写作累计金币）", /写作累计金币/.test(writeCoins) && !/体能获得/.test(writeCoins), writeCoins.slice(0, 120));
  await page.screenshot({ path: path.join(SHOT, "fit-08-write-back.png") });

  // 回到模块选择页（首页）：共用奖金池显示写作/体能拆分，游戏卡也在这里
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(600);
  const pool = await page.evaluate(() => document.getElementById("coinPool").textContent.replace(/\s+/g, " ").trim());
  check("模块选择页的共用奖金池显示写作/体能金币拆分", /写作获得/.test(pool) && /体能获得/.test(pool), pool.slice(0, 120));
  const homeHasGame = await page.evaluate(() => !!document.querySelector("#moduleChooser #gameCards .game-card"));
  check("模块选择页（首页）承载游戏卡", homeHasGame, String(homeHasGame));
  await page.screenshot({ path: path.join(SHOT, "fit-09-home-rewards.png") });

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");

  console.log(`\n结果：通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) console.log("失败项：" + fail.join(" | "));

  await browser.close();
  process.exit(errors.length || fail.length ? 1 : 0);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
