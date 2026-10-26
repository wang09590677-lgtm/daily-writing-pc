const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: false,
    args: ["--no-first-run","--no-default-browser-check","--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-vidsize"),
      "--autoplay-policy=no-user-gesture-required"] });
  const p = await b.newPage();
  await p.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(800);
  const r = await p.evaluate(async () => {
    const cv = document.createElement("canvas");
    cv.width = 640; cv.height = 480;
    const c = cv.getContext("2d");
    c.fillStyle = "#123"; c.fillRect(0, 0, 640, 480);
    const st = cv.captureStream(30);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.srcObject = st;
    document.body.appendChild(v);
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 900));
    const t = st.getVideoTracks()[0];
    return {
      videoWH: v.videoWidth + "x" + v.videoHeight,
      readyState: v.readyState,
      trackSettings: t.getSettings ? JSON.stringify(t.getSettings()) : "n/a",
      trackLabel: t.label,
      canvasWH: cv.width + "x" + cv.height
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await b.close();
})();
