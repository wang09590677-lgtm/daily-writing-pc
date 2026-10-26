// 教练计时浮层：几何自检 + 演示截图
//
// 1) 批量校验全部动作动画的几何：所有关节坐标有限、脚底贴地、包围盒不越界
// 2) 把每个动作的一帧拼成一张"动作总览图"，一眼看清教练示范画得对不对
// 3) 截几张真实的浮层大图（单组 / 多组自动串组间歇 / 组间歇中 / 保持类）
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const logs = [];
  page.on("console", m => logs.push(m.type() + ": " + m.text()));
  page.on("pageerror", e => logs.push("pageerror: " + e.message));

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify({
      module: "fitness",
      profile: { name: "小作家", age: 10, grade: "五年级", targetWords: 350 }
    }));
  });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(700);

  // ---------- 1. 几何自检 ----------
  const geo = await page.evaluate(() => {
    const CT = window.CoachTimer;
    const keys = Object.keys(CT.ANIMS);
    const bad = [];
    const rows = [];
    keys.forEach(key => {
      const def = CT.ANIMS[key];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let nonFinite = 0, groundMax = -Infinity, groundMin = Infinity;
      [0, 0.2, 0.4, 0.5, 0.6, 0.8].forEach(t => {
        const pose = CT.__poseAt(key, t);
        const pts = [];
        pose.arms.forEach(a => a.pts.forEach(p => pts.push(p)));
        pose.legs.forEach(l => l.pts.forEach(p => pts.push(p)));
        pts.push(pose.head, pose.hip, pose.neck);
        pts.forEach(p => {
          if (!isFinite(p.x) || !isFinite(p.y)) nonFinite++;
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        });
        // 脚底（腿的最末两点）最低处应当贴地 y≈0
        let legMin = Infinity;
        pose.legs.forEach(l => l.pts.forEach(p => { legMin = Math.min(legMin, p.y); }));
        groundMin = Math.min(groundMin, legMin);
        groundMax = Math.max(groundMax, legMin);
      });
      const row = {
        key, view: def.view, cycle: def.cycle,
        bbox: [+minX.toFixed(3), +maxX.toFixed(3), +minY.toFixed(3), +maxY.toFixed(3)],
        nonFinite,
        footY: [+groundMin.toFixed(4), +groundMax.toFixed(4)]
      };
      rows.push(row);
      if (nonFinite > 0) bad.push(key + " 有非有限坐标");
      if (groundMin < -0.002) bad.push(key + " 脚穿到地面以下 " + groundMin.toFixed(3));
      // 躺姿（平板支撑 0.16 / 臀桥 0.24 / 靠墙静蹲 0.29）本来就矮，阈值取 0.12 只拦"整个人塌了"
      if (maxY < 0.12) bad.push(key + " 整个人太矮 " + maxY.toFixed(3));
      if (maxY > 1.25) bad.push(key + " 顶出取景窗 " + maxY.toFixed(3));
      if (Math.abs(minX) > 0.78 || Math.abs(maxX) > 0.82) bad.push(key + " 横向超出取景窗");
    });
    return { count: keys.length, rows, bad };
  });

  console.log("== 动作动画几何自检 ==");
  console.log("动画数：" + geo.count);
  geo.rows.forEach(r => {
    console.log(`  ${r.key.padEnd(16)} ${r.view.padEnd(5)} cycle=${r.cycle}s  bbox=[${r.bbox.join(", ")}]  脚底y=${r.footY.join("~")}`);
  });
  if (geo.bad.length) {
    console.log("!! 异常：" + geo.bad.join(" | "));
  } else {
    console.log("全部动画几何正常（坐标有限 / 脚不穿地 / 高度合理 / 不越界）");
  }

  // 动作 id → 动画 的映射覆盖检查
  const cover = await page.evaluate(() => {
    const CT = window.CoachTimer;
    const ids = Object.keys(window.FITNESS_EX);
    const missing = ids.filter(id => !CT.EX_ANIM[id]);
    const used = {};
    ids.forEach(id => { const k = CT.EX_ANIM[id]; used[k] = (used[k] || 0) + 1; });
    return { total: ids.length, mapped: ids.length - missing.length, missing, used };
  });
  console.log("\n== 动作覆盖 ==");
  console.log(`FITNESS_EX 共 ${cover.total} 个动作，已配演示 ${cover.mapped} 个`);
  if (cover.missing.length) console.log("  未配：" + cover.missing.join(", "));
  console.log("  动画复用情况：" + Object.entries(cover.used).map(([k, v]) => k + "×" + v).join("  "));

  // ---------- 2. 动作总览图 ----------
  await page.evaluate(() => {
    const CT = window.CoachTimer;
    const keys = Object.keys(CT.ANIMS);
    const COLS = 6, CELL_W = 220, CELL_H = 240, PAD = 10, HEAD = 34;
    const rows = Math.ceil(keys.length / COLS);
    const W = COLS * (CELL_W + PAD) + PAD;
    const H = HEAD + rows * (CELL_H + PAD) + PAD;
    const sheet = document.createElement("canvas");
    sheet.width = W; sheet.height = H;
    sheet.id = "coachSheet";
    sheet.style.cssText = "position:fixed;left:0;top:0;z-index:99999;background:#0f172a";
    document.body.appendChild(sheet);
    const g = sheet.getContext("2d");
    g.fillStyle = "#0f172a"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#f8fafc";
    g.font = "bold 18px 'Microsoft YaHei',sans-serif";
    g.fillText("教练计时浮层 · 动作演示总览（每个动作取 1/4 相位）", PAD + 4, 24);

    keys.forEach((key, i) => {
      const cx = PAD + (i % COLS) * (CELL_W + PAD);
      const cy = HEAD + Math.floor(i / COLS) * (CELL_H + PAD);
      g.fillStyle = "rgba(248,250,252,0.06)";
      g.fillRect(cx, cy, CELL_W, CELL_H);
      const cell = document.createElement("canvas");
      cell.width = CELL_W; cell.height = CELL_H;
      cell.style.width = CELL_W + "px"; cell.style.height = CELL_H + "px";
      CT.__drawPose(cell, key, 0.25);
      g.drawImage(cell, cx, cy);
      g.fillStyle = "#5eead4";
      g.font = "bold 14px 'Microsoft YaHei',sans-serif";
      g.fillText(key, cx + 10, cy + CELL_H - 10);
      g.fillStyle = "rgba(226,232,240,0.6)";
      g.font = "12px 'Microsoft YaHei',sans-serif";
      g.fillText(CT.ANIMS[key].view === "front" ? "正视" : "侧视", cx + CELL_W - 44, cy + CELL_H - 10);
    });
  });
  const sheetEl = await page.$("#coachSheet");
  await sheetEl.screenshot({ path: path.join(SHOT, "coach-anims.png") });
  await page.evaluate(() => { const e = document.getElementById("coachSheet"); if (e) e.remove(); });
  console.log("\n已输出 build/shots/coach-anims.png");

  // ---------- 3. 真实浮层截图 ----------
  // 用真实的分段计划（运动 → 组间歇 → 运动 …），跟点动作块上的「计时」完全一样
  const cases = [
    { tag: "深蹲（单组）", exId: "squat", name: "徒手深蹲", emoji: "🪑",
      how: "双脚与肩同宽，屁股往后坐，膝盖别超过脚尖。",
      label: "12 次 · 参考配速 30 秒",
      segments: [{ kind: "work", seconds: 30, setNo: 1, setCount: 1 }], left: 30 * 0.62 },
    { tag: "开合跳（3 组自动串组间歇）", exId: "jumpingJacks", name: "开合跳", emoji: "⭐",
      how: "跳开时脚分开、手举过头，落地轻一点。",
      label: "3 组 × 30 次 · 参考配速 35 秒/组 · 组间歇 30 秒",
      segments: [
        { kind: "work", seconds: 35, setNo: 1, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 35, setNo: 2, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 35, setNo: 3, setCount: 3 }
      ], left: 165 - 10 },
    { tag: "组间歇中（同一份计划里自动切过来）", exId: "jumpingJacks", name: "开合跳", emoji: "⭐",
      how: "跳开时脚分开、手举过头，落地轻一点。",
      label: "3 组 × 30 次 · 参考配速 35 秒/组 · 组间歇 30 秒",
      segments: [
        { kind: "work", seconds: 35, setNo: 1, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 35, setNo: 2, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 35, setNo: 3, setCount: 3 }
      ], left: 165 - 45 },
    { tag: "原地小步跑（用户举的例子：3 组 × 30 秒 · 间歇 30 秒 = 150 秒）",
      exId: "fastFeet", name: "原地小步跑", emoji: "👟",
      how: "步幅很小、频率很快，前脚掌着地，手臂快速前后摆。",
      label: "3 组 × 30 秒 · 30 秒/组 · 组间歇 30 秒",
      segments: [
        { kind: "work", seconds: 30, setNo: 1, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 30, setNo: 2, setCount: 3 },
        { kind: "rest", seconds: 30 },
        { kind: "work", seconds: 30, setNo: 3, setCount: 3 }
      ], left: 150 - 30 },
    { tag: "平板支撑（保持类）", exId: "plank", name: "平板支撑", emoji: "🧘",
      how: "身体一条直线，肚子收紧，别塌腰也别撅屁股。",
      label: "25 秒",
      segments: [{ kind: "work", seconds: 25, setNo: 1, setCount: 1 }], left: 25 * 0.38 }
  ];
  for (const c of cases) {
    await page.evaluate((cfg) => {
      const nav = [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessToday");
      if (nav) nav.click();
      window.CoachTimer.open({
        exId: cfg.exId, name: cfg.name, emoji: cfg.emoji, how: cfg.how,
        label: cfg.label, segments: cfg.segments
      });
      window.CoachTimer.update(cfg.left);
    }, c);
    await sleep(1400);
    await page.screenshot({ path: path.join(SHOT, `coach-${c.exId}-${c.left | 0}.png`) });
    console.log(`已输出 build/shots/coach-${c.exId}-${c.left | 0}.png  (${c.tag})`);
  }

  console.log("\n== 控制台 ==");
  const bad = logs.filter(l => /pageerror|error:/i.test(l));
  console.log(bad.length ? bad.join("\n") : "无报错");

  await browser.close();
})().catch(err => { console.error("失败：", err); process.exit(1); });
