const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const ROOT = path.join(__dirname, "..", "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const target = process.argv[2] || "file";
(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
           "--no-first-run", "--no-default-browser-check"]
  });
  const page = await browser.newPage();
  await page.goto("about:blank");
  // 授权摄像头（Puppeteer 覆盖权限）
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(target === "file" ? "file://" : "http://127.0.0.1:8899", ["camera"]).catch(e => console.log("perm override:", e.message));
  const fileUrl = "file:///" + path.join(ROOT, "build", "probe", "camera-probe.html").replace(/\\/g, "/");
  const url = target === "file" ? fileUrl : "http://127.0.0.1:8899/build/probe/camera-probe.html";
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERROR " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("CONSOLE " + m.text()); });
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction("window.__probeResult && window.__probeResult.done", { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate(() => window.__probeResult);
  console.log("=== 目标:", url.slice(0, 60), "===");
  console.log(JSON.stringify(r, null, 2));
  if (errs.length) console.log("错误:\n" + errs.join("\n"));
  await browser.close();
})();
