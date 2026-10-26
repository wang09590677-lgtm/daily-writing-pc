/* 换模型后的冒烟测试：真加载 + 实测尺寸 + IK 误差 + 骨名解析 + 关键姿势截图。
   用法：node build/_smoke-human-avatar.js
   不写任何断言文件，只打印 —— 断言由正式的验收脚本负责。 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const SHOT = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STAND = {
  head: { x: 0.500, y: 0.120 }, neck: { x: 0.500, y: 0.235 },
  shoulderL: { x: 0.430, y: 0.280 }, shoulderR: { x: 0.570, y: 0.280 },
  midL: { x: 0.425, y: 0.330 }, midR: { x: 0.575, y: 0.330 },
  elbowL: { x: 0.420, y: 0.380 }, elbowR: { x: 0.580, y: 0.380 },
  foreL: { x: 0.416, y: 0.425 }, foreR: { x: 0.584, y: 0.425 },
  wristL: { x: 0.414, y: 0.468 }, wristR: { x: 0.586, y: 0.468 },
  handL: { x: 0.413, y: 0.492 }, handR: { x: 0.587, y: 0.492 },
  hipMid: { x: 0.500, y: 0.560 }, hipL: { x: 0.462, y: 0.563 }, hipR: { x: 0.538, y: 0.563 },
  kneeL: { x: 0.460, y: 0.712 }, kneeR: { x: 0.540, y: 0.712 },
  shinL: { x: 0.459, y: 0.800 }, shinR: { x: 0.541, y: 0.800 },
  ankleL: { x: 0.458, y: 0.888 }, ankleR: { x: 0.542, y: 0.888 },
  toeL: { x: 0.458, y: 0.930 }, toeR: { x: 0.542, y: 0.930 }
};
const clone = o => JSON.parse(JSON.stringify(o));
function armSpread() {
  const o = clone(STAND);
  const s = (k, x, y) => { o[k].x = x; o[k].y = y; };
  s("shoulderL", 0.40, 0.280); s("shoulderR", 0.60, 0.280);
  s("midL", 0.34, 0.300); s("midR", 0.66, 0.300);
  s("elbowL", 0.27, 0.265); s("elbowR", 0.73, 0.265);
  s("foreL", 0.21, 0.225); s("foreR", 0.79, 0.225);
  s("wristL", 0.16, 0.190); s("wristR", 0.84, 0.190);
  s("handL", 0.14, 0.170); s("handR", 0.86, 0.170);
  return o;
}
function raiseOne(side, dy) {
  const o = clone(STAND);
  const up = side === "engineL" ? ["shoulderL", "midL", "elbowL", "foreL", "wristL", "handL"]
    : ["shoulderR", "midR", "elbowR", "foreR", "wristR", "handR"];
  const dn = side === "engineL" ? ["shoulderR", "midR", "elbowR", "foreR", "wristR", "handR"]
    : ["shoulderL", "midL", "elbowL", "foreL", "wristL", "handL"];
  const sx = side === "engineL" ? -1 : 1;
  up.forEach((k, i) => { o[k].x = 0.5 + sx * (0.06 + i * 0.035); o[k].y = 0.28 - i * 0.045; });
  dn.forEach((k, i) => { o[k].x = 0.5 - sx * (0.06 - i * 0.006); o[k].y = 0.28 + i * 0.048; });
  return o;
}
function deepKnee() {
  const o = clone(STAND);
  Object.assign(o, {
    kneeL: { x: 0.440, y: 0.600 }, ankleL: { x: 0.440, y: 0.680 }, toeL: { x: 0.440, y: 0.700 },
    kneeR: { x: 0.560, y: 0.600 }, ankleR: { x: 0.560, y: 0.680 }, toeR: { x: 0.560, y: 0.700 }
  });
  return o;
}
function legsApart() {
  const o = clone(STAND);
  Object.assign(o, {
    kneeL: { x: 0.400, y: 0.712 }, kneeR: { x: 0.600, y: 0.712 },
    shinL: { x: 0.360, y: 0.800 }, shinR: { x: 0.640, y: 0.800 },
    ankleL: { x: 0.320, y: 0.888 }, ankleR: { x: 0.680, y: 0.888 },
    toeL: { x: 0.310, y: 0.930 }, toeR: { x: 0.690, y: 0.930 }
  });
  return o;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-smoke-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errs = [];
  page.on("pageerror", e => { errs.push("PAGEERROR " + e.message); console.log("PAGEERROR:", e.message); });
  page.on("console", m => {
    const t = m.type();
    if (t === "error") { errs.push("CONSOLE " + m.text()); console.log("CONSOLE-ERR:", m.text()); }
    if (t === "warning") console.log("CONSOLE-WARN:", m.text());
  });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1000);
  await page.evaluate(() => window.MotionAvatar.show());

  let sk = null;
  for (let i = 0; i < 45; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("\n== 加载 ==");
  console.log("ready=" + sk.ready + " failed=" + sk.failed + " reason=" + (sk.reason || "-"));
  console.log("boneCount=" + sk.boneCount + " skinnedCount=" + sk.skinnedCount + " topDownLen=" + sk.topDownLen + " tail=" + sk.tail);
  console.log("使用兜底 = " + sk.usingFallback);
  console.log("骨轴偏差>15° = " + JSON.stringify(sk.axisMismatch));

  const mm = await page.evaluate(() => window.MotionAvatar.__modelMetrics());
  console.log("\n== 实测尺寸 ==");
  console.log("url = " + mm.url);
  console.log("RAW_H = " + mm.rawH + "  REST_LOWEST = " + mm.restLowest + "  LEG_STRETCH = " + mm.legStretch);
  console.log("measured = " + JSON.stringify(mm.measured));

  const dbg = await page.evaluate(() => window.MotionAvatar.debug());
  console.log("\n== 驱动表解析 ==");
  console.log("unresolved = " + JSON.stringify(dbg.unresolved));
  console.log("aliased 数 = " + dbg.aliased.length + "  例: " + dbg.aliased.slice(0, 4).join(", "));
  const badLen = dbg.links.filter(l => !l.visible || l.length <= 0.005 || l.length >= 0.85);
  console.log("长度越界的驱动骨骼 = " + (badLen.length ? JSON.stringify(badLen.map(l => l.name + "=" + (l.length || 0).toFixed(4))) : "无"));
  console.log("links = " + dbg.links.map(l => l.name + ":" + l.length.toFixed(3)).join(" "));

  const feed = async (j, n) => page.evaluate((jj, nn) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < nn; i++) M.updateFromSkeleton(jj);
    M.__renderNow();
    return { pose: M.__poseSnapshot(), ik: M.__ikError() };
  }, j, n || 40);

  console.log("\n== IK 绝对误差（越小越好）==");
  const st = await feed(STAND);
  console.log("站姿   ik = " + JSON.stringify(st.ik));
  const dk = await feed(deepKnee());
  console.log("深屈膝 ik = " + JSON.stringify(dk.ik));

  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const ang = (u, v) => {
    const nu = Math.hypot(...u), nv = Math.hypot(...v);
    if (nu < 1e-9 || nv < 1e-9) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
  };
  console.log("深屈膝右腿大腿-小腿夹角 = " + ang(sub(dk.pose.RightLeg, dk.pose.RightUpLeg), sub(dk.pose.RightFoot, dk.pose.RightLeg)).toFixed(1) + "°（180° 说明膝盖没弯）");

  const ap = await feed(legsApart());
  const d3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  console.log("腿幅度 脚 = " + ((d3(st.pose.RightFoot, ap.pose.RightFoot) + d3(st.pose.LeftFoot, ap.pose.LeftFoot)) / 2).toFixed(4) +
    "  膝 = " + ((d3(st.pose.RightLeg, ap.pose.RightLeg) + d3(st.pose.LeftLeg, ap.pose.LeftLeg)) / 2).toFixed(4));

  console.log("\n== 交叉映射（引擎 wristL 应驱动模型 RightHand）==");
  const idleP = await feed(null);
  const eL = await feed(raiseOne("engineL", 0.30));
  const eR = await feed(raiseOne("engineR", 0.30));
  console.log("引擎左抬 → 模型RightHand Δy = " + (eL.pose.RightHand[1] - idleP.pose.RightHand[1]).toFixed(4) +
    "  模型LeftHand Δy = " + (eL.pose.LeftHand[1] - idleP.pose.LeftHand[1]).toFixed(4));
  console.log("引擎右抬 → 模型LeftHand  Δy = " + (eR.pose.LeftHand[1] - idleP.pose.LeftHand[1]).toFixed(4) +
    "  模型RightHand Δy = " + (eR.pose.RightHand[1] - idleP.pose.RightHand[1]).toFixed(4));

  console.log("\n== 4c 平面判据（骨链 |z|）==");
  const plane = await feed(armSpread(), 50);
  ["LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand"].forEach(k => {
    console.log("  " + k.padEnd(14) + " z = " + plane.pose[k][2]);
  });
  console.log("  站姿 LeftHand = " + JSON.stringify(idleP.pose.LeftHand) + "  平举 LeftHand = " + JSON.stringify(plane.pose.LeftHand));

  console.log("\n== 构图（UI 安全区）==");
  const lay = await page.evaluate(() => window.MotionAvatar.__layout());
  console.log("layout = " + JSON.stringify(lay));
  const top = await page.evaluate(() => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(null);
    M.__renderNow();
    return { headTop: M.__boneWorld("HeadTop_End"), hips: M.__boneWorld("Hips"), foot: M.__boneWorld("RightFoot"), toeEnd: M.__boneWorld("RightToe_End") };
  });
  console.log("站姿 HeadTop_End = " + JSON.stringify(top.headTop) + "  安全区上沿 = " + (lay.top).toFixed(4));
  console.log("站姿 Hips = " + JSON.stringify(top.hips) + "  RightFoot = " + JSON.stringify(top.foot) + "  RightToe_End = " + JSON.stringify(top.toeEnd));

  // 截图
  async function shot(j, tag, mirror) {
    await page.evaluate((jj, mir) => {
      const M = window.MotionAvatar;
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(jj);
      M.setProgress({ name: "开合跳", current: 12, target: 20, unit: "次", percent: 60, seqIndex: 2, seqTotal: 5 });
      const cv = document.querySelector("#motionAvatar canvas");
      if (cv) cv.style.transform = (mir === false) ? "" : "scaleX(-1)";
      M.__renderNow();
    }, j, mirror);
    await sleep(300);
    const el = await page.$("#motionAvatar");
    const out = path.join(SHOT, "human-" + tag + ".png");
    if (el) await el.screenshot({ path: out });
    console.log("  截图 -> " + out);
  }
  console.log("\n== 截图 ==");
  await shot(null, "stand", true);
  await shot(armSpread(), "jack", true);
  await shot(raiseOne("engineL", 0.30), "raiseL-mirror", true);
  await shot(raiseOne("engineL", 0.30), "raiseL-nomirror", false);
  await shot(deepKnee(), "deepknee", true);
  await shot(legsApart(), "legsapart", true);

  console.log("\n== 页面报错 ==");
  console.log(errs.length ? errs.join("\n") : "无");
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
