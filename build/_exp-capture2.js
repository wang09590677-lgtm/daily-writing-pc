// 采集 v2：合成一个**幅度真实**的开合跳人形（包围盒宽度摆动接近 fitness-plan.js 里
// expectedAmplitude: 0.18 的水平），用来公平检验「绝对幅度门限」是不是会把真动作挡掉。
// 同时保留"弱动作"（幅度只有一半）用来测门限的宽容度。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
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
    let seed = 90210;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    window.__exp = {};
    // spread: 腿横向张开量(px)  armOut: 手臂水平外展(px)  jitter: 亚像素噪声
    window.__exp.drawJack = function (phase, spread, armOut, jitter, scale) {
      const S = scale || 1;
      g.fillStyle = "#0c0c0c"; g.fillRect(0, 0, CW, CH);
      g.fillStyle = "#eeeeee";
      const cx = CW / 2, cy = CH / 2, J = jitter || 0;
      const box = (x, y, w, h) => {
        const jx = (rnd() - 0.5) * 2 * J, jy = (rnd() - 0.5) * 2 * J;
        g.fillRect(Math.round(x + jx), Math.round(y + jy), Math.max(2, Math.round(w * S)), Math.max(2, Math.round(h * S)));
      };
      // 腿：从并拢(spread→0=间距4px) 张到 spread 宽度
      const legGap = 2 + spread * S;
      box(cx - legGap - 5 * S, cy + 9 * S, 6, 30);          // 左腿
      box(cx + legGap, cy + 9 * S, 6, 30);                   // 右腿
      // 躯干
      box(cx - 10 * S, cy - 19 * S, 20, 28);
      // 手臂：phase<0 时下垂贴近躯干；phase>0 时水平外展 armOut
      const ao = armOut * S;
      box(cx - 12 * S - ao, cy - 16 * S, 5, 19);
      box(cx + 7 * S + ao, cy - 16 * S, 5, 19);
      // 头
      const hy = cy - 27 * S, hr = Math.round(6 * S);
      for (let yy = hy - hr; yy <= hy + hr; yy++) {
        const half = Math.round(Math.sqrt(Math.max(0, hr * hr - (yy - hy) * (yy - hy))));
        g.fillRect(cx - half, yy, half * 2 + 1, 1);
      }
    };
    window.__exp.run = function (profile, src, secs) {
      const eng = window.MotionEngine.createEngine();
      eng.attach(cv); eng.setProfile(profile);
      const ser = [];
      const t0 = performance.now();
      eng.onTick(st => ser.push({ t: (performance.now() - t0) / 1000, width: st.live.width, height: st.live.height,
        centroidY: st.live.centroidY, motion: st.live.motion }));
      const drawFn = new Function("draw", "t", "rnd", "gauss", "sin", src);
      window.__exp.done = null;
      let raf = 0;
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        if (t > secs) { eng.stop(); window.__exp.done = ser; return; }
        drawFn(window.__exp.drawJack, t, rnd, gauss, Math.sin);
        raf = requestAnimationFrame(loop);
      };
      eng.start(); raf = requestAnimationFrame(loop);
    };
  });

  const JJ = { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 };
  // 全幅开合跳：腿张开 0→22px，手臂外展 0→14px（接近真实开合跳）
  const FULL = "const p=(1-Math.cos(2*Math.PI*0.8*t))/2; draw(p, 22*p, 14*p, 0.4, 1)";
  // 半幅开合跳（孩子做得很小）
  const HALF = "const p=(1-Math.cos(2*Math.PI*0.8*t))/2; draw(p, 11*p, 7*p, 0.4, 1)";
  // 静止 + 噪声
  const STATIC = "draw(0,0,0,1.2,1)";
  // 全幅开合跳 @4m（尺寸减半）
  const FULL4 = "const p=(1-Math.cos(2*Math.PI*0.8*t))/2; draw(p, 22*p, 14*p, 0.4, 0.5)";

  const cases = [
    { id: "J1_static_2m", profile: JJ, secs: 12, src: STATIC },
    { id: "J2_full_2m", profile: JJ, secs: 12, src: FULL },
    { id: "J3_half_2m", profile: JJ, secs: 12, src: HALF },
    { id: "J4_full_4m", profile: JJ, secs: 12, src: FULL4 }
  ];
  const out = {};
  for (const c of cases) {
    await page.evaluate(c => window.__exp.run(c.profile, c.src, c.secs), c);
    let ser = null;
    for (let i = 0; i < 60; i++) { ser = await page.evaluate(() => window.__exp.done); if (ser) break; await sleep(500); }
    const ws = ser.filter(r => isFinite(r.width)).map(r => r.width);
    const hs = ser.filter(r => isFinite(r.height)).map(r => r.height);
    console.log(`${c.id}: ${ser.length} 帧, width range=${(Math.max(...ws) - Math.min(...ws)).toFixed(4)} mean=${(ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(3)}, height mean=${(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(3)}`);
    out[c.id] = { profile: c.profile, secs: c.secs, series: ser };
  }
  fs.writeFileSync(path.join(__dirname, "_exp-series-jack.json"), JSON.stringify(out));
  console.log("已写出 build/_exp-series-jack.json");
  await browser.close();
})().catch(e => { console.error("崩溃", e); process.exit(2); });
