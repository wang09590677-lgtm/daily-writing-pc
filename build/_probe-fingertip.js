/* 快速探针：验证"真·指尖"这条链真的通了 —— 不跑整套验收，10 秒出结论。
 *   ① REACH_UP 是不是**从模型实测**来的（不是兜底 0.2125）
 *   ② `fingertipName()` 发现了哪根骨、腕→指尖有多远
 *   ③ 举手过顶时**真指尖**投到屏幕多少 px，与顶部面板下沿比
 *   ④ 顺手把"腕"也打印出来 —— 两者之差就是第一版 REACH_UP 少算的量
 *   ⑤ 存一张截图（R7：涉及界面的改动必须真的看一眼）
 *
 * 用法：node build/_probe-fingertip.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const VIEW = { width: 1280, height: 800 };
const VIEW_H = 1.8;
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "wbc-tip-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport(VIEW);
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE[" + m.type() + "]:", m.text()); });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  for (let i = 0; i < 40; i++) {
    const sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }

  const r = await page.evaluate((vh, overhead) => {
    const M = window.MotionAvatar;
    const h = window.innerHeight;
    const proj = y => (0.9 - y) * h / vh;
    M.setProgress({ name: "开合跳", current: 12, target: 20, unit: "次", percent: 60, seqIndex: 2, seqTotal: 5 });
    const prog = document.querySelector(".motion-avatar-progress");
    const safeTopPx = prog ? prog.getBoundingClientRect().bottom : 198;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(overhead);
    M.__renderNow();
    const s = M.__poseSnapshot();
    return {
      h, safeTopPx,
      lay: M.__layout(),
      mm: M.__modelMetrics(),
      tipKey: M.__modelMetrics().fingertip,
      tipWorld: s.RightFingertip ? s.RightFingertip[1] : null,
      tipPx: s.RightFingertip ? proj(s.RightFingertip[1]) : null,
      wristPx: s.RightHand ? proj(s.RightHand[1]) : null,
      headTopPx: s.HeadTop_End ? proj(s.HeadTop_End[1]) : null,
      handPx: s.RightHand ? proj(s.RightHand[1]) : null,
      keys: Object.keys(s)
    };
  }, VIEW_H, F.armsOverhead());

  console.log("\n== 布局 ==");
  console.log("  H=" + r.lay.H.toFixed(4) + "  footY=" + r.lay.footY.toFixed(4) +
    "  reachUp=" + r.lay.reachUp + "  reachUpMeasured=" + r.lay.reachUpMeasured + "  rawH=" + r.lay.rawH);
  console.log("\n== 模型实测手臂链 ==");
  console.log("  指尖骨 = " + r.mm.fingertip + "   臂链 = " + JSON.stringify(r.mm.armChain));
  const ac = r.mm.armChain || {};
  console.log("  归一化（臂链世界长 ÷ H × 0.827）：上臂 " + (ac.upperArm / r.lay.H * 0.827).toFixed(4) +
    "  前臂 " + (ac.foreArm / r.lay.H * 0.827).toFixed(4) +
    "  手 " + (ac.hand / r.lay.H * 0.827).toFixed(4) + "（期望 ≈0.1273/0.1295/0.0874）");
  console.log("\n== 举手过顶（armsOverhead）屏幕像素 ==");
  console.log("  顶部面板下沿      = " + r.safeTopPx.toFixed(1) + "px");
  console.log("  真·指尖           = " + (r.tipPx == null ? "缺" : r.tipPx.toFixed(1) + "px") +
    "   ← 判据：必须 > 面板下沿" + (r.tipPx != null ? "（余量 " + (r.tipPx - r.safeTopPx).toFixed(1) + "px）" : ""));
  console.log("  腕（RightHand）   = " + (r.wristPx == null ? "缺" : r.wristPx.toFixed(1) + "px") +
    "   ← 第一版把这里当成了指尖（差 " + (r.tipPx != null && r.wristPx != null ? (r.wristPx - r.tipPx).toFixed(1) : "-") + "px）");
  console.log("  头顶 HeadTop_End  = " + (r.headTopPx == null ? "缺" : r.headTopPx.toFixed(1) + "px"));
  console.log("  snapshot 键: " + r.keys.filter(k => /Fingertip|Hand/.test(k)).join(", "));

  await page.screenshot({ path: path.join(SHOTS, "avatar-overhead.png") });
  /* ⚠️ 必须喂**多帧**：`updateFromSkeleton` 带低通平滑（JOINT_SMOOTH），
   * 只喂 1 帧的话姿势还停在上一帧的半路上 —— 站姿截图会变成"手举在肩上"的假象。 */
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(null);
    window.MotionAvatar.__renderNow();
  });
  await page.screenshot({ path: path.join(SHOTS, "avatar-stand.png") });
  console.log("\n截图: build/shots/avatar-overhead.png, avatar-stand.png");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(2); });
