// 可行性门禁测试：file:// 页面能否连本地 WebSocket / fetch localhost
// 深度流没法走 getUserMedia，只能靠本地桥接进程转发；这一步不通，深度方案就不成立。
const path = require("path");
const http = require("http");
const WS = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "ws"));
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 47821;

const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*"
    });
    res.end(JSON.stringify({ ok: true, from: "local-bridge", ua: req.headers.origin || "none" }));
  });
  const wss = new WS.Server({ server });
  wss.on("connection", ws => {
    ws.send(JSON.stringify({ hello: "depth-bridge", n: 1 }));
  });
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));
  console.log("bridge listening on 127.0.0.1:" + PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", m => logs.push(m.type() + ": " + m.text()));
  await page.goto(INDEX, { waitUntil: "domcontentloaded" });

  const origin = await page.evaluate(() => ({ href: location.href, origin: location.origin, protocol: location.protocol }));
  console.log("PAGE:", JSON.stringify(origin));

  const wsResult = await page.evaluate(port => new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, why: "timeout(4s)" }); } }, 4000);
    try {
      const s = new WebSocket("ws://127.0.0.1:" + port);
      s.onopen = () => { };
      s.onmessage = ev => { if (!done) { done = true; clearTimeout(t); resolve({ ok: true, msg: ev.data }); s.close(); } };
      s.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, why: "onerror" }); } };
    } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, why: "throw " + e.message }); } }
  }), PORT);
  console.log("WEBSOCKET:", JSON.stringify(wsResult));

  const fetchResult = await page.evaluate(port => fetch("http://127.0.0.1:" + port + "/ping")
    .then(r => r.json()).then(j => ({ ok: true, body: j }))
    .catch(e => ({ ok: false, why: e.name + ": " + e.message })), PORT);
  console.log("FETCH:", JSON.stringify(fetchResult));

  await browser.close();
  server.close();
  if (logs.length) console.log("CONSOLE:", logs.join(" | "));
})().catch(e => { console.error("FATAL", e); process.exit(1); });
