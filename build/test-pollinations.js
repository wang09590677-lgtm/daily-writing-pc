// 测试 Pollinations 免费接口的稳定性、水印与模型可用性
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "imgtest");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchImage(url, outFile, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, res => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", d => (body += d));
        res.on("end", () => reject(new Error("HTTP " + res.statusCode + " " + body.slice(0, 200))));
        return;
      }
      const ct = res.headers["content-type"] || "";
      if (!ct.startsWith("image/")) {
        let body = "";
        res.on("data", d => (body += d));
        res.on("end", () => reject(new Error("非图片 " + ct + " " + body.slice(0, 200))));
        return;
      }
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        fs.writeFileSync(outFile, Buffer.concat(chunks));
        resolve(Buffer.concat(chunks).length);
      });
    });
    req.on("timeout", () => { req.destroy(new Error("超时")); });
    req.on("error", reject);
  });
}

const PROMPT = "children's picture book illustration, flat vector art, warm orange sunset sky over a park, a happy child in yellow shirt throwing a white paper airplane, a small brown dog running after it, a wooden bench with a red schoolbag on it, green grass, bright colors";
const enc = encodeURIComponent(PROMPT);

const MODELS = ["flux", "sana", "turbo", "kontext"];

(async () => {
  for (const model of MODELS) {
    const url = `https://image.pollinations.ai/prompt/${enc}?width=896&height=672&model=${model}&nologo=true&seed=11&private=true`;
    const file = path.join(OUT, `model-${model}.jpg`);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const size = await fetchImage(url, file);
        console.log(`[OK]   model=${model} 第${attempt}次  ${(size / 1024).toFixed(1)} KB`);
        ok = true;
      } catch (e) {
        console.log(`[FAIL] model=${model} 第${attempt}次  ${String(e.message).slice(0, 120)}`);
        await new Promise(r => setTimeout(r, 8000));
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log("完成，输出目录:", OUT);
})();
