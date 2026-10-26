// 深度接入端到端自检：用真实 Chrome 打开 file:// 页面，
// 页面连 ws://127.0.0.1:8765 拿 Astra 真实深度，交给体感引擎算人形。
//
// 前置：先跑 tools/orbbec/start-depth-bridge.bat
// 用法：node build/depth-e2e.js

const path = require("path");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = "file:///" + path.join(__dirname, "depth-e2e.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.on("console", m => console.log("   [页面] " + m.text()));
  page.on("pageerror", e => console.log("   [页面错误] " + e.message));

  await page.goto(PAGE, { waitUntil: "load" });
  await page.waitForFunction("window.RESULT && window.RESULT.done === true", { timeout: 30000 });
  const res = await page.evaluate("window.RESULT");
  await browser.close();

  console.log("\n=== 深度接入端到端结果 ===");
  const log = res.log || [];
  log.forEach(r => {
    console.log(`  t=${String(r.t).padStart(4)}ms  链接=${r.linkStatus}/${r.linkFps}fps/有效${(r.linkValid * 100).toFixed(0)}%  ` +
      `深度用上=${r.depthOn ? "是" : "否"}  人距=${r.depthNear}mm  身高=${r.bodyHeightMM}mm  ` +
      `骨架关节=${r.joints}  面积=${r.area}`);
  });

  const last = log.slice(-4);
  const linkOk = last.some(r => r.linkStatus === "open" && r.linkFps > 0);
  const depthUsed = last.some(r => r.depthOn);
  const skelOk = last.some(r => r.joints >= 8);
  const sizedOk = last.some(r => r.bodyHeightMM > 300 && r.bodyHeightMM < 3000);

  console.log("\n--- 判定 ---");
  console.log(`  ${linkOk ? "PASS" : "FAIL"}  file:// 页面连上了本地桥接服务并收到深度帧`);
  console.log(`  ${depthUsed ? "PASS" : "FAIL"}  引擎确实用深度算了人形（depthOn）`);
  console.log(`  ${skelOk ? "PASS" : "FAIL"}  深度人形生成了骨架（≥8 个关节）`);
  console.log(`  ${sizedOk ? "PASS" : "FAIL"}  换算出的身高在合理范围（300~3000mm）`);

  const allOk = linkOk && depthUsed && skelOk && sizedOk;
  console.log(allOk ? "\n全部通过 ✅" : "\n有未通过项 ❌");
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error("跑测试出错：", e.message); process.exit(2); });
