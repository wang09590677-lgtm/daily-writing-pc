// 验证「整体倾斜 + 节内回正」这组尾巴参数：
// 目标 尾尖 x 明显偏右、y 明显上抬、|z| 很小（正面看得见）。
const path = require("path");
const puppeteer = require(path.join(
  "C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules",
  "puppeteer-core"
));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
      "--allow-file-access-from-files", "--window-size=1280,800"]
  });
  const page = await browser.newPage();
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 1000));

  const out = await page.evaluate(() => {
    const SEG = 0.072, SEGS = 7;
    function trial(tilt, z0, zStep) {
      const root = new THREE.Group();
      root.rotation.z = tilt;
      let pivot = root;
      const pts = [];
      for (let i = 0; i < SEGS; i++) {
        const node = new THREE.Group();
        node.position.set(0, i === 0 ? 0 : SEG, 0);
        node.rotation.z = i === 0 ? z0 : zStep;
        pivot.add(node);
        pivot = node;
        root.updateMatrixWorld(true);
        const p = new THREE.Vector3(0, SEG, 0);
        p.applyMatrix4(node.matrixWorld);
        pts.push(p);
      }
      const a = pts[0], b = pts[pts.length - 1];
      const ab = b.clone().sub(a);
      const L = ab.length() || 1e-6;
      let dev = 0;
      pts.forEach(p => {
        const ap = p.clone().sub(a);
        dev = Math.max(dev, ap.clone().sub(ab.clone().multiplyScalar(ap.dot(ab) / (L * L))).length());
      });
      const last = pts[pts.length - 1];
      return { x: last.x, y: last.y, z: last.z, dev };
    }
    const rows = [];
    [-0.75, -0.65, -0.60, -0.55, -0.50].forEach(tilt => {
      [-0.05, -0.11, -0.16].forEach(z0 => {
        [0.09, 0.115, 0.14].forEach(zStep => {
          const r = trial(tilt, z0, zStep);
          // 只要「上抬 + 侧偏 + 不朝后」同时满足的
          if (r.y > 0.16 && r.x > 0.20 && Math.abs(r.z) < 0.06 && r.dev > 0.02) {
            rows.push({ tilt, z0, zStep, ...r });
          }
        });
      });
    });
    rows.sort((p, q) => (q.y + q.x) - (p.y + p.x));
    return rows.slice(0, 8);
  });

  if (!out.length) {
    console.log("没有候选同时满足条件，需要放宽。");
  } else {
    console.log("满足「上抬+侧偏+不朝后+有弧度」的候选（按 y+x 排序）:");
    out.forEach(r => {
      console.log("  tilt=" + r.tilt.toFixed(2) + " z0=" + r.z0.toFixed(2) +
        " zStep=" + r.zStep + "  →  尾尖(" + r.x.toFixed(3) + ", " + r.y.toFixed(3) +
        ", " + r.z.toFixed(3) + ")  弧度=" + r.dev.toFixed(3));
    });
  }
  await browser.close();
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
