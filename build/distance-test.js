// 距离回归：站到 2 米以外骨架不能整块消失（真实 Chrome + 合成深度场景）
//
// 背景（用户两次反馈的问题）：站到「2 米多一点」以外，体感出的骨架就突然乱掉、
// 感应不出整个身体。根因是**地板**：相机高 1 米时画面里最近能看到的地板是
// camH/tan(22.75°) ≈ 2.4 米，人一站远，地板就落进「人的深度带」，
// 与人的腿 8-连通，把最大连通域撑到整幅宽（实测 1.00×0.71），
// 长宽比 0.71 < 1.10 的判据 → labelComponents 判"这不是人" → 骨架整块消失。
// 修法见 motion-engine.js 的 stripBackgroundRows()。
//
// 本测试按真实针孔投影造「地板平面 + 后墙 + 站立人形」，扫距离与相机高度，
// 断言：骨架必须出来、关节数够、depthNear 与真实距离的误差 < 8%。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-distest"),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 600));

  // 假摄像头把引擎建起来
  await page.evaluate(async () => {
    const cv0 = document.createElement("canvas");
    cv0.width = 640; cv0.height = 480;
    const c0 = cv0.getContext("2d");
    c0.fillStyle = "#111"; c0.fillRect(0, 0, 640, 480);
    window.__fakeStream = cv0.captureStream(30);
    setInterval(() => { c0.fillStyle = "#111"; c0.fillRect(0, 0, 640, 480); c0.fillRect((Date.now() / 40) % 640, 0, 2, 2); }, 33);
    navigator.mediaDevices.getUserMedia = async () => window.__fakeStream;
    setView("fitnessMotion");
    await motionCamRefresh();
    await motionCamEnsureDefault();
  });
  await page.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await new Promise(r => setTimeout(r, 1500));

  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, 640, 480);
    const grid = new Float32Array(96 * 72);
    window.__grid = grid;
    const fake = {
      available: () => true, grid: () => grid,
      stats: () => ({ status: "open", fps: 15, validRatio: 0.9 }),
      onStatus: () => {}, connect: () => {}, close: () => {}
    };
    motionEngine.attachDepth(fake);
    motionEngine.attach(cv);
    motionEngine.preview();

    // 造场景：地板平面 + 后墙 + 站立人形（全部按针孔投影算）
    window.__scene = function (dist, camH, wallMM) {
      const W = 96, H = 72, VFOV = 45.5, HFOV = 58.4;
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H - 0.5;
        const tv = Math.tan(v * VFOV * Math.PI / 180);
        const d = tv > 1e-4 ? Math.min(wallMM, camH / tv) : wallMM;
        for (let x = 0; x < W; x++) grid[y * W + x] = d;
      }
      const height = 1350, legHalf = 55, legGap = 75, torsoHalf = 170;
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H - 0.5;
        const tv = Math.tan(v * VFOV * Math.PI / 180);
        const yw = camH - dist * tv;
        if (yw < 0 || yw > height) continue;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W - 0.5;
          const ax = Math.abs(dist * Math.tan(u * HFOV * Math.PI / 180));
          let half;
          if (yw > height - 200) half = 75;
          else if (yw < height * 0.42) {
            if (Math.abs(ax - legGap) > legHalf && Math.abs(ax + legGap) > legHalf) continue;
            half = 9999;
          } else half = torsoHalf;
          if (half < 9999 && ax > half) continue;
          grid[y * W + x] = dist;
        }
      }
    };
  });

  const CAM_HEIGHTS = [700, 1000, 1300];
  const DISTS = [1600, 2000, 2400, 2800, 3200, 3600];
  let cases = 0;

  for (const camH of CAM_HEIGHTS) {
    for (const dist of DISTS) {
      const wall = dist + 2500;   // 后墙永远在人身后 2.5 米，避免"人贴墙"的退化情形
      await page.evaluate((d, c, w) => window.__scene(d, c, w), dist, camH, wall);
      await new Promise(r => setTimeout(r, 850));
      const s = await page.evaluate(() => {
        const sk = motionEngine.getSkeleton();
        const live = motionEngine.getLive();
        const p = motionEngine.getPose();
        return {
          has: sk.has, joints: sk.visibleJointCount || 0,
          bh: sk.bbox ? sk.bbox.h : 0, near: live.depthNear || 0,
          guide: p ? p.guide : ""
        };
      });
      cases++;
      const err = Math.abs(s.near - dist) / dist;
      const ok = s.has && s.joints >= 12 && err <= 0.08 && s.bh > 0.30;
      check(`相机 ${camH}mm / 人站 ${dist}mm：骨架出得来且距离准`,
        ok,
        `has=${s.has} 关节=${s.joints} bbox.h=${s.bh.toFixed(2)} depthNear=${Math.round(s.near)}(误差 ${(err * 100).toFixed(1)}%) guide=${s.guide}`);
    }
  }

  // 反向回归：近处不该被误伤（地板剔除逻辑不能把人自己当背景切掉）
  for (const dist of [1200, 1400]) {
    await page.evaluate((d) => window.__scene(d, 1000, d + 2500), dist);
    await new Promise(r => setTimeout(r, 850));
    const s = await page.evaluate(() => {
      const sk = motionEngine.getSkeleton();
      return { has: sk.has, joints: sk.visibleJointCount || 0 };
    });
    check(`近处 ${dist}mm 不被地板剔除逻辑误伤`, s.has && s.joints >= 12,
      `has=${s.has} 关节=${s.joints}`);
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过（共 ${cases} 个距离场景）=====`);
  if (failed.length) { failed.forEach(f => console.log("  FAIL:", f.name, f.detail || "")); process.exit(1); }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
