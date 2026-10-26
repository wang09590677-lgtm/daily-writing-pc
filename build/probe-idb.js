// 探测 file:// 下浏览器持久化能力：IndexedDB / Cache Storage / localStorage 配额
// 结论决定「跟做视频持久化」用哪条路。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-idb"),
      "--window-size=1000,700"
    ]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 500));

  const out = await page.evaluate(async () => {
    const r = { origin: location.origin, href: location.href.slice(0, 60) };

    // 1) IndexedDB 是否可用 + 能否存 Blob
    try {
      r.idbType = typeof indexedDB;
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open("probe_db", 1);
        req.onupgradeneeded = () => { req.result.createObjectStore("v"); };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        setTimeout(() => rej(new Error("open timeout")), 3000);
      });
      r.idbOpen = "ok";
      // 写一个 200KB 的 Blob
      const bytes = new Uint8Array(200 * 1024);
      for (let i = 0; i < bytes.length; i += 997) bytes[i] = i % 255;
      const blob = new Blob([bytes], { type: "video/mp4" });
      await new Promise((res, rej) => {
        const tx = db.transaction("v", "readwrite");
        tx.objectStore("v").put(blob, "k");
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      const got = await new Promise((res, rej) => {
        const tx = db.transaction("v", "readonly");
        const q = tx.objectStore("v").get("k");
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      r.idbBlobRoundTrip = got && got.size ? got.size : "empty";
      r.idbBlobUrl = (() => { try { const u = URL.createObjectURL(got); return u.slice(0, 5); } catch (e) { return "ERR:" + e.message; } })();
      db.close();
    } catch (e) {
      r.idbError = String(e && e.message || e);
    }

    // 2) localStorage 可用性与容量
    try {
      r.lsType = typeof localStorage;
      const big = "x".repeat(200 * 1024);
      localStorage.setItem("__probe_big", big);
      r.lsWrite = localStorage.getItem("__probe_big").length;
      localStorage.removeItem("__probe_big");
    } catch (e) { r.lsError = String(e && e.message || e); }

    // 3) Cache Storage
    try {
      r.cachesType = typeof caches;
      const c = await caches.open("probe-cache");
      await c.put("/__probe", new Response(new Blob(["hi"])));
      const m = await c.match("/__probe");
      r.cacheOk = !!m;
      await caches.delete("probe-cache");
    } catch (e) { r.cacheError = String(e && e.message || e); }

    // 4) navigator.storage 估算
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        r.quota = est.quota; r.usage = est.usage;
      } else r.quota = "n/a";
    } catch (e) { r.quota = "ERR:" + e.message; }

    // 5) 相对路径视频能否加载（休息固定视频方案的前提）
    try {
      const v = document.createElement("video");
      v.src = "体能训练动作演示/中场休息.mp4";
      v.muted = true;
      const meta = await new Promise((res) => {
        v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
        v.onerror = () => res({ err: (v.error && v.error.code) || "load-error" });
        setTimeout(() => res({ err: "timeout" }), 4000);
      });
      r.relVideo = meta;
    } catch (e) { r.relVideo = "ERR:" + e.message; }

    return r;
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
