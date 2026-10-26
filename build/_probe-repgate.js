// 直测：合成人形（与 build/motion-browser-test.js 完全同一夹具）在**现行生产代码**下，
// 计次幅度闸门到底是「挡住」还是「放行但计数链路另有问题」。
// 只读：不改任何生产文件。采样 window.__motionDebug() 的 repGate / repSpread / progress。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__probe-repgate.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 与 motion-browser-test.js 相同的合成人形夹具 ---
const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], armL: [-18, -16, -12, 3], armR: [12, -16, 18, 3], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 36, REP_HZ = 0.6;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128);
  const cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => { for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v; };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24);
    const cy = Math.round(VH / 2 + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * 12);
    const B = 238;
    for (const part of [FIG.torso, FIG.armL, FIG.armR, FIG.legL, FIG.legR]) paint(y, cx + part[0], cy + part[1], cx + part[2], cy + part[3], B);
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) {
      const half = Math.round(Math.sqrt(Math.max(0, FIG.headR * FIG.headR - (yy - hy) * (yy - hy))));
      paint(y, cx - half, yy, cx + half + 1, yy + 1, B);
    }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

(async () => {
  buildY4M(Y4M);
  const y4mWin = Y4M.replace(/\//g, "\\");
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + y4mWin,
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR: " + e.message));
  await page.evaluateOnNewDocument(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url) { if (String(url).indexOf("127.0.0.1:8765") >= 0) throw new Error("depth bridge blocked"); return new RealWS(url, ...Array.prototype.slice.call(arguments, 1)); };
    window.WebSocket.prototype = RealWS.prototype;
  });
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date; const FIXED = new RealDate(2026, 8, 29, 10, 30, 0).getTime();
    class MockDate extends RealDate { constructor(...a) { if (!a.length) super(FIXED); else super(...a); } static now() { return FIXED; } }
    window.Date = MockDate;
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);
  await page.evaluate(() => { [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click(); });
  await sleep(500);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(1800);
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(600);
  const picked = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const idx = [...sel.options].findIndex(o => o.textContent.includes("半蹲热身"));
    sel.value = String(idx >= 0 ? idx : 0);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.options[sel.value].textContent.trim();
  });
  console.log("选中动作: " + picked);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1000);

  console.log("\n=== 采样（每 0.5s）：reps / repGate / repSpread / 是否被闸门挡 / visionSource / mode ===");
  const T0 = Date.now();
  let rows = [];
  for (let i = 0; i < 32; i++) {   // 16 秒
    const s = await page.evaluate(() => {
      const d = window.__motionDebug && window.__motionDebug();
      const reps = document.getElementById("mr-reps").textContent.trim();
      return d ? { reps, gate: d.repGate, spread: d.repSpread, vs: d.visionSource, mode: d.mode, running: d.running, previewing: d.previewing, prog: d.progress && d.progress.current, pct: d.progress && d.progress.percent } : null;
    });
    const t = ((Date.now() - T0) / 1000).toFixed(1);
    if (s) {
      const blocked = (s.spread != null && s.gate != null) ? (s.spread < s.gate) : null;
      rows.push({ t, ...s, blocked });
      console.log(`t=${String(t).padStart(5)}s  reps=${String(s.reps).padStart(3)}  gate=${fmt(s.gate)}  spread=${fmt(s.spread)}  ${blocked === null ? "?" : (blocked ? "BLOCKED(被挡)" : "open(放行)")}  vs=${s.vs || "-"}  mode=${s.mode}  run=${s.running}  prog=${fmt(s.prog)}`);
    } else {
      console.log(`t=${String(t).padStart(5)}s  __motionDebug=null`);
    }
    await sleep(500);
  }

  const openN = rows.filter(r => r.blocked === false).length;
  const blockedN = rows.filter(r => r.blocked === true).length;
  const maxSpread = Math.max(...rows.map(r => Number(r.spread) || 0));
  const minGate = Math.min(...rows.map(r => Number(r.gate) || Infinity));
  console.log("\n=== 汇总 ===");
  console.log(`放行帧 ${openN} / 被挡帧 ${blockedN} / 共 ${rows.length}`);
  console.log(`观测最大 spread=${fmt(maxSpread)}  最小 gate=${fmt(minGate)}  → ${maxSpread >= minGate ? "信号振幅 ≥ 门限（闸门**不应**挡）" : "信号振幅 < 门限（闸门确实在挡）"}`);
  console.log(`末帧 reps=${rows.length ? rows[rows.length - 1].reps : "-"}`);

  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  console.log("PROBE_DONE");

  function fmt(v) { return (v === null || v === undefined || v === "") ? "-" : (typeof v === "number" ? v.toFixed(4) : String(v)); }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
