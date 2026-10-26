// 体感「锁定后自动开练 + 语音倒计时」验收（真实 Chrome）
//
// 用户需求原话：
//   「体感的时候我是在远离电脑的位置的，无法在体感识别后立即过来选择启动运动的
//     项目，所以应该的逻辑是体感感应好了之后自动启动这个动作的运动，而且也应该
//     先语音提示 "开始**动作" 倒计时数 3 秒后自动开始」
//
// 所以要验四件事：
//   1. 站位锁定后**不再需要点按钮**：自动进入「准备开练」流程
//   2. 口令文案就是「准备开始进行XX」（音源 ready-<exId>.mp3）
//   3. 屏幕上真的出现 3 → 2 → 1 → 开始，而且这时画面还是全屏的
//      （孩子站在两三米外，缩回小窗就等于看不见）
//   4. 数到"开始"之后自动开跑：引擎转正式计时（previewing=false）、
//      按钮变「进行中…」、结束按钮可用
//
// 另外要守住两条不能倒退的既有行为：
//   * 手动点「开始跟练」仍然有效（自动流程失败时的人工兜底）
//   * 切页时口令必须被掐断，不能换到别的页面还在念
//
// ---- 两个容易踩的坑（都实测过）----
//
// A. **音频必须能被断言**。人声是从 mp3 播的，测试"听"不到。
//    这里用 Object.defineProperty 把 window.Audio 换成能记账的替身，
//    记录「谁在什么时候播了」。注意 window.Audio 在部分环境是只读访问器，
//    直接赋值会被静默忽略 —— 必须 defineProperty。
//
// B. **不能用 URL 上的 ?motionPrep=0 来测这条链路**。那个开关是给别的回归
//    图省事用的（跳过口令直接开跑）。本测试要验的恰恰是口令本身，
//    所以走**默认路径**，并且额外断言 ?motionPrep=0 下 prepDisabled 为真，
//    证明这个测试捷径真的生效、别的回归不会被 8 秒口令拖住。
//
// C. **真实照片是近景构图，直接喂进站位框会被判"人太大"**。第 7 节走主链路
//    （真实 MediaPipe 骨架），样本是 build/fixtures/pose-human.png —— 它人占
//    画面高 83%，站位评分给 guide="back"，于是"分够了(84)但不锁定"，自动开练
//    永远不触发。这不代表产品有 bug：孩子真实站位在 2~3 米外，本来就比这张
//    近景照片小得多。解法 = 把 33 点按 scale = 0.62 / bbox.h 等比缩到画面中心
//    再喂（模拟"孩子站到 2.5 米"），测的仍是同一条主链路。
//
// 第 1~6 节站位人形是合成深度网格喂进去的（走**深度回退链路**，不走真实摄像头
// 画面），判定可复现；第 7 节单独喂真实照片的 33 关键点走**真实骨架主链路**。
// 两条链路产出的字段同构，只测一条就断言"自动开练能用"是靠不住的。
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}

(async () => {
  // Chrome 专用 profile 关掉后仍会短暂持文件句柄，放 tmp 并重试删除
  const profileDir = path.join(os.tmpdir(), "wbc-autostart-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--allow-file-access-from-files",
      "--user-data-dir=" + profileDir,
      "--window-size=1440,900"
    ]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async function () {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); }
    }
  };

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => { errors.push(e.message); console.log("PAGEERROR:", e.message); });

  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(600);

  /* ---------- 0. 装一个能记账的 Audio 替身 ----------
   * 必须在任何音频被创建之前装好，否则"谁播了什么"就漏掉了。
   *
   * 关键坑：替身**不能**写成 Object.create(RealAudio.prototype)。
   * HTMLMediaElement 的 src / volume / currentTime 是原生访问器，
   * 在原型链上继承过来之后，`this.src = "..."` 会以非原生对象为 this
   * 去调那个 setter，直接抛 "Illegal invocation"，整个页面报错。
   * 所以老实用普通对象，把需要的字段全做成自有属性。 */
  await page.evaluate(() => {
    window.__audioLog = [];
    function FakeAudio(src) {
      this._src = src || "";
      this.loop = false;
      this.volume = 1;
      this.preload = "";
      this.paused = true;
      this.currentTime = 0;
      this.readyState = 4;
      this.duration = 0.6;          // 口令短一点，测试跑得快
      this._listeners = {};
      const self = this;
      window.__audioLog.push({ ev: "create", src: String(src || "").split("/").pop() });
      this.play = function () {
        self.paused = false;
        window.__audioLog.push({ ev: "play", src: String(self._src || "").split("/").pop(), t: Math.round(performance.now()) });
        // 立刻发 loadedmetadata/durationchange，让 cueDuration() 马上拿到时长
        setTimeout(function () {
          (self._listeners.loadedmetadata || []).forEach(fn => fn());
          (self._listeners.durationchange || []).forEach(fn => fn());
        }, 0);
        return Promise.resolve();
      };
      this.pause = function () {
        self.paused = true;
        window.__audioLog.push({ ev: "pause", src: String(self._src || "").split("/").pop() });
      };
      this.load = function () {};
      this.addEventListener = function (type, fn) {
        (self._listeners[type] = self._listeners[type] || []).push(fn);
      };
      this.removeEventListener = function (type, fn) {
        const arr = self._listeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    }
    // src 用普通属性访问器：读出来要带上目录，才能和真实 Audio 的 src 形态一致
    Object.defineProperty(FakeAudio.prototype, "src", {
      configurable: true,
      get: function () { return this._src; },
      set: function (v) { this._src = String(v == null ? "" : v); }
    });
    Object.defineProperty(window, "Audio", {
      configurable: true, writable: true, value: FakeAudio
    });

    // ---- 合成深度：站位好、可复现（与 pose-calib-test 同一套做法）----
    const W = 96, H = 72;
    const grid = new Float32Array(W * H);
    window.__setPerson = function (o) {
      grid.fill(0);
      if (!o || !o.cx) return;
      const wall = o.wall || 6000;
      for (let i = 0; i < grid.length; i++) grid[i] = wall;
      const bodyW = Math.max(4, Math.round(o.h * 0.32));
      const gap = Math.round(bodyW * 0.16);
      const legTop = Math.round(o.top + o.h * 0.55);
      const shoulderY = Math.round(o.top + o.h * 0.22);
      const armW = Math.round(o.h * 0.46);
      const halfLeg = Math.round((bodyW - gap) / 2);
      for (let y = Math.round(o.top); y < Math.round(o.top + o.h); y++) {
        if (y < 0 || y >= H) continue;
        let halfW;
        if (y < o.top + o.h * 0.13) halfW = Math.max(2, Math.round(o.h * 0.055));
        else if (y >= legTop) halfW = halfLeg + gap;
        else halfW = Math.max(3, Math.round(o.h * 0.13));
        if (y >= shoulderY && y <= shoulderY + Math.round(o.h * 0.22)) halfW = Math.max(halfW, armW);
        for (let x = o.cx - halfW; x <= o.cx + halfW; x++) {
          if (x < 0 || x >= W) continue;
          if (y >= legTop && gap && Math.abs(x - o.cx) <= gap - 2) continue;
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
    window.__fakeDepth = fake;

    // 摄像头替身：不做真实 getUserMedia，省掉权限与冷启动的不确定性
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => {
      cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
      cx.fillRect((Date.now() / 40) % 640, 0, 2, 2);
    }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
  });

  await page.evaluate(() => setView("fitnessMotion"));
  await sleep(300);

  /* ---------- 1. 开摄像头 → 校准就位 ---------- */
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  /* 彩色源换成静止灰底画布：灰度永远分不出人，骨架只能来自深度，
   * 这样"评分变了"就一定是我们喂进去的深度在起作用。
   * （canvas.captureStream 在画布不动时会停帧，video.readyState 掉下来
   *  之后引擎就不采样了，所以直接把引擎的采样源换成画布本身。）
   *
   * ★ 必须直接写 `motionEngine`，不能写 `window.motionEngine`：
   *   app.js 是用顶层 `let motionEngine = null` 声明的，顶层 let/const
   *   只活在全局**词法**作用域里，不会成为 window 的属性 ——
   *   写成 window.motionEngine 会恒为 undefined，然后被 if 保护静默跳过，
   *   表现就是"深度喂进去了但引擎根本没看到人"，极难查。
   *   page.evaluate 的代码是在页面全局作用域里跑的，直接写名字就能拿到。 */
  await page.evaluate(() => {
    const cv2 = document.createElement("canvas");
    cv2.width = 640; cv2.height = 480;
    const c2 = cv2.getContext("2d");
    c2.fillStyle = "#3a3a3a"; c2.fillRect(0, 0, 640, 480);
    window.__srcCanvas = cv2;
    // 先接深度再换画面源（与已验证的 pose-calib-test 同序）
    motionEngine.attachDepth(window.__fakeDepth);
    motionEngine.attach(cv2);
  });
  await sleep(400);

  const opened = await page.evaluate(() => ({
    calib: !document.getElementById("poseCalib").classList.contains("hidden"),
    full: document.getElementById("motionScreen").classList.contains("is-calib"),
    prepShown: !document.getElementById("posePrep").classList.contains("hidden"),
    d: window.__motionDebug()
  }));
  check("开摄像头后进入站位校准，且准备工作尚未开始",
    opened.calib && !opened.prepShown, `calib=${opened.calib} prep=${opened.prepShown}`);

  /* ---------- 2. 站到好位置 → 自动进入准备流程 ---------- */
  console.log("\n== 2. 站位锁定后自动进入「准备开练」（不点任何按钮）==");

  /* 空房扫描要先"看到空房间"才会推进；本测试从第一帧起就让合成人形站在画面里
   * （模拟孩子已经在镜头前），所以扫描永远不会满。这里点「跳过」——
   * 这是产品里真实存在的入口（孩子/家长想直接练时用的），不是为测试开的后门。
   * 跳过之后 roomScan.phase 变 "skipped"，校准评分才开始累计保持时间。 */
  await page.evaluate(() => {
    const skip = document.getElementById("roomScanSkip");
    if (skip) skip.click();
  });
  await sleep(400);

  await page.evaluate(() => window.__setPerson({ cx: 48, top: 8, h: 55, dist: 2500 }));

  /* 锁定要 hold 1.5 秒 + 之后 1.4 秒的"听完识别成功"延时 → 约 3 秒。
   * 轮询等 prepShown 出现，比死等固定秒数稳（机器负载会影响收敛速度）。 */
  let prepSeen = false;
  for (let i = 0; i < 30; i++) {
    prepSeen = await page.evaluate(() => {
      const d = window.__motionDebug();
      return !!(d && d.prepping) || !document.getElementById("posePrep").classList.contains("hidden");
    });
    if (prepSeen) break;
    await sleep(300);
  }
  check("站位锁定后**没有点任何按钮**就自动进入准备流程", prepSeen);

  const prep = await page.evaluate(() => ({
    shown: !document.getElementById("posePrep").classList.contains("hidden"),
    name: document.getElementById("posePrepName").textContent.trim(),
    full: document.getElementById("motionScreen").classList.contains("is-calib"),
    calibHidden: document.getElementById("poseCalib").classList.contains("hidden"),
    startDisabled: document.getElementById("motionStartBtn").disabled,
    startText: document.getElementById("motionStartBtn").textContent.trim(),
    running: (() => { const d = window.__motionDebug(); return d ? d.running : null; })(),
    previewing: (() => { const d = window.__motionDebug(); return d ? d.previewing : null; })()
  }));
  check("准备层已显示", prep.shown === true);
  check("口令文案是「准备开始进行XX」", /^准备开始进行/.test(prep.name), prep.name);
  /* 关键：缩回小窗孩子就看不见了 —— 倒计时必须还在全屏画面上 */
  check("口令期间画面仍是全屏（远处也看得见）", prep.full === true, `is-calib=${prep.full}`);
  check("校准面板已收起（不跟准备层抢画面）", prep.calibHidden === true);
  check("准备期间「开始这一组」置灰且改文案", prep.startDisabled === true && prep.startText === "准备中…",
    `disabled=${prep.startDisabled} text="${prep.startText}"`);
  check("口令期间还没开始正式计时", prep.running === true && prep.previewing === true,
    `running=${prep.running} previewing=${prep.previewing}`);

  /* ---------- 3. 真的播了口令 + 数了 3、2、1、开始 ---------- */
  console.log("\n== 3. 语音：口令 + 人声 3、2、1 ==");
  const log = await page.evaluate(() => window.__audioLog.slice());
  const played = log.filter(x => x.ev === "play").map(x => x.src);
  const cueFile = played.find(s => /^ready-/.test(s));
  check("播了动作准备口令（ready-<exId>.mp3）", !!cueFile, cueFile || played.join(","));
  /* 别硬编码动作名：选中的是"今天计划里第一个可测动作"，会随日期/周次变。
   * 直接问页面当前选的是哪个动作，再核对口令文件名跟它对得上 ——
   * 这才是真正要守的性质（口令必须念的是**当前这个**动作，不能念错人）。 */
  const cueMatch = await page.evaluate(() => {
    const cur = (typeof motionChoice !== "undefined") ? motionChoice : null;
    const ex = (cur && typeof FITNESS_EX !== "undefined" && FITNESS_EX[cur.exId]) || {};
    return { exId: cur ? cur.exId : "", name: ex.name || "" };
  });
  check("口令念的就是当前选中的动作",
    cueFile === "ready-" + cueMatch.exId + ".mp3", `${cueMatch.name}(${cueMatch.exId}) → ${cueFile}`);
  const prepNameText = await page.evaluate(() => document.getElementById("posePrepName").textContent.trim());
  check("屏幕大字也写了同一个动作名",
    !!cueMatch.name && prepNameText.includes(cueMatch.name), `"${prepNameText}" 应含 "${cueMatch.name}"`);

  /* 数数：等着看 3、2、1、go 依次出现。
   * 口令 0.6 秒 + 每个数字 1 秒 → 数完约 3.6 秒（另有 PREP_TAIL 余量）。 */
  const countSeq = [];
  for (let i = 0; i < 26; i++) {
    const now = await page.evaluate(() => window.__audioLog.filter(x => x.ev === "play")
      .map(x => String(x.src || "").split("/").pop()));
    countSeq.length = 0; countSeq.push(...now);
    if (countSeq.includes("count-go.mp3")) break;
    await sleep(250);
  }
  const nums = countSeq.filter(s => /^count-/.test(s));
  check("人声数了数（count-*.mp3）", nums.length >= 4, nums.join(" → "));
  check("数的顺序是 3 → 2 → 1 → go",
    nums.join(",") === "count-3.mp3,count-2.mp3,count-1.mp3,count-go.mp3", nums.join(" → "));

  /* ---------- 4. 数到"开始"后自动开跑 ---------- */
  console.log("\n== 4. 数到「开始」自动开跑 ==");
  let started = null;
  for (let i = 0; i < 24; i++) {
    started = await page.evaluate(() => {
      const d = window.__motionDebug();
      return {
        running: d ? d.running : null,
        previewing: d ? d.previewing : null,
        prepping: d ? d.prepping : null,
        startText: document.getElementById("motionStartBtn").textContent.trim(),
        startDisabled: document.getElementById("motionStartBtn").disabled,
        finishDisabled: document.getElementById("motionFinishBtn").disabled,
        prepShown: !document.getElementById("posePrep").classList.contains("hidden"),
        full: document.getElementById("motionScreen").classList.contains("is-calib")
      };
    });
    if (started.running === true && started.previewing === false) break;
    await sleep(300);
  }
  check("数完「开始」后引擎转入正式计时", started.running === true && started.previewing === false,
    `running=${started.running} previewing=${started.previewing}`);
  check("按钮切成「进行中…」", started.startText === "进行中…" && started.startDisabled === true,
    `text="${started.startText}" disabled=${started.startDisabled}`);
  check("「结束并评分」已可用", started.finishDisabled === false);
  check("准备层已收起", started.prepShown === false);
  /* 开跑这一刻要把全屏还给 3D 人偶：人偶自己是 position:fixed 全屏，
   * 但如果 #motionScreen 还挂着 is-calib，两者会重叠打架。 */
  check("开跑后退出全屏校准态", started.full === false, `is-calib=${started.full}`);

  await page.screenshot({ path: path.join(__dirname, "..", "..", "outputs", "motion-autostart.png") });

  /* ---------- 5. 回归：手动入口仍然可用 ---------- */
  console.log("\n== 5. 回归：手动「开始这一组」仍然可用 ==");
  const manual = await page.evaluate(async () => {
    document.getElementById("motionFinishBtn").click();   // 先结束这一组
    await new Promise(r => setTimeout(r, 500));
    window.__audioLog.length = 0;
    document.getElementById("motionStartBtn").click();
    await new Promise(r => setTimeout(r, 300));
    return {
      prepping: (() => { const d = window.__motionDebug(); return d ? d.prepping : null; })(),
      prepShown: !document.getElementById("posePrep").classList.contains("hidden"),
      startText: document.getElementById("motionStartBtn").textContent.trim()
    };
  });
  check("手动点开始也会走口令流程（同一条入口）",
    manual.prepping === true && manual.prepShown === true, `prepping=${manual.prepping}`);

  /* 重入保护：口令期间再点一次，不能叠出第二层数数 */
  const reentry = await page.evaluate(async () => {
    window.__audioLog.length = 0;
    document.getElementById("motionStartBtn").click();
    document.getElementById("motionStartBtn").click();
    await new Promise(r => setTimeout(r, 400));
    return window.__audioLog.filter(x => x.ev === "play").map(x => String(x.src || "").split("/").pop());
  });
  const cueCount = reentry.filter(s => /^ready-/.test(s)).length;
  check("口令期间重复点开始不会叠播口令", cueCount <= 1, `口令播了 ${cueCount} 次：${reentry.join(",")}`);

  /* ---------- 6. 打断：切页 / 重开校准 / 重来 ---------- */
  console.log("\n== 6. 打断：切页 / 重开校准 / 重来 ==");
  /* 第 5 节起的口令还在念（刚等了 400ms，口令 0.6s + 数数 3s 远没走完）。
   * 先确认这个前置条件成立，再切页 —— 否则"切页掐断口令"这条断言
   * 会退化成"本来就没在念"，测不出任何东西。 */
  const livePrep = await page.evaluate(() => (() => {
    const d = window.__motionDebug();
    return { prepping: d ? d.prepping : null, shown: !document.getElementById("posePrep").classList.contains("hidden") };
  })());
  check("切页前口令确实在念（前置条件）", livePrep.prepping === true, JSON.stringify(livePrep));

  await page.evaluate(async () => {
    window.__audioLog.length = 0;
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessToday").click();
  });
  await sleep(700);
  const afterLeave = await page.evaluate(() => ({
    prepShown: !document.getElementById("posePrep").classList.contains("hidden"),
    prepping: (() => { const d = window.__motionDebug(); return d ? d.prepping : null; })(),
    remaining: document.getElementById("posePrepCount").textContent.trim(),
    camOff: !document.getElementById("motionVideo").srcObject,
    full: document.getElementById("motionScreen").classList.contains("is-calib")
  }));
  check("离开体感页后准备层收起", afterLeave.prepShown === false, `prepping=${afterLeave.prepping}`);
  check("离开体感页后全屏态被收回", afterLeave.full === false);
  check("离开体感页后摄像头关掉（既有隐私行为不变）", afterLeave.camOff === true);

  /* 重开校准必须作废上一次没走完的口令。
   * 不掐断的话：口令念到一半、孩子退回校准 → 几秒后那声"开始"照原计划喊出来，
   * 运动在新一轮校准进行到一半时**自己启动了**，而屏幕上没有任何东西是他点的。
   * 这是本轮改动引入的新风险，必须有断言守住。
   *
   * 时序必须干净：先把画面里的人形清掉（grid 在上一节留着一张好人形，
   * 留着它就等于"站位达标"，重开校准会立刻自动开练，把本节的断言全冲掉）。 */
  await page.evaluate(() => setView("fitnessMotion"));
  await sleep(400);
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1600);
  await page.evaluate(() => {
    window.__setPerson({});                                  // 画面里没人 → 校准不会自动达标
    const rs = document.getElementById("roomScanSkip");
    if (rs) rs.click();
    const cs = document.getElementById("poseCalibSkip");
    if (cs) cs.click();                                      // 退出校准，回到可点"开始"的状态
  });
  await sleep(600);
  const armed = await page.evaluate(() => {
    const d = window.__motionDebug();
    return {
      calib: d ? d.calibrating : null, running: d ? d.running : null,
      previewing: d ? d.previewing : null,
      startDisabled: document.getElementById("motionStartBtn").disabled
    };
  });
  check("准备好前置状态（校准已退出、尚未开跑）",
    armed.calib === false && armed.running === true && armed.previewing === true,
    JSON.stringify(armed));

  const midPrep = await page.evaluate(async () => {
    window.__audioLog.length = 0;
    document.getElementById("motionStartBtn").click();
    await new Promise(r => setTimeout(r, 600));
    const d = window.__motionDebug();
    return { prepping: d ? d.prepping : null, shown: !document.getElementById("posePrep").classList.contains("hidden") };
  });
  check("重开校准前口令确实在念（前置条件）", midPrep.prepping === true, JSON.stringify(midPrep));

  await page.evaluate(() => motionCalibOpen());              // 口令念到一半，退回校准
  await sleep(500);
  const afterReopen = await page.evaluate(() => (() => {
    const d = window.__motionDebug();
    return {
      prepping: d ? d.prepping : null,
      shown: !document.getElementById("posePrep").classList.contains("hidden"),
      previewing: d ? d.previewing : null
    };
  })());
  check("重开校准会作废上一次没念完的口令", afterReopen.prepping === false && afterReopen.shown === false,
    JSON.stringify(afterReopen));
  /* 再等过原来的口令时长，确认没有"迟到的开始"把运动偷偷启动 */
  await sleep(9000);
  const noGhost = await page.evaluate(() => {
    const d = window.__motionDebug();
    return { running: d ? d.running : null, previewing: d ? d.previewing : null, prepping: d ? d.prepping : null };
  });
  check("等过口令时长也没有「迟到的自动开跑」",
    noGhost.previewing === true && noGhost.prepping === false, JSON.stringify(noGhost));

  /* ---------- 7. 主链路（真实 MediaPipe 骨架）也要能自动开练 ----------
   *
   * 前面 1~6 节走的是**深度回退链路**（合成深度网格 → 掩码骨架）。
   * 但孩子实际用的是 MediaPipe 真实骨架主链路 —— 两条链路产出的字段同构，
   * 只测一条就断言"自动开练能用"是靠不住的（真人房间里正是主链路在跑）。
   * 这里喂真实人体照片的 33 关键点，确认主链路下同样会触发自动开练。
   *
   * 关键坑：`poll()` 有 700ms 漏检宽限（抬手挡脸时骨架不该闪断）。
   * 只喂一次关键点，宽限一过就自然过期、退回掩码链路 —— 那测的是"过期行为"。
   * 必须靠持续喂把主链路钉住（感知器接口是 setVideo / pushLandmarks，
   * **没有** start/stop，写错方法名会静默走到 catch 里、测试假通过）。 */
  console.log("\n== 7. 主链路（真实 MediaPipe 骨架）下的自动开练 ==");
  const fixture = path.join(__dirname, "fixtures", "pose-human.png");
  if (!fs.existsSync(fixture)) {
    check("真实人体样本存在（主链路验证的前提）", false, fixture);
  } else {
    /* 重载回干净状态。第 6 节结束时摄像头是开着的（那里重开过一次验证打断），
     * 直接再点「开启」会变成**关闭**，前置条件就不成立了。
     * 与其小心翼翼地"先关再开"，不如重载 —— 主链路要验证的性质
     * （真实骨架下也会自动开练）不依赖前面积累的会话状态。
     * 注意：reload 会把页面上的替身（假摄像头流、Audio 记账）一起清掉，
     * 所以这里必须**重新装一遍**，不能假设还留着。 */
    await page.reload({ waitUntil: "load" });
    await sleep(900);
    await page.evaluate(() => {
      const cv = document.createElement("canvas");
      cv.width = 640; cv.height = 480;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
      window.__fakeStream = cv.captureStream(30);
      setInterval(() => {
        cx.fillStyle = "#111"; cx.fillRect(0, 0, 640, 480);
        cx.fillRect((Date.now() / 40) % 640, 0, 2, 2);
      }, 33);
      navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    });
    await page.evaluate(() => setView("fitnessMotion"));
    await sleep(600);
    await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
    /* 冷启动时 video.play() 的 Promise 在外接 USB 摄像头上可能一两秒才 settle，
     * 固定 sleep 会让"摄像头已开"这条前置断言随机失败 → 轮询。 */
    let camUp = false;
    for (let i = 0; i < 20; i++) {
      camUp = await page.evaluate(() => !!document.getElementById("motionVideo").srcObject);
      if (camUp) break;
      await sleep(400);
    }
    await sleep(900);       // 再给校准界面与引擎几帧时间

    const MAIN_OPENED = await page.evaluate(() => {
      const d = window.__motionDebug();
      return {
        camUp: !!document.getElementById("motionVideo").srcObject,
        running: d ? d.running : null,
        calib: d ? d.calibrating : null
      };
    });
    check("主链路场景：摄像头已开、校准已进入",
      MAIN_OPENED.camUp === true && MAIN_OPENED.running === true && MAIN_OPENED.calib === true,
      JSON.stringify(MAIN_OPENED));

    const b64 = fs.readFileSync(fixture).toString("base64");
    /* 换成真实感知器 + 真实人体画面，然后持续喂 33 点。
     * 注意直接用页面全局的 motionEngine / motionCalib 等（顶层 let，不能写 window.xxx）。 */
    const mainRun = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);

      const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
      pose.setOptions({
        modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        smoothSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5
      });
      let lm = null;
      pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
      await pose.send({ image: cv });
      await new Promise(r => setTimeout(r, 300));
      if (!lm) {
        return { err: "未检测到人体" };
      }

      /* 把关键点按比例缩放到"站得合适"的大小再喂。
       *
       * 为什么要这一步：这张真实照片是**近景半身偏大**的构图，人占了画面高 83%。
       * 直接喂进去，站位评分会给 guide="back"（人太大了 → 无法锁定），
       * 而 score 却已经有 84 分 —— 于是卡在"分够了但不锁定"，自动开练永远不触发。
       * 这不代表产品有问题：孩子真实站位在 2~3 米外，本来就比这张近景照片小得多。
       * 缩放 = 模拟"孩子站到 2.5 米"的正确站位，测的仍是同一条主链路。
       *
       * 缩到画面高的 ~62%（站位框要求 h≈0.62），并把中心对到画面中心。 */
      const bboxOf = (pts) => {
        let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
        pts.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
        return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0 };
      };
      const bb = bboxOf(lm);
      const scale = bb.h > 0.01 ? (0.62 / bb.h) : 1;
      const scaled = lm.map(p => ({
        x: (p.x - bb.cx) * scale + 0.5,
        y: (p.y - bb.cy) * scale + 0.5,
        z: p.z, visibility: p.visibility
      }));

      // 换成真实感知器 + 真实人体画面
      const pv = window.PoseVision.createPoseVision({ modelComplexity: 0 });
      pv.setVideo(cv);
      motionEngine.attachVision(pv);
      motionEngine.attach(cv);
      motionEngine.attachDepth(null);          // 主链路场景：不接深度
      window.__pv = pv;

      // 主链路场景本来就没深度，空房扫描该是 skipped；显式点一下更稳
      const rs = document.getElementById("roomScanSkip");
      if (rs) rs.click();

      /* 持续喂缩放后的关键点（poll 有 700ms 漏检宽限，喂一次会过期退回掩码）。
       * 先喂缩放版让站位达标；同时保留原始点作为"真骨架"的证明。 */
      window.__feeder = setInterval(() => { pv.pushLandmarks(scaled); }, 80);
      return { landmarks: lm.length, scaledH: +(bb.h * scale).toFixed(3) };
    }, b64);

    if (mainRun.err) {
      check("主链路：真实照片能检测出人体", false, mainRun.err);
    } else {
      check("主链路：真实照片检测到 33 关键点", mainRun.landmarks === 33, `${mainRun.landmarks} 点`);

      // 等自动开练：站位达标 hold 1.5s + 1.4s 延时
      let mainAuto = false;
      for (let i = 0; i < 40; i++) {
        mainAuto = await page.evaluate(() => {
          const d = window.__motionDebug();
          return !!(d && d.prepping);
        });
        if (mainAuto) break;
        await sleep(300);
      }
      /* 诊断：没触发时看看卡在哪一项上（真实照片的人是站姿，未必落在
       * 站位框要求的"张臂"里 —— 这正是主链路与合成人形的差别所在）。 */
      if (!mainAuto) {
        const why = await page.evaluate(() => {
          const p = motionEngine.getPose();
          const vs = motionEngine.visionStats ? motionEngine.visionStats() : null;
          return {
            source: vs ? vs.source : null,
            seen: !!(p && p.seen), score: p ? p.score : -1, locked: !!(p && p.locked),
            guide: p ? p.guide : "", guideText: p ? p.guideText : "",
            checks: p ? p.checks : null, bbox: p ? p.bbox : null,
            hold: Math.round(motionCalib.hold), passed: motionCalib.passed,
            roomPhase: roomScan.phase
          };
        });
        console.log("  [主链路诊断]", JSON.stringify(why));
      }
      check("主链路：站位锁定后自动进入准备开练", mainAuto === true);

      const mainSrc = await page.evaluate(() => {
        const vs = motionEngine.visionStats ? motionEngine.visionStats() : null;
        const d = window.__motionDebug();
        return {
          source: vs ? vs.source : null,
          joints: d && d.skeleton ? d.skeleton.jointCount : 0,
          prepName: document.getElementById("posePrepName").textContent.trim(),
          prepShown: !document.getElementById("posePrep").classList.contains("hidden"),
          prepDone: (() => {
            const el = document.getElementById("posePrepCount");
            return el ? el.textContent : "";
          })()
        };
      });
      check("主链路：确实走的是 pose 而不是掩码", mainSrc.source === "pose", `source=${mainSrc.source}`);
      check("主链路：准备层已显示且写了动作名",
        mainSrc.prepShown === true && /^准备开始进行/.test(mainSrc.prepName),
        `"${mainSrc.prepName}" joints=${mainSrc.joints} 倒计时="${mainSrc.prepDone}"`);

      // 收尾：停喂点、摘掉感知器，别把后面的收尾逻辑搞乱
      await page.evaluate(() => {
        if (window.__feeder) clearInterval(window.__feeder);
        if (typeof motionFlowTeardown === "function") motionFlowTeardown();
        try { motionEngine.attachVision(null); } catch (e) { }
      });
      await sleep(300);
    }
  }

  /* ---------- 8. 测试捷径 ?motionPrep=0 生效 ---------- */
  console.log("\n== 8. 测试捷径：?motionPrep=0 ==");
  const offPage = await browser.newPage();
  await offPage.goto(INDEX + "?motionPrep=0", { waitUntil: "domcontentloaded" });
  await sleep(600);
  const off = await offPage.evaluate(() => {
    const d = window.__motionDebug();
    return { disabled: motionPrepDisabled(), fromDebug: d ? d.prepDisabled : null };
  });
  check("?motionPrep=0 时测试捷径生效", off.disabled === true, JSON.stringify(off));
  await offPage.close();

  /* 默认（无参数）必须是"带孩子口令"的真实行为 —— 别把捷径做成默认 */
  const defPage = await browser.newPage();
  await defPage.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(600);
  const def = await defPage.evaluate(() => motionPrepDisabled());
  check("默认路径不跳过口令（孩子平时走的就是带口令的路）", def === false, `disabled=${def}`);
  await defPage.close();

  check("全过程没有 JS 报错", errors.length === 0, errors.join(" | "));

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    failed.forEach(f => console.log("  FAIL:", f.name, f.detail || ""));
    process.exit(1);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
