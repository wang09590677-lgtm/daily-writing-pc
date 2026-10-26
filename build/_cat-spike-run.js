/* 跑 _cat-spike.html：验证 GLB 在 file:// 下加载 + 骨骼驱动蒙皮变形。
 * 用法：node build/_cat-spike-run.js
 */
"use strict";
const path = require("path"), os = require("os"), fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HTML = "file:///" + path.join(__dirname, "_cat-spike.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-spike-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
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
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text()); });
  await page.goto(HTML, { waitUntil: "load", timeout: 30000 });
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(() => window.__spike && window.__spike.done);
    if (done) break;
    await sleep(500);
  }
  const text = await page.evaluate(() => document.getElementById("out").textContent);
  console.log(text);
  const rep = await page.evaluate(() => window.__spike.report);
  const err = await page.evaluate(() => window.__spike.error);
  console.log("\n===== 结构判定 =====");
  if (err) console.log("失败:", err);
  if (rep) {
    console.log("three 版本:", rep.revision);
    console.log("加载耗时:", rep.loadMs + "ms");
    console.log("骨骼/蒙皮/网格:", rep.bones + "/" + rep.skinned + "/" + rep.meshes);
    console.log("顶点/三角面:", rep.verts + "/" + rep.tris);
    console.log("骨骼驱动顶点最大位移:", rep.maxDelta.toFixed(4), "→", rep.maxDelta > 0.01 ? "蒙皮会变形 ✅" : "蒙皮无反应 ❌");
    console.log("每帧耗时:", rep.perFrameMs.toFixed(2) + "ms");
  }
  await browser.close();
  process.exit(rep && rep.maxDelta > 0.01 && !err ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
