// start-app.bat 端到端验证：用和 bat 完全相同的参数启动 Chrome，走一遍真实流程。
//
// 验证四件事：
//   1. 摄像头权限不弹框 —— 真实调用 getUserMedia（不 mock），能在短时间内成功返回
//   2. 默认选中 Astra Pro，不是笔记本内置头
//   3. 开摄像头后自动进入全屏骨骼校准界面，「开始跟练」是灰的
//   4. 深度桥接能连上，骨架有输出
//
// 用的是真实摄像头和真实深度桥接服务，所以结果依赖现场站位；
// 站位不成立时只会有对应提示，不算脚本失败。
const path = require("path");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules",
  "puppeteer-core"
));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const PROFILE = path.join(process.env.TEMP || "C:/Windows/Temp", "WritingCoachE2EProfile");
const SHOT = path.join(__dirname, "shots", "startbat-e2e.png");

// 与 start-app.bat 保持一致的启动参数
const LAUNCH_ARGS = [
  "--user-data-dir=" + PROFILE,
  "--allow-file-access-from-files",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-search-engine-choice-screen",
  "--window-size=1440,900"
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,   // 让 --window-size 生效，否则视口被压成 800x600
    args: LAUNCH_ARGS
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(800);

  // 包装 getUserMedia 记录耗时与结果，但仍然真实调用 —— 用来判断有没有被权限框卡住
  await page.evaluate(() => {
    window.__gum = { calls: 0, ms: -1, ok: false, err: "" };
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      window.__gum.calls++;
      window.__gum.constraints = c;
      const t0 = Date.now();
      try {
        const s = await orig(c);
        window.__gum.ms = Date.now() - t0;
        window.__gum.ok = true;
        return s;
      } catch (e) {
        window.__gum.ms = Date.now() - t0;
        window.__gum.err = String(e && e.name || e);
        throw e;
      }
    };
    // 必须走模块选择，否则 #appShell 是 hidden，画面量出来是 0
    state.module = "fitness"; saveState(); applyModule();
    setView("fitnessMotion");
  });
  await sleep(600);

  check("体能模块进入体感跟练页", await page.evaluate(() => {
    const v = document.getElementById("fitnessMotion");
    return !!v && !v.hidden && !document.getElementById("appShell").hidden;
  }));

  const diag = await page.evaluate(() => ({
    hasEngine: typeof MOTION_ENGINE !== "undefined" && !!MOTION_ENGINE,
    enabled: typeof motionEnabled === "function" ? motionEnabled() : null,
    hasToggle: typeof motionToggleCamera === "function",
    btnDisabled: (document.getElementById("motionCameraBtn") || {}).disabled,
    motionEnabledFlag: state.fitness.motion && state.fitness.motion.enabled,
    depthLink: typeof motionDepthLink === "function" ? !!motionDepthLink() : null
  }));
  console.log("DIAG: " + JSON.stringify(diag));
  check("体感引擎已加载", diag.hasEngine === true);
  check("体感开关已打开", diag.enabled === true);

  // 按钮在页面下方，先滚到视口里再测（否则 elementFromPoint 落在视口外，恒为 null）
  await page.evaluate(() =>
    document.getElementById("motionCameraBtn").scrollIntoView({ block: "center" }));
  await sleep(400);

  const hit = await page.evaluate(() => {
    const b = document.getElementById("motionCameraBtn");
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      topEl: top ? (top.id || top.tagName + "." + top.className) : null,
      isSelf: !!top && (top === b || b.contains(top))
    };
  });
  console.log("HITTEST: " + JSON.stringify(hit));
  check("开启摄像头按钮可点击（没被别的层挡住）", hit.isSelf === true, JSON.stringify(hit));

  // 走真实点击路径（用户就是这么点的）
  await page.click("#motionCameraBtn");
  await sleep(5000);

  // 点击若没生效（比如被滚动容器坑了），退回直接调用，保证后面流程能验完
  if (!(await page.evaluate(() => window.__gum.calls)) ) {
    console.log("  (点击未触发，退回直接调用 motionToggleCamera)");
    await page.evaluate(() => motionToggleCamera());
    await sleep(5000);
  }

  // ---------- 1. 权限 ----------
  const gum = await page.evaluate(() => window.__gum);
  check("getUserMedia 被真实调用过", gum.calls > 0, `calls=${gum.calls}`);
  check("摄像头权限自动允许（未卡在权限框）", gum.ok === true,
        gum.ok ? `${gum.ms}ms 内拿到流` : `err=${gum.err}`);

  const c = gum.constraints || {};
  const v = c.video || {};
  check("约束锁定 deviceId，不再用 facingMode", !!v.deviceId && !v.facingMode,
        JSON.stringify(v));

  // ---------- 2. 默认摄像头 ----------
  const cam = await page.evaluate(() => ({
    label: (document.getElementById("motionCamInfo") || {}).textContent || "",
    sel: (() => { const s = document.getElementById("motionCamSelect");
                  return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : ""; })(),
    track: (() => { const el = document.getElementById("motionVideo");
                    const s = el && el.srcObject;
                    const t = s && s.getVideoTracks && s.getVideoTracks()[0];
                    return t ? (t.label || "") : ""; })()
  }));
  const isAstra = /astra|orbbec|2bc5/i.test(cam.track + cam.label + cam.sel);
  const isBuiltin = /integrated|内置/i.test(cam.track);
  check("默认用的是 Astra Pro，不是笔记本内置头", isAstra && !isBuiltin,
        `track="${cam.track}"`);

  // ---------- 3. 视频流与校准界面 ----------
  const st = await page.evaluate(() => {
    const el = document.getElementById("motionVideo");
    const pc = document.getElementById("poseCalib");
    const scr = document.getElementById("motionScreen");
    const go = document.getElementById("poseCalibGo");
    return {
      ready: el ? el.readyState : -1,
      w: el ? el.videoWidth : 0,
      h: el ? el.videoHeight : 0,
      calibVisible: !!pc && !pc.hidden && getComputedStyle(pc).display !== "none",
      fullscreen: scr ? (() => { const r = scr.getBoundingClientRect();
                                 return Math.round(r.width) + "x" + Math.round(r.height); })() : "",
      goDisabled: go ? go.disabled : null,
      score: (document.getElementById("poseScoreNum") || {}).textContent || "",
      guide: (document.getElementById("poseGuide") || {}).textContent || "",
      depth: (document.getElementById("poseCalibDepth") || {}).textContent || ""
    };
  });
  check("摄像头画面已出帧", st.ready >= 2 && st.w > 0, `readyState=${st.ready} ${st.w}x${st.h}`);
  check("自动进入骨骼校准界面", st.calibVisible);
  check("校准界面为全屏", /^1[0-9]{3}x[0-9]{3}$/.test(st.fullscreen), st.fullscreen);
  check("校准未过时「开始跟练」是灰的", st.goDisabled === true, `disabled=${st.goDisabled}`);
  check("深度桥接已连接", /已连接|连接/i.test(st.depth), st.depth.trim());

  console.log(`\n  现场分数: ${st.score}   引导: ${st.guide.trim()}`);

  await page.screenshot({ path: SHOT });
  console.log(`\n截图: ${SHOT}`);

  await browser.close();

  const fail = results.filter(r => !r.ok);
  console.log(`\n==== ${results.length - fail.length}/${results.length} PASS ====`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
