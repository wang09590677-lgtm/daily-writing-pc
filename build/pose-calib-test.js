// 开场骨骼校准 + 默认摄像头 端到端测试（真实 Chrome）
//
// 测三件事：
//   1. 点「开启摄像头」后默认选中 Astra Pro（不是笔记本内置头）
//   2. 自动进入全屏骨骼校准界面，并且「开始跟练」一开始是灰的
//   3. 站位评分 / 语音引导指令随人形位置变化：偏左报左、太小报走近、
//      没进画面报退后、站好了才锁定放行
//
// 人形是合成的深度网格喂进去的（不走摄像头画面），所以判定完全可复现：
// 骨架来自 depthPersonMask → extractSkeleton，evaluatePose 只看这个结果。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--allow-file-access-from-files",
      "--window-size=1440,900"
    ]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 600));

  // ---------- 1. 默认摄像头 ----------
  const camInfo = await page.evaluate(async () => {
    // 用一块静止画布当"摄像头"，这样不依赖真实画面也能跑通流程
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    // 画布不动时 captureStream 会停帧，video.play() 的 Promise 就一直不 settle。
    // 真实摄像头不会这样，所以这里定时补一笔，把流喂住。
    setInterval(() => {
      cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
      cx.fillRect((Date.now() / 40) % 640, 0, 2, 2);
    }, 33);
    window.__lastConstraints = null;
    navigator.mediaDevices.getUserMedia = async (c) => {
      window.__lastConstraints = c;
      return window.__fakeStream;
    };
    setView("fitnessMotion");
    await motionCamRefresh();
    await motionCamEnsureDefault();
    return {
      picked: motionCam.label,
      id: motionCam.id,
      list: motionCamList.map(d => d.label),
      hasAstra: motionCamList.some(d => /astra|orbbec|2bc5/i.test(d.label || ""))
    };
  });
  console.log("  摄像头列表:", camInfo.list.join(" | "));
  check("能枚举到摄像头", camInfo.list.length > 0, `${camInfo.list.length} 个`);
  if (camInfo.hasAstra) {
    check("默认选中的是 Astra（不是笔记本内置头）",
      /astra|orbbec|2bc5/i.test(camInfo.picked || ""), camInfo.picked);
    check("没落到笔记本内置头上", !/integrated|内置/i.test(camInfo.picked || ""), camInfo.picked);
  } else {
    console.log("  （这台机器没插 Astra，跳过设备名断言）");
  }

  // ---------- 2. 开摄像头 → 自动进校准 ----------
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await new Promise(r => setTimeout(r, 1200));

  const opened = await page.evaluate(() => ({
    constraints: window.__lastConstraints,
    calibVisible: !document.getElementById("poseCalib").classList.contains("hidden"),
    screenFull: document.getElementById("motionScreen").classList.contains("is-calib"),
    targetShown: !document.getElementById("poseTarget").classList.contains("hidden"),
    goDisabled: document.getElementById("poseCalibGo").disabled,
    startDisabled: document.getElementById("motionStartBtn").disabled,
    stream: !!motionStream
  }));
  check("摄像头开起来了", opened.stream === true);
  check("约束里锁的是 deviceId（不是 facingMode:'user'）",
    !!(opened.constraints && opened.constraints.video && opened.constraints.video.deviceId)
    && !opened.constraints.video.facingMode,
    JSON.stringify(opened.constraints && opened.constraints.video));
  check("自动进入骨骼校准界面", opened.calibVisible === true);
  check("画面被放大成全屏", opened.screenFull === true);
  check("显示站位目标框", opened.targetShown === true);
  check("校准期间「开始跟练」是灰的", opened.goDisabled === true);
  check("校准期间「开始这一组」也是灰的", opened.startDisabled === true);

  // ---------- 3. 合成深度喂进去，看评分与引导 ----------
  await page.evaluate(() => {
    // 彩色源换成一块静止的灰底画布：灰度永远分不出人，骨架只能来自深度，
    // 这样"评分变了"就一定是我们喂进去的深度在起作用。
    // （canvas.captureStream 在画布不动时会停帧，video.readyState 掉下来
    //  之后引擎就不采样了，所以这里直接把引擎的采样源换成画布本身。）
    const cv2 = document.createElement("canvas");
    cv2.width = 640; cv2.height = 480;
    const c2 = cv2.getContext("2d");
    c2.fillStyle = "#3a3a3a"; c2.fillRect(0, 0, 640, 480);
    window.__srcCanvas = cv2;

    const W = 96, H = 72;
    const grid = new Uint16Array(W * H);
    window.__setPerson = function (opt) {
      const o = Object.assign({ cx: 48, top: 8, h: 54, dist: 2200, wall: 5000, legs: true, arms: true }, opt || {});
      grid.fill(o.wall);
      const bottom = Math.min(H - 1, o.top + o.h);
      const halfLeg = Math.max(2, Math.round(o.legs ? (o.h * 0.10) : (o.h * 0.22)));
      const gap = o.legs ? 5 : 0;
      const legTop = o.top + Math.round(o.h * 0.55);
      const shoulderY = o.top + Math.round(o.h * 0.22);
      const armW = o.arms ? 16 : 9;
      for (let y = o.top; y <= bottom; y++) {
        let halfW;
        if (y < o.top + o.h * 0.13) halfW = Math.max(2, Math.round(o.h * 0.055));        // 头
        else if (y >= legTop) halfW = halfLeg + gap;                                      // 腿（两腿之间有空）
        else halfW = Math.max(3, Math.round(o.h * 0.13));                                 // 躯干
        if (y >= shoulderY && y <= shoulderY + Math.round(o.h * 0.22)) halfW = Math.max(halfW, armW);
        for (let x = o.cx - halfW; x <= o.cx + halfW; x++) {
          if (x < 0 || x >= W) continue;
          if (y >= legTop && gap && Math.abs(x - o.cx) <= gap - 2) continue;   // 两腿之间的缝
          grid[y * W + x] = o.dist;
        }
      }
    };
    window.__setPerson({});
    const fake = {
      available: function () { return true; },
      grid: function () { return grid; },
      stats: function () { return { status: "open", fps: 15, validRatio: 0.9 }; },
      onStatus: function () {}, connect: function () {}, close: function () {}
    };
    motionEngine.attachDepth(fake);
    motionEngine.attach(cv2);
    window.__fakeDepth = fake;
  });

  const readPose = () => page.evaluate(() => {
    const p = motionEngine.getPose();
    return {
      seen: !!(p && p.seen), score: p ? p.score : 0, locked: !!(p && p.locked),
      guide: p ? p.guide : "", text: p ? p.guideText : "",
      voice: motionPoseVoice(p),
      guideText: document.getElementById("poseGuide").textContent,
      scoreText: document.getElementById("poseScoreNum").textContent,
      goDisabled: document.getElementById("poseCalibGo").disabled,
      goText: document.getElementById("poseCalibGo").textContent,
      calibVisible: !document.getElementById("poseCalib").classList.contains("hidden"),
      calib: { active: motionCalib.active, hold: Math.round(motionCalib.hold), passed: motionCalib.passed, guideKey: motionCalib.guideKey },
      badge: document.getElementById("motionBadge").textContent,
      hint: document.getElementById("motionHint").textContent,
      engine: !!motionEngine, tickBound: motionTickBound,
      liveFps: motionEngine ? Math.round(motionEngine.getLive().fps) : -1,
      srcW: motionEngine ? (document.getElementById("motionVideo").videoWidth) : -1
    };
  });

  async function scenario(name, opt, waitMs) {
    await page.evaluate(o => window.__setPerson(o), opt);
    await new Promise(r => setTimeout(r, waitMs || 1200));
    const p = await readPose();
    console.log(`  [${name}] seen=${p.seen} score=${p.score} locked=${p.locked} guide=${p.guide} voice=${p.voice}`
      + `\n       calib=${JSON.stringify(p.calib)} go="${p.goText}" disabled=${p.goDisabled} 屏幕分数=${p.scoreText}`
      + ` | engine=${p.engine} tickBound=${p.tickBound} fps=${p.liveFps} badge="${p.badge}" hint="${p.hint}"`);
    return p;
  }

  /* 空房扫描要先"看到空房间"才会推进（引擎要求帧数与时长同时满足）。
   * 本测试从第一帧起就让合成人形站在画面里，扫描永远不满 ——
   * 而 motionCalibTick 在 roomScan.phase === "scanning" 时会提前 return，
   * 保持进度（hold）因此恒为 0，"按钮亮起"这条断言就永远过不了。
   *
   * 这里点「跳过」：它是产品里真实存在的入口（孩子/家长想直接练时用的），
   * 不是为测试开的后门。跳过之后校准评分才开始累计保持时间。 */
  await page.evaluate(() => {
    const skip = document.getElementById("roomScanSkip");
    if (skip) skip.click();
  });
  await new Promise(r => setTimeout(r, 400));

  // 最佳窗口 2~3.5 米，标准场景用 2.5 米
  const good = await scenario("站得好（2.5 米）", { cx: 48, top: 8, h: 55, dist: 2500 }, 2600);
  check("站得好时能识别到人", good.seen === true, `score=${good.score}`);
  check("站得好时评分达标（≥82）", good.score >= 82, `score=${good.score}`);
  /* 稳住 1.5 秒（POSE_HOLD_MS）才算锁定。上面那 2.6 秒采样窗口不够：
   * 扣掉空房扫描跳过后背景收敛的时间，hold 未必累满。再等一会儿，明确地等。 */
  await new Promise(r => setTimeout(r, 2000));
  const held = await page.evaluate(() => ({
    hold: Math.round(motionCalib.hold),
    passed: motionCalib.passed,
    goDisabled: document.getElementById("poseCalibGo").disabled,
    prepping: (() => { const d = window.__motionDebug(); return d ? d.prepping : null; })()
  }));
  check("站得好并稳住后自动放行（按钮亮起）", held.goDisabled === false,
    `hold=${held.hold}ms passed=${held.passed} prepping=${held.prepping}`);

  /* 锁定之后会自动进入「准备开练」（口令 + 数 3、2、1），这是本轮的新行为。
   * 认到 prepping 就说明自动开练真的被触发了 —— 孩子不用跑过来点按钮。 */
  let autoSeen = false;
  for (let i = 0; i < 12; i++) {
    autoSeen = await page.evaluate(() => {
      const d = window.__motionDebug();
      return !!(d && d.prepping);
    });
    if (autoSeen) break;
    await new Promise(r => setTimeout(r, 300));
  }
  check("锁定后自动进入准备开练（不需要点按钮）", autoSeen === true);
  /* 把自动流程掐掉，后面还有一串"站位不对"的场景要测，不能被开练打断 */
  await page.evaluate(() => {
    if (typeof motionFlowTeardown === "function") motionFlowTeardown();
  });
  await new Promise(r => setTimeout(r, 300));

  // 近处家具比远处人更靠近镜头：不能优先把家具当作人体，
  // 这是用户反馈的「站到约 2 米骨架突然跑到角落」可复现情形。
  const furniture = await page.evaluate(async () => {
    window.__setPerson({ cx: 48, top: 9, h: 49, dist: 2100, wall: 5000 });
    const grid = window.__fakeDepth.grid();
    for (let y = 47; y < 65; y++) for (let x = 3; x < 26; x++) grid[y * 96 + x] = 900;
    await new Promise(resolve => setTimeout(resolve, 1400));
    const sk = motionEngine.getState().skeleton;
    const live = motionEngine.getLive();
    return { has: sk.has, center: sk.bbox ? sk.bbox.x + sk.bbox.w / 2 : 0,
      dist: live.depthNear, area: sk.area };
  });
  check("2.1 米人体不被 0.9 米家具抢走骨架", furniture.has &&
    furniture.center > 0.36 && furniture.center < 0.64 &&
    furniture.dist > 1700 && furniture.dist < 2500,
    JSON.stringify(furniture));
  const alignment = await page.evaluate(() => {
    const video = document.getElementById("motionVideo");
    const overlay = document.getElementById("motionOverlay");
    const rules = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules); } catch (e) { return []; }
    });
    const mirror = sel => rules.find(rule => rule.selectorText === sel &&
      rule.style.transform === "scaleX(-1)");
    return {
      video: !!mirror(".motion-screen video"),
      overlay: !!mirror(".motion-screen canvas"),
      depthView: document.getElementById("motionScreen").classList.contains("is-depth-view"),
      videoHidden: getComputedStyle(video).visibility === "hidden"
    };
  });
  check("镜像同时作用视频与叠加层", alignment.video && alignment.overlay, JSON.stringify(alignment));
  /* 真实视频必须**始终可见** —— 叠加层恒用彩色坐标系，关节点直接画在
   * 孩子的真实影像上（2026-10-06 按用户要求改）。
   * ⚠️ 这条断言原本是反过来的（`depthView && videoHidden`，要求深度生效时藏视频），
   *    它对应的是「全黑底 + 青色线条」那个被用户否掉的方案。
   *    改需求后必须同步改断言，否则会拦着正确的实现。 */
  check("深度生效时真实视频仍可见（关节点叠在真实影像上）",
    !alignment.videoHidden, JSON.stringify(alignment));
  check("叠加层不再切深度剪影视图（is-depth-view 已废弃）",
    !alignment.depthView, JSON.stringify(alignment));
  await page.evaluate(() => window.__setPerson({ cx: 48, top: 8, h: 55, dist: 2500 }));

  await page.evaluate(() => { motionCalibOpen(); motionCalib.passed = false; motionCalib.hold = 0; motionCalib.okSince = 0; document.getElementById("poseCalibGo").disabled = true; });

  const left = await scenario("站偏左（图像左）", { cx: 20, top: 8, h: 55, dist: 2500 }, 1200);
  check("人偏图像左侧 → 提示往左边挪", left.voice === "left", `voice=${left.voice} text=${left.text}`);

  const right = await scenario("站偏右（图像右）", { cx: 78, top: 8, h: 55, dist: 2500 }, 1200);
  check("人偏图像右侧 → 提示往右边挪", right.voice === "right", `voice=${right.voice} text=${right.text}`);

  const small = await scenario("站太远（人很小）", { cx: 48, top: 22, h: 28, dist: 3800 }, 1200);
  check("人太小 → 提示往前走近", small.voice === "closer", `voice=${small.voice} text=${small.text}`);

  // 2 米内看不到全身，应该提示往后退
  const cut = await scenario("太近看不到全身", { cx: 48, top: 0, h: 85, dist: 1500 }, 1200);
  check("太近看不到全身时提示往后退", cut.voice === "back",
    `voice=${cut.voice} text=${cut.text}`);

  const nobody = await scenario("画面里没人", { cx: 48, top: 8, h: 54, dist: 5000, wall: 5000 }, 1200);
  check("画面里没人 → seen=false 且提示站到镜头前", nobody.seen === false && nobody.voice === "nobody",
    `seen=${nobody.seen} voice=${nobody.voice}`);

  const near = await scenario("离得太近", { cx: 48, top: 8, h: 85, dist: 1000 }, 1200);
  check("离镜头太近 → 提示往后退", near.voice === "back", `voice=${near.voice} text=${near.text}`);

  // ---------- 4. 跳过 ----------
  const skipped = await page.evaluate(() => {
    motionCalibOpen();          // 重新打开一次，确认「先跳过」按钮真的能收掉它
    document.querySelector("[data-action='pose-calib-skip']").click();
    return {
      hidden: document.getElementById("poseCalib").classList.contains("hidden"),
      screenFull: document.getElementById("motionScreen").classList.contains("is-calib"),
      startDisabled: document.getElementById("motionStartBtn").disabled
    };
  });
  check("点「先跳过」收掉校准界面", skipped.hidden === true);
  check("跳过之后画面恢复成页面内的小窗", skipped.screenFull === false);
  check("跳过之后「开始这一组」可用", skipped.startDisabled === false, `disabled=${skipped.startDisabled}`);

  // ---------- 5. 语音文件 ----------
  const voice = await page.evaluate(() => {
    window.VoiceGuide.warm();
    return { keys: window.VoiceGuide.keys().length, has: typeof window.VoiceGuide.say === "function" };
  });
  // 句数随功能增加：13 = 站位引导；+2 = 空房扫描（roomscan / roomok）。
  // 这里只断言"至少覆盖站位引导那 13 句"，避免每次加语音都要改硬编码数字。
  check("引导语音模块可用（≥13 句）", voice.has && voice.keys >= 13, `${voice.keys} 句`);

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    failed.forEach(f => console.log("  FAIL:", f.name, f.detail || ""));
    process.exit(1);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
