/* 【verifier-oneshot 闸门归因探针】
 * 目的：独立证实/推翻"合成人形数到 0 次 = 幅度闸门把它挡掉了"这一归因。
 * 做法：用与 motion-browser-test.js 相同的合成人形 Y4M 喂真 Chrome 假摄像头，
 * 进体感页开摄像头跑半蹲热身，通过劫持 createEngine 抓到引擎实例，onTick
 * 收集真实的 repGate / repSpread / live.height / live.centroidY。
 * 只读，不改任何产品文件。
 */
"use strict";
const path = require("path"), fs = require("fs");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "_verify-gate.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// —— 与 build/motion-browser-test.js 完全一致的合成人形 ——
const FIG = {
  headR: 6, headDy: -27, torso: [-10, -19, 10, 9], armL: [-18, -16, -12, 3],
  armR: [12, -16, 18, 3], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30]
};
const VW = 128, VH = 96, VFPS = 25, VSEC = 36, REP_HZ = 0.6;
function buildY4M(file, ampPx, footDy) {
  const ySize = VW * VH, cSize = (VW >> 1) * (VH >> 1);
  const chunks = [Buffer.from(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc(cSize, 128);
  const cx = Math.round(VW / 2);
  const paint = (y, x0, y0, x1, y1, v) => {
    for (let yy = Math.max(0, y0); yy < Math.min(VH, y1); yy++)
      for (let xx = Math.max(0, x0); xx < Math.min(VW, x1); xx++) y[yy * VW + xx] = v;
  };
  for (let f = 0; f < VFPS * VSEC; f++) {
    chunks.push(Buffer.from("FRAME\n"));
    const y = Buffer.alloc(ySize, 24);
    const cy = Math.round(VH / 2 + (footDy || 0) + Math.sin((f / VFPS) * 2 * Math.PI * REP_HZ) * ampPx);
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
  buildY4M(Y4M, 12, 0);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));

  // 劫持 createEngine，抓实例并把 onTick 数据记下来
  await page.evaluateOnNewDocument(() => {
    let _me = null;
    Object.defineProperty(window, "MotionEngine", {
      configurable: true,
      get() { return _me; },
      set(v) {
        if (v && typeof v.createEngine === "function") {
          const orig = v.createEngine;
          v.createEngine = function () {
            const inst = orig.apply(this, arguments);
            window.__eng = inst; window.__gateLog = [];
            try {
              inst.onTick(st => window.__gateLog.push({
                reps: st.reps, gate: st.repGate, spread: st.repSpread,
                mode: st.mode, h: st.live ? st.live.height : null,
                cy: st.live ? st.live.centroidY : null, src: st.live ? st.live.visionSource : null
              }));
            } catch (e) {}
            return inst;
          };
        }
        _me = v;
      }
    });
  });
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) { if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("depth blocked"); return new RWS(u, ...Array.prototype.slice.call(arguments, 1)); };
    window.WebSocket.prototype = RWS.prototype;
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click());
  await sleep(500);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(1800);
  await page.evaluate(() => document.getElementById("poseCalibSkip").click());
  await sleep(600);
  await page.evaluate(() => {
    const sel = document.getElementById("motionExSelect");
    const idx = [...sel.options].findIndex(o => o.textContent.includes("半蹲热身"));
    sel.value = String(idx >= 0 ? idx : 0);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(300);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());
  await sleep(15000);

  const out = await page.evaluate(() => {
    const log = window.__gateLog || [];
    const last = log.slice(-40);
    const gates = log.map(x => x.gate).filter(g => g > 0);
    const spreads = log.map(x => x.spread).filter(s => s > 0);
    const cy = log.map(x => x.cy).filter(v => v !== null && v !== undefined);
    const hs = log.map(x => x.h).filter(v => v !== null && v !== undefined && v > 0);
    const mx = a => a.length ? Math.max(...a) : null, mn = a => a.length ? Math.min(...a) : null;
    const repsEl = document.getElementById("mr-reps");
    return {
      n: log.length,
      reps: repsEl ? repsEl.textContent.trim() : "?",
      gateMax: mx(gates), gateMin: mn(gates),
      spreadMax: mx(spreads), spreadMin: mn(spreads),
      heightMax: mx(hs), heightMin: mn(hs),
      cyMax: mx(cy), cyMin: mn(cy), cySpread: (cy.length ? mx(cy) - mn(cy) : null),
      src: last.length ? last[last.length - 1].src : null,
      mode: last.length ? last[last.length - 1].mode : null,
      gateSample: last.slice(0, 6).map(x => `gate=${x.gate} spread=${x.spread} h=${x.h} cy=${x.cy}`)
    };
  });
  console.log("== 闸门归因探针结果 ==");
  console.log(JSON.stringify(out, null, 2));
  console.log("页面异常:", errs.length ? errs : "无");
  await browser.close();
})().catch(e => { console.error("探针崩溃:", e); process.exit(1); });
