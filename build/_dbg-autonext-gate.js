/* 【快速诊断】探针的 expectedAmplitude 放宽到底有没有生效？
 *
 * 疑点：_probe-autonext-verify.js 里写的是
 *     motionChoice.profile.expectedAmplitude = 0.005;
 * 但引擎里的 profile 是 setProfile() 时做的**副本**（Object.assign({}, DEFAULT_PROFILE, p)），
 * 而 setMotionChoice() 已经在那之前调过 setProfile 了 —— 也就是说这一行改的是
 * 「动作选择对象」，引擎手上一份旧副本没变，闸门仍是 0.18*0.5*bodyScale。
 * 若成立：合成夹具 spread(~0.02) < gate(~0.09) → 逐帧被挡 → 只数 1 次。
 * 这就能解释「同一个夹具、同一个脚本，11:32 能数到 20、现在只数到 1」——
 * 因为 11:32 时幅度闸门还没落地。
 *
 * 本脚本只做一件事：改 ea → **重新 setProfile** → 读回引擎实测 spread/gate 与计数。
 * 用法：node build/_dbg-autonext-gate.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const Y4M = path.join(os.tmpdir(), "wbc-gate-" + process.pid + ".y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 40, REP_HZ = 1.25;
function buildY4M(file) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128), cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => { for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v; };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24), B = 238;
    const spread = 17 + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * 9, cy = Math.round(VH / 2);
    for (const p of [FIG.torso, FIG.legL, FIG.legR]) paint(y, cx + p[0], cy + p[1], cx + p[2], cy + p[3], B);
    paint(y, Math.round(cx - spread), cy - 15, Math.round(cx - 9), cy - 12, B);
    paint(y, Math.round(cx + 9), cy - 15, Math.round(cx + spread), cy - 12, B);
    const hy = cy + FIG.headDy;
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) { const h = Math.round(Math.sqrt(Math.max(0, FIG.headR ** 2 - (yy - hy) ** 2))); paint(y, cx - h, yy, cx + h + 1, yy + 1, B); }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

(async () => {
  buildY4M(Y4M);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) { if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("blocked"); return new RWS(u, ...Array.prototype.slice.call(arguments, 1)); };
    window.WebSocket.prototype = RWS.prototype;
  });
  await page.evaluateOnNewDocument(() => {
    const RD = Date; const FIXED = new RD(2026, 9, 1, 10, 30, 0).getTime();
    class MD extends RD { constructor(...a) { if (!a.length) super(FIXED); else super(...a); } static now() { return FIXED; } }
    window.Date = MD;
  });
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => { try { localStorage.removeItem("dailyWritingPcStateV3"); } catch (e) { } });
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(480);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(420);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  for (let i = 0; i < 25; i++) { if (await page.evaluate(() => !!document.getElementById("motionVideo").srcObject)) break; await sleep(400); }
  await sleep(800);
  await page.evaluate(() => { const b = document.getElementById("poseCalibSkip"); if (b) b.click(); });
  await sleep(600);

  const pre = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const i = [...sel.options].findIndex(o => o.textContent.includes("开合跳"));
    sel.value = String(i); sel.dispatchEvent(new Event("change", { bubbles: true }));
    const before = motionChoice.profile.expectedAmplitude;
    return { exId: motionChoice.exId, eaBefore: before };
  });
  console.log("SETUP", JSON.stringify(pre));

  // 对照 A：只改 motionChoice.profile，不重设（复现探针的做法）
  await page.evaluate(() => { motionChoice.profile.expectedAmplitude = 0.005; document.getElementById("motionStartBtn").click(); });
  await sleep(9000);
  const a = await page.evaluate(() => {
    const st = motionEngine.getState(), d = window.__motionDebug();
    return { gate: st.repGate, spread: st.repSpread, reps: st.reps, pct: d.progress ? d.progress.percent : null };
  });
  console.log("对照A（只改对象，不重设）", JSON.stringify(a));

  // 对照 B：改 ea 后【重新 setProfile】，把新 ea 真正推进引擎
  // （setProfile 内部会 resetCounters(true)，不需要另外调 resetCounters ——
  //  它不在引擎的公开 API 里，直接调会 TypeError）
  await page.evaluate(() => {
    if (typeof motionStopSet === "function") motionStopSet(true);
    motionChoice.profile.expectedAmplitude = 0.005;
    motionEngine.setProfile(motionChoice.profile);       // ★ 关键一步
  });
  await sleep(400);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(12000);
  const b = await page.evaluate(() => {
    const st = motionEngine.getState(), d = window.__motionDebug();
    return { gate: st.repGate, spread: st.repSpread, reps: st.reps, mode: st.mode, pct: d.progress ? d.progress.percent : null };
  });
  console.log("对照B（改后重设 setProfile）", JSON.stringify(b));

  await browser.close();
  try { fs.unlinkSync(Y4M); } catch (e) { }
  process.exit(0);
})().catch(e => { console.error("FATAL", e); try { fs.unlinkSync(Y4M); } catch (_) { } process.exit(1); });
