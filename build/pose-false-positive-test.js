// 反向风险探针（gstack-investigator）：验证「纯家具、画面里没人」时，
// 新加的滑窗裁剪 / sideFB 兜底 / 软扣分 会不会裁出伪人段（误报）。
//
// 断言：所有"无人"场景必须 has=false（不允许出现骨架/bbox）。
// 只读项目文件；本脚本放系统 temp，不改动任何项目文件。
//
// 归因：命中误报时，除打印 bbox/cx/面积/填充率/是否贴边外，还会按几何启发式
// 判定"最可能由哪条逻辑放行"，并原样打印 motionEngine.depthDebug().diag 逐候选评分。
//   - 贴边 && 填充率>0.88  → 疑似 sideFB 兜底
//   - 贴边 && 填充率≤0.88  → 疑似主循环/fallback 选中后经「滑窗候选B」裁剪
//   - 不贴边 && 竖长窄条    → 疑似「滑窗候选B」从宽家具裁出的伪人条
//   - 其余                  → 主循环直接选中
// 注：启发式仅为线索；最终以 team-lead 暴露的 depthDebugInfo.path 显式标记为准。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc/index.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  (s.objects || []).forEach(function(o){
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = ray(x, y); const t = o.dist / d.dz; if (!(t > 0)) continue;
      const wx = t * d.dx, wy = s.camH + t * d.dy;
      if (wy < o.wy0 || wy > o.wy1) continue;
      if (wx < o.wx0 || wx > o.wx1) continue;
      grid[y * W + x] = o.dist;
    }
  });
  return grid;
}
window.__buildScene = buildScene;
`;

// 从 depthDebug().diag 里取出"被选中那一帧"的显式归因（team-lead 已加 path/split）
function pickAttr(dbg) {
  if (!dbg || !dbg.diag) return { path: "?", split: "?" };
  const ok = dbg.diag.filter(r => r.pick === "合格");
  if (!ok.length) return { path: "none", split: "none" };
  const atChosen = ok.filter(r => r.t === dbg.chosen);
  const r = (atChosen.length ? atChosen[atChosen.length - 1] : ok[ok.length - 1]);
  return { path: r.path || "?", split: r.split || "?" };
}

function classify(snap) {
  if (!snap.bbox) return "—";
  const b = snap.bbox, cx = b.x + b.w / 2;
  const touchEdge = b.x <= 0.02 || b.x + b.w >= 0.98;
  const fill = snap.area / Math.max(1e-6, b.w * b.h);
  // 有显式 path/split 时以它为准
  const a = snap.attr || { path: "?", split: "?" };
  if (a.path !== "?" && a.path !== "none") {
    const via = a.split === "slide" ? "经滑窗裁剪" : "未经裁剪";
    return `【显式】path=${a.path} split=${a.split}（${via}）` +
      (touchEdge ? " · 仍贴边" : "") + (fill > 0.88 ? " · 填充>0.88" : "");
  }
  // 退回几何启发式
  if (touchEdge && fill > 0.88) return "疑似 sideFB 兜底（贴边+高填充）";
  if (touchEdge) return "疑似 主循环/fallback 选中后经滑窗裁剪（仍贴边）";
  if (b.w < 0.30 && b.h / b.w >= 1.6) return "疑似 滑窗从宽家具裁出的窄竖条";
  return "疑似 主循环直接选中";
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--user-data-dir=" + path.join("C:/Users/lixue/AppData/Local/Temp/gstack-probe", "fp-" + process.pid),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(700);

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

  let pass = 0, fail = 0;
  const D = [1600, 2400, 3000, 3600];
  const scenes = [
    { name: "空房间(只有地板+后墙)", objs: () => [] },
    { name: "左侧同深度大柜子(无人)", objs: (d) => [{ wx0: -1400, wx1: -450, wy0: 0, wy1: 1900, dist: d }] },
    { name: "左侧贴边竖长门框(无人)", objs: (d) => [{ wx0: -2000, wx1: -900, wy0: 0, wy1: 2100, dist: d }] },
    { name: "整面衣柜占左半幅(无人)", objs: (d) => [{ wx0: -2200, wx1: -100, wy0: 0, wy1: 2200, dist: d }] },
    { name: "两侧对称柜子(无人)", objs: (d) => [
        { wx0: -1600, wx1: -600, wy0: 0, wy1: 1900, dist: d },
        { wx0: 600, wx1: 1600, wy0: 0, wy1: 1900, dist: d }] },
    { name: "低矮书桌(无人)", objs: (d) => [{ wx0: -700, wx1: 700, wy0: 0, wy1: 750, dist: d }] },
    { name: "远处整面墙+近处门框(无人)", objs: (d) => [{ wx0: -2200, wx1: -800, wy0: 0, wy1: 2100, dist: d }] }
  ];

  for (const sc of scenes) {
    for (const d of D) {
      const s = { camH: 1000, wall: 6000, objects: sc.objs(d) };
      await page.evaluate((sc2) => { window.__buildScene(window.__grid, sc2); }, s);
      await sleep(850);
      const snap = await page.evaluate(() => {
        const sk = motionEngine.getSkeleton();
        const dbg = motionEngine.depthDebug ? motionEngine.depthDebug() : null;
        return { has: sk.has, bbox: sk.bbox || null, area: sk.area || 0, dbg: dbg };
      });
      snap.attr = pickAttr(snap.dbg);
      const ok = !snap.has;
      if (ok) pass++; else fail++;
      if (ok) {
        console.log(`PASS  ${sc.name} @${d}mm  has=false`);
      } else {
        const b = snap.bbox, cx = b.x + b.w / 2;
        const fill = snap.area / Math.max(1e-6, b.w * b.h);
        console.log(`FAIL-误报  ${sc.name} @${d}mm  bbox=${b.w.toFixed(2)}×${b.h.toFixed(2)}` +
          ` cx=${cx.toFixed(3)} x0=${b.x.toFixed(2)} 面积=${(snap.area * 100).toFixed(1)}% 填充=${fill.toFixed(2)}` +
          `  → ${classify(snap)}`);
        if (snap.dbg && snap.dbg.diag) {
          console.log("       diag: " + snap.dbg.diag.map(r =>
            `t=${r.t}${r.q} r=${r.r}${r.pick !== "合格" ? "→" + r.pick : `→合格(${r.bw}×${r.bh} 分${r.score} ${r.path}/${r.split})`}`).join(" | "));
        }
      }
    }
  }

  await browser.close();
  console.log(`\n===== 误报探针 ${pass}/${pass + fail} 全部无人生还（应全 has=false）=====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
