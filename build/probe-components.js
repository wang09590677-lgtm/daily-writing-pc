// 从 midMask ASCII 复原连通域表（8-连通并查集），检查"含臂整块"是否真的存在。
// 这样不用改引擎就能判定：t_pose 的宽块是被谁吃掉的。
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORBBEC = path.join(__dirname, "..", "tools", "orbbec");
const real = JSON.parse(fs.readFileSync(path.join(ORBBEC, "real-depth-person.json"), "utf8"));

// —— 纯 JS 连通域（与引擎同构：8-连通 + labelBuf 扁平化）——
function components(ascii) {
  const H = ascii.length, W = ascii[0].length, PIX = W * H;
  const mask = new Uint8Array(PIX);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ascii[y][x] === "#") mask[y * W + x] = 1;
  const label = new Int32Array(PIX);
  const par = new Int32Array(PIX + 1);
  let next = 0;
  const find = a => { let r = a; while (par[r] !== r) r = par[r]; while (par[a] !== r) { const n = par[a]; par[a] = r; a = n; } return r; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par[rb] = ra; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!mask[i]) continue;
    let lb = 0;
    const l = x > 0 ? label[i - 1] : 0; if (l) lb = l;
    if (y > 0) {
      const tl = x > 0 ? label[i - W - 1] : 0, t = label[i - W], tr = x < W - 1 ? label[i - W + 1] : 0;
      if (tl && (!lb || tl < lb)) lb = tl;
      if (t && (!lb || t < lb)) lb = t;
      if (tr && (!lb || tr < lb)) lb = tr;
    }
    if (!lb) { next++; par[next] = next; lb = next; }
    label[i] = lb;
    if (l) uni(lb, l);
    if (y > 0) { if (x > 0 && label[i - W - 1]) uni(lb, label[i - W - 1]); if (label[i - W]) uni(lb, label[i - W]); if (x < W - 1 && label[i - W + 1]) uni(lb, label[i - W + 1]); }
  }
  const area = new Int32Array(PIX + 1), mnx = new Int32Array(PIX + 1).fill(W), mxx = new Int32Array(PIX + 1).fill(-1),
    mny = new Int32Array(PIX + 1).fill(H), mxy = new Int32Array(PIX + 1).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!label[i]) continue;
    const r = find(label[i]); label[i] = r; area[r]++;
    if (x < mnx[r]) mnx[r] = x; if (x > mxx[r]) mxx[r] = x;
    if (y < mny[r]) mny[r] = y; if (y > mxy[r]) mxy[r] = y;
  }
  const out = [];
  for (let r = 1; r <= next; r++) if (area[r] > 0) out.push({ r, area: area[r], w0: mnx[r], w1: mxx[r], h0: mny[r], h1: mxy[r] });
  out.sort((a, b) => b.area - a.area);
  return { out, label, W, H, find };
}

function render(label, keepRoot, W, H) {
  const lines = [];
  for (let y = 0; y < H; y++) {
    let s = "";
    for (let x = 0; x < W; x++) { const r = label[y * W + x]; s += (!r ? "." : (r === keepRoot ? "#" : "o")); }
    lines.push(s);
  }
  return lines;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-cc-" + process.pid),
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
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
    const grid = new Float32Array(96 * 72); window.__grid = grid;
    motionEngine.attachDepth({ available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {} });
    motionEngine.attach(cv); motionEngine.preview();
  });
  await page.evaluate(() => motionEngine.beginRoomScan());
  async function feed(arr, n) {
    for (let i = 0; i < n; i++) {
      const cs = arr[Math.min(i, arr.length - 1)];
      await page.evaluate((cells) => {
        const g = window.__grid; const flat = [];
        for (let y = 0; y < cells.length; y++) { const row = cells[y];
          for (let x = 0; x < row.length; x++) flat.push(row[x] || 0); }
        for (let k = 0; k < g.length; k++) g[k] = flat[k] || 0;
      }, cs);
      await sleep(170);
    }
  }
  await feed(new Array(20).fill(real.bg), 20);

  const only = process.env.POSE || null;
  for (const p of real.poses) {
    if (only && p.name !== only) continue;
    await feed(p.frames.slice(0, 6).map(f => f.grid), 6);
    const r = await page.evaluate(() => {
      const d = motionEngine.depthDebug();
      return { mid: d && d.midMask, person: d && d.personMask, gc: d && d.gc };
    });
    console.log("\n================ " + p.name + " ================");
    console.log("  引擎 gc: " + JSON.stringify(r.gc));
    if (!r.mid) { console.log("  (无 midMask)"); continue; }
    const cc = components(r.mid);
    console.log("  连通域总数=" + cc.out.length + "（面积 ≥ 0.5% PIX 的）");
    const PIX = 96 * 72;
    cc.out.filter(c => c.area >= PIX * 0.005).forEach(c => {
      const bw = (c.w1 - c.w0 + 1) / 96, bh = (c.h1 - c.h0 + 1) / 72;
      const fill = c.area / ((c.w1 - c.w0 + 1) * (c.h1 - c.h0 + 1));
      const cx = (c.w0 + c.w1 + 1) / 192;
      console.log("   #" + c.r + " area=" + c.area + " (" + (c.area / PIX * 100).toFixed(1) + "%)" +
        "  bbox x" + c.w0 + "-" + c.w1 + " (" + bw.toFixed(3) + ")" +
        " y" + c.h0 + "-" + c.h1 + " (" + bh.toFixed(3) + ")" +
        "  ratio=" + (bh / bw).toFixed(2) + " fill=" + fill.toFixed(2) + " cx=" + cx.toFixed(3) +
        (c.area >= PIX * 0.005 && bh >= 0.22 && bw >= 0.025 && bh / bw >= 1.10 ? "   [过形状闸]" : ""));
    });
    // 用面积最大的那块渲染
    const big = cc.out[0];
    if (big) {
      console.log("\n  —— 最大块 #" + big.r + " 空间图（#=该块, o=其它块）——");
      render(cc.label, big.r, 96, 72).forEach((s, i) => { if (s.includes("#") || s.includes("o")) console.log(String(i).padStart(3) + " " + s); });
    }
  }
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
