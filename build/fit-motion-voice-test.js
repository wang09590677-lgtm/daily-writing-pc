// 体感跟练「语音/提示音反馈」验收（真实 Chrome，file://）
//
// 用户需求原话：
//   「在运动时由于距离显示器远不方便看体感正确与否的反馈，需要增加体感的语音反馈，
//     具体要求是体感类计数的项目，比如开合跳、跳绳这种，每一次正确感应出动作后
//     有"滴"的一声提示音；其余计时的项目，在感应动作无效时不但要停止计时也要语音
//     报"动作不正确"，注意这个语音没有播报完的话不要立即重复播报，动作正确后就恢复计时」
//
// 落成三条链路：
//   A. 计次类（rep）：每正确完成一次动作「滴」一声（fitRepTick）。
//   B. 计时类（hold / burst）：动作无效（连续约 1.2 秒没动、且过了 3 秒宽限期）
//      → 停表提示（进度面板变灰）+ 语音「动作不正确」；恢复动作后继续。
//   C. 深度状态文案：从"未连接（像坏了）"改成"未开启（可选）"。
//
// ⚠️ 本页在 puppeteer 下被 Chrome 重度节流（实测 performance.now() 5 秒只涨 10ms），
//    所以**绝不写"等 N 秒看它自己触发"的断言**，也**绝不冻结 Date.now()**（会让页面里
//    一切计时失效）。本项目已验证的约定：直接验逻辑分支 —— 把无效起点人为拨老
//    （motionInvalidSince = monoNow() - 5000）、把宽限期拨到过去（motionSetStartAt
//    拨老），再手动喂一帧合成的 st 给 renderMotionLive(st)。
//
// ⚠️ 顶层 let/const 不是 window 属性 → page.evaluate 里要用变量名本身
//    （motionLastReps / motionRunning / motionInvalidSince ...），不要写 window.xxx。
//    顶层 function 声明**是** window 属性 → 可以把 fitRepTick 换成记录器来数"响了几声"。
//
// ⚠️ 音频替身的坑（本项目踩过）：window.speechSynthesis / window.Audio 是只读访问器，
//    必须用 Object.defineProperty 截获；替身对象**不能继承 HTMLMediaElement.prototype**
//    （会抛 Illegal invocation 把整页挂掉）。B2 节用独立的 setContent 沙箱加载真实的
//    voice-guide.js，避免替身 Audio 影响主页面里别的模块。
//
// 本测试必须串行跑，不要并行开多个 Chrome。
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required", "--no-proxy-server"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

  /* 断掉深度桥的 WebSocket：本机没跑 start-depth-bridge.bat 时它会持续报连接失败，
   * 那是既有环境噪声、与本功能无关（照抄 accept-motion-autonext.js 的桩）。 */
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) {
      if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("blocked");
      return new RWS(u, ...Array.prototype.slice.call(arguments, 1));
    };
    window.WebSocket.prototype = RWS.prototype;
  });

  /* ============ 0. 素材与 TEXT 兜底 ============ */
  console.log("\n== 0. 素材与 VoiceGuide.TEXT ==");
  const mp3 = path.join(ROOT, "assets", "coach", "guide-wrong.mp3");
  let mp3Size = 0;
  try { mp3Size = fs.statSync(mp3).size; } catch (e) { mp3Size = -1; }
  check("assets/coach/guide-wrong.mp3 存在且 > 5000 字节", mp3Size > 5000, `${mp3Size} 字节`);

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  const textWrong = await page.evaluate(() => {
    const t = window.VoiceGuide && window.VoiceGuide.TEXT && window.VoiceGuide.TEXT.wrong;
    return { type: typeof t, value: t, hasSayExclusive: !!(window.VoiceGuide && typeof window.VoiceGuide.sayExclusive === "function") };
  });
  check("VoiceGuide.TEXT.wrong 是非空字符串（否则 play() 直接 return）",
    textWrong.type === "string" && textWrong.value.length > 0, JSON.stringify(textWrong.value));
  check("VoiceGuide.sayExclusive 已导出", textWrong.hasSayExclusive === true);

  /* 页面侧脚手架：合成动作 + 合成 st 喂帧 + 记录器。
   * 记录器替换的是 window 上的顶层 function（fitRepTick）与 VoiceGuide.sayExclusive，
   * 不碰真实音频 —— 只数"调用了几次"。 */
  await page.evaluate(() => {
    window.__ticks = [];
    window.__wrong = [];
    window.fitRepTick = function (o) { window.__ticks.push(o || 0); };
    window.VoiceGuide.sayExclusive = function (k) { window.__wrong.push(k); return true; };

    window.__setChoice = function (mode) {
      motionChoice = {
        exId: mode === "rep" ? "jumpingJack" : "plank",
        profile: { id: "x", name: mode === "rep" ? "开合跳" : "平板支撑", emoji: "🤸",
          unit: mode === "rep" ? "次" : "秒", how: "", mode: mode },
        target: mode === "rep" ? 100 : 30, blockId: "", group: "main"
      };
      renderMotionReadouts();
    };
    window.__feed = function (over) {
      const st = Object.assign({
        reps: 0, mode: "rep", previewing: false, hasMotion: true,
        holdSeconds: 0, activeSeconds: 0, tempo: 0, amplitude: 0, symmetry: 0,
        activeRatio: 0, stability: 0, intensity: 0, hint: "", hintLevel: "info",
        live: {}, skeleton: {}, fps: 0
      }, over);
      renderMotionLive(st);
      return { ticks: window.__ticks.length, wrong: window.__wrong.length };
    };
  });

  /* ============ A. 计次类「滴」声 ============ */
  console.log("\n== A. 计次类：每正确完成一次动作「滴」一声 ==");

  const a1 = await page.evaluate(() => {
    __setChoice("rep");
    motionFeedbackReset();          // 新开一组等价的重置（motionLastReps = -1）
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "rep", reps: 0 });
    __feed({ mode: "rep", reps: 1 });
    __feed({ mode: "rep", reps: 2 });
    return window.__ticks.length;
  });
  check("A① rep 0→1→2 恰好响 2 次（一次动作一声）", a1 === 2, `实际 ${a1}`);

  const a2 = await page.evaluate(() => {
    motionFeedbackReset();
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "rep", reps: 3 });   // 首帧：只建基线
    __feed({ mode: "rep", reps: 3 });   // 没涨：不响
    return window.__ticks.length;
  });
  check("A② 首帧只初始化不响（reps 保持 3 喂两次 → 0 次）", a2 === 0, `实际 ${a2}`);

  const a3 = await page.evaluate(() => {
    motionFeedbackReset();
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "rep", reps: 0 });
    __feed({ mode: "rep", reps: 5, previewing: true });   // 预览态：不该响
    return window.__ticks.length;
  });
  check("A③ 预览态（previewing）reps 涨 → 不响", a3 === 0, `实际 ${a3}`);

  const a4 = await page.evaluate(() => {
    __setChoice("hold");
    motionFeedbackReset();
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "hold", reps: 0, hasMotion: true });
    __feed({ mode: "hold", reps: 5, hasMotion: true });   // 计时类不该有滴声
    return window.__ticks.length;
  });
  check("A④ 计时类（hold）reps 涨 → 不响", a4 === 0, `实际 ${a4}`);

  const a5 = await page.evaluate(() => {
    __setChoice("rep");
    motionFeedbackReset();
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "rep", reps: 0 });
    __feed({ mode: "rep", reps: 20 });   // 增量 20 > 5 → 只响一声
    return window.__ticks.length;
  });
  check("A⑤ 增量 > 5（引擎被重置）只响 1 次，不连响一串", a5 === 1, `实际 ${a5}`);

  const a6 = await page.evaluate(() => {
    // 承接 A⑤（motionLastReps = 20）→ 新开一组把基线归零
    motionFeedbackReset();
    motionRunning = true;
    window.__ticks = [];
    __feed({ mode: "rep", reps: 0 });    // 归零后第一帧：只建基线，不响
    return { ticks: window.__ticks.length, baseline: motionLastReps };
  });
  check("A⑥ 新开一组后基线归零（喂 reps:0 不响，基线=0）",
    a6.ticks === 0 && a6.baseline === 0, `ticks=${a6.ticks} baseline=${a6.baseline}`);

  /* ============ B. 计时类「动作无效」判定与语音 ============ */
  console.log("\n== B. 计时类：动作无效 → 停表 + 语音「动作不正确」==");

  const b1 = await page.evaluate(() => {
    __setChoice("hold");
    motionFeedbackReset();
    motionRunning = true;
    window.__wrong = [];
    motionSetStartAt = monoNow() - 10000;      // 宽限期拨到过去
    motionInvalidSince = monoNow() - 5000;     // 无效计时拨老（早已超过防抖 1.2s）
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    return { wrong: window.__wrong.length, keys: window.__wrong.slice(), flag: motionInvalidFlag };
  });
  check("B① hold + 无效 + 超防抖 + 过宽限 → 播一次 wrong 且置无效标记",
    b1.wrong === 1 && b1.keys[0] === "wrong" && b1.flag === true, JSON.stringify(b1));

  const b2 = await page.evaluate(() => {
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    return window.__wrong.length;
  });
  check("B② 无效状态持续再喂若干帧 → 不重复播报（调用次数不增加）", b2 === 1, `实际 ${b2}`);

  const b3 = await page.evaluate(() => {
    __feed({ mode: "hold", hasMotion: true, holdSeconds: 8 });   // 动作恢复正确
    const flagAfterRecover = motionInvalidFlag;
    motionInvalidSince = monoNow() - 5000;                       // 再次无效并拨老
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    return { flagAfterRecover, wrong: window.__wrong.length };
  });
  check("B③ 动作恢复后标记清除，再次无效又能播（不是永久哑掉）",
    b3.flagAfterRecover === false && b3.wrong === 2, JSON.stringify(b3));

  const b4 = await page.evaluate(() => {
    __setChoice("rep");
    motionFeedbackReset();
    motionRunning = true;
    window.__wrong = [];
    motionSetStartAt = monoNow() - 10000;
    motionInvalidSince = monoNow() - 5000;
    __feed({ mode: "rep", hasMotion: false, reps: 0 });
    __feed({ mode: "rep", hasMotion: false, reps: 0 });
    return window.__wrong.length;
  });
  check("B④ 计次类（rep）无效多久 → 都不播 wrong", b4 === 0, `实际 ${b4}`);

  const b5 = await page.evaluate(() => {
    __setChoice("hold");
    motionFeedbackReset();
    motionRunning = true;
    window.__wrong = [];
    motionSetStartAt = monoNow();               // 刚开跑：还在 3 秒宽限期内
    motionInvalidSince = monoNow() - 5000;      // 即便计时很老，宽限期也要挡住
    __feed({ mode: "hold", hasMotion: false, holdSeconds: 0 });
    return { wrong: window.__wrong.length, flag: motionInvalidFlag };
  });
  check("B⑤ 刚开跑宽限期内无效 → 不播（不立刻骂孩子）",
    b5.wrong === 0 && b5.flag === false, JSON.stringify(b5));

  /* ============ B2. 真验 voice-guide.js 的 sayExclusive（不打断重播）============
   * 用独立沙箱 setContent 加载磁盘上的真实 voice-guide.js，并把 window.Audio 换成
   * 可控替身（Object.defineProperty 截获只读访问器；替身不继承 HTMLMediaElement）。 */
  console.log("\n== B2. VoiceGuide.sayExclusive：正在播就不打断重播 ==");
  const vgSrc = fs.readFileSync(path.join(ROOT, "voice-guide.js"), "utf8");
  const sandbox = await browser.newPage();
  sandbox.setDefaultTimeout(15000);
  sandbox.on("pageerror", e => errors.push("SANDBOX PAGEERROR: " + e.message));
  const harness = `<!DOCTYPE html><html><body><script>
    window.__playCalls = 0;
    window.__lastEl = null;
    function FakeAudio() {
      var el = {
        paused: true, ended: false, currentTime: 0, duration: 0.05,
        readyState: 4, error: null, volume: 1, preload: "", src: "",
        play: function () { this.paused = false; this.ended = false; this.currentTime = 0.01; window.__playCalls++; return Promise.resolve(); },
        pause: function () { this.paused = true; },
        load: function () {}
      };
      window.__lastEl = el;
      return el;
    }
    Object.defineProperty(window, "Audio", { configurable: true, get: function () { return FakeAudio; } });
    try {
      Object.defineProperty(window, "speechSynthesis", { configurable: true,
        get: function () { return { speaking: false, cancel: function () {}, speak: function () {} }; } });
    } catch (e) {}
  </script>
  <script>${vgSrc}</script></body></html>`;
  await sandbox.setContent(harness, { waitUntil: "load" });
  await sleep(120);

  const s1 = await sandbox.evaluate(() => {
    const r = window.VoiceGuide.sayExclusive("wrong");
    return { r, calls: window.__playCalls, busy: window.VoiceGuide.__busy("wrong") };
  });
  check("B2① 首次 sayExclusive('wrong') → true 且 play() 调用 1 次",
    s1.r === true && s1.calls === 1, JSON.stringify(s1));

  const s2 = await sandbox.evaluate(() => {
    const r = window.VoiceGuide.sayExclusive("wrong");   // 立刻再调：正在播 → 不打断
    return { r, calls: window.__playCalls };
  });
  check("B2② 立刻再调 → false 且 play() 次数仍是 1（没有打断重播）",
    s2.r === false && s2.calls === 1, JSON.stringify(s2));

  // 模拟"播完了"：替身置为 paused/ended，并等时长窗口（50ms 时长 + 150ms 余量）过去
  await sandbox.evaluate(() => { const el = window.__lastEl; el.paused = true; el.ended = true; el.currentTime = 0; });
  await sleep(400);
  const s3 = await sandbox.evaluate(() => {
    const r = window.VoiceGuide.sayExclusive("wrong");
    return { r, calls: window.__playCalls, busy: window.VoiceGuide.__busy("wrong") };
  });
  check("B2③ 播完（paused/ended + 时长窗口过去）后再调 → true 且 play() 变 2 次",
    s3.r === true && s3.calls === 2, JSON.stringify(s3));
  await sandbox.close();

  /* ============ C. 深度文案（孩子可见的那一行）============ */
  console.log("\n== C. 深度状态文案 ==");
  const depthText = await page.evaluate(() => ({
    chip: (document.getElementById("motionDepthChip") || {}).textContent || "",
    chipTitle: (document.getElementById("motionDepthChip") || {}).title || "",
    calib: (document.getElementById("poseCalibDepth") || {}).textContent || "",
    calibTitle: (document.getElementById("poseCalibDepth") || {}).title || ""
  }));
  check("motionDepthChip 初始文案是中性「深度：未开启」（不是「未连接」）",
    /未开启/.test(depthText.chip) && !/未连接/.test(depthText.chip), depthText.chip);
  check("poseCalibDepth 初始文案是「深度：未开启」",
    /未开启/.test(depthText.calib) && !/未连接/.test(depthText.calib), depthText.calib);
  check("深度 chip 的 title 说明了「可选 + 怎么开」",
    /可选/.test(depthText.chipTitle) && /start-depth-bridge/.test(depthText.chipTitle), depthText.chipTitle.slice(0, 40));

  /* ============ 截图：无效态下的进度面板（必须真看一眼）============ */
  console.log("\n== 截图：无效态进度面板 ==");
  // 先进体能模块、再切到体感视图（setView 会因离开旧视图触发 teardown 清状态，
  // 所以无效态必须在切完视图之后再摆）
  await page.evaluate(() => {
    const card = document.querySelector('.chooser-card[data-module="fitness"]');
    if (card) card.click();
  });
  await sleep(500);
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion");
    if (nav) nav.click();
  });
  await sleep(500);
  await page.evaluate(() => {
    __setChoice("hold");
    motionRunning = true;
    motionSetStartAt = monoNow() - 10000;
    motionInvalidFlag = true;                 // 直接摆成"已判定无效"
    renderMotionProgress({ mode: "hold", hasMotion: false, holdSeconds: 12.5,
      activeSeconds: 0, reps: 0, previewing: false, live: {}, skeleton: {}, fps: 0 });
    // 进度面板在页面下半部分，滚到视野中央，截图才看得到"停住"的样子 + 深度 chip
    const box = document.getElementById("motionGoalProgress");
    if (box) box.scrollIntoView({ block: "center" });
  });
  await sleep(250);
  const shotState = await page.evaluate(() => {
    const box = document.getElementById("motionGoalProgress");
    const fill = document.getElementById("motionGoalFill");
    return {
      visible: !!box && !box.classList.contains("hidden"),
      border: box ? box.style.borderColor : "",
      bg: box ? box.style.background : "",
      fill: fill ? fill.style.background : "",
      num: (document.getElementById("motionGoalNum") || {}).textContent || "",
      depth: (document.getElementById("motionDepthChip") || {}).textContent || ""
    };
  });
  check("无效态进度面板可见且套上了「停住」的行内样式（灰底 + 灰进度条）",
    shotState.visible && shotState.border === "rgb(148, 163, 184)" &&
    shotState.bg === "rgb(226, 232, 240)" && shotState.fill === "rgb(148, 163, 184)",
    JSON.stringify(shotState));
  await page.screenshot({ path: path.join(SHOT, "motion-voice.png") });
  console.log("  截图已存 build/shots/motion-voice.png");

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");
  const unexpected = errors.filter(e => {
    if (/^PAGEERROR:/.test(e) || /^SANDBOX PAGEERROR:/.test(e)) return true;
    if (/ERR_REQUEST_RANGE_NOT_SATISFIABLE/.test(e)) return false;
    if (/Failed to load resource/.test(e)) return false;
    return true;
  });
  check("无意外控制台报错（JS 异常）", unexpected.length === 0, unexpected.length ? `${unexpected.length} 条` : "");

  console.log(`\nPASS ${pass.length}/${pass.length + fail.length}`);
  if (fail.length) console.log("失败项：" + fail.join(" | "));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
