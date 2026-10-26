/* 直连深度桥 ws://127.0.0.1:8765，量 6 秒内到底有没有帧。
 *
 * 为什么需要这个探针：`accept-real-room` 曾出现"桥在跑但不出帧"的状态 ——
 * 表现为 app 侧 `stats()` = `{status:"open", frameIndex:0}`（WebSocket 连上了，
 * 但一帧数据都没推）。这与"桥没启动"（status≠open）是**两种完全不同的故障**，
 * 光看 app 的 chip 文案分不出来。本探针直接量协议层。
 *
 * 帧格式（见 depth-link.js:101-112）：小端 uint32 ×6 = w,h,idx,valid,minMM,maxMM，
 * 其后是 w*h 个 uint16 深度值（单位 mm）。
 *
 * 用法：node build/_probe-depth-bridge.js [ws://127.0.0.1:8765] [毫秒]
 */
const path = require("path");
const WebSocket = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "ws"));

const URL = process.argv[2] || "ws://127.0.0.1:8765";
const DUR = parseInt(process.argv[3] || "6000", 10);

let bin = 0, text = 0, bytes = 0, first = null, lastIdx = null, nonZeroGrids = 0;
const t0 = Date.now();

const ws = new WebSocket(URL);
ws.on("open", () => console.log("✔ WebSocket 已连接  " + URL));
ws.on("error", e => console.log("✘ 连接错误: " + e.message));

ws.on("message", (d, isBinary) => {
  if (!isBinary) {
    text++;
    if (text <= 3) console.log("  文本帧: " + String(d).slice(0, 1500));
    return;
  }
  bin++; bytes += d.length;
  if (d.length >= 24) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true), idx = dv.getUint32(8, true);
    const v = dv.getUint32(12, true), mn = dv.getUint32(16, true), mx = dv.getUint32(20, true);
    if (!first) first = { w, h, idx, v, mn, mx, len: d.length };
    lastIdx = idx;
    if (v > 0) nonZeroGrids++;
    if (bin === 2) {
      console.log(`  第 2 帧: ${w}×${h}  idx=${idx}  有效=${v}  范围=${mn}~${mx}mm  ${d.length} 字节`);
    }
  }
});

ws.on("close", () => console.log("  连接已关闭"));

setTimeout(() => {
  const dt = (Date.now() - t0) / 1000;
  console.log("\n================ 结果 ================");
  console.log(`  时长            ${dt.toFixed(1)} s`);
  console.log(`  二进制帧        ${bin}   (≈ ${(bin / dt).toFixed(1)} fps)`);
  console.log(`  文本帧          ${text}`);
  console.log(`  收到字节        ${bytes}`);
  if (first) {
    console.log(`  首帧头          ${first.w}×${first.h}  idx=${first.idx}  有效格=${first.v}  ${first.mn}~${first.mx}mm`);
    console.log(`  末帧 idx        ${lastIdx}`);
    console.log(`  有效格>0 的帧   ${nonZeroGrids}/${bin}`);
    console.log("\n  ⇒ 判定：桥在推数据，深度管线可用。");
  } else if (ws.readyState === 1) {
    console.log("\n  ⇒ 判定：**WebSocket 连上了但一帧都没推** —— 桥进程活着，但它的取流循环已经坏了。");
    console.log("     看上面 hello 里的 note 字段，它会直接给出内部异常。");
    console.log("     2026-10-09 实测过这一种：note = `异常: [WinError 206] 文件名或扩展名太长。:");
    console.log("     '…\\tools\\orbbec\\runtime'`，而这个**长驻**实例坏了之后**永远不会自愈**");
    console.log("     （每 1.5 秒重试、每次都同样失败）。");
    console.log("     ★ 同一天用 `--port 8799` **新起一个**实例则完全正常（13.8 fps / 约 258k 有效像素），");
    console.log("       所以**硬件和桥代码都是好的，只是那个长驻进程变馊了** → 关掉重开即可。");
    console.log("     ⚠️ app 侧只会显示“深度：未开启”，**分不出**这一种和“桥没启动”。");
  } else {
    console.log("\n  ⇒ 判定：连不上（桥没启动）。app 侧同样是“深度：未开启”。");
  }
  process.exit(0);
}, DUR);
