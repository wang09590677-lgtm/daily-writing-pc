/* 【verifier-oneshot 猫骨骼名核查】看 three.js GLTFLoader 载入后 bones{} 里的真实名字，
 * 特别是有无重名被改名（Head / Head_1）。只读。 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const puppeteer = require("puppeteer-core");
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-names-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--allow-file-access-from-files", "--user-data-dir=" + profileDir] });
  const page = await browser.newPage(); page.setDefaultTimeout(40000);
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  for (let i = 0; i < 45; i++) { const s = await page.evaluate(() => window.MotionAvatar.__skeleton()); if (s && (s.ready || s.failed)) break; await sleep(400); }
  const out = await page.evaluate(() => {
    const sk = window.MotionAvatar.__skeleton();
    const snap = window.MotionAvatar.__poseSnapshot();
    const want = ["Hips", "Spine", "Neck", "Head", "LeftUpperArm", "LeftHand", "RightUpperArm", "RightHand", "LeftUpperLeg", "LeftFoot", "RightUpperLeg", "RightFoot", "Tail_06"];
    return { boneNames: sk.boneNames, missingInSnap: want.filter(n => !(n in snap)), snapKeys: Object.keys(snap), axisMismatch: sk.axisMismatch };
  });
  console.log("骨骼名(" + out.boneNames.length + "):");
  console.log("  " + out.boneNames.join(", "));
  console.log("\n__poseSnapshot 里缺失的期望骨骼:", out.missingInSnap.join(", ") || "（无）");
  console.log("snap 实际键:", out.snapKeys.join(", "));
  console.log("\naxisMismatch:", out.axisMismatch.join(", ") || "（无）");
  console.log("\n含 Head 的骨骼名:", out.boneNames.filter(n => /head/i.test(n)).join(", "));
  await browser.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
})().catch(e => { console.error("崩溃:", e); process.exit(1); });
