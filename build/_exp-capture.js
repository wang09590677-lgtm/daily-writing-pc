// 采集：把**真实 motion-engine.js** 在若干场景下产出的逐帧信号录下来（t/width/height/centroidY），
// 供 _exp-replay.js 在**同一段数据**上对比「现状计次器」与「加了绝对幅度门限的计次器」。
// 只读生产代码，不改任何生产文件。
const path = require("path");
const fs = require("fs");
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
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  await page.evaluate(() => {
    const CW = 128, CH = 96;
    const cv = document.createElement("canvas");
    cv.width = CW; cv.height = CH;
    const g = cv.getContext("2d");
    let seed = 20260926;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    // scale: 人形整体尺寸倍率，用来模拟站位远近（1.0≈2m，0.5≈4m）
    window.__exp = { gauss };
    window.__exp.drawFig = function (dyPx, spreadPx, armUpPx, jitterPx, scale) {
      const S = scale || 1;
      g.fillStyle = "#0c0c0c"; g.fillRect(0, 0, CW, CH);
      g.fillStyle = "#eeeeee";
      const cx = CW / 2, cy = CH / 2 + dyPx * S;
      const J = jitterPx || 0;
      const box = (x, y, w, h) => {
        const jx = (rnd() - 0.5) * 2 * J, jy = (rnd() - 0.5) * 2 * J;
        g.fillRect(Math.round(x + jx), Math.round(y + jy), Math.max(2, Math.round(w * S)), Math.max(2, Math.round(h * S)));
      };
      box(cx - (9 + spreadPx) * S, cy + 9 * S, 7, 30);
      box(cx + (2 + spreadPx) * S, cy + 9 * S, 7, 30);
      box(cx - 10 * S, cy - 19 * S, 20, 28);
      box(cx - (18 + spreadPx) * S, cy - (16 + armUpPx) * S, 6, 19);
      box(cx + (12 + spreadPx) * S, cy - (16 + armUpPx) * S, 6, 19);
      const hy = cy - 27 * S, hr = Math.round(6 * S);
      for (let yy = hy - hr; yy <= hy + hr; yy++) {
        const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy))));
        g.fillRect(cx - half, yy, half * 2 + 1, 1);
      }
    };
    window.__exp.run = function (profile, drawFnSrc, secs) {
      const eng = window.MotionEngine.createEngine();
      eng.attach(cv);
      eng.setProfile(profile);
      const ser = [];
      const t0 = performance.now();
      eng.onTick(function (st) {
        ser.push({ t: (performance.now() - t0) / 1000, width: st.live.width, height: st.live.height,
                   centroidY: st.live.centroidY, motion: st.live.motion, area: st.live.area });
      });
      const drawFn = new Function("draw", "t", "rnd", "gauss", drawFnSrc);
      let raf = 0;
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        if (t > secs) { eng.stop(); window.__exp.done = ser; return; }
        drawFn(window.__exp.drawFig, t, rnd, gauss);
        raf = requestAnimationFrame(loop);
      };
      window.__exp.done = null;
      eng.start();
      raf = requestAnimationFrame(loop);
    };
  });

  const JJ = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 };
  const SQ = { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 };

  const cases = [
    // 站在 2m（人形占满画面），完全静止
    { id: "A_static_2m", profile: JJ, secs: 12, src: "draw(0,0,0,0,1)" },
    // 静止 + 亚像素噪声（真实摄像头必有）：±0.6px / ±1.2px / ±2px
    { id: "B_noise06_2m", profile: JJ, secs: 12, src: "draw(0,0,0,0.6,1)" },
    { id: "C_noise12_2m", profile: JJ, secs: 12, src: "draw(0,0,0,1.2,1)" },
    { id: "C2_noise20_2m", profile: JJ, secs: 12, src: "draw(0,0,0,2.0,1)" },
    // 真开合跳 0.8Hz（腿开合 ±10px + 手臂上举 ±8px），带一点点噪声
    { id: "D_jack08_2m", profile: JJ, secs: 12, src: "const p=Math.sin(2*Math.PI*0.8*t); draw(0,10*p,8*p,0.4,1)" },
    // 真开合跳，但站到 ~4m（人形尺寸减半）→ 绝对幅度减半，检验门限的尺度无关性
    { id: "F_jack08_4m", profile: JJ, secs: 12, src: "const p=Math.sin(2*Math.PI*0.8*t); draw(0,10*p,8*p,0.4,0.5)" },
    // 4m 处静止噪声
    { id: "G_noise12_4m", profile: JJ, secs: 12, src: "draw(0,0,0,1.2,0.5)" },
    // 回归场景：半蹲热身 0.6Hz 上下 ±12px（= motion-browser-test.js 的合成人形）
    { id: "E_squat06", profile: SQ, secs: 15, src: "draw(Math.sin(2*Math.PI*0.6*t)*12,0,0,0.4,1)" },
    // 回归场景 4m 版
    { id: "H_squat06_4m", profile: SQ, secs: 15, src: "draw(Math.sin(2*Math.PI*0.6*t)*12,0,0,0.4,0.5)" }
  ];

  const out = {};
  for (const c of cases) {
    await page.evaluate((c) => { window.__exp.run(c.profile, c.src, c.secs); }, c);
    let ser = null;
    for (let i = 0; i < 60; i++) {
      ser = await page.evaluate(() => window.__exp.done);
      if (ser) break;
      await sleep(500);
    }
    out[c.id] = { profile: c.profile, secs: c.secs, series: ser };
    const reps = await page.evaluate(() => window.__exp && window.__exp.lastReps);
    console.log(`${c.id}: 采到 ${ser ? ser.length : 0} 帧`);
  }

  fs.writeFileSync(path.join(__dirname, "_exp-series.json"), JSON.stringify(out));
  console.log("已写出 build/_exp-series.json");
  await browser.close();
})().catch(e => { console.error("崩溃", e); process.exit(2); });
