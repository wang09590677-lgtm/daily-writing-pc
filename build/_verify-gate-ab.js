/* 【verifier-oneshot 闸门归因 A/B 对照】
 * 目的：区分两种解释——
 *   ① 闸门挡掉了夹具信号（那降门限后计数应恢复）
 *   ② 夹具信号本身没成形（那降门限后仍是 0）
 * 做法：同一次运行内，先默认（expectedAmplitude=0.06）跑 15s，再运行时把
 * expectedAmplitude 临时降到 0.005 继续跑 15s，比较两段 reps。
 * 只改运行时内存里的 profile 对象，不碰任何文件。
 */
"use strict";
const path = require("path"), fs = require("fs");
const puppeteer = require("puppeteer-core");
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const Y4M = path.join(__dirname, "_verify-gate.y4m");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FIG = { headR: 6, headDy: -27, torso: [-10, -19, 10, 9], armL: [-18, -16, -12, 3], armR: [12, -16, 18, 3], legL: [-9, 9, -2, 30], legR: [2, 9, 9, 30] };
const VW = 128, VH = 96, VFPS = 25, VSEC = 36, REP_HZ = 0.6;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + Y4M.replace(/\//g, "\\"),
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    let _me = null;
    Object.defineProperty(window, "MotionEngine", {
      configurable: true, get() { return _me; },
      set(v) { if (v && typeof v.createEngine === "function") { const o = v.createEngine; v.createEngine = function () { const i = o.apply(this, arguments); window.__eng = i; return i; }; } _me = v; }
    });
  });
  await page.evaluateOnNewDocument(() => {
    const RWS = window.WebSocket;
    window.WebSocket = function (u) { if (String(u).indexOf("127.0.0.1:8765") >= 0) throw new Error("d"); return new RWS(u, ...Array.prototype.slice.call(arguments, 1)); };
    window.WebSocket.prototype = RWS.prototype;
  });
  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/") + "?motionPrep=0";
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" }); await sleep(900);
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click()); await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click()); await sleep(500);
  await page.evaluate(() => document.getElementById("motionCameraBtn").click()); await sleep(1800);
  await page.evaluate(() => document.getElementById("poseCalibSkip").click()); await sleep(600);
  await page.evaluate(() => { const s = document.getElementById("motionExSelect"); const i = [...s.options].findIndex(o => o.textContent.includes("半蹲热身")); s.value = String(i >= 0 ? i : 0); s.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(300);
  await page.evaluate(() => document.getElementById("motionStartBtn").click());

  await sleep(15000);
  const segA = await page.evaluate(() => ({ reps: document.getElementById("mr-reps").textContent.trim(), gate: window.__eng.getState().repGate, spread: window.__eng.getState().repSpread }));
  console.log("段A（原门限 expectedAmplitude=0.06）:", JSON.stringify(segA));

  // 运行时把门限降到近乎不放行门槛以外的极小值
  await page.evaluate(() => {
    window.__eng.setProfile({ id: "__probe", mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.005 });
  });
  await page.evaluate(() => { window.__repBase = window.__eng.getState().reps; });
  await sleep(15000);
  const segB = await page.evaluate(() => ({ reps: document.getElementById("mr-reps").textContent.trim(), gate: window.__eng.getState().repGate, spread: window.__eng.getState().repSpread }));
  console.log("段B（运行时门限 expectedAmplitude=0.005）:", JSON.stringify(segB));

  console.log("\n判定：段B 计数若明显 > 0 → 闸门是主因；若仍为 0 → 信号本身未成形。");
  await browser.close();
})().catch(e => { console.error("崩溃:", e); process.exit(1); });
