/* 【causal 下的信号适配性】对真机 5 动作，把**每一个可用引擎信号**都过一遍 causal 计数器，
 * 看是否存在"换信号就把真值数回来"的可能。
 *
 * 背景（已定案的数学事实）：
 *   居中滑动均值对正弦信号是**同相**的 → y = x - MA(x) 可以互相抵消 →
 *     当 window ≪ 周期时振幅被压到只剩几个百分点 → 低频动作计 0（delay 的软肋）。
 *   后向滑动均值对正弦信号**滞后 ωW/2 相位** → 永远无法完全抵消 →
 *     振幅保留 ≈ 71%，且与原周期一致 → 无论窗长都能数对（causal 稳健性的根源）。
 *   这就是 causal 在 60 格合成上 0 超计 0 欠计、而 delay 在 cap 小的时候大面积欠计的原因。
 *
 * 所以 causal 是正确骨架。剩下的偏差（跳绳偏低）只能是**信号本身品质**问题。
 * 本脚本就用 causal 骨架逐个信号体检，量化"哪个信号能把这个动作数对"。
 *
 * 真值（原始 MediaPipe 关键点独立数出，见 _lead-jumprope-truth-kp.js）：
 *   开合跳 6~7（62/分）、跳绳 10（103/分）、徒手深蹲 鼻y/髋y 5、半蹲热身 、波比跳 2
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

const PREFIX = `function psum(a){const p=new Float64Array(a.length+1);for(let i=0;i<a.length;i++)p[i+1]=p[i]+a[i];return p;}
function rmean(p,a,b){if(b<=a)return 0;return (p[b]-p[a])/(b-a);}
function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}`;

function mkCausal(cap) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${PREFIX}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06));
    let reps=0,lastAt=-1,armed=false,scannedT=-1;
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const n=raw.length, B0=Math.max(8,band[0]);
      const win=Math.min(clamp(Math.round(fps*60/B0),3,Math.round(fps*${cap})), n);
      const g=std(raw)||1e-6, P=psum(raw);
      const det=new Float64Array(n);
      for(let i=0;i<n;i++){ const m=rmean(P,Math.max(0,i-win+1),i+1); det[i]=(raw[i]-m)/g; }
      const d=smooth(Array.from(det),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      for(let i=0;i<n;i++){ const v=d[i], t=rawT[i]; if(t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; lastAt=now; } armed=false; } }
      if(n) scannedT=Math.max(scannedT, rawT[n-1]);
    }
    return reps;
  };`)();
}

/* 峰值法参考（不依赖任何阈值自适应）：局部极大 */
function peakRef(vals, h, k) {
  const sm = vals.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - h); j <= Math.min(vals.length - 1, i + h); j++) { a += vals[j]; n++; } return a / n; });
  const m = sm.reduce((a, b) => a + b, 0) / sm.length;
  const sd = Math.sqrt(sm.reduce((a, b) => a + (b - m) ** 2, 0) / sm.length) || 1e-6;
  const times = [];
  for (let i = h; i < sm.length - h; i++) {
    if (sm[i] - m < k * sd) continue;
    let isMax = true;
    for (let j = i - h; j <= i + h; j++) if (j !== i && sm[j] > sm[i]) { isMax = false; break; }
    if (isMax) times.push(i);
  }
  const dd = [];
  for (const t of times) if (!dd.length || t - dd[dd.length - 1] > h) dd.push(t);
  const gaps = [];
  for (let i = 1; i < dd.length; i++) gaps.push((dd[i] - dd[i - 1]) / 60);
  gaps.sort((a, b) => a - b);
  return { n: dd.length, med: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0 };
}

const SIGS = ["motion","area","centroidX","centroidY","width","height","bottomL","bottomR","left","right","upper","lower"];
const TRUTH = { jumpingJacks: "6~7", squat: "5?", halfSquatWarm: "?", jumpRope: "10", burpee: "2" };

const F = mkCausal(1.2);
console.log("=".repeat(120));
console.log("【真机 5 动作 × 全部引擎信号】causal(cap1.2) 计数  (值) / 峰值法参考  [间隔]");
console.log("期望：计数 ≈ 真值。差得远的信号说明它对这个动作不敏感。");
console.log("-".repeat(120));
for (const k of Object.keys(R.acts)) {
  const a = R.acts[k], p = a.profile;
  const declared = a.signal;
  console.log(`\n■ ${a.cn}（声明信号 = ${declared}，band=[${p.tempoBand}]，ea=${p.expectedAmplitude}，gap=${p.minRepGap}，时长 ${a.secs}s，真值 ${TRUTH[k] || "?"}）`);
  const rows = [];
  for (const sig of SIGS) {
    if (!(sig in a.series[0])) continue;
    const s = a.series.map(x => ({ t: x.t, v: x[sig] }));
    const vals = s.map(x => x.v);
    const sp = Math.max(...vals) - Math.min(...vals);
    const c = F(s, 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap);
    const pk = peakRef(vals, 10, 0.4);
    rows.push({ sig, sp, c, pk });
  }
  rows.sort((x, y) => x.sig === declared ? -1 : y.sig === declared ? 1 : 0);
  console.log("   信号        峰峰      causal  cnt   峰值法cnt  峰值中位间隔");
  for (const r of rows) {
    const mark = r.sig === declared ? " ★" : "  ";
    console.log(`${mark}${r.sig.padEnd(11)} ${r.sp.toFixed(4).padStart(7)}  ${String(r.c).padStart(8)}   ${String(r.pk.n).padStart(8)}     ${r.pk.med.toFixed(3)}s`);
  }
}

console.log("\n" + "=".repeat(120));
console.log("【对照：不改信号时，三种实现的计数】");
console.log("-".repeat(120));
console.log("动作        声明信号   causal   （参考真值）");
for (const k of Object.keys(R.acts)) {
  const a = R.acts[k], p = a.profile;
  const s = a.series.map(x => ({ t: x.t, v: x[a.signal] }));
  console.log(`${a.cn.padEnd(11)} ${a.signal.padEnd(10)} ${String(F(s, 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap)).padStart(6)}    ${TRUTH[k] || "?"}`);
}
