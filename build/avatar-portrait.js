// 只截「跟练角色本体」：显示 3D 角色 → 只截 #motionAvatar 元素。
// 目的：给用户一张干净的验收图（当前底层模型读不了图，人眼必须能看清造型）。
// 顺带打印：骨架诊断 + **角色在屏幕上的实际像素范围 vs UI 安全区**（构图是否被压）。
//
// ⚠️ 本项目反复证明："程序化断言全绿 ≠ 看起来对"（曾漏看"头被顶部面板压住"、
//    "站姿踮脚"）。所以这个脚本是**验收流程的固定一环**：改完跟练角色必须真的看一眼截图。
//
// 用法：node build/avatar-portrait.js
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
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEW_H = 1.8;          // 相机竖直视野（正交 ±0.9）

/* 站姿 = 没有识别到人时孩子看到的姿势（用产品自己的 IDLE 表，别自造） */
const STAND = null;
/* 开合跳张臂瞬间 */
const JACK = F.armSpread();
/* 深蹲（验膝盖真的弯） */
const DEEP = F.deepKnee();
/* 并腿→分开（验腿的幅度） */
const APART = F.legsApart();

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-portrait-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1280, height: 800 },
    args: [
      "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir,
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => window.MotionAvatar.show());

  // 等模型就绪（GLB 是异步加载的，不等就会截到兜底人形或空屏）
  let sk = null;
  for (let i = 0; i < 40; i++) {
    sk = await page.evaluate(() => window.MotionAvatar.__skeleton());
    if (sk && (sk.ready || sk.failed)) break;
    await sleep(400);
  }
  console.log("骨架:", JSON.stringify({ ready: sk.ready, failed: sk.failed, bones: sk.boneCount,
    skinned: sk.skinnedCount, tail: sk.tail, fallback: sk.usingFallback, axisMismatch: sk.axisMismatch }));
  if (!sk.ready) console.log("⚠ 模型没就绪，截出来的会是兜底人形");

  /* UI 安全区（从真实 DOM 量，别信常量） */
  const safe = await page.evaluate(() => {
    window.MotionAvatar.setProgress({ name: "开合跳", current: 12, target: 20, unit: "次", percent: 60, seqIndex: 2, seqTotal: 5 });
    const p = document.querySelector(".motion-avatar-progress");
    const c = document.querySelector(".motion-avatar-controls");
    return {
      h: window.innerHeight,
      top: p ? p.getBoundingClientRect().bottom : 198,
      bot: c ? c.getBoundingClientRect().top : window.innerHeight - 91
    };
  });
  console.log(`UI 安全区: y ∈ [${safe.top.toFixed(1)}, ${safe.bot.toFixed(1)}]  (窗口高 ${safe.h})`);

  const shots = [];
  async function shot(joints, tag, note, mirror) {
    const info = await page.evaluate((p, label, mir, vh) => {
      const M = window.MotionAvatar;
      // 多喂几帧让低通收敛，否则截到的是过渡中的中间姿势
      for (let i = 0; i < 40; i++) M.updateFromSkeleton(p);
      M.setStatus(label);
      M.setProgress({ name: "开合跳", current: 12, target: 20, unit: "次", percent: 60, seqIndex: 2, seqTotal: 5 });
      // 镜像开关：只动 WebGL 画布那一层，用来出"镜像前/后"对照图
      const cv = document.querySelector("#motionAvatar canvas");
      if (cv) cv.style.transform = (mir === false) ? "" : "scaleX(-1)";
      M.__renderNow();
      const s = M.__poseSnapshot();
      /* ⚠️ 上边界**必须含 `*Fingertip`**。这里原来只列了 `LeftHand/RightHand` —— 那是**腕**
       * （骨 origin，也是手臂 IK 的末端），比真指尖低一整个手掌（实测 ~41px）。
       * 拿它当"角色最高点"，构图安全区判据会**系统性偏乐观**：
       * 举手过顶时脚本报"在安全区内"，而手指其实已经伸进顶部面板里了。
       * 同一个错在 `accept-human-glb.js` ⑧ 里也犯过一次（见那里的长注释）。 */
      let topY = -Infinity, botY = Infinity;
      ["HeadTop_End", "LeftFingertip", "RightFingertip", "LeftHand", "RightHand",
        "LeftToe_End", "RightToe_End"].forEach(k => {
        if (!s[k]) return;
        if (s[k][1] > topY) topY = s[k][1];
        if (s[k][1] < botY) botY = s[k][1];
      });
      const proj = y => (0.9 - y) * window.innerHeight / vh;
      /* 顺手量一下"跟得准不准"（唯一绝对判据）。
       * 这一项本来只在 accept-human-glb.js 里对**站姿**量；但截图脚本覆盖了更多姿势
       * （分腿/深蹲），而"看起来对不对"必须有个数佐证 —— 否则又会掉进
       * "程序化断言全绿 ≠ 看起来对"的坑（曾把手臂折成叉腰当成正常）。 */
      const ik = M.__ikError ? M.__ikError() : null;
      /* 手臂"直不直"必须单独量：腕误差小只说明**腕到了目标点**，
       * 若肩位没到位、肘被折起来，腕照样能到 —— 这就是"双手叉腰"的成因。
       * 骨长固定 ⇒ |肩→肘|+|肘→腕| 是常数，比值 1.0 = 完全伸直。 */
      const arms = {};
      [["L", "LeftArm", "LeftForeArm", "LeftHand"], ["R", "RightArm", "RightForeArm", "RightHand"]]
        .forEach(([side, a, b, c]) => {
          if (!s[a] || !s[b] || !s[c]) return;
          const V = (p, q) => [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
          const L = v => Math.hypot(v[0], v[1], v[2]);
          const u = V(s[a], s[b]), f = V(s[b], s[c]);
          const straight = L(V(s[a], s[c])) / (L(u) + L(f));
          const cos = (u[0] * f[0] + u[1] * f[1] + u[2] * f[2]) / (L(u) * L(f));
          arms[side] = { straight, elbow: Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI };
        });
      return {
        visible: M.isVisible(), pose: s, ik, arms,
        screenTop: proj(topY), screenBot: proj(botY)
      };
    }, joints, note, mirror, VIEW_H);
    await sleep(350);
    const el = await page.$("#motionAvatar");
    const out = path.join(SHOT, "avatar-" + tag + ".png");
    if (el) await el.screenshot({ path: out });
    /* 判据不只"在不在安全区"：手臂被折成叉腰时构图照样合法，
     * 所以把"手臂伸直度"也并进来（实测 站姿/分腿/深蹲 = 100%，张臂 = 98%）。
     * 折成叉腰大约会掉到 60~70%，阈值 90% 有充足余量。 */
    const minStraight = info.arms && info.arms.L && info.arms.R
      ? Math.min(info.arms.L.straight, info.arms.R.straight) : 1;
    const okArm = minStraight > 0.90;
    const okTop = info.screenTop > safe.top, okBot = info.screenBot < safe.bot;
    shots.push({ tag, ok: okTop && okBot && okArm, okArm, okTop, okBot, minStraight,
      screenTop: info.screenTop, screenBot: info.screenBot });
    console.log(`[${tag}] visible=${info.visible} 屏幕范围 ${info.screenTop.toFixed(0)}~${info.screenBot.toFixed(0)}px ` +
      `${okTop && okBot ? "✓ 在安全区内" : "✗ 超出安全区!"} -> ${path.basename(out)}`);
    console.log(`        关键骨骼: LeftHand=${JSON.stringify(info.pose.LeftHand)} RightHand=${JSON.stringify(info.pose.RightHand)} Hips=${JSON.stringify(info.pose.Hips)} RightToe_End=${JSON.stringify(info.pose.RightToe_End)}`);
    if (info.ik) {
      const f = v => (v == null ? "n/a" : v.toFixed(4));
      console.log(`        IK误差: 腕 ${f(info.ik.wristL)}/${f(info.ik.wristR)}  踝 ${f(info.ik.ankleL)}/${f(info.ik.ankleR)}  ` +
        `膝极杆 ${f(info.ik.kneeL)}  肘极杆 ${f(info.ik.elbowL)}`);
    }
    if (info.arms && info.arms.L && info.arms.R) {
      const a = info.arms;
      console.log(`        手臂伸直度: 左 ${(a.L.straight * 100).toFixed(0)}%（肘 ${a.L.elbow.toFixed(0)}°）  ` +
        `右 ${(a.R.straight * 100).toFixed(0)}%（肘 ${a.R.elbow.toFixed(0)}°）`);
    }
    return info;
  }

  await shot(STAND, "stand", "跟练角色站姿", true);
  await shot(JACK, "jack", "跟练角色开合跳张臂", true);
  /* 举过头顶 —— 真人开合跳的最高点。构图安全区的**真正**上边界要靠它去顶，
   * 只喂 armSpread（抬 30°）时最高点还是头顶，等于没验上边界。 */
  await shot(F.armsOverhead(), "overhead", "跟练角色举手过顶", true);
  await shot(APART, "legsapart", "跟练角色分腿", true);
  await shot(DEEP, "deepknee", "跟练角色深蹲", true);
  await shot(F.raiseOne("engineR"), "raiseR", "引擎右手抬起", true);
  /* 镜像专项：只抬**引擎 L** 一侧。
   * 引擎 L = 图像 x 较小侧；摄像头画面已被 CSS 镜像成"照镜子"，所以引擎 L 在**屏幕右侧**。
   * 于是要求"角色抬起的那只手也在屏幕右侧"。出两张对照：镜像开 / 镜像关。 */
  await shot(F.raiseOne("engineL"), "raiseL-mirror", "引擎左手抬起（镜像开）", true);
  await shot(F.raiseOne("engineL"), "raiseL-nomirror", "引擎左手抬起（镜像关，对照）", false);
  await shot(F.raiseOne("engineL"), "raiseL-mirror2", "引擎左手抬起（镜像恢复）", true);

  await browser.close();
  console.log("\n截图目录:", SHOT);
  /* 本脚本的主要产物是**给人看的截图**，但它顺手也是一条真判据：
   * 只要有一个姿势的角色越出了 UI 安全区就报错退出 —— 这样它能进回归跑批，
   * 而不是"跑完什么都看不出来"。 */
  const bad = shots.filter(s => !s.ok);
  if (bad.length) {
    bad.forEach(b => {
      const why = [];
      if (!b.okTop) why.push("头顶压面板");
      if (!b.okBot) why.push("脚沉进控制栏");
      if (!b.okArm) why.push("手臂被折起（伸直度 " + (b.minStraight * 100).toFixed(0) + "%）");
      console.log("✗ [" + b.tag + "] " + why.join(" + "));
    });
    console.log("✗ 有 " + bad.length + " 个姿势不合格: " + bad.map(b => b.tag).join(", "));
    process.exit(1);
  }
  console.log("✓ " + shots.length + " 个姿势全部落在 UI 安全区内、且手臂未被折起");
})().catch(e => { console.error("FATAL", e); process.exit(1); });
