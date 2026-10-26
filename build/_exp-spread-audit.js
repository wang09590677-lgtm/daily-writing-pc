// 审计：从**真实浏览器采集**的逐帧 series 里，直接算 detectReps / amplitude 看到的原始峰峰值。
// 只读 JSON，不开浏览器、不改任何生产代码。
// 关键：分辨「我的合成夹具」与「motion-browser-test.js 的 Y4M 夹具」是不是同一条信号量级。
const fs = require("fs");
const path = require("path");

function median(a) { const b = a.slice().sort((x, y) => x - y); const n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; }
function pct(a, p) { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((b.length - 1) * p)))]; }

// 与生产 detectReps 完全同构：在 t 处回看 seconds 秒，取该键的原始值数组，spread = max-min
function rollingSpread(series, key, seconds, rollEvery = 0.5) {
  const out = [];
  const key2 = key;
  for (let i = 0; i < series.length; i++) {
    const t = series[i].t;
    const from = t - seconds;
    const raw = [];
    for (let j = i; j >= 0; j--) { if (series[j].t < from) break; const v = series[j][key2]; if (isFinite(v)) raw.unshift(v); }
    if (raw.length < 10) continue;
    out.push({ t, spread: Math.max(...raw) - Math.min(...raw), n: raw.length });
  }
  return out;
}

for (const f of ["build/_exp-series.json", "build/_exp-series-jack.json"]) {
  const o = JSON.parse(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
  console.log("\n############ " + f + " ############");
  for (const id of Object.keys(o)) {
    const s = o[id].series || [];
    if (!s.length) continue;
    const key = (o[id].profile && o[id].profile.signal) || "centroidY";
    const ref = (o[id].profile && o[id].profile.expectedAmplitude) || 0.1;
    const hs = s.filter(r => isFinite(r.height)).map(r => r.height);
    const hMed = median(hs);
    const bodyScale = Math.min(1.5, Math.max(1.0, hMed / 0.6));
    const gate = ref * 0.5 * bodyScale;

    const sp35 = rollingSpread(s, key, 3.5).map(x => x.spread);   // detectReps 用的窗
    const sp6 = rollingSpread(s, key, 6).map(x => x.spread);      // amplitude() 用的窗
    const amp = sp6.map(r => Math.min(1.6, Math.max(0, r / ref)) / 1.6);

    console.log(
      `${id.padEnd(22)} key=${key.padEnd(9)} ref=${ref} hMed=${hMed.toFixed(3)} bodyScale=${bodyScale.toFixed(2)} gate=${gate.toFixed(4)}`);
    console.log(
      `   spread@3.5s (detectReps)  p10=${pct(sp35, 0.10).toFixed(4)} p50=${median(sp35).toFixed(4)} p90=${pct(sp35, 0.90).toFixed(4)} max=${Math.max(...sp35).toFixed(4)}`);
    console.log(
      `   spread@6s   (amplitude)   p50=${median(sp6).toFixed(4)}  → 幅度读数 p50=${(median(amp) * 100).toFixed(0)}%  p90=${(pct(amp, 0.9) * 100).toFixed(0)}%`);
  }
}

// 从回归日志的「幅度 %」反推 motion-browser-test.js Y4M 夹具的真实 range（amplitude 公式逆运算）
console.log("\n############ 反推：motion-browser-test.js 的 Y4M 夹具（真实浏览器链路）############");
console.log("amplitude() = clamp(range/ref,0,1.6)/1.6,  半蹲 ref=0.06");
for (const p of [0.14, 0.15, 0.16]) {
  const range = p * 1.6 * 0.06;
  console.log(`  幅度读数 ${(p * 100).toFixed(0)}%  →  range = ${(p * 1.6).toFixed(3)}×0.06 = ${range.toFixed(5)}  (≈ ${(range / 96 * 1000).toFixed(2)} 千分位画面高)`);
}
const hY4M = 0.66; // Y4M 人形 y 方向跨度 ≈63px/96
const bodyScaleY4M = Math.min(1.5, Math.max(1.0, hY4M / 0.6));
console.log(`  Y4M 人形高度≈${hY4M} → bodyScale=${bodyScaleY4M.toFixed(2)} → gate = 0.06×0.5×${bodyScaleY4M.toFixed(2)} = ${(0.06 * 0.5 * bodyScaleY4M).toFixed(4)}`);
console.log(`  若真实 range≈0.0144 → ${0.0144} < ${(0.06 * 0.5 * bodyScaleY4M).toFixed(4)}  ⇒ 被闸门挡掉（0 次）`);
