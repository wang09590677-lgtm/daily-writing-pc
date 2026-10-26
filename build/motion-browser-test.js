// 真实浏览器验证：体感跟练（摄像头 → 本地动作分析 → 计数评分 → 结算 → 报告）
//
// 画面来源用**合成的 Y4M 假摄像头**：一个**竖直站立的人形**（有头/躯干/双臂/
// 分腿）在暗背景上按 0.6 Hz（36 次/分）上下往复（模拟深蹲）。这样"应该数出
// 多少次"是可以算出来的，能真正验证引擎在数次数，而不是只验证"没报错"。
// 同时用 --use-fake-device-for-media-stream 确保绝不会碰这台机器上的真实摄像头。
//
// 注意：人形必须是**竖长**的。引擎有一道"像不像人"的判据 `bh/bw >= 1.10`，
// 早期版本用的是 52×36 的横条，比例只有 0.69，被直接判成"不是人"，
// 于是预览无骨架、计数恒 0，主流程整段假失败。
//
// 日期冻结到 2026-09-29（周二 = 腿部力量日）：半蹲热身是周二热身的正式动作，
// 有真实 blockId，可以顺带验证动作分达标自动勾选清单。
//
// 流程：开摄像头 → **站位校准**（本测试点「先跳过，直接练」放行）→ 开始这一组
//       → 采帧计数 → 结束评分 → 报告页。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

const Y4M = path.join(__dirname, "__motion-test.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

// ---- 合成假摄像头画面：一个**竖直站立的人形**上下往复（深蹲），频率 REP_HZ ----
//
// 为什么不能再用"亮方块"：引擎有一道"这像不像人"的判据 `bh/bw >= 1.10`
// （人比家具竖长）。旧场景那是个 52×36 的**横条**，比例 0.69，直接被判成
// "不是人" → 预览不出骨架、计数恒为 0，整条主流程的断言全跟着挂。
// 换成有头/躯干/双臂/分腿的竖直人形后，人能真正被认出来，主流程才可测。
//
// 关节几何（相对人形中心的偏移，单位：视频像素）：
const FIG = {
  headR: 6,
  headDy: -27,                    // 圆心
  torso: [-10, -19, 10, 9],       // [dx0, dy0, dx1, dy1] 相对中心
  armL: [-18, -16, -12, 3],
  armR: [12, -16, 18, 3],
  legL: [-9, 9, -2, 30],
  legR: [2, 9, 9, 30]
};
const VW = 128, VH = 96, VFPS = 25, VSEC = 36, REP_HZ = 0.6;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128);
  const cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => {
    for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++) {
      for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v;
    }
  };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24);                                   // 暗背景
    // 上下往复：沿画面中线，振幅 12 像素（深蹲幅度）
    const cy = Math.round(VH / 2 + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * 12);
    const B = 238;                                                       // 人体亮度
    for (const part of [FIG.torso, FIG.armL, FIG.armR, FIG.legL, FIG.legR]) {
      paint(y, cx + part[0], cy + part[1], cx + part[2], cy + part[3], B);
    }
    // 头（圆）
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) {
      const half = Math.round(Math.sqrt(Math.max(0, FIG.headR * FIG.headR - (yy - hy) * (yy - hy))));
      paint(y, cx - half, yy, cx + half + 1, yy + 1, B);
    }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

(async () => {
  buildY4M(Y4M);
  const y4mWin = Y4M.replace(/\//g, "\\");

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",              // 兜底：绝不使用真实摄像头
      "--use-file-for-fake-video-capture=" + y4mWin,     // 用合成画面替换摄像头输入
      "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("dialog", async d => { await d.accept(); });

  // 本测试验证的是**纯彩色通路**的计数。这台机器上可能跑着 Astra 深度桥接
  // （ws://127.0.0.1:8765），不屏蔽的话引擎会走真实深度，测试就不再可复现。
  await page.evaluateOnNewDocument(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url) {
      if (String(url).indexOf("127.0.0.1:8765") >= 0) throw new Error("depth bridge blocked in test");
      return new RealWS(url, ...Array.prototype.slice.call(arguments, 1));
    };
    window.WebSocket.prototype = RealWS.prototype;
  });
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    const FIXED = new RealDate(2026, 8, 29, 10, 30, 0).getTime();
    class MockDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
      static now() { return FIXED; }
    }
    window.Date = MockDate;
  });

  /* ?motionPrep=0 跳过「准备开始进行XX + 人声数 3、2、1」。
   *
   * 那套口令是给真实孩子用的：报出动作名、给 3 秒时间就位，整套约 8 秒。
   * 本测试测的是引擎本身（计次 / 评分 / 榜单 / 隐私），不是口令节奏，
   * 干等 8 秒会把每次回归拖长，还会让"点开始后按钮立刻变成进行中"
   * 这类断言失效 —— 插了口令之后，点下去先进入的是"准备中…"，这是**设计内**的。
   * 口令本身的正确性由 accept-motion-autostart.js 专门验证（31 项）。 */
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  /* ---------------- 1. 体感导航项 ---------------- */
  console.log("\n== 1. 体感导航项 ==");
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);

  const nav = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".nav-item")].filter(i => !i.classList.contains("hidden"));
    return {
      views: items.map(i => i.dataset.view),
      motionVisible: items.some(i => i.dataset.view === "fitnessMotion"),
      reportVisible: items.some(i => i.dataset.view === "fitnessReport")
    };
  });
  check("体能模块出现「体感跟练」", nav.motionVisible);
  check("体能模块出现「体感报告」", nav.reportVisible);
  check("体能导航共 6 项", nav.views.filter(v => v.startsWith("fitness")).length === 6, nav.views.filter(v => v.startsWith("fitness")).join(","));

  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
  });
  await sleep(500);

  const stage = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    return {
      active: document.getElementById("fitnessMotion").classList.contains("active"),
      title: document.getElementById("pageTitle").textContent.trim(),
      optionCount: sel.options.length,
      firstOption: sel.options[0] ? sel.options[0].textContent.trim() : "",
      hasVideo: !!document.getElementById("motionVideo"),
      hasOverlay: !!document.getElementById("motionOverlay"),
      startDisabled: document.getElementById("motionStartBtn").disabled,
      finishDisabled: document.getElementById("motionFinishBtn").disabled,
      canDo: document.querySelectorAll("#motionCanDo li").length,
      cannotDo: document.querySelectorAll("#motionCannotDo li").length,
      setup: document.querySelectorAll("#motionSetup li").length
    };
  });
  check("进入体感跟练页", stage.active && stage.title === "体感跟练");
  check("动作下拉里有今天计划的可测动作", stage.optionCount > 0, `共 ${stage.optionCount} 项，首项「${stage.firstOption}」`);
  check("视频与叠加层已就位", stage.hasVideo && stage.hasOverlay);
  check("未开摄像头时开始按钮禁用", stage.startDisabled && stage.finishDisabled);
  check("三组能力说明文案已渲染", stage.canDo === 7 && stage.cannotDo === 4 && stage.setup === 5,
    `能测 ${stage.canDo} / 测不了 ${stage.cannotDo} / 摆放 ${stage.setup}`);

  /* ---------------- 2. 开启摄像头 ---------------- */
  console.log("\n== 2. 开启摄像头 ==");
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(1800);

  const cam = await page.evaluate(() => {
    const v = document.getElementById("motionVideo");
    const t = v.srcObject ? v.srcObject.getVideoTracks()[0] : null;
    return {
      streamLive: !!v.srcObject,
      tracks: v.srcObject ? v.srcObject.getVideoTracks().length : 0,
      label: t ? t.label : "",
      readyState: v.readyState,
      videoW: v.videoWidth,
      videoH: v.videoHeight,
      btn: document.getElementById("motionCameraBtn").textContent.trim(),
      isLive: document.getElementById("motionScreen").classList.contains("is-live"),
      placeholderHidden: document.getElementById("motionPlaceholder").classList.contains("hidden"),
      startDisabled: document.getElementById("motionStartBtn").disabled,
      calibShown: !document.getElementById("poseCalib").classList.contains("hidden"),
      roomScanShown: !document.getElementById("roomScan").classList.contains("hidden")
    };
  });
  check("摄像头流已建立", cam.streamLive && cam.tracks === 1, `${cam.videoW}×${cam.videoH} readyState=${cam.readyState}`);
  check("用的是合成假画面（不是真实摄像头）", cam.videoW === VW && cam.videoH === VH, cam.label);
  check("按钮切换为「关闭摄像头」", cam.btn === "关闭摄像头", cam.btn);
  check("画面区进入 live 状态、占位层隐藏", cam.isLive && cam.placeholderHidden);
  /* 2026-10-02 起：开摄像头后先进「站位校准」，校准没走完「开始这一组」是灰的。
   * 纯彩色 / 合成画面没有深度 → 空房扫描那一步必须自动跳过（不该弹卡片）。 */
  check("开摄像头后先弹站位校准（此时还不能开始）", cam.calibShown && cam.startDisabled === true,
    `calib=${cam.calibShown} startDisabled=${cam.startDisabled}`);
  check("纯彩色通路不弹空房扫描卡片（没有深度就跳过）", cam.roomScanShown === false);

  /* ---------------- 2b. 一开摄像头就该看到骨架（预览态）---------------- */
  console.log("\n== 2b. 开启后立即出骨架（不用点开始）==");
  const preview = await page.evaluate(() => {
    const ov = document.getElementById("motionOverlay");
    const ctx = ov.getContext("2d");
    const d = ctx.getImageData(0, 0, ov.width, ov.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    const eng = window.__motionDebug && window.__motionDebug();
    return {
      paintedRatio: painted / (ov.width * ov.height),
      ovW: ov.width, ovH: ov.height,
      videoW: document.getElementById("motionVideo").videoWidth,
      videoH: document.getElementById("motionVideo").videoHeight,
      canvasTransform: getComputedStyle(ov).transform,
      videoTransform: getComputedStyle(document.getElementById("motionVideo")).transform,
      legend: document.getElementById("motionLegend").textContent.trim(),
      legendShown: getComputedStyle(document.getElementById("motionLegend")).display !== "none",
      legendLost: document.getElementById("motionLegend").classList.contains("is-lost"),
      hint: document.getElementById("motionHint").textContent.trim(),
      skeleton: eng ? eng.skeleton : null,
      startDisabled: document.getElementById("motionStartBtn").disabled
    };
  });
  check("未点开始，叠加层已经画出了骨架", preview.paintedRatio > 0.002,
    `覆盖 ${(preview.paintedRatio * 100).toFixed(1)}%`);
  check("叠加层画布与视频流同尺寸（否则 cover 裁切会让骨架错位）",
    preview.ovW === preview.videoW && preview.ovH === preview.videoH,
    `画布 ${preview.ovW}×${preview.ovH} / 视频 ${preview.videoW}×${preview.videoH}`);
  check("叠加层与视频做同样的镜像（否则骨架左右颠倒）",
    preview.canvasTransform === preview.videoTransform && /matrix\(-1/.test(preview.canvasTransform),
    preview.canvasTransform);
  check("识别到人体并给出关节点", !!preview.skeleton && preview.skeleton.has && preview.skeleton.jointCount >= 8,
    preview.skeleton ? `${preview.skeleton.jointCount} 个关节` : "无");
  /* 校准期间图例是「正在感应画面…」，校准结束后才切成「已认出人形」。
   * 两种都算"没丢人"，但绝不能是 is-lost（未获取到可靠人形）。 */
  check("画面图例告诉孩子「已认出人形」", preview.legendShown && !preview.legendLost, preview.legend);
  check("预览态提示引导孩子站位（还没开始计数）", /看到你了|走近|后退|校准/.test(preview.hint), preview.hint);

  /* ---------------- 2c. 走完校准流程（点「先跳过，直接练」）----------------
     开摄像头后是「站位校准」在把关：校准没过，「开始这一组」一直是灰的。
     测试里点跳过把流程放行，同时验证校准面板确实收起了、开始按钮才亮。 */
  console.log("\n== 2c. 校准流程（跳过）==");
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(600);
  const calib = await page.evaluate(() => ({
    panelHidden: document.getElementById("poseCalib").classList.contains("hidden"),
    targetHidden: document.getElementById("poseTarget").classList.contains("hidden"),
    active: (() => { const d = window.__motionDebug && window.__motionDebug(); return d ? d.calibrating : null; })(),
    startDisabled: document.getElementById("motionStartBtn").disabled,
    hint: document.getElementById("motionHint").textContent.trim()
  }));
  check("点「先跳过，直接练」后校准面板收起", calib.panelHidden && calib.targetHidden, `calibrating=${calib.active}`);
  check("跳过校准后「开始这一组」才可点", calib.startDisabled === false);

  /* ---------------- 3. 开始一组 → 采帧 → 计数 → 评分 ---------------- */
  console.log("\n== 3. 开始一组并评分 ==");
  /* 动作类型文案：rep / burst / hold 三种必须各自说对，不能一律叫"计次类" */
  const modeLabels = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const hint = () => document.getElementById("motionGoalHint").textContent.trim();
    const pick = name => {
      const idx = [...sel.options].findIndex(o => o.textContent.includes(name));
      if (idx < 0) return null;
      sel.value = String(idx);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return hint();
    };
    return { rep: pick("半蹲热身"), burst: pick("原地踏步"), hold: pick("靠墙静蹲") };
  });
  check("计次类动作标注为「计次类动作」", /计次类动作/.test(modeLabels.rep || ""), modeLabels.rep);
  check("高频动作（原地踏步）不能错标成计次类", /高频/.test(modeLabels.burst || "") && !/计次/.test(modeLabels.burst || ""), modeLabels.burst);
  check("保持类动作标注为「保持类动作」", /保持类动作/.test(modeLabels.hold || ""), modeLabels.hold);

  // 半蹲热身（周二热身第 3 个动作）的计次信号是"人形重心纵向位置"，
  // 正好对应假画面里上下往复的方块；它也有真实 blockId，能验证自动勾选
  // 上面的探测把下拉停在了「靠墙静蹲」，这里选回半蹲热身，
  // 后面的计数 / 评分 / 自动勾选断言都依赖它
  const picked = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const idx = [...sel.options].findIndex(o => o.textContent.includes("半蹲热身"));
    const use = idx >= 0 ? idx : 0;
    sel.value = String(use);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: sel.options[use].textContent.trim(), goal: document.getElementById("motionGoalHint").textContent.trim() };
  });
  check("选中半蹲热身并刷新本组目标", picked.text.includes("半蹲热身"), picked.text + " · " + picked.goal);

  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1200);

  const running = await page.evaluate(() => ({
    startText: document.getElementById("motionStartBtn").textContent.trim(),
    startDisabled: document.getElementById("motionStartBtn").disabled,
    finishDisabled: document.getElementById("motionFinishBtn").disabled,
    badge: document.getElementById("motionBadge").textContent.trim(),
    previewing: (() => { const d = window.__motionDebug(); return d ? d.previewing : null; })(),
    legend: document.getElementById("motionLegend").textContent.trim(),
    readouts: [...document.querySelectorAll("#motionReadouts .motion-readout")].map(el => el.textContent.trim())
  }));
  check("开始后按钮状态切换", running.startText === "进行中…" && running.startDisabled && !running.finishDisabled, `badge=${running.badge}`);
  check("实时指标面板已渲染（计次类 5 项）", running.readouts.length === 5, running.readouts.join(" | "));
  check("点开始后从预览态转入正式计时", running.previewing === false, `previewing=${running.previewing}`);

  // 合成画面 0.6 Hz（36 次/分），跑 ~15 秒理论上约 9 次
  await sleep(13000);

  // 机器负载高时（比如同时跑好几个浏览器）背景收敛会变慢，骨架可能还没出来。
  // 这里轮询等它出现，最多再等 4 秒；正常情况下第一次检查就通过，不会延长采样窗口。
  for (let i = 0; i < 8; i++) {
    const ok = await page.evaluate(() => {
      const ov = document.getElementById("motionOverlay");
      const d = ov.getContext("2d").getImageData(0, 0, ov.width, ov.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
      return n / (ov.width * ov.height) > 0.002;
    });
    if (ok) break;
    await sleep(500);
  }

  const live = await page.evaluate(() => {
    const overlay = document.getElementById("motionOverlay");
    const ctx = overlay.getContext("2d");
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return {
      badge: document.getElementById("motionBadge").textContent.trim(),
      hint: document.getElementById("motionHint").textContent.trim(),
      hintClass: document.getElementById("motionHint").className,
      reps: document.getElementById("mr-reps").textContent.trim(),
      tempo: document.getElementById("mr-tempo").textContent.trim(),
      amp: document.getElementById("mr-amp").textContent.trim(),
      sym: document.getElementById("mr-sym").textContent.trim(),
      cont: document.getElementById("mr-cont").textContent.trim(),
      paintedRatio: painted / (overlay.width * overlay.height),
      ring: document.getElementById("motionRing").textContent.trim(),
      engine: (() => { const e = window.__motionDebug && window.__motionDebug(); return e || null; })()
    };
  });
  check("叠加层画出了检测到的人形", live.paintedRatio > 0.002, `覆盖 ${(live.paintedRatio * 100).toFixed(1)}%`);
  check("实时面板在更新", live.amp !== "—" && live.cont !== "—",
    `次数 ${live.reps} · 节奏 ${live.tempo} · 幅度 ${live.amp} · 对称 ${live.sym} · 连续 ${live.cont}`);
  check("提示条带上了状态类", /motion-hint (info|good|warn)/.test(live.hintClass), `${live.hint}（${live.hintClass}）`);
  const liveReps = Number(live.reps) || 0;
  // 理论值：0.6 Hz × 15 秒 ≈ 9 次。背景差法在物体停在两端时会被背景吸收一部分，
  // 允许 ±5 次的误差，只要求数量级对得上（不做精确仪器用）。
  check("引擎数出了动作次数（合成画面 0.6 Hz × 15 秒 ≈ 9 次）", liveReps >= 4 && liveReps <= 15, `数到 ${liveReps} 次`);
  // 节奏 = 次数 / 用时，面板上带单位渲染（如 "43/分"），所以先 parseFloat 剥掉单位再比较。
  // 合成画面是 36 次/分，但背景差法在物体停两端时会被背景吸收、导致计数偏多，
  // 节奏随之被放大到 40 上下。这里只要求落在「慢到快」的合理量级内（20~60 次/分）。
  const liveTempo = parseFloat(live.tempo);
  check("识别出的节奏在合理量级（合成 36 次/分）",
    live.tempo === "—" || (!Number.isNaN(liveTempo) && liveTempo >= 20 && liveTempo <= 60),
    `节奏 ${live.tempo}`);

  await page.screenshot({ path: path.join(SHOT, "motion-live.png") });

  await page.evaluate(() => document.getElementById("motionFinishBtn").click());
  await sleep(900);

  const scored = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    const rec = st.fitness.motion.scores[st.fitness.motion.scores.length - 1];
    return {
      count: st.fitness.motion.scores.length,
      rec,
      resultHtml: document.getElementById("motionResult").textContent.replace(/\s+/g, " ").trim(),
      finishDisabled: document.getElementById("motionFinishBtn").disabled,
      ring: document.getElementById("motionRing").textContent.replace(/\s+/g, " ").trim(),
      toast: (document.getElementById("toastBar") || {}).textContent || "",
      done: st.fitness.done["2026-09-29"] || []
    };
  });
  check("评分后写入一条体感记录", scored.count === 1, `动作分 ${scored.rec && scored.rec.total}`);
  check("记录里保存了数到的次数", scored.rec && scored.rec.reps >= 4 && scored.rec.exId === "halfSquatWarm",
    `次数 ${scored.rec && scored.rec.reps} · 节奏 ${scored.rec && scored.rec.tempo}/分`);
  check("记录带完整字段", !!scored.rec && scored.rec.mode === "rep" && scored.rec.parts
    && Object.keys(scored.rec.parts).length === 3 && typeof scored.rec.symmetry === "number",
    scored.rec ? `parts=${JSON.stringify(scored.rec.parts)} 用时=${scored.rec.elapsed}s` : "");
  check("动作分是真实算出来的（不是 0）", scored.rec && scored.rec.total > 0, `${scored.rec && scored.rec.total} 分`);
  check("结果卡渲染出总分与分项", /动作分/.test(scored.resultHtml) && /完成/.test(scored.resultHtml), scored.resultHtml.slice(0, 60));
  check("评分后结束按钮回到禁用", scored.finishDisabled);
  check("今日最好环形已更新", scored.ring.includes("今日最好"), scored.ring);
  check("弹出结算提示", /动作分/.test(scored.toast), scored.toast);
  check("动作分达标后自动勾选今天的清单", scored.done.length > 0, `已勾选 ${scored.done.join(",") || "无"}`);

  /* ---------------- 4. 体感报告页 ---------------- */
  console.log("\n== 4. 体感报告页 ==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessReport").click();
  });
  await sleep(600);

  const report = await page.evaluate(() => ({
    active: document.getElementById("fitnessReport").classList.contains("active"),
    title: document.getElementById("pageTitle").textContent.trim(),
    pool: document.getElementById("motionCoinPool").textContent.replace(/\s+/g, " ").trim(),
    parts: document.getElementById("motionLastParts").textContent.replace(/\s+/g, " ").trim(),
    rows: document.querySelectorAll("#motionScoreList .fit-history-row").length,
    rules: document.querySelectorAll("#motionCoinPool .medal-row").length
  }));
  check("进入体感报告页", report.active && report.title === "体感报告");
  check("金币池显示累计与历史最好", /体感累计金币/.test(report.pool), report.pool.slice(0, 70));
  check("三条动作分奖牌线已渲染", report.rules === 3);
  check("最近一次分项有内容", /总分/.test(report.parts), report.parts.slice(0, 70));
  check("记录列表有一条", report.rows === 1);

  await page.screenshot({ path: path.join(SHOT, "motion-report.png") });

  /* ---------------- 5. 隐私：离开页面自动关摄像头 ---------------- */
  console.log("\n== 5. 隐私：离开页面自动关摄像头 ==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
  });
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  // 摄像头冷启动 + video.play() 可能超过固定 1.5 秒，轮询等它真的挂上流
  let camBack = false;
  for (let i = 0; i < 12; i++) {
    camBack = await page.evaluate(() => !!document.getElementById("motionVideo").srcObject);
    if (camBack) break;
    await sleep(400);
  }
  check("再次开启摄像头成功", camBack);
  // 开摄像头又会进站位校准，这里同样跳过，好验证"离开页面"这一条
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(400);

  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessToday").click();
  });
  await sleep(700);
  const left = await page.evaluate(() => ({
    src: !!document.getElementById("motionVideo").srcObject,
    live: document.getElementById("motionScreen").classList.contains("is-live"),
    btn: document.getElementById("motionCameraBtn").textContent.trim()
  }));
  check("离开体感页后摄像头被关掉", !left.src && !left.live, `按钮回到「${left.btn}」`);

  /* ---------------- 6. 家长设置：开关与分数线 ---------------- */
  console.log("\n== 6. 家长设置 ==");
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "admin").click();
  });
  await sleep(400);
  await page.type("#adminPasswordInput", "09590677");
  await page.evaluate(() => document.querySelector("[data-action='admin-login']").click());
  await sleep(400);

  const admin = await page.evaluate(() => ({
    gold: document.getElementById("motionGoldScore").value,
    silver: document.getElementById("motionSilverScore").value,
    bronze: document.getElementById("motionBronzeScore").value,
    coin: document.getElementById("motionGoldCoin").value,
    enabled: document.getElementById("motionEnabled").checked,
    switchLabel: document.querySelector(".motion-switch span").textContent.trim()
  }));
  check("体感分数线已回填", admin.gold === "90" && admin.silver === "75" && admin.bronze === "60",
    `${admin.gold}/${admin.silver}/${admin.bronze}，金牌 ${admin.coin} 金币`);
  check("体感总开关默认打开", admin.enabled === true);
  check("开关有明确说明", /只在本机分析/.test(admin.switchLabel), admin.switchLabel);

  await page.evaluate(() => {
    document.getElementById("motionGoldScore").value = "95";
    document.getElementById("motionSilverScore").value = "80";
    document.getElementById("motionBronzeScore").value = "65";
    document.querySelector("[data-action='save-motion-rewards']").click();
  });
  await sleep(600);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.motion.rewards);
  check("体感规则保存成功", saved.thresholds.gold === 95 && saved.thresholds.bronze === 65, JSON.stringify(saved.thresholds));

  await page.evaluate(() => {
    document.getElementById("motionGoldScore").value = "40";
    document.getElementById("motionSilverScore").value = "90";
    document.querySelector("[data-action='save-motion-rewards']").click();
  });
  await sleep(500);
  const rejected = await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.motion.rewards.thresholds.gold);
  check("非法分数线（金 < 银）被拒绝", rejected === 95, `金线仍为 ${rejected}`);

  await page.evaluate(() => {
    document.getElementById("motionGoldScore").value = "95";
    document.getElementById("motionSilverScore").value = "80";
    document.getElementById("motionEnabled").checked = false;
    document.querySelector("[data-action='save-motion-rewards']").click();
  });
  await sleep(500);
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
  });
  await sleep(500);
  const disabled = await page.evaluate(() => ({
    enabled: JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.motion.enabled,
    unsupported: document.getElementById("motionUnsupported").textContent.trim(),
    shown: !document.getElementById("motionUnsupported").classList.contains("hidden")
  }));
  check("关掉开关后状态落库", disabled.enabled === false);
  check("跟练页给出「已被家长关闭」提示", disabled.shown && /关掉/.test(disabled.unsupported), disabled.unsupported);

  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "admin").click();
  });
  await sleep(300);
  await page.evaluate(() => {
    document.getElementById("motionEnabled").checked = true;
    document.querySelector("[data-action='save-motion-rewards']").click();
  });
  await sleep(500);
  check("重新打开体感开关", await page.evaluate(() => JSON.parse(localStorage.getItem("dailyWritingPcStateV3")).fitness.motion.enabled === true));

  /* ---------------- 7. 刷新后数据保留 ---------------- */
  console.log("\n== 7. 刷新后记录保留 ==");
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  const afterReload = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    return { module: st.module, count: st.fitness.motion.scores.length, total: st.fitness.motion.scores[0] && st.fitness.motion.scores[0].total };
  });
  check("刷新后仍在体能模块", afterReload.module === "fitness");
  check("刷新后体感记录还在", afterReload.count === 1, `动作分 ${afterReload.total}`);

  /* ---------------- 8. 写作模块不该出现体感项 ---------------- */
  console.log("\n== 8. 写作模块隔离 ==");
  await page.evaluate(() => document.getElementById("moduleSwitchBtn").click());
  await sleep(400);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="write"]').click());
  await sleep(600);
  const writeNav = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".nav-item")].filter(i => !i.classList.contains("hidden"));
    return {
      writeCount: items.filter(i => i.dataset.module === "write").length,
      hasMotion: items.some(i => i.dataset.view === "fitnessMotion" || i.dataset.view === "fitnessReport")
    };
  });
  check("写作模块不出现体感导航", !writeNav.hasMotion);
  check("写作导航仍为 9 项", writeNav.writeCount === 9, `${writeNav.writeCount} 项`);

  /* ---------------- 9. 骨架几何：喂一个合成人体，看关节落在哪 ----------------
     假摄像头那个方块只能证明"有东西被画出来了"，证明不了骨架画对了。
     这里另外造一个**有头、有躯干、有四肢、两腿分开**的人形喂给引擎，
     再检查关节点是不是落在该在的位置、上下左右顺序对不对。
     人形整体上下平移，用来验证骨架确实跟着身体走。 */
  console.log("\n== 9. 骨架几何（合成人体） ==");
  await page.evaluate(() => {
    const CW = 128, CH = 96;
    const cv = document.createElement("canvas");
    cv.width = CW; cv.height = CH;
    const g = cv.getContext("2d");

    // 归一化坐标画人形：头 / 躯干 / 双臂 / 双腿（两腿之间留空隙，测分簇）。
    // dy 是测试给的基准位移；另外叠一个持续的小幅摆动，这样"正在动"的
    // 帧间差一直存在，能验证关节点会被运动能量点亮。
    const t0 = performance.now();
    function draw(base) {
      const t = (performance.now() - t0) / 1000;
      const dy = base + Math.sin(t * 2 * Math.PI * 1.2) * 0.02;
      g.fillStyle = "#3c3c3c"; g.fillRect(0, 0, CW, CH);
      g.fillStyle = "#e8e8e8";
      const box = (x, y, w, h) => g.fillRect(x * CW, (y + dy) * CH, w * CW, h * CH);
      g.beginPath();
      g.arc(0.5 * CW, (0.09 + dy) * CH, 0.055 * CW, 0, Math.PI * 2);
      g.fill();
      box(0.43, 0.13, 0.14, 0.40);     // 躯干
      box(0.34, 0.17, 0.10, 0.26);     // 左臂
      box(0.56, 0.17, 0.10, 0.26);     // 右臂
      box(0.40, 0.53, 0.07, 0.41);     // 左腿
      box(0.53, 0.53, 0.07, 0.41);     // 右腿
    }

    draw(0);
    const eng = window.MotionEngine.createEngine();
    eng.attach(cv);
    eng.setProfile({ mode: "rep", signal: "centroidY" });
    window.__skTest = { dy: 0, target: 0, skel: null };
    const tick = () => {
      // 位移平滑趋近目标（模拟真人连续下蹲，而不是瞬移）
      window.__skTest.dy += (window.__skTest.target - window.__skTest.dy) * 0.12;
      draw(window.__skTest.dy);
      const st = eng.getState();
      if (st.skeleton && st.skeleton.has) window.__skTest.skel = st.skeleton;
      requestAnimationFrame(tick);
    };
    eng.preview();
    tick();
  });
  await sleep(1200);
  const skelA = await page.evaluate(() => window.__skTest.skel);

  await page.evaluate(() => { window.__skTest.target = 0.10; });
  await sleep(2000);
  const skelB = await page.evaluate(() => window.__skTest.skel);

  const J = (s, n) => (s && s.joints && s.joints[n]) || null;
  check("合成人体被认出来", !!skelA && skelA.has && skelA.area > 0.05,
    skelA ? `面积 ${(skelA.area * 100).toFixed(1)}%` : "无");
  /* 关节数是"下界"而不是定值：引擎在识别到张开的双臂时会额外生成
   * elbow / wrist / fore / hand 等关节（最多 24 个），旧断言写死 14/15
   * 会因正常的关节数增长而误报。这里只要求"基础关节齐全"。 */
  check("关节点齐全（≥14 个可见关节 + ≥15 个总关节）",
    !!skelA && skelA.jointCount >= 15 && skelA.visibleJointCount >= 14,
    skelA ? `${skelA.jointCount} 个（可见 ${skelA.visibleJointCount}）` : "无");
  check("包围盒与人形对得上", !!skelA && skelA.bbox && skelA.bbox.w > 0.25 && skelA.bbox.w < 0.40
    && skelA.bbox.h > 0.80 && skelA.bbox.h < 0.98,
    skelA && skelA.bbox ? `w=${skelA.bbox.w.toFixed(2)} h=${skelA.bbox.h.toFixed(2)}` : "");

  // 上下顺序：头 → 颈 → 胯 → 膝 → 踝
  const chain = ["head", "neck", "hipMid", "kneeL", "ankleL"].map(n => J(skelA, n));
  check("关节上下顺序正确（头→颈→胯→膝→踝）",
    chain.every(Boolean) && chain.every((p, i) => i === 0 || p.y > chain[i - 1].y),
    chain.map((p, i) => `${["头", "颈", "胯", "膝", "踝"][i]}=${p ? p.y.toFixed(2) : "—"}`).join(" "));

  // 左右顺序：左肩 < 颈 < 右肩
  const shL = J(skelA, "shoulderL"), shR = J(skelA, "shoulderR"), nk = J(skelA, "neck");
  check("左右肩分居颈两侧", !!shL && !!shR && !!nk && shL.x < nk.x && shR.x > nk.x,
    shL ? `左肩 ${shL.x.toFixed(2)} / 颈 ${nk.x.toFixed(2)} / 右肩 ${shR.x.toFixed(2)}` : "");

  // 两腿分簇：膝/踝应该落在两条腿各自的中心，而不是整个人形的外边界
  const knL = J(skelA, "kneeL"), knR = J(skelA, "kneeR");
  check("两条腿被分开识别（分簇生效，膝点各自落在一条腿上）",
    !!knL && !!knR && knL.x < 0.47 && knR.x > 0.53 && (knR.x - knL.x) > 0.06,
    knL ? `左膝 ${knL.x.toFixed(2)} / 右膝 ${knR.x.toFixed(2)}` : "");

  const anL = J(skelA, "ankleL"), anR = J(skelA, "ankleR");
  check("踝点也在各自腿上", !!anL && !!anR && anL.x < 0.48 && anR.x > 0.52,
    anL ? `左踝 ${anL.x.toFixed(2)} / 右踝 ${anR.x.toFixed(2)}` : "");

  check("所有关节都落在画面内", !!skelA && Object.values(skelA.joints).every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));

  // 人形整体下移 10%，头点应该跟着下移
  const headA = J(skelA, "head"), headB = J(skelB, "head");
  check("人形下移时骨架跟着下移（骨架真的在跟人）",
    !!headA && !!headB && (headB.y - headA.y) > 0.04,
    headA && headB
      ? `头 ${headA.y.toFixed(3)} → ${headB.y.toFixed(3)}；包围盒 h ${skelA.bbox.h.toFixed(2)} → ${skelB.bbox.h.toFixed(2)}，阈值 ${skelB.maskThresh}（otsu ${skelB.otsuRaw} / 前景 ${skelB.fgRatio}）`
      : "");

  // 运动能量：躯干在动，关节点应该被点亮
  check("关节点带运动能量（正在动的部位会被点亮）",
    !!skelA && Object.keys(skelA.joints).some(n => (J(skelA, n).energy || 0) > 0.05),
    skelA ? Object.keys(skelA.joints).map(n => `${n}:${J(skelA, n).energy}`).slice(0, 5).join(" ") : "");

  /* ---------------- 汇总 ---------------- */
  console.log("\n== 控制台错误 ==");
  if (errors.length) errors.forEach(e => console.log("  " + e));
  check("无控制台报错 / 页面异常", errors.length === 0, errors.length ? `${errors.length} 条` : "");

  console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { console.log("失败项："); fail.forEach(f => console.log("  - " + f)); }

  await browser.close();
  fs.unlinkSync(Y4M);
  process.exit(fail.length ? 1 : 0);
})().catch(err => {
  console.error("测试崩溃：", err);
  try { fs.unlinkSync(Y4M); } catch (e) { /* 忽略 */ }
  process.exit(2);
});
