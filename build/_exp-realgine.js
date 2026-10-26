// 端到端实证：把**真实 motion-engine.js** 跑起来，喂「站着不动的人形 + 传感器噪声」，
// 直接读引擎计次。用来证明"不动也计数"，并测出噪声下的虚增速率的量级。
//
// 只读生产代码；本脚本只新开一个引擎实例，不碰 app 状态、不写 localStorage。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR", e.message));
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  // 场景定义：all 在 128x96 画布上画一个竖直人形；mode=jitter 决定噪声强度 / 动作幅度
  await page.evaluate(() => {
    window.__exp = {};
    const CW = 128, CH = 96;
    const cv = document.createElement("canvas");
    cv.width = CW; cv.height = CH;
    const g = cv.getContext("2d");
    // 确定性伪随机
    let seed = 20260926;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

    window.__exp.drawFig = function (dyPx, spreadPx, armUpPx, jitterPx) {
      g.fillStyle = "#0c0c0c"; g.fillRect(0, 0, CW, CH);
      g.fillStyle = "#eeeeee";
      const cx = CW / 2, cy = CH / 2 + dyPx;
      const J = jitterPx || 0;
      const box = (x, y, w, h) => {
        // 每帧给每个矩形一个亚像素级的噪声抖动，模拟真实摄像头传感器噪声
        const jx = (rnd() - 0.5) * 2 * J;
        const jy = (rnd() - 0.5) * 2 * J;
        g.fillRect(Math.round(x + jx), Math.round(y + jy), Math.round(w), Math.round(h));
      };
      // 腿（随 spreadPx 分开 → 影响包围盒宽度）
      box(cx - 9 - spreadPx, cy + 9, 7, 30);
      box(cx + 2 + spreadPx, cy + 9, 7, 30);
      // 躯干
      box(cx - 10, cy - 19, 20, 28);
      // 手臂（随 armUpPx 上举；张开时横向外扩）
      box(cx - 18 - spreadPx, cy - 16 - armUpPx, 6, 19);
      box(cx + 12 + spreadPx, cy - 16 - armUpPx, 6, 19);
      // 头
      const hy = cy - 27;
      for (let yy = hy - 6; yy <= hy + 6; yy++) {
        const half = Math.round(Math.sqrt(Math.max(0, 36 - (yy - hy) * (yy - hy))));
        g.fillRect(cx - half, yy, half * 2 + 1, 1);
      }
    };
    window.__exp.setup = function (profile) {
      const eng = window.MotionEngine.createEngine();
      eng.attach(cv);
      eng.setProfile(profile);
      window.__exp.eng = eng;
      window.__exp.samples = { width: [], height: [], repsAt: [] };
      const t0 = performance.now();
      window.__exp.t0 = t0;
      eng.onTick(function (st) {
        const wid = st.live.width, hei = st.live.height;
        window.__exp.samples.width.push(wid);
        window.__exp.samples.height.push(hei);
        if (window.__exp.samples.width.length > 4000) window.__exp.samples.width.shift();
        if (window.__exp.samples.height.length > 4000) window.__exp.samples.height.shift();
        window.__exp.samples.repsAt.push({ t: (performance.now() - t0) / 1000, reps: st.reps });
      });
      eng.start();
    };
    window.__exp.stop = function () { window.__exp.eng.stop(); };
  });

  // 开合跳的真实 profile（data/fitness-plan.js:69）
  const JJ = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 };
  const SQ = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };

  const cases = [
    { name: "A 完全静止（人形纹丝不动）", profile: JJ, draw: "static", secs: 12 },
    { name: "B 静止 + 亚像素噪声 0.6px", profile: JJ, draw: "noise0.6", secs: 12 },
    { name: "C 静止 + 亚像素噪声 1.2px", profile: JJ, draw: "noise1.2", secs: 12 },
    { name: "D 真开合跳 开合±10px @0.8Hz", profile: JJ, draw: "jack", secs: 12 },
    { name: "E 半蹲热身 上下±12px @0.6Hz", profile: SQ, draw: "squat", secs: 15 }
  ];

  const out = [];
  for (const c of cases) {
    await page.evaluate((c) => {
      const S = window.__exp;
      S.stopParity = null;
      const t0 = performance.now();
      let raf = 0;
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        if (t > c.secs) { S.eng.stop(); S.lastAvg = S.avg(); return; }
        if (c.draw === "static") S.drawFig(0, 0, 0, 0);
        else if (c.draw === "noise0.6") S.drawFig(0, 0, 0, 0.6);
        else if (c.draw === "noise1.2") S.drawFig(0, 0, 0, 1.2);
        else if (c.draw === "jack") {
          const ph = Math.sin(2 * Math.PI * 0.8 * t);
          S.drawFig(0, 10 * ph, 8 * ph, 0.4);
        } else if (c.draw === "squat") {
          S.drawFig(Math.sin(2 * Math.PI * 0.6 * t) * 12, 0, 0, 0.4);
        }
        raf = requestAnimationFrame(loop);
      };
      S.setup(c.profile);
      raf = requestAnimationFrame(loop);
    }, c);
    await sleep((c.secs + 1.5) * 1000);
    const r = await page.evaluate(() => {
      const S = window.__exp;
      const w = S.samples.width, h = S.samples.height;
      const stat = a => {
        if (!a.length) return { n: 0 };
        const mn = Math.min(...a), mx = Math.max(...a);
        const m = a.reduce((s, v) => s + v, 0) / a.length;
        const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
        return { n: a.length, min: +mn.toFixed(4), max: +mx.toFixed(4), range: +(mx - mn).toFixed(4), mean: +m.toFixed(4), std: +sd.toFixed(4) };
      };
      const reps = S.samples.repsAt.length ? S.samples.repsAt[S.samples.repsAt.length - 1].reps : 0;
      const elapsed = S.samples.repsAt.length ? S.samples.repsAt[S.samples.repsAt.length - 1].t : 0;
      const st = S.eng.getState();
      return { reps, elapsed, fps: +st.fps.toFixed(1), width: stat(w), height: stat(h), amp: +st.amplitude.toFixed(3) };
    });
    out.push({ case: c.name, ...r });
    console.log(`\n【${c.name}】`);
    console.log(`  计数 = ${r.reps} 次 / ${r.elapsed.toFixed(1)}s  → ${(r.reps / r.elapsed * 60).toFixed(1)} 次/分   fps=${r.fps}`);
    console.log(`  width  实测量级: mean=${r.width.mean} range=${r.width.range} std=${r.width.std}  (min ${r.width.min} max ${r.width.max})`);
    console.log(`  height 实测量级: mean=${r.height.mean} range=${r.height.range} std=${r.height.std}`);
    console.log(`  幅度分 amplitude=${r.amp}`);
  }

  await browser.close();
  require("fs").writeFileSync(path.join(__dirname, "_exp-realgine.json"), JSON.stringify(out, null, 2));
  console.log("\n结果已写入 build/_exp-realgine.json");
})().catch(e => { console.error("崩溃", e); process.exit(2); });
