/* 候选修法验证：把 detrend 的"局部均值窗 win"从**最快拍速**改为**最慢拍速**派生，
 * 看能否把 2× 区挤出各动作的 tempoBand。
 *
 * 现状：win = clamp(round(fps*60/band[1]), 3, fps*1.5)   ← 用 band[1]（最快）
 * 候选：win' = round(fps*60/band[0])                      ← 用 band[0]（最慢），即 W ≈ 最慢一个周期
 * 候选2：win'' = round(fps*60/band[0]*1.25)               ← 再留 25% 余量
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取失败 " + a.slice(0, 25)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");

const FPS = 60, WIN_SECS = 3.5, TAIL_SECS = 0.35;
function counter(win, minGap) {
  const env = `${clampSrc}${meanSrc}${detrendSrc}${smoothSrc}
    return function (series, fps) {
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const tailN = Math.max(2, Math.round(fps * ${TAIL_SECS}));
      const winN = ${win}, gapN = ${minGap};
      let reps = 0, lastAt = -1, armed = false;
      for (let f = 0; f < series.length; f++) {
        const now = series[f].t, from = now - ${WIN_SECS};
        const raw = []; for (let i = f; i >= 0; i--) { if (series[i].t < from) break; raw.unshift(series[i].v); }
        if (raw.length < 10) continue;
        const d = smooth(detrend(raw, winN), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v*v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);
        for (let i = Math.max(0, d.length - tailN); i < d.length; i++) {
          const v = d[i];
          if (v < -k) armed = true;
          else if (v > k && armed) { if (lastAt < 0 || now - lastAt >= gapN) { reps += 1; lastAt = now; } armed = false; }
        }
      }
      return reps;
    };`;
  return new Function(env)();
}
const sine = (f, secs) => { const n = Math.round(secs*FPS), a = []; for (let i = 0; i < n; i++) a.push({ t: i/FPS, v: 0.1*Math.sin(2*Math.PI*f*i/FPS) }); return a; };
const SECS = 20;

// 全部 12 个 rep 动作真值（signal/band/minRepGap），来自 data/fitness-plan.js
const ACT = [
  ["半蹲热身", 15, 40, 0.9], ["开合跳", 40, 90, 0.45], ["跳绳", 60, 120, 0.3],
  ["徒手深蹲", 15, 45, 0.9], ["弓步蹲", 12, 36, 1.1], ["提踵", 20, 55, 0.7],
  ["臀桥", 15, 40, 1.0], ["死虫式", 15, 40, 1.1], ["仰卧举腿", 8, 25, 1.2],
  ["侧向跳", 40, 100, 0.45], ["波比跳", 12, 35, 1.4], ["登山跑", 10, 30, 1.2],
];
const cap = Math.round(FPS * 1.5);
console.log("每个动作在其 band 内取 5 个拍速，看比值范围（越接近 1.00 越好；>1.5 = 2× 多计）\n");
console.log("动作      band/min   现状win=60/B1    候选 win=60/B0    候选2 win=1.25*60/B0");
for (const [name, b0, b1, gap] of ACT) {
  const speeds = [b0, (b0+b1)/2, b1].map(x => x/60);   // Hz
  const variants = [
    Math.max(3, Math.min(cap, Math.round(FPS*60/b1))),
    Math.max(3, Math.min(cap, Math.round(FPS*60/b0))),
    Math.max(3, Math.min(cap, Math.round(FPS*60/b0*1.25))),
  ];
  const cols = variants.map(w => {
    const c = counter(w, gap);
    const rs = speeds.map(f => { const r = c(sine(f, SECS), FPS); return r/(f*SECS); });
    return `${Math.min(...rs).toFixed(2)}~${Math.max(...rs).toFixed(2)}`;
  });
  console.log(`${name.padEnd(9)} ${String(b0+"~"+b1).padEnd(10)} ${cols[0].padEnd(16)} ${cols[1].padEnd(16)} ${cols[2]}`);
}
console.log("\n注：cap =", cap, "帧 =", (cap/FPS).toFixed(2), "秒（现有上限 fps*1.5）");
