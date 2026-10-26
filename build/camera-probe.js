// 摄像头探测：枚举设备 + 看 facingMode:"user" 到底选中了谁 + 实测各设备能力
// 需要真实摄像头，所以用 headful（headless 下设备枚举不可靠）
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
      "--use-fake-ui-for-media-stream",          // 自动同意摄像头权限，免去手点
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const page = await browser.newPage();
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async () => {
    const out = { ok: false, err: "", devices: [], facingUser: null, perDevice: [], constraints: [] };

    // 先要一次权限，否则 enumerateDevices 的 label 是空的
    let primer = null;
    try {
      primer = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e) { out.err = "primer failed: " + e.name + " " + e.message; return out; }

    const all = await navigator.mediaDevices.enumerateDevices();
    out.devices = all.map(d => ({ kind: d.kind, label: d.label, id: d.deviceId.slice(0, 12), group: d.groupId.slice(0, 8) }));
    primer.getTracks().forEach(t => t.stop());

    // 1) 看 facingMode:"user" 实际解析到哪个设备（复现 app 当前行为）
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false
      });
      const t = s.getVideoTracks()[0];
      const st = t.getSettings();
      const dev = all.find(d => d.deviceId === st.deviceId);
      out.facingUser = {
        label: t.label, width: st.width, height: st.height,
        frameRate: st.frameRate, deviceId: (st.deviceId || "").slice(0, 12),
        resolvedLabel: dev ? dev.label : "(未匹配)"
      };
      t.stop();
    } catch (e) { out.facingUser = { error: e.name + " " + e.message }; }

    // 2) 逐个设备试，看真实能力
    const cams = all.filter(d => d.kind === "videoinput");
    for (const cam of cams) {
      const rec = { label: cam.label, id: cam.deviceId.slice(0, 12) };
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cam.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
        });
        const t = s.getVideoTracks()[0];
        const st = t.getSettings();
        const cap = typeof t.getCapabilities === "function" ? t.getCapabilities() : null;
        rec.got = { width: st.width, height: st.height, frameRate: st.frameRate };
        rec.caps = cap ? { w: cap.width, h: cap.height, fr: cap.frameRate } : null;
        rec.settings = t.getSettings();
        // 抓一帧，量亮度 / 看是不是灰度（IR 摄像头）
        const v = document.createElement("video");
        v.srcObject = s; v.muted = true; v.playsInline = true;
        await v.play();
        await new Promise(r => setTimeout(r, 900));
        const c = document.createElement("canvas");
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lum = 0, chroma = 0, n = 0;
        for (let i = 0; i < d.length; i += 40) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          lum += (r + g + b) / 3;
          chroma += Math.max(r, g, b) - Math.min(r, g, b);
          n++;
        }
        rec.frame = { w: c.width, h: c.height, lum: Math.round(lum / n), chroma: Math.round(chroma / n) };
        t.stop();
      } catch (e) { rec.error = e.name + ": " + e.message; }
      out.perDevice.push(rec);
    }

    out.ok = true;
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
