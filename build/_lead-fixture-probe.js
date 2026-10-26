// 【合成夹具体检】用与 motion-browser-test 完全相同的假摄像头 Y4M，
// 但**不做任何断言**，只把引擎每一秒的 live 信号 + 门限诊断打出来。
// 目的：判定"合成人形数到 0 次"到底是
//   (a) 幅度门限把它挡了（repSpread < repGate）
//   (b) 信号本身在合成画面里根本没变化（背景差把静止两端的位移吸收了）
//   (c) 计数逻辑问题
// 这是排查既有失败的正确方式：先看数据，再决定改什么。
"use strict";
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "__motion-test.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 完全复用 motion-browser-test 的夹具参数 */
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
    for (let yy = hy - FIG.headR; yy <= hy + FIG.headR; yy++) { const half = Math.round(Math.sqrt(Math.max(0, FIG.headR * FIG.headR - (yy - hy) * (yy - hy)))); paint(y, cx - half, yy, cx + half + 1, yy + 1, B); }
    chunks.push(y, chroma, chroma);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

(async () => {
  buildY4M(Y4M);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required", "--no-proxy-server"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on("dialog", async d => { await d.accept(); });
  await page.evaluateOnNewDocument(() => { try { Object.defineProperty(window, "WebSocket", { value: function () { throw new Error("no depth"); }, writable: true, configurable: true }); } catch (e) { } });
  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0", { waitUntil: "load", timeout: 30000 });
  await sleep(1500);

  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);
  await page.evaluate(() => { [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click(); });
  await sleep(500);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(2500);
  const picked = await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    if (!sel) return null;
    const i = [...sel.options].findIndex(o => /半蹲热身/.test(o.textContent));
    const use = i >= 0 ? i : 0;
    sel.value = sel.options[use].value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.options[use].textContent.trim();
  });
  console.log("选中动作:", picked);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(1500);

  console.log("\n秒   reps  repSpread  repGate   说明    其他");
  for (let s = 0; s < 16; s++) {
    const d = await page.evaluate(() => {
      const e = window.__motionDebug ? window.__motionDebug() : null;
      if (!e) return null;
      return { reps: document.getElementById('mr-reps').textContent.trim(), spread: e.repSpread, gate: e.repGate,
        w: e.repSpread, h: e.repGate, cy: null, mo: null, badge: e.hint, vs: e.visionSource, sk: e.skeleton ? 1 : 0 };
    });
    if (d) {
      const blocked = (d.spread != null && d.gate != null && d.spread < d.gate);
      console.log(`${String(s + 1).padStart(2)}  ${String(d.reps).padStart(5)}  ${Number(d.spread).toFixed(5).padStart(9)}  ${Number(d.gate).toFixed(5).padStart(8)}  ${blocked ? "被闸门挡" : "  放行  "}  骨架=${d.sk} 链路=${d.vs}`);
    }
    await sleep(1000);
  }
  await browser.close();
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
