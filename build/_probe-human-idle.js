/* 诊断：换成人形模型后，**空闲站姿**与**脚掌俯仰**到底被驱动成什么样。
   只打印，不写断言。用法：node build/_probe-human-idle.js

   要回答两个问题：
   A. IDLE_JOINTS 里手臂是**垂直向下**的（shoulder 0.428 → elbow 0.418 → wrist 0.412），
      但截图里手却在腰上、肘向外撇 —— 到底哪一环没跟上？
   B. 脚掌看起来"踮着"，脚趾掉到 footY 以下 —— 脚骨到底转了多少度？为什么？ */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-idle-" + process.pid + "-" + Date.now());
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
  console.log("ready=" + sk.ready + " failed=" + sk.failed + " boneCount=" + sk.boneCount);

  const dump = async (label, joints) => page.evaluate((jj, lb) => {
    const M = window.MotionAvatar;
    for (let i = 0; i < 40; i++) M.updateFromSkeleton(jj);
    M.__renderNow();
    const snap = M.__poseSnapshot();
    const ik = M.__ikError();
    const lay = M.__layout();
    const idle = M.__idleJoints();
    const keys = ["Hips", "Spine", "Spine2", "Neck", "Head", "HeadTop_End",
      "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
      "RightShoulder", "RightArm", "RightForeArm", "RightHand",
      "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
      "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End"];
    const out = {};
    keys.forEach(k => { if (snap[k]) out[k] = snap[k].map(v => +v.toFixed(4)); });

    // 骨链夹角（世界向量）
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const ang = (u, v) => {
      const nu = Math.hypot(...u), nv = Math.hypot(...v);
      if (nu < 1e-9 || nv < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
    };
    const res = { label: lb, layout: lay, ik: ik, idle: null, out: out, angles: {} };
    if (snap.RightUpLeg && snap.RightLeg && snap.RightFoot && snap.RightToe_End) {
      res.angles.kneeR = +ang(sub(snap.RightLeg, snap.RightUpLeg), sub(snap.RightFoot, snap.RightLeg)).toFixed(1);
      res.angles.ankleR = +ang(sub(snap.RightFoot, snap.RightLeg), sub(snap.RightToe_End, snap.RightFoot)).toFixed(1);
      res.angles.thighFromDown = +ang(sub(snap.RightLeg, snap.RightUpLeg), [0, -1, 0]).toFixed(1);
      res.angles.shinFromDown = +ang(sub(snap.RightFoot, snap.RightLeg), [0, -1, 0]).toFixed(1);
      res.angles.footFromDown = +ang(sub(snap.RightToe_End, snap.RightFoot), [0, -1, 0]).toFixed(1);
      res.angles.footFromForward = +ang(sub(snap.RightToe_End, snap.RightFoot), [0, 0, 1]).toFixed(1);
    }
    if (snap.RightArm && snap.RightForeArm && snap.RightHand && snap.RightShoulder) {
      res.angles.elbowR = +ang(sub(snap.RightForeArm, snap.RightArm), sub(snap.RightHand, snap.RightForeArm)).toFixed(1);
      res.angles.upperArmFromDown = +ang(sub(snap.RightForeArm, snap.RightArm), [0, -1, 0]).toFixed(1);
      res.angles.foreArmFromDown = +ang(sub(snap.RightHand, snap.RightForeArm), [0, -1, 0]).toFixed(1);
    }
    // 蒙皮网格世界包围盒（真蒙皮变换）
    let bone = M.__bone ? M.__bone("Hips") : null;
    if (bone) {
      let root = bone; while (root.parent) root = root.parent;
      let top = 1e9, bot = -1e9, nMesh = 0;
      const v = new THREE.Vector3();
      root.traverse(o => {
        if (!o.isSkinnedMesh) return;
        nMesh++;
        const pos = o.geometry.attributes.position;
        const n = pos.count;
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(pos, i);
          if (o.applyBoneTransform) o.applyBoneTransform(i, v); else if (o.boneTransform) o.boneTransform(i, v);
          o.localToWorld(v);
          if (v.y > bot) bot = v.y;
          if (v.y < top) top = v.y;
        }
      });
      res.mesh = { nMesh: nMesh, meshTop: +bot.toFixed(4), meshBottom: +top.toFixed(4) };
    }
    return res;
  }, joints, label);

  const show = r => {
    console.log("\n================ " + r.label + " ================");
    console.log("layout = " + JSON.stringify(r.layout));
    console.log("ik     = " + JSON.stringify(r.ik));
    console.log("angles = " + JSON.stringify(r.angles));
    console.log("mesh   = " + JSON.stringify(r.mesh) + "   （footY=" + r.layout.footY + " 上沿=" + (r.layout.footY + r.layout.H).toFixed(4) + "）");
    ["Hips", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End",
      "RightShoulder", "RightArm", "RightForeArm", "RightHand",
      "LeftArm", "LeftForeArm", "LeftHand", "HeadTop_End"].forEach(k => {
        if (r.out[k]) console.log("  " + k.padEnd(14) + JSON.stringify(r.out[k]));
      });
  };

  const idleJ = await page.evaluate(() => window.MotionAvatar.__idleJoints());
  show(await dump(null, "空闲 IDLE_JOINTS（updateFromSkeleton(null)）"));

  // 引擎给的 idle 目标关节 vs 实际到手的位置
  console.log("\n== 空闲目标（归一化 → 世界，用页面自己的 rawWorld）==");
  const tgt = await page.evaluate((j) => {
    const M = window.MotionAvatar;
    const r = {};
    ["shoulderR", "elbowR", "wristR", "handR", "hipR", "kneeR", "shinR", "ankleR", "toeR"].forEach(k => {
      const w = M.__rawWorld ? M.__rawWorld(j, k) : null;
      if (w) r[k] = w;
    });
    return r;
  }, idleJ);
  console.log(JSON.stringify(tgt, null, 1));

  // 静止（未驱动）时的脚掌方向作为基准
  console.log("\n== 参考：rest 脚掌方向 ==");
  const rest = await page.evaluate(() => {
    const M = window.MotionAvatar;
    const f = M.__bone("RightFoot"), t = M.__bone("RightToe_End");
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    f.getWorldPosition(a); t.getWorldPosition(b);
    const d = b.clone().sub(a);
    const down = new THREE.Vector3(0, -1, 0), fwd = new THREE.Vector3(0, 0, 1);
    return {
      len: +d.length().toFixed(4),
      footFromDown: +(d.angleTo(down) * 180 / Math.PI).toFixed(1),
      footFromForward: +(d.angleTo(fwd) * 180 / Math.PI).toFixed(1),
      delta: [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)]
    };
  });
  console.log(JSON.stringify(rest));

  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
