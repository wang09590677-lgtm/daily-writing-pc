/* 【verifier-oneshot 猫左右调试】定位"喂 engineL / engineR 结果相同"的原因。 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const puppeteer = require("puppeteer-core");
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function poseBase() {
  return {
    head: { x: .5, y: .10 }, neck: { x: .5, y: .22 },
    shoulderL: { x: .43, y: .27 }, shoulderR: { x: .57, y: .27 },
    elbowL: { x: .42, y: .37 }, elbowR: { x: .58, y: .37 },
    foreL: { x: .415, y: .41 }, foreR: { x: .585, y: .41 },
    wristL: { x: .41, y: .45 }, wristR: { x: .59, y: .45 },
    handL: { x: .41, y: .47 }, handR: { x: .59, y: .47 },
    midL: { x: .44, y: .40 }, midR: { x: .56, y: .40 },
    hipMid: { x: .5, y: .55 }, hipL: { x: .46, y: .55 }, hipR: { x: .54, y: .55 },
    kneeL: { x: .46, y: .70 }, kneeR: { x: .54, y: .70 },
    shinL: { x: .46, y: .79 }, shinR: { x: .54, y: .79 },
    ankleL: { x: .456, y: .88 }, ankleR: { x: .544, y: .88 },
    toeL: { x: .456, y: .925 }, toeR: { x: .544, y: .925 }
  };
}
function raise(side, dy) {
  const j = poseBase();
  const k = side === "engineL" ? ["shoulderL", "midL", "elbowL", "foreL", "wristL", "handL"]
    : ["shoulderR", "midR", "elbowR", "foreR", "wristR", "handR"];
  k.forEach(n => { if (j[n]) j[n].y -= dy; });
  return j;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-dbgcat-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required", "--user-data-dir=" + profileDir] });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  for (let i = 0; i < 45; i++) { const s = await page.evaluate(() => window.MotionAvatar.__skeleton()); if (s && (s.ready || s.failed)) break; await sleep(400); }

  const A = raise("engineL", 0.30), B = raise("engineR", 0.30);
  console.log("Node 侧输入差异自检：");
  console.log("  A.handL=", JSON.stringify(A.handL), " A.handR=", JSON.stringify(A.handR));
  console.log("  B.handL=", JSON.stringify(B.handL), " B.handR=", JSON.stringify(B.handR));

  const out = await page.evaluate((a, b) => {
    const snap = () => window.MotionAvatar.__poseSnapshot();
    const feed = j => { for (let i = 0; i < 60; i++) window.MotionAvatar.updateFromSkeleton(j); return snap(); };
    window.MotionAvatar.updateFromSkeleton(null);
    for (let i = 0; i < 60; i++) window.MotionAvatar.updateFromSkeleton(null);
    const idle = snap();
    const sA = feed(a);
    const sB = feed(b);
    // 直接读"引擎侧"驱动后的方向：模型各臂骨的世界位置
    const pick = s => ({ LHand: s.LeftHand, RHand: s.RightHand, LArm: s.LeftUpperArm, RArm: s.RightUpperArm, Head: s.Head, Hips: s.Hips, Neck: s.Neck });
    return { idle: pick(idle), A: pick(sA), B: pick(sB) };
  }, A, B);

  const show = (n, o) => console.log(`  ${n.padEnd(6)} LHand=${JSON.stringify(o.LHand)} RHand=${JSON.stringify(o.RHand)} LArm=${JSON.stringify(o.LArm)} RArm=${JSON.stringify(o.RArm)} Head=${JSON.stringify(o.Head)} Hips=${JSON.stringify(o.Hips)}`);
  console.log("\n浏览器侧快照：");
  show("idle", out.idle); show("A(engineL)", out.A); show("B(engineR)", out.B);

  console.log("\nA 与 B 是否完全相同:", JSON.stringify(out.A) === JSON.stringify(out.B));

  await browser.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
})().catch(e => { console.error("崩溃:", e); process.exit(1); });
