/* 决定性实验：深度桥到底有没有推出**有效**深度帧？
 *
 * 背景：app.js 弹"我先记一下房间的样子"的前提是
 *   motionDepth.stats().status === "open"   ← 只代表 WebSocket 连上了
 * 而引擎 structureWarm() 的推进条件是每帧
 *   valid（grid 里 d>0 的格数） ≥ PIX*0.05 = 6912*0.05 = 345
 *   且累计 stSamples ≥ 12 且 elapsedMs ≥ 2500ms 才 finalize。
 * 若深度帧的有效格一直 < 5%，stSamples 永远不涨 → 对话框永久卡住。
 * 本脚本直接连 8765 收若干帧，把 valid / 分辨率 / min-max 打出来。
 *
 * 用法：NODE_PATH=... node build/_dbg-depth-probe.js [收几帧]
 */
"use strict";
const path = require("path");
const WebSocket = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "ws"));

const URL = "ws://127.0.0.1:8765";
const WANT = Number(process.argv[2] || 20);
const PIX = 96 * 72;                    // 引擎采样网格
const NEED = Math.ceil(PIX * 0.05);     // 5% 闸门

const rows = [];
let hello = null, n = 0, t0 = 0;
const ws = new WebSocket(URL);
ws.binaryType = "arraybuffer";

const timer = setTimeout(() => {
  console.log("\n!! 5 秒内没收到足够帧，可能桥在跑但不出帧");
  finish();
}, 5000);

ws.on("open", () => { t0 = Date.now(); console.log("已连上 " + URL + "，收 " + WANT + " 帧…"); });
ws.on("error", e => { console.log("连接错误:", e && e.message); });
ws.on("close", () => { console.log("连接已关闭"); finish(); });

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    try {
      const m = JSON.parse(data.toString());
      hello = m;
      console.log("hello:", JSON.stringify(m));
    } catch (e) { console.log("非二进制消息:", data.toString().slice(0, 120)); }
    return;
  }
  const buf = Buffer.from(data);
  if (buf.length < 24) return;
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  const index = buf.readUInt32LE(8), valid = buf.readUInt32LE(12);
  const minMM = buf.readUInt32LE(16), maxMM = buf.readUInt32LE(20);
  const raw = buf.slice(24);
  const total = w * h;
  rows.push({ index, valid, w, h, minMM, maxMM, rawLen: raw.length });
  n++;
  if (n === 1) {
    console.log("首帧: " + w + "x" + h + " valid=" + valid + "/" + total +
      " (" + (valid / total * 100).toFixed(1) + "%) minMM=" + minMM + " maxMM=" + maxMM + " rawLen=" + raw.length);
  }
  if (n >= WANT) { clearTimeout(timer); finish(); }
});

function finish() {
  try { ws.close(); } catch (e) { }
  console.log("\n================= 结论 =================");
  if (!rows.length) {
    console.log("❌ 一帧深度数据都没收到 → 引擎 structureWarm() 里的");
    console.log("   `if (!g || g.length !== PIX) return;` 会每帧早退");
    console.log("   → stSamples 永远 0 → **对话框永久卡住**（正是用户看到的现象）");
    process.exit(0);
  }
  const valids = rows.map(r => r.valid);
  const avg = valids.reduce((a, b) => a + b, 0) / valids.length;
  const { w, h } = rows[0];
  const total = w * h;
  console.log("收到 " + rows.length + " 帧，耗时 " + (Date.now() - t0) + "ms");
  console.log("原始分辨率: " + w + "x" + h + " = " + total);
  console.log("valid 原始格数: 最小 " + Math.min(...valids) + " / 平均 " + avg.toFixed(0) + " / 最大 " + Math.max(...valids));
  console.log("valid 占比: " + (avg / total * 100).toFixed(2) + "%");
  console.log("minMM: " + Math.min(...rows.map(r => r.minMM)) + "  maxMM: " + Math.max(...rows.map(r => r.maxMM)));
  console.log("");
  console.log("引擎闸门: 降采样到 " + PIX + " 格后，有效格需 ≥ " + NEED + " (" + (NEED / PIX * 100) + "%) 才计入样本");
  const okRatio = avg / total;
  // 降采样是取块内代表值，比例大致保持
  const estGridValid = Math.round(PIX * okRatio);
  console.log("按同比例估算降采样后有效格 ≈ " + estGridValid + " / " + PIX);
  if (estGridValid >= NEED) {
    console.log("✅ 数据量够 → structureWarm 应该能推进（若仍卡住，问题在别处）");
  } else {
    console.log("❌ 有效格不足 " + NEED + " → structureWarm **每帧 return、stSamples 永远 0**");
    console.log("   → **对话框永久卡住**，这就是根因");
  }
  process.exit(0);
}
