// 3D 跟练角色基础渲染测试（不依赖真实摄像头，用合成骨架驱动）
//
// ⚠️ 本文件跟着模型替换更新过两次，**每次都是"改写断言"而不是"放宽断言"**：
//    ① 2026-10-06：程序化拼几何的猫 → GLB 蒙皮猫（骨段 mesh 名 → 骨骼层级名）
//    ② 2026-10-09：GLB 蒙皮猫 → Mixamo 人形 65 骨骼（骨名再变一次，见下面 LIMB_BONES）
//    核心意图一直没变：**骨架要连贯、要显示出来、退出入口要在、极限姿态不能断**。
//
// 另有一处必须注意的**时序**问题：GLB 是**异步加载**的（`GLTFLoader.load`），
// 页面 load 完的那一刻模型还没到，此时查骨骼会全部落空（links=0）——
// 老版本是同步建几何，没有这个问题。所以本测试必须**先等 __skeleton().ready**。
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules",
  "puppeteer-core"
));
const F = require("./_avatar-fixtures.js");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 合成站姿 / 双臂平举：统一从 `_avatar-fixtures.js` 取，别在本文件另抄一份
 * （抄了就会与其它三个测试漂移，最后"红了也不知道是产品变了还是夹具变了"）。 */
const STAND = F.STAND;
const ARMS_UP = F.armSpread();

/* 驱动表里代表"四肢骨段"的骨骼名（Mixamo 短名，`resolveBone()` 会补 mixamorig 前缀）。
 * ⚠️ 别用"名字里含 Arm 的骨骼数 === N"这类计数断言 —— 驱动表里手臂相关骨骼有 6 根
 *    （Shoulder/Arm/ForeArm/Hand × 左右），数出来会误判。按名精确取。
 * ⚠️ Mixamo 命名与旧猫模型不同：上臂 = `*Arm`、前臂 = `*ForeArm`、大腿 = `*UpLeg`、
 *    小腿 = `*Leg`。别按"UpperArm / LowerArm"的直觉写（那是旧猫的名字）。 */
const LIMB_BONES = [
  "RightArm", "RightForeArm", "LeftArm", "LeftForeArm",
  "RightUpLeg", "RightLeg", "LeftUpLeg", "LeftLeg"
];

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-avtest-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 900 },
    args: [
      "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir
    ]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);

  // 先显示，再等 GLB 异步加载完成（否则查骨骼必然全空）
  await page.evaluate(() => window.MotionAvatar.show());
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (s && (s.ready || s.failed)) { ready = s.ready; break; }
    await sleep(400);
  }

  const ok = await page.evaluate(stand => {
    window.MotionAvatar.updateFromSkeleton(stand);
    for (let i = 0; i < 30; i++) window.MotionAvatar.updateFromSkeleton(stand);
    const debug = window.MotionAvatar.debug();
    const pose = window.MotionAvatar.__poseSnapshot();
    return {
      ready: debug.ready,
      links: debug.links.filter(l => l.visible).length,
      badLen: debug.links.filter(l => l.visible && (l.length <= 0.005 || l.length >= 0.85)).map(l => l.name),
      visible: !document.getElementById("motionAvatar").classList.contains("hidden"),
      hasCanvas: !!document.querySelector("#motionAvatar canvas"),
      exitButton: Array.from(document.querySelectorAll("#motionAvatar button"))
        .some(button => button.textContent.includes("结束并评分")),
      pose
    };
  }, STAND);

  const limbsOk = LIMB_BONES.every(n => Array.isArray(ok.pose[n]) && ok.pose[n].every(v => Number.isFinite(v)));
  const chainOk = ok.links >= 12 && ok.badLen.length === 0;
  console.log((chainOk && ok.exitButton && ok.visible && ok.hasCanvas && limbsOk)
    ? "PASS  3D角色骨架连贯、显示和退出入口"
    : "FAIL  3D角色骨架或退出入口");
  console.log("  ready=" + ok.ready + " visible=" + ok.visible + " hasCanvas=" + ok.hasCanvas +
    " 驱动骨骼=" + ok.links + " exitButton=" + ok.exitButton + " 四肢骨段=" + (limbsOk ? "齐全" : "缺"));
  if (ok.badLen.length) console.log("  长度越界: " + JSON.stringify(ok.badLen));

  await sleep(250);
  await page.screenshot({ path: path.join(__dirname, "shots", "avatar-test.png") });
  console.log("截图: build/shots/avatar-test.png");

  /* 双臂抬起仍要保持骨链完整（极限姿态下不能断/不能 NaN） */
  const raised = await page.evaluate(up => {
    for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(up);
    const pose = window.MotionAvatar.__poseSnapshot();
    const links = window.MotionAvatar.debug().links;
    return {
      pose,
      visible: links.filter(l => l.visible).length,
      badLen: links.filter(l => l.visible && (l.length <= 0.005 || l.length >= 0.85)).map(l => l.name)
    };
  }, ARMS_UP);

  // 抬臂后：手应该比肩高（y 向上为正）
  const armUpOk = raised.pose.LeftHand[1] > raised.pose.LeftArm[1] &&
    raised.pose.RightHand[1] > raised.pose.RightArm[1];
  const chainOK2 = raised.visible >= 12 && raised.badLen.length === 0 &&
    LIMB_BONES.every(n => raised.pose[n] && raised.pose[n].every(v => Number.isFinite(v)));
  const poseOK = chainOK2 && armUpOk;
  console.log(poseOK ? "PASS  双臂抬起仍保持骨链连接" : "FAIL  双臂骨段断开或未抬起");
  if (!poseOK) {
    console.log("  可见骨骼=" + raised.visible + " 长度越界=" + JSON.stringify(raised.badLen));
    console.log("  左肩y=" + raised.pose.LeftArm[1] + " 左手y=" + raised.pose.LeftHand[1]);
    console.log("  右肩y=" + raised.pose.RightArm[1] + " 右手y=" + raised.pose.RightHand[1]);
  }
  console.log("  驱动骨骼总数=" + raised.visible);

  await sleep(250);
  await page.screenshot({ path: path.join(__dirname, "shots", "avatar-arms-raised.png") });
  console.log("截图: build/shots/avatar-arms-raised.png");

  await browser.close();
  process.exit(chainOk && ok.exitButton && ok.visible && ok.hasCanvas && limbsOk && poseOK ? 0 : 1);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
