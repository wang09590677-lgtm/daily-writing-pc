/* 独立复核「2× 多计」：不复用队友脚本，自己从 motion-engine.js 抠出
 * detrend / smooth / 迟滞过零 三个函数，在纯数学正弦上复算。
 * 目的：① 确认 2× 是否真的存在；② 找出触发区间；
 *       ③ 用 model 里的真实 win/minRepGap 算出每个计次动作的风险区。
 * 只读产品文件。 */
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");

function grab(a, b, label) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("抠取失败 " + label);
  return SRC.slice(i, j);
}
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)", "clamp");
const meanSrc = grab("function mean(arr)", "function std(arr)", "mean");
const detrendSrc = grab("function detrend(raw, win)", "function smooth(raw, k)", "detrend");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次", "smooth");
// 生产源码取证
if (!detrendSrc.includes("// 整段标准差")) console.log("!! detrend 源码与预期不符，请人工核对");

const FPS = 60;
const minRepGapSrc = 'const minGap = cfg("minRepGap") || 0.5;';
if (!SRC.includes(minRepGapSrc)) console.log("!! minGap 取值行与预期不符");

// 用生产源码搭一个"纯信号计次器"：完全复刻 detectReps 的核心循环，但不接姿态/掩码
function makeCounter(win, minGap) {
  const env = `
    ${clampSrc}
    ${meanSrc}
    ${detrendSrc}
    ${smoothSrc}
    return function (sig, fps) {
      let reps = 0, lastAt = -1, armed = false;
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const win = ${win};
      const minGapNow = ${minGap};
      const d = smooth(detrend(sig, win), smoothK);
      const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
      const k = Math.max(0.45, Math.min(2.2, rms * 0.85));
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (v < -k) armed = true;
        else if (v > k && armed) {
          const now = i / fps;
          if (lastAt < 0 || now - lastAt >= minGapNow) { reps += 1; lastAt = now; }
          armed = false;
        }
      }
      return reps;
    };`;
  return new Function(env)();
}

// 生成纯正弦（模拟"某个信号"在 20 秒里的波形）
function sine(freq, secs, amp) {
  const n = Math.round(secs * FPS);
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * (i / FPS));
  return a;
}

console.log("=== A. 纯数学复现：2× 到底存不存在（detrend win=30, minGap=0.3，=跳绳档）===");
console.log("物理Hz  周期s   win/周期   minGap下计次   minGap=0计次   比值(有/物理周期)");
const cnt = makeCounter(30, 0.3);
const cntNoGap = makeCounter(30, 0);
const SECS = 20;
for (const f of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.875, 0.9, 1.0, 1.2, 1.5, 1.667, 2.0, 2.5, 3.0]) {
  const sig = sine(f, SECS, 0.1);
  const r1 = cnt(sig, FPS), r2 = cntNoGap(sig, FPS);
  const expect = f * SECS;
  console.log(`${f.toFixed(3).padStart(6)}  ${(1/f).toFixed(3).padStart(6)}  ${(0.5/(1/f)).toFixed(3).padStart(8)}   ${String(r1).padStart(8)}   ${String(r2).padStart(8)}   ${(r1/expect).toFixed(2)}${r1/expect>1.6?" ★2×":""}`);
}

console.log("\n=== B. 用生产真值算每个计次动作的风险区 [0.44/win_sec, 1/(2·minGap)] ===");
console.log("win = clamp(round(fps*60/max(15,band[1])), 3, round(fps*1.5))，fps=60");
const REPS = [
  ["半蹲热身", "centroidY", 15, 40, 0.9, 0.06],
  ["开合跳", "width", 40, 90, 0.45, 0.18],
  ["跳绳", "height", 60, 120, 0.3, 0.05],
  ["徒手深蹲", "height", 15, 45, 0.9, 0.12],
  ["弓步蹲", "height", 12, 36, 1.1, 0.12],
  ["提踵", "height", 20, 55, 0.7, 0.045],
  ["臀桥", "height", 15, 40, 1.0, 0.08],
  ["死虫式", "centroidY", 15, 40, 1.1, 0.09],
  ["仰卧举腿", "centroidY", 8, 25, 1.2, 0.10],
  ["侧向跳", "width", 40, 100, 0.45, 0.18],
  ["波比跳", "height", 12, 35, 1.4, 0.16],
  ["line153", "height", 10, 30, 1.2, 0.06],
];
console.log("动作       band(/分)     win帧 win_sec   风险区(/分)        与band重叠       重叠占比");
for (const [name, sig, lo, hi, gap, ea] of REPS) {
  const win = Math.max(3, Math.min(90, Math.round(FPS * 60 / Math.max(15, hi))));
  const winSec = win / FPS;
  const zoneLo = 0.44 / winSec * 60, zoneHi = (1 / (2 * gap)) * 60;
  const ovLo = Math.max(lo, zoneLo), ovHi = Math.min(hi, zoneHi);
  const ov = Math.max(0, ovHi - ovLo);
  const bandW = hi - lo;
  const pct = bandW > 0 ? (ov / bandW * 100) : 0;
  const mark = ov <= 0 ? "安全" : (pct > 60 ? "★★大段命中" : (pct > 25 ? "★部分命中" : "擦边"));
  console.log(`${name.padEnd(9)} ${String(lo+"~"+hi).padEnd(11)} ${String(win).padStart(5)} ${winSec.toFixed(2).padStart(7)}   ${(zoneLo.toFixed(0)+"~"+zoneHi.toFixed(0)).padStart(11)}   ${(ov>0?(ovLo.toFixed(0)+"~"+ovHi.toFixed(0)):"—").padStart(11)}   ${(pct.toFixed(0)+"%").padStart(6)} ${mark}`);
}
