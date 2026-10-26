// 真实浏览器验证：打开页面、切换模块、播放音频、检查报错与音频信号
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=AudioServiceOutOfProcess",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });

  const errors = [];
  const warnings = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => {
    if (m.type() === "error") errors.push("CONSOLE: " + m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  // 听音撰文属于「拓展模块」，必须先完成当天「每日必写」才解锁。
  // 这里在页面加载前塞一篇今天的每日必写，让门禁放行（否则点不到播放按钮）。
  await page.evaluateOnNewDocument(() => {
    const pad = n => String(n).padStart(2, "0");
    const d = new Date(); d.setHours(10, 0, 0, 0);
    const day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 },
      essays: [{
        id: "seed-essential", date: d.toISOString(), topicId: "seed", type: "每日必写",
        title: "每日必写 测试", goal: "", skillFocus: "语言表达", material: "",
        text: "这是用于验证听音撰文播放的测试文本，内容足够长以便通过渲染检查。".repeat(2),
        feedback: { score: 70, parts: {}, strengths: [], improvements: [], nextGoal: "" }
      }],
      rewards: {}, redemptions: []
    }));
    window.__seedDayKey = day;
  });
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));

  // 1) 首页 —— 先过模块选择页，进入写作模块（否则导航项不可见，点不到）
  const chooserVisible = await page.$eval("#moduleChooser", el => !el.classList.contains("hidden"));
  console.log("模块选择页:", chooserVisible);
  await page.evaluate(() => {
    document.querySelector('.chooser-card[data-module="write"]').click();
  });
  await new Promise(r => setTimeout(r, 500));
  const navCount = await page.$$eval('.nav-item[data-module="write"]', els => els.length);
  console.log("写作导航项数量:", navCount);

  // 2) 切到听音撰文
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "audio").click();
  });
  await new Promise(r => setTimeout(r, 400));
  const audioVisible = await page.$eval("#audio", el => el.classList.contains("active"));
  const audioTitle = await page.$eval("#audioTitle", el => el.textContent);
  const sceneCount = await page.evaluate(() => window.AUDIO_SCENES.length);
  console.log("听音撰文视图激活:", audioVisible, "| 当前场景:", audioTitle, "| 场景库:", sceneCount);

  // 3) 点播放，检查真实录音是否真的在播（<audio> 元素不挂 DOM，靠引擎状态查）
  await page.click("#audioPlayBtn");
  await new Promise(r => setTimeout(r, 2500));

  const audioProbe = await page.evaluate(async () => {
    const eng = window.AudioSceneEngine;
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      const spec = eng.getSpectrum() || [];
      for (const v of spec) if (v > peak) peak = v;
      await new Promise(r => setTimeout(r, 100));
    }
    const st = eng.getStatus();
    const live = (st.elements || []).filter(e => !e.paused && e.t > 0);
    const btn = document.getElementById("audioPlayBtn");
    return {
      playing: eng.isPlaying(),
      layers: st.layers,
      engineError: st.error || "无",
      liveTracks: live.length,
      trackDetail: (st.elements || []).map(e => e.id + ":vol" + e.volume + "/t" + e.t + "/ready" + e.ready),
      spectrumPeak: peak,
      btnPlaying: btn.classList.contains("playing"),
      icon: document.getElementById("audioPlayIcon").textContent,
      status: document.getElementById("audioStatus").textContent,
      barHeight: document.querySelector("#audioWave i") ? document.querySelector("#audioWave i").style.height : "n/a"
    };
  });
  console.log("播放状态:", JSON.stringify(audioProbe, null, 0));
  await page.screenshot({ path: path.join(SHOT, "audio-playing.png") });

  // 4) 停止
  await page.click("#audioPlayBtn");
  await new Promise(r => setTimeout(r, 700));
  const afterStop = await page.evaluate(() => ({
    playing: window.AudioSceneEngine.isPlaying(),
    layers: window.AudioSceneEngine.getStatus().layers,
    icon: document.getElementById("audioPlayIcon").textContent
  }));
  console.log("停止后:", JSON.stringify(afterStop));

  // 5) 抽查 8 段不同分类的场景，确认真实录音都能起播
  const samples = await page.evaluate(() => {
    const cats = {};
    window.AUDIO_SCENES.forEach(s => { (cats[s.category] = cats[s.category] || []).push(s.id); });
    return Object.keys(cats).map(c => cats[c][0]);
  });
  for (const id of samples) {
    const r = await page.evaluate(async (sid) => {
      const eng = window.AudioSceneEngine;
      const sc = window.AUDIO_SCENES.find(s => s.id === sid);
      eng.play(sc);
      await new Promise(x => setTimeout(x, 1600));
      const st = eng.getStatus();
      let peak = 0;
      for (let i = 0; i < 6; i++) {
        for (const v of eng.getSpectrum()) if (v > peak) peak = v;
        await new Promise(x => setTimeout(x, 80));
      }
      eng.stop();
      await new Promise(x => setTimeout(x, 300));
      return { title: sc.title, cat: sc.category, layers: st.layers,
               live: (st.elements || []).filter(e => !e.paused && e.t > 0).length,
               peak, err: st.error || "" };
    }, id);
    console.log("  抽查", id, JSON.stringify(r));
  }
  await new Promise(r => setTimeout(r, 600));

  // 6) 每日任务里的听音题
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === "dailyTask").click();
  });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".task-tab")].find(b => b.dataset.taskType === "audio");
    if (tab) tab.click();
  });
  await new Promise(r => setTimeout(r, 400));
  const taskInfo = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".task-tab")].map(b => b.textContent.trim()),
    title: document.getElementById("taskTitle").textContent,
    hasMiniPlay: Boolean(document.querySelector("#taskMaterial [data-audio-play]")),
    hint: document.getElementById("taskCountHint").textContent
  }));
  console.log("每日任务页签:", taskInfo.tabs.join(" | "));
  console.log("听音题:", taskInfo.title, "| 有播放按钮:", taskInfo.hasMiniPlay);
  console.log("素材统计:", taskInfo.hint);
  await page.screenshot({ path: path.join(SHOT, "daily-task-audio.png") });

  // 7) 点"用这段声音开始写"
  await page.click("[data-action='start-task-writing']");
  await new Promise(r => setTimeout(r, 500));
  const writeInfo = await page.evaluate(() => ({
    view: document.getElementById("pageTitle").textContent,
    mode: document.getElementById("writeModeLabel").textContent,
    title: document.getElementById("writeTopicTitle").textContent,
    hasPlayer: Boolean(document.querySelector("#activeMaterialCard [data-audio-play]")),
    cardHtml: document.getElementById("activeMaterialCard").innerHTML.slice(0, 120),
    prompts: [...document.querySelectorAll("#promptList li")].length
  }));
  console.log("写作页:", JSON.stringify(writeInfo));
  await page.screenshot({ path: path.join(SHOT, "write-audio.png") });

  // 8) 范文临摹 + 成长页快速过一遍
  for (const v of ["imitate", "growth", "parent", "history", "settings"]) {
    await page.evaluate(view => {
      [...document.querySelectorAll(".nav-item")].find(el => el.dataset.view === view).click();
    }, v);
    await new Promise(r => setTimeout(r, 200));
  }
  await page.screenshot({ path: path.join(SHOT, "settings.png") });

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");

  await browser.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
