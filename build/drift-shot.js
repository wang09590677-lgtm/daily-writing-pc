// 出图：画面左侧放一个同深度大柜子时，绿色色块是否仍锁在人身上。
// 对应修复项：labelComponents 面积降权 + 按列切分 + 竖长/居中/填充率判据。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const OUT = path.join(__dirname, "..", "..", "outputs");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCENE_FN = `
function buildScene(grid, s) {
  const W = 96, H = 72;
  const tv2 = Math.tan(45.5 * Math.PI / 360), th2 = Math.tan(58.4 * Math.PI / 360);
  const ray = (x, y) => { const u=(x+0.5)/W-0.5, v=(y+0.5)/H-0.5;
    return { dx: u*2*th2, dy: -v*2*tv2, dz: 1 }; };
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const d = ray(x,y); let z = s.wall / d.dz;
    if (d.dy < -1e-6) { const zf = (-s.camH/d.dy)*d.dz; if (zf>0 && zf<z) z = zf; }
    grid[y*W+x] = z>0 ? z : 0;
  }
  const height=1350, shoulder=340, legHalf=55, legGap=75, D=s.dist;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const d=ray(x,y); const t=D/d.dz; if (!(t>0)) continue;
    const wx=t*d.dx, wy=s.camH+t*d.dy;
    if (wy<0 || wy>height) continue;
    const ax=Math.abs(wx);
    let half;
    if (wy>height-200) half=75;
    else if (wy<height*0.42) { if (Math.abs(ax-legGap)>legHalf && Math.abs(ax+legGap)>legHalf) continue; half=9999; }
    else half=shoulder/2;
    if (half<9999 && ax>half) continue;
    grid[y*W+x]=D;
  }
  if (s.box) for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const d=ray(x,y); const t=s.dist/d.dz;
    const wx=t*d.dx, wy=s.camH+t*d.dy;
    if (wy<0 || wy>1900) continue;
    if (wx<-1400 || wx>-450) continue;
    grid[y*W+x]=s.dist;
  }
  return grid;
}
window.__buildScene = buildScene;
`;

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-drift-shot"),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1440,900"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(800);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(600);

  await page.evaluate(async () => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => { c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480); c.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
    await motionCamRefresh();
    await motionCamEnsureDefault();
  });
  await sleep(400);
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1600);

  // 画面尺寸钉成 640×480（harness 的假流上报不了可靠尺寸）
  await page.evaluate(() => {
    const v = document.getElementById("motionVideo");
    Object.defineProperty(v, "videoWidth", { configurable: true, get: () => 640 });
    Object.defineProperty(v, "videoHeight", { configurable: true, get: () => 480 });
    motionSyncOverlaySize(v);
  });
  await page.evaluate(`(function(){ ${SCENE_FN} })();`);
  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    motionEngine.attachDepth({
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  const shots = [];
  for (const dist of [1600, 2600, 3600]) {
    await page.evaluate((dist) => {
      window.__buildScene(window.__grid, { camH: 1000, wall: 4000, cx: 0.5, dist: dist, box: 1 });
    }, dist);
    await sleep(1100);
    const info = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const live = motionEngine.getLive();
      return { has: sk.has, bbox: sk.bbox || null, near: Math.round(live.depthNear || 0) };
    });
    const cx = info.bbox ? (info.bbox.x + info.bbox.w / 2).toFixed(3) : "—";
    console.log(`  ${dist}mm 骨架=${info.has ? "有" : "无"} cx=${cx} 距离=${info.near}mm`);
    const file = path.join(OUT, `motion-drift-${dist}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }

  await browser.close();
  console.log("出图: " + shots.map(f => path.basename(f)).join(", "));
})().catch(e => { console.error("FATAL", e); process.exit(1); });
