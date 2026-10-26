// 用最"严格"的 Chrome 配置（不加 --allow-file-access-from-files）跑 file:// 音频探测
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const url = "file:///" + path.join(__dirname, "probe-file-audio.html").replace(/\\/g, "/");

(async () => {
  for (const extra of [[], ["--allow-file-access-from-files"]]) {
    const browser = await puppeteer.launch({
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: "new",
      args: ["--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", ...extra]
    });
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.goto(url, { waitUntil: "load" });
    await new Promise(r => setTimeout(r, 14000));
    const out = await page.$eval("#out", el => el.textContent);
    console.log("========== 启动参数: " + (extra.length ? extra.join(" ") : "（无，等同于双击打开）") + " ==========");
    console.log(out);
    if (errs.length) console.log("pageerror:", errs.join(" | "));
    console.log();
    await browser.close();
  }
})();
