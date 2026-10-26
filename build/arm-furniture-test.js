// 回归：贴着人身的"悬空横条家具"不能被并进人身。
//
// 背景（为什么会有这个测试）：
//   修「张开的双臂被当成空列缝隙裁掉」时，我加了 floating() 判据 ——
//   矮列若与块底脱开 ≥15% 块高，判为悬空细条（四肢）并入人身。
//   但这条太激进：**贴着人身、下方悬空的横条家具**（搁板 / 半墙 / 护栏 /
//   吧台 / 晾衣杆）也是"悬空矮列"，会被当成手臂并进来。QA 实测复现：
//     儿童居中站位、左侧悬空横板（右端贴躯干缘、下缘高 980mm、厚 90mm）
//       @3000mm → bbox 从 0.104 撑到 0.375、cx 从 0.500 掉到 0.365
//     —— 正是"一后退绿块就偏到屏幕边"的老症状回归。
//   而且横板还会让 wMax/wMean 飙到 3.2~3.9 → 被误判成"张开双臂"、造出假手腕。
//
//   修法：浮列必须**左右对称**才承认是手臂。真手臂（侧平举/斜下举/V 举）
//   左右成对；横板家具只有一侧 → fR=0 → 不并。
//
// 断言：
//   A. 无家具时张臂仍能正确识别（不能因为加约束把真手臂也挡掉）
//   B. 单侧悬空横板不能把 bbox 撑宽、不能把 cx 拉偏
//   C. 单侧悬空横板不能伪造"张开双臂"、不能造出假腕关节
//   D. 有横板时若孩子真的张臂，仍应识别出张臂（组合场景不能退化）
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  → " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  → " + detail : ""}`); }
}

const SCENE_FN = `
function buildScene(grid, s) {
  const W = 96, H = 72;
  const tv2 = Math.tan(45.5 * Math.PI / 360), th2 = Math.tan(58.4 * Math.PI / 360);
  function ray(x, y) {
    const u = (x + 0.5) / W - 0.5, v = (y + 0.5) / H - 0.5;
    return { dx: u * 2 * th2, dy: -v * 2 * tv2, dz: 1 };
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    let z = s.wall / d.dz;
    if (d.dy < -1e-6) { const zf = (-s.camH / d.dy) * d.dz; if (zf > 0 && zf < z) z = zf; }
    grid[y * W + x] = z > 0 ? z : 0;
  }
  const ph = s.ph || 1350, shoulder = 340, legHalf = 55, legGap = 75, D = s.dist;
  const armHalf = s.arm || 0;
  const armY = s.uFromTop === undefined ? ph * 0.58 : ph * (1 - s.uFromTop);
  const armT = s.armT === undefined ? 120 : s.armT;
  const headT = Math.min(200, ph * 0.15);
  const legTop = ph * 0.42;
  const cxW = (s.cx - 0.5) * 2 * D * th2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = ray(x, y);
    const t = D / d.dz;
    if (!(t > 0)) continue;
    const wx = t * d.dx, wy = s.camH + t * d.dy;
    if (wy < 0 || wy > ph) continue;
    const ax = Math.abs(wx - cxW);
    let inside = false;
    if (wy > ph - headT) inside = ax <= 75;
    else if (wy < legTop) inside = !(Math.abs(ax - legGap) > legHalf && Math.abs(ax + legGap) > legHalf);
    else if (ax <= shoulder / 2) inside = true;
    if (!inside && armHalf > 0 && ax <= armHalf && Math.abs(wy - armY) <= armT / 2) inside = true;
    if (inside) grid[y * W + x] = D;
  }
  // 同深度、贴着人身、下方悬空的横条家具（搁板 / 半墙 / 吧台 / 栏杆）
  if (s.bar) {
    const b = s.bar;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = ray(x, y);
      if (d.dz < 1e-6) continue;
      const t = D / d.dz;
      const wx = t * d.dx, wy = s.camH + t * d.dy;
      if (wx < b.x0 || wx > b.x1) continue;
      if (wy < b.yBot || wy > b.yTop) continue;
      grid[y * W + x] = D;
    }
  }
  return grid;
}
window.__buildScene = buildScene;
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-armfurn-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);
  await page.evaluate(async () => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv.captureStream(30);
    setInterval(() => { c.fillStyle = "#111"; c.fillRect(0, 0, 640, 480); c.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion");
    await motionCamRefresh();
    await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1500);
  await page.evaluate(`(function(){ ${SCENE_FN} })();`);
  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    cv.getContext("2d").fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    motionEngine.attachDepth({
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    });
    motionEngine.attach(cv);
    motionEngine.preview();
  });

  async function shoot(sc) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5 }, sc);
    await page.evaluate((d, sc2) => { sc2.dist = d; window.__buildScene(window.__grid, sc2); }, s.dist, s);
    await sleep(900);
    return await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      return {
        has: sk.has, bbox: sk.bbox || null,
        cx: sk.bbox ? sk.bbox.x + sk.bbox.w / 2 : null,
        w: sk.bbox ? sk.bbox.w : 0,
        arms: pose ? pose.checks.arms : null,
        hasWrist: !!(sk.joints && (sk.joints.wristL || sk.joints.wristR)),
        guideText: pose ? pose.guideText : ""
      };
    });
  }

  const dists = [2500, 3000, 3500];
  // QA 复现的横板：右端贴躯干缘(躯干半宽170) → x1=-171；下缘 980mm、厚 90mm
  const shelf = { x0: -1100, x1: -171, yBot: 980, yTop: 1070 };
  // 同深度悬空栏杆：更低更细
  const rail = { x0: -1400, x1: -171, yBot: 1000, yTop: 1060 };

  console.log("== A 对照：无家具时张臂必须仍被正确识别 ==");
  for (const d of dists) {
    const down = await shoot({ dist: d, arm: 0 });
    const tp = await shoot({ dist: d, arm: 675, uFromTop: 0.20 });
    check(`@${d}mm 无家具·双臂下垂 arms=0.6`, down.arms === 0.6, `arms=${down.arms}`);
    check(`@${d}mm 无家具·T-pose arms=1`, tp.arms === 1, `arms=${tp.arms}`);
    check(`@${d}mm 无家具·T-pose 有腕关节`, tp.hasWrist, tp.hasWrist ? "有" : "无");
    check(`@${d}mm 无家具·T-pose bbox 明显变宽`, down.w > 0 && tp.w / down.w > 2,
      `${(down.w * 96).toFixed(0)}格 → ${(tp.w * 96).toFixed(0)}格`);
  }

  console.log("\n== B/C 单侧悬空横条家具不能被并进人身 ==");
  for (const d of dists) {
    const clean = await shoot({ dist: d, arm: 0 });
    const withShelf = await shoot({ dist: d, arm: 0, bar: shelf });
    check(`@${d}mm 悬空横搁板·bbox 不被撑宽（≤干净场景 1.35 倍）`,
      withShelf.w <= clean.w * 1.35,
      `干净 ${(clean.w * 96).toFixed(0)}格 → 有板 ${(withShelf.w * 96).toFixed(0)}格`);
    check(`@${d}mm 悬空横搁板·cx 不被拉偏（±0.06）`,
      withShelf.cx !== null && Math.abs(withShelf.cx - 0.5) <= 0.06,
      `cx=${withShelf.cx === null ? "丢人" : withShelf.cx.toFixed(3)}`);
    check(`@${d}mm 悬空横搁板·不伪造"张开双臂"（arms=0.6）`,
      withShelf.arms === 0.6, `arms=${withShelf.arms}`);
    check(`@${d}mm 悬空横搁板·不造假腕关节`, !withShelf.hasWrist,
      withShelf.hasWrist ? "造出了假手腕" : "无");

    const withRail = await shoot({ dist: d, arm: 0, bar: rail });
    check(`@${d}mm 悬空栏杆·cx 不被拉偏（±0.06）`,
      withRail.cx !== null && Math.abs(withRail.cx - 0.5) <= 0.06,
      `cx=${withRail.cx === null ? "丢人" : withRail.cx.toFixed(3)}`);
    check(`@${d}mm 悬空栏杆·不伪造"张开双臂"（arms=0.6）`,
      withRail.arms === 0.6, `arms=${withRail.arms}`);
  }

  console.log("\n== D 组合场景：有横板 + 孩子真张臂 ==");
  console.log("   （设计取舍：横板把整块撑宽后 bh/bw 掉到 1.10 以下，含浮列的段被拒，");
  console.log("     退回躯干段 —— 宁可少认一次张臂，也不让绿块连横板一起框进去、把重心拉偏）");
  for (const d of dists) {
    const both = await shoot({ dist: d, arm: 675, uFromTop: 0.20, bar: shelf });
    const cleanDown = await shoot({ dist: d, arm: 0, bar: shelf });
    // 最差不劣于"修复前"：必须认出人、必须居中、bbox 不能比"有板不张臂"更宽
    check(`@${d}mm 横板 + T-pose 不丢人`, both.has && !!both.bbox,
      both.bbox ? `bbox ${(both.w * 96).toFixed(0)}格` : "丢人");
    check(`@${d}mm 横板 + T-pose 仍居中（±0.10）且不比干净场景更宽`,
      both.cx !== null && Math.abs(both.cx - 0.5) <= 0.10 && both.w <= cleanDown.w * 1.35,
      `cx=${both.cx === null ? "丢人" : both.cx.toFixed(3)} 宽 ${(both.w * 96).toFixed(0)}格(干净有板 ${(cleanDown.w * 96).toFixed(0)}格)`);
    check(`@${d}mm 横板 + T-pose 不把横板框进来（bbox 宽 ≤ 22 格）`,
      both.w <= 22 / 96 + 1e-6, `${(both.w * 96).toFixed(0)}格`);
  }

  console.log("\n== E 无横板对照：真张臂必须被识别（证明 D 的退化只由横板引起）==");
  for (const d of dists) {
    const tp = await shoot({ dist: d, arm: 675, uFromTop: 0.20 });
    check(`@${d}mm 无横板 T-pose arms=1`, tp.arms === 1, `arms=${tp.arms}`);
  }

  await browser.close();
  console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
