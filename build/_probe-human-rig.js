/* 跑 _probe-human-rig.html：打印新模型的静止几何与朝向判定，并出三视图截图。
   用法：node build/_probe-human-rig.js */
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = "file:///" + path.join(__dirname, "_probe-human-rig.html").replace(/\\/g, "/");
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-hrig-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    defaultViewport: { width: 620, height: 780 },
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await origClose(); } catch (e) { }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (e) { await sleep(300); } }
  };
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(PAGE, { waitUntil: "load", timeout: 40000 });

  let rep = null;
  for (let i = 0; i < 50; i++) {
    rep = await page.evaluate(() => window.__report);
    if (rep && (rep.ok || rep.error)) break;
    await sleep(300);
  }
  if (!rep || !rep.ok) { console.log("模型没加载成功:", JSON.stringify(rep)); await browser.close(); return; }

  console.log("骨骼数 =", rep.boneCount, " 蒙皮网格 =", rep.skinned);
  console.log("骨骼名前 6 个（注意冒号是否被洗掉）:", rep.names.slice(0, 6).join(", "));
  console.log("内置动画 =", JSON.stringify(rep.anims));
  console.log("\n=== 骨轴检验（局部 +Y vs 指向子骨骼），偏差 >5° ===");
  console.log(rep.axisGap.length ? "  " + rep.axisGap.join("  ") : "  无");
  console.log("\n=== 关键骨骼静止世界坐标 ===");
  Object.keys(rep.bones).forEach(n => console.log("  " + n.padEnd(16) + " " + JSON.stringify(rep.bones[n])));
  console.log("\n=== 朝向判定 ===");
  Object.keys(rep.face).forEach(k => console.log("  " + k + " = " + rep.face[k]));

  for (const v of ["front", "side", "back"]) {
    await page.evaluate(n => window.__setView(n), v);
    await sleep(250);
    const out = path.join(SHOT, "_probe-human-" + v + ".png");
    await page.screenshot({ path: out });
    console.log("截图 " + v + " -> " + out);
  }
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
