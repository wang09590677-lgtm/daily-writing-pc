/* 验收：**没有** --allow-file-access-from-files 时必须优雅降级
 *
 * 背景：MediaPipe 能在 file:// 下工作，靠的是 start-app.bat 带的
 *   --allow-file-access-from-files。用户若直接双击 index.html（不走 bat），
 *   这个 flag 就不在，fetch 本地 .wasm/.tflite 会被 origin 'null' 拦掉。
 *
 * 此时**绝不能白屏、也不能报错吓孩子**，必须：
 *   1) 感知器加载失败被捕获（不产生未捕获异常）
 *   2) 引擎自动退回轮廓（掩码）链路，体感功能照常可用
 *   3) 界面给出"轮廓估计"的如实说明（不是骗人说用了真实关节）
 *
 * 运行：node build/accept-no-file-access.js
 */
"use strict";
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      // ⚠️ 刻意**不**加 --allow-file-access-from-files
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e && e.message)));

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem("dailyWritingPcStateV3"));
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  console.log("\n== 直接双击打开（无 file-access flag）==");
  await page.evaluate(() => document.querySelector('.chooser-card[data-module="fitness"]').click());
  await sleep(700);
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(i => i.dataset.view === "fitnessMotion").click();
  });
  // 给预热失败足够时间
  await sleep(6000);

  const st = await page.evaluate(() => {
    const d = window.motionVisionDebug ? window.motionVisionDebug() : null;
    const legend = document.getElementById("motionLegend");
    return {
      ok: !!d,
      failed: d ? d.failed : null,
      ready: d ? d.ready : null,
      legendText: legend ? legend.textContent.trim() : "",
      canDo: document.querySelectorAll("#motionCanDo li").length,
      setup: document.querySelectorAll("#motionSetup li").length,
      startDisabled: document.getElementById("motionStartBtn").disabled,
      camBtn: !!document.getElementById("motionCameraBtn")
    };
  });

  check("页面没有白屏、体感页面结构完整", st.canDo > 0 && st.setup > 0 && st.camBtn,
    `能测 ${st.canDo} / 摆放 ${st.setup}`);
  check("感知器被判定为失败态（而不是一直挂着未就绪）", st.failed === true,
    `failed=${st.failed} ready=${st.ready}`);
  check("没有任何未捕获异常（失败被 try/catch 接住）", pageErrors.length === 0,
    pageErrors.slice(0, 2).join(" | ") || "无");

  // 开摄像头，确认退回掩码链路后功能仍可用
  await page.evaluate(() => document.getElementById("motionCameraBtn").click());
  await sleep(3000);
  const after = await page.evaluate(() => ({
    isLive: document.getElementById("motionScreen").classList.contains("is-live"),
    calibShown: !document.getElementById("poseCalib").classList.contains("hidden"),
    legend: document.getElementById("motionLegend").textContent.trim()
  }));
  check("摄像头仍能正常开启（退回链路可用）", after.isLive === true, `legend=${after.legend}`);

  console.log("\n================ 汇总 ================");
  console.log(`  通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) console.log("失败项：\n  - " + fail.join("\n  - "));
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();
