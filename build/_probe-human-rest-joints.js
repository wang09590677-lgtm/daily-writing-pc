/* 诊断：把**模型自己的静止骨架**换算成引擎的归一化关节坐标。
   用途：IDLE_JOINTS（无相机数据时的兜底站姿）应当**就是模型的自然站姿** ——
   手自然下垂、腿自然伸直、脚掌平放。旧表是照着旧猫模型手写的，比例不是人形，
   换成人形后照它驱动会得到"微蹲 + 双手叉腰"。

   换算公式（页面里 rawWorld 的逆）：
     归一化 y = yBot - (localY - localBot) / RAW_H * span
     归一化 x = 0.5 + localX / RAW_H * span
   其中 span = yBot - yHead（沿用 0.827 / head=0.098 / bot=0.925，保持与旧表同一约定）。
   注意：layout / 窗口尺寸**会约掉**，所以这是与布局无关的常量表。

   用法：node build/_probe-human-rest-joints.js */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-rest-" + process.pid + "-" + Date.now());
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
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1000);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 45; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("ready=" + sk.ready + " failed=" + sk.failed);

  const res = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const B = (n) => M.__bone(n);
    // 模型局部坐标：把世界坐标除以 modelRoot 缩放、减去其位移。
    // 但更省事也更准：直接用骨骼的 matrixWorld 乘 modelRoot.matrixWorld 的逆。
    let root = B("Hips");
    while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const L = (n) => {
      const b = B(n); if (!b) return null;
      b.updateMatrixWorld(true);
      const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
      return [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)];
    };
    const mid = (a, b) => {
      const A = L(a), Bb = L(b);
      if (!A || !Bb) return null;
      return [+((A[0] + Bb[0]) / 2).toFixed(5), +((A[1] + Bb[1]) / 2).toFixed(5), +((A[2] + Bb[2]) / 2).toFixed(5)];
    };
    const mm = M.__modelMetrics();
    const raw = {
      Hips: L("Hips"), Spine: L("Spine"), Spine1: L("Spine1"), Spine2: L("Spine2"),
      Neck: L("Neck"), Head: L("Head"), HeadTop_End: L("HeadTop_End"),
      L_Shoulder: L("LeftShoulder"), L_Arm: L("LeftArm"), L_ForeArm: L("LeftForeArm"),
      L_Hand: L("LeftHand"), L_HandEnd: L("LeftHandEnd") || L("LeftHandThumb4"),
      R_Shoulder: L("RightShoulder"), R_Arm: L("RightArm"), R_ForeArm: L("RightForeArm"),
      R_Hand: L("RightHand"), R_HandEnd: L("RightHandEnd") || L("RightHandThumb4"),
      L_UpLeg: L("LeftUpLeg"), L_Leg: L("LeftLeg"), L_Foot: L("LeftFoot"),
      L_ToeBase: L("LeftToeBase"), L_Toe_End: L("LeftToe_End"),
      R_UpLeg: L("RightUpLeg"), R_Leg: L("RightLeg"), R_Foot: L("RightFoot"),
      R_ToeBase: L("RightToeBase"), R_Toe_End: L("RightToe_End")
    };
    const allBoneNames = [];
    root.traverse(o => { if (o.isBone) allBoneNames.push(o.name); });
    return { raw: raw, metrics: mm, allBoneNames: allBoneNames };
  });

  console.log("\n== 模型静止（局部坐标，未驱动）==");
  Object.keys(res.raw).forEach(k => console.log("  " + k.padEnd(13) + JSON.stringify(res.raw[k])));
  console.log("\n== 尺寸 ==");
  console.log(JSON.stringify(res.metrics.measured));
  console.log("含 'Hand' 的骨骼名: " + res.allBoneNames.filter(n => /Hand/.test(n)).join(", "));

  // ---- 换算成归一化关节表 ----
  // ⚠️ 上面的 `inv` 取到的是**场景根**，所以 raw 里其实是**世界坐标**（已含布局缩放）。
  //    因此换算必须用"世界身高 Hw"和"世界最低点 wBot"，不能用模型原始身高 RAW_H。
  const g = (k) => res.raw[k];
  const wBot = Math.min(g("L_Toe_End")[1], g("R_Toe_End")[1]);
  const Hw = g("HeadTop_End")[1] - wBot;
  console.log("\n世界身高 Hw = " + Hw.toFixed(4) + "  世界最低点 wBot = " + wBot.toFixed(4));
  const yHead = 0.098, yBot = 0.925, span = yBot - yHead;
  const nx = (wx) => +(0.5 + wx / Hw * span).toFixed(4);
  const ny = (wy) => +(yBot - (wy - wBot) / Hw * span).toFixed(4);
  const P = (name, v) => ({ x: nx(v[0]), y: ny(v[1]) });
  const midP = (a, b) => {
    const A = res.raw[a], Bb = res.raw[b];
    return { x: nx((A[0] + Bb[0]) / 2), y: ny((A[1] + Bb[1]) / 2) };
  };

  const out = {};
  out.head = P("head", g("Head"));
  out.neck = P("neck", g("Neck"));
  // 引擎的 shoulderL = 图像 x 较小侧 = **被拍摄者的右** → 模型 RightArm（交叉映射）
  out.shoulderL = P("shoulderL", g("R_Arm"));
  out.shoulderR = P("shoulderR", g("L_Arm"));
  out.midL = midP("R_Arm", "R_ForeArm");
  out.midR = midP("L_Arm", "L_ForeArm");
  out.elbowL = P("elbowL", g("R_ForeArm"));
  out.elbowR = P("elbowR", g("L_ForeArm"));
  out.foreL = midP("R_ForeArm", "R_Hand");
  out.foreR = midP("L_ForeArm", "L_Hand");
  out.wristL = P("wristL", g("R_Hand"));
  out.wristR = P("wristR", g("L_Hand"));
  out.handL = P("handL", g("R_Hand"));
  out.handR = P("handR", g("L_Hand"));
  out.hipMid = P("hipMid", g("Hips"));
  out.hipL = P("hipL", g("R_UpLeg"));
  out.hipR = P("hipR", g("L_UpLeg"));
  out.kneeL = P("kneeL", g("R_Leg"));
  out.kneeR = P("kneeR", g("L_Leg"));
  out.shinL = midP("R_Leg", "R_Foot");
  out.shinR = midP("L_Leg", "L_Foot");
  out.ankleL = P("ankleL", g("R_Foot"));
  out.ankleR = P("ankleR", g("L_Foot"));
  out.toeL = P("toeL", g("R_ToeBase"));
  out.toeR = P("toeR", g("L_ToeBase"));

  console.log("\n== 建议的 IDLE_JOINTS（人形自然站姿，由模型静止骨架反推）==");
  console.log(JSON.stringify(out, null, 1));

  console.log("\n== 比例核对（相对身高）==");
  const frac = (v) => +((v[1] - wBot) / Hw).toFixed(4);
  console.log("髋(UpLeg)离地 = " + frac(g("R_UpLeg")) + "   膝 = " + frac(g("R_Leg")) +
    "   踝 = " + frac(g("R_Foot")) + "   肩 = " + frac(g("R_Arm")) + "   头 = " + frac(g("Head")));
  console.log("腿长(髋→踝)/身高 = " + (((g("R_UpLeg")[1] - g("R_Foot")[1]) / Hw)).toFixed(4));
  console.log("腿长(髋→趾)/身高 = " + (((g("R_UpLeg")[1] - g("R_Toe_End")[1]) / Hw)).toFixed(4));
  console.log("旧 IDLE 表: 髋=0.545 膝=0.700 踝=0.880 肩=0.262 头=0.098  span=0.827");

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
