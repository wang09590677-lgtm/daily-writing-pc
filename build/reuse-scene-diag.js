// 临时诊断：复用 arm-furniture-test.js 的 SCENE_FN（避免手抄），
// 判断 arm-furniture-test 组 E 的 FAIL 是"引擎时序残留"还是真问题。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROJ = "D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc";
const BUILD = path.join(PROJ, "build");
const INDEX = "file:///" + path.join(PROJ, "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 直接从正式测试文件里抠出 SCENE_FN，保证与正式测试逐字节同源
const src = fs.readFileSync(path.join(BUILD, "arm-furniture-test.js"), "utf8");
const m = src.match(/const SCENE_FN = `([\s\S]*?)`;\n/);
if (!m) { console.error("无法提取 SCENE_FN"); process.exit(1); }
const SCENE_FN = m[1];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(BUILD, "probe-profile-reuse-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => { c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480); c.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(`(function(){ ${SCENE_FN} })();`);
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv); motionEngine.preview();
  });

  const shelf = { x0: -1100, x1: -171, yBot: 980, yTop: 1070 };
  async function shoot(sc, wait) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5 }, sc);
    await page.evaluate((d, sc2) => { sc2.dist = d; window.__buildScene(window.__grid, sc2); }, s.dist, s);
    await sleep(wait);
    return await page.evaluate(() => {
      const sk = motionEngine.getSkeleton(); const pose = motionEngine.getPose();
      const n3000 = (() => { let n = 0; const g = window.__grid; for (let i = 0; i < g.length; i++) if (g[i] === 3000) n++; return n; })();
      return {
        w: sk.bbox ? sk.bbox.w : 0, arms: pose ? pose.checks.arms : null,
        cx: sk.bbox ? sk.bbox.x + sk.bbox.w / 2 : null, has: sk.has,
        n3000: n3000,
        bands: (sk.bands || []).filter(b => b.ok).map(b => (b.R - b.L) * 100)
      };
    });
  }

  console.log("网格里等于 3000mm 的像素数（用来确认造景真的写进去了）");
  let r = await shoot({ dist: 3000, arm: 0 }, 900);
  console.log(`  下垂        n3000=${r.n3000}  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 900);
  console.log(`  T-pose      n3000=${r.n3000}  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms}`);
  console.log(`             逐带宽度: ${r.bands.map(x => x.toFixed(0)).join(" ")}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20, bar: shelf }, 900);
  console.log(`  横板T-pose  n3000=${r.n3000}  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms}`);
  console.log(`             逐带宽度: ${r.bands.map(x => x.toFixed(0)).join(" ")}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 900);
  console.log(`  切回干净    n3000=${r.n3000}  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms}`);
  console.log(`             逐带宽度: ${r.bands.map(x => x.toFixed(0)).join(" ")}`);
  r = await shoot({ dist: 3000, arm: 675, uFromTop: 0.20 }, 2500);
  console.log(`  再等2.5s    n3000=${r.n3000}  w=${(r.w * 96).toFixed(0)}格 arms=${r.arms}`);
  console.log(`             逐带宽度: ${r.bands.map(x => x.toFixed(0)).join(" ")}`);

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
