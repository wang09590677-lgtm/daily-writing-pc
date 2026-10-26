// 回归：张开双臂必须被引擎看见。
//
// 背景（为什么会有这个测试）：
//   原来的实现把"张开的双臂"当成"人+家具之间的空列缝隙"整块裁掉 ——
//   手臂是细横条，所在列的像素数过不了 minCol 门槛。后果：
//     ① bbox 宽度与"双臂自然下垂"完全一样，wrist/elbow/hand 关节全部消失；
//     ② evaluatePose 的"双手张开"检查（老实现用 bandAt(0.42).split）永远为假，
//        而 T-pose 时左臂—肩—躯干—肩—右臂本来是连续的、压根没有缝隙 ——
//        孩子张得越标准越判不出来，界面就一直挂着"请把双手张开一点"，
//        照着做也消不掉。
//   修法：① splitByColumnGap 里把"悬空细列（不碰块底）"并入人身，不当缝切掉；
//        ② 张臂判据从 split 改成"带状宽度比 wMax/wMean >= 1.5 且 wMax >= 0.15"。
//
// 断言：
//   A. 张臂时 bbox 宽度必须**明显大于**双臂下垂时（证明手臂像素没被裁掉）
//   B. 张臂时 checks.arms 必须为 1（证明判据认得出张臂）
//   C. 双臂下垂时 checks.arms 应为 0.6（证明判据没有变成"永远为真"）
//   D. 所有姿态都要认得出人、且 bbox 宽度与真实几何大致相符
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
  return grid;
}
window.__buildScene = buildScene;
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-armspan-test-" + process.pid),
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

  const th2 = Math.tan(58.4 * Math.PI / 360);
  const dists = (process.env.DISTANCES || "2000,2500,3000,3500").split(",").map(Number);

  async function shoot(sc) {
    const s = Object.assign({ camH: 1000, wall: 4000, cx: 0.5 }, sc);
    await page.evaluate((d, sc2) => { sc2.dist = d; window.__buildScene(window.__grid, sc2); }, s.dist, s);
    await sleep(900);
    return await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      const pose = motionEngine.getPose();
      return {
        has: sk.has, bbox: sk.bbox || null,
        arms: pose ? pose.checks.arms : null,
        guideText: pose ? pose.guideText : "",
        wristsSeen: !!(sk.joints && (sk.joints.wristL || sk.joints.handL))
      };
    });
  }

  console.log("== A/B/C 张臂必须被看见、被认出 ==");
  for (const d of dists) {
    const down = await shoot({ dist: d, arm: 0 });
    const tpose = await shoot({ dist: d, arm: 675, uFromTop: 0.20 });
    const diag = await shoot({ dist: d, arm: 400, uFromTop: 0.50 });

    check(`@${d}mm 双臂下垂 认得出人`, down.has && !!down.bbox,
      down.bbox ? `bbox宽 ${(down.bbox.w * 96).toFixed(0)}格` : "丢人");
    check(`@${d}mm T-pose 认得出人`, tpose.has && !!tpose.bbox,
      tpose.bbox ? `bbox宽 ${(tpose.bbox.w * 96).toFixed(0)}格` : "丢人");

    if (down.bbox && tpose.bbox) {
      const grow = tpose.bbox.w / Math.max(0.001, down.bbox.w);
      check(`@${d}mm 张臂后 bbox 明显变宽（>2 倍）`, grow > 2.0,
        `${(down.bbox.w * 96).toFixed(0)}格 → ${(tpose.bbox.w * 96).toFixed(0)}格（${grow.toFixed(2)}×）`);
      // 真实几何：画面宽 = 2·d·tan(29.2°)，臂展 1350mm（注意 d 与画面宽都是毫米）
      const viewW = 2 * d * th2;
      const expect = 1350 / viewW;
      check(`@${d}mm T-pose bbox 宽与真实几何相符（±0.06）`,
        Math.abs(tpose.bbox.w - expect) <= 0.06,
        `实测 ${(tpose.bbox.w * 100).toFixed(1)}% vs 几何 ${(expect * 100).toFixed(1)}%`);
    }

    check(`@${d}mm T-pose checks.arms == 1`, tpose.arms === 1, `arms=${tpose.arms}`);
    check(`@${d}mm 斜下举 checks.arms == 1`, diag.arms === 1, `arms=${diag.arms}`);
    check(`@${d}mm 双臂下垂 checks.arms == 0.6（判据没退化成恒真）`, down.arms === 0.6, `arms=${down.arms}`);
    check(`@${d}mm T-pose 能看见腕/手关节`, tpose.wristsSeen, tpose.wristsSeen ? "有" : "无");
  }

  console.log("\n== D 引导语不再出现消解不掉的假指令 ==");
  for (const d of dists) {
    const r = await shoot({ dist: d, arm: 675, uFromTop: 0.20 });
    check(`@${d}mm T-pose 高分时引导语是"保持"而非"请把双手张开"`,
      /保持/.test(r.guideText), `「${r.guideText}」`);
  }

  await browser.close();
  console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
