// 临时探针：验证 file:// 下摄像头权限到底会不会被 --use-fake-ui-for-media-stream 抑制。
// 三种启动参数各开一次独立浏览器（互不影响），分别看：
//   1) navigator.permissions.query({name:'camera'}) 的 state
//   2) 不点任何按钮时 getUserMedia 会怎样（resolve / reject / 卡住）
// 用独立 temp profile，避免污染用户真实配置档。
const path = require("path");
const os = require("os");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = ["--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen"];

const CASES = [
  { name: "裸启动（无任何 flag）", args: [] },
  { name: "只有 allow-file-access", args: ["--allow-file-access-from-files"] },
  { name: "完整 bat 参数（含 fake-ui）", args: ["--allow-file-access-from-files", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
];

async function run(c) {
  const dir = path.join(os.tmpdir(), "camperm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: BASE.concat(c.args, ["--user-data-dir=" + dir, "--window-size=1000,700"]),
  });
  const page = await browser.newPage();
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(600);

  // 1) 权限状态（不触发请求）
  let perm = "n/a";
  try {
    perm = await page.evaluate(async () => {
      if (!navigator.permissions || !navigator.permissions.query) return "no-api";
      try {
        const s = await navigator.permissions.query({ name: "camera" });
        return s.state;
      } catch (e) { return "query-err:" + e.name; }
    });
  } catch (e) { perm = "eval-err"; }

  // 2) 直接 getUserMedia，看能否拿到流（带 4 秒超时：拒绝/挂起都要能区分）
  const gum = await page.evaluate(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, why: "no-api" };
    const t0 = performance.now();
    try {
      const s = await Promise.race([
        navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), 4000)),
      ]);
      const tr = s.getVideoTracks()[0];
      const out = { ok: true, label: (tr && tr.label) || "", ms: Math.round(performance.now() - t0) };
      s.getTracks().forEach(t => t.stop());
      return out;
    } catch (e) {
      return { ok: false, why: e.name + ": " + e.message, ms: Math.round(performance.now() - t0) };
    }
  });

  await browser.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 句柄未释放，忽略 */ }
  return { name: c.name, perm, gum };
}

(async () => {
  console.log("file:// 摄像头权限实测（每例独立浏览器，串行）\n");
  for (const c of CASES) {
    const r = await run(c);
    console.log("── " + r.name);
    console.log("   permissions.state = " + r.perm);
    console.log("   getUserMedia      = " + JSON.stringify(r.gum));
    console.log("");
    await sleep(2500);
  }
  console.log("说明：perm=granted 表示浏览器已预先放行（不会弹框）；");
  console.log("      perm=prompt  表示每次调用都会弹框问；denied 表示被拒。");
})().catch(e => { console.error("FATAL", e); process.exit(1); });
