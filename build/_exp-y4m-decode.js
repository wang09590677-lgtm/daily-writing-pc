// 解码 build/__motion-test.y4m（motion-browser-test.js 的真实夹具），
// 逐帧量出人形在 128×96 里的真实包围盒与纵向行程。纯离线，不开浏览器。
const fs = require("fs");
const path = require("path");

const buf = fs.readFileSync(path.join(__dirname, "__motion-test.y4m"));
// 解析头部到第一个 \n
let p = 0;
while (buf[p] !== 0x0a) p++;
const header = buf.slice(0, p).toString("latin1");
p++;
console.log("Y4M header:", header);

const W = 128, H = 96;
const ySize = W * H, cSize = (W >> 1) * (H >> 1);
const frameBytes = 6 + ySize + cSize + cSize; // "FRAME\n" + Y + U + V

const frames = [];
const maxFrames = 400; // 前 400 帧(16s @25fps)足够看数个周期
while (p + frameBytes <= buf.length && frames.length < maxFrames) {
  const tag = buf.slice(p, p + 6).toString("latin1");
  if (tag !== "FRAME\n") { console.log("unexpected tag at", p, JSON.stringify(tag)); break; }
  const y0 = p + 6;
  const Y = buf.slice(y0, y0 + ySize);
  let minX = W, maxX = -1, minY = H, maxY = -1, sum = 0, cnt = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Y[y * W + x];
    if (v > 128) { cnt++; sum += y; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  frames.push({ i: frames.length, cnt, minX, maxX, minY, maxY, cy: cnt ? sum / cnt : NaN, w: maxX - minX + 1, h: maxY - minY + 1 });
  p += frameBytes;
}
console.log("decoded frames:", frames.length, " total bytes:", buf.length, " expected consumed:", p);

const cys = frames.map(f => f.cy).filter(Number.isFinite);
const cymin = Math.min(...cys), cymax = Math.max(...cys);
console.log("figure centroidY(px, 0..96): min=" + cymin.toFixed(3) + " max=" + cymax.toFixed(3) + " span=" + (cymax - cymin).toFixed(3) + "px");
console.log("  归一化(/96) span=" + ((cymax - cymin) / 96).toFixed(4));
console.log("  bbox h px: min=" + Math.min(...frames.map(f => f.h)) + " max=" + Math.max(...frames.map(f => f.h)) + "  (归一化 /96 = " + (Math.max(...frames.map(f => f.h)) / 96).toFixed(3) + ")");
console.log("  bbox w px: min=" + Math.min(...frames.map(f => f.w)) + " max=" + Math.max(...frames.map(f => f.w)) + "  (归一化 /128 = " + (Math.max(...frames.map(f => f.w)) / 128).toFixed(3) + ")");
// 逐帧 cy 的极值出现的帧号，核对是不是 0.6Hz 正弦
console.log("  前 30 帧 cy: " + frames.slice(0, 30).map(f => f.cy.toFixed(2)).join(" "));
// 是否整幅刚性平移：检查 bbox 高度是否恒定
const hs = frames.map(f => f.h);
console.log("  bbox 高度唯一值: " + JSON.stringify([...new Set(hs)].sort((a, b) => a - b)));
