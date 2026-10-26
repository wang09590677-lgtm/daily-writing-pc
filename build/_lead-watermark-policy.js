/* 【水位线在闸门关闭时的行为 — 定论】
 *
 * 修复后的计次是"每个样本只判一次"：水位线之前每帧只判**最新到达的 1 个样本**
 * （窗口里其余样本早判过了）。水位线一旦在闸门关闭的帧上推进，就产生一个分支：
 *
 *   V1 不推进 —— 闸门关着的那些样本"还没判过"，闸门重开时**补判**（catch-up）
 *   V2 推进   —— 那些样本直接作废，闸门重开后从最新样本开始判
 *
 * 两者在之前的 6 卷测试上**完全一致**（因为测试里的静止段都 > 3.5s 窗口，
 * 老样本自然过期）。真正能分出高下的是**短暂停**：停顿短于 3.5s 窗口。
 * 三种现实情形：
 *   ① 中途歇 1.0s / 1.5s 再继续   ← 孩子喘一口气
 *   ② 中途一次"划水"（幅度掉到门限下）再恢复  ← 最常见的偷懒
 *   ③ 门限边缘抖动（幅度在门限上下抖）
 * 判据：计数不超额（真值 = 实际做满的次数），不漏掉恢复后的正常次数。
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const STD = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";

function mkFixed(advanceOnGate, catchup) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${STD}
return function(series,fps,gate,band,gap){
  const smoothK=Math.max(1,Math.round(fps*0.06));
  const win=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
  let reps=0,lastAt=-1,armed=false,scannedT=-1; const hits=[];
  for(let f=0;f<series.length;f++){
    const now=series[f].t,from=now-3.5;const raw=[],rawT=[];
    for(let i=f;i>=0;i--){if(series[i].t<from)break;raw.unshift(series[i].v);rawT.unshift(series[i].t);}
    if(raw.length<10)continue;
    const spread=Math.max(...raw)-Math.min(...raw);
    if(gate>0&&spread<gate){
      armed=false;
      if(${advanceOnGate}&&rawT.length)scannedT=Math.max(scannedT,rawT[rawT.length-1]);
      continue;
    }
    const n=raw.length;
    let gs=0;for(let i=0;i<n;i++)gs+=raw[i];const gm=gs/n;
    let gv=0;for(let i=0;i<n;i++)gv+=(raw[i]-gm)*(raw[i]-gm);
    const gstd=Math.sqrt(gv/n)||1e-6;
    const det=new Float64Array(n);let acc=0;
    for(let i=0;i<n;i++){acc+=raw[i];if(i>=win)acc-=raw[i-win];const len=i<win?i+1:win;det[i]=(raw[i]-acc/len)/gstd;}
    const d=smooth(Array.from(det),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1,k=clamp(rms*0.85,0.45,2.2);
    const lo = ${catchup} ? 0 : Math.max(0, n-1);
    for(let i=lo;i<n;i++){const t=rawT[i];if(t<=scannedT)continue;const v=d[i];
      if(v<-k)armed=true;else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;hits.push(+now.toFixed(2));lastAt=now;}armed=false;}}
    if(rawT.length)scannedT=Math.max(scannedT,rawT[n-1]);
  }
  return {reps,hits};
};`)();
}
const V1 = mkFixed(false, true);   // 不推进 + 补判
const V2 = mkFixed(true, true);    // 推进 + 补判
const V2b = mkFixed(true, false);  // 推进 + 不补判

const P = { ea: 0.18, band: [40, 90], gap: 0.45 };
const f = 60 / 60; // 60/分
const step = 1 / 60;
/* 段式造序列：[{secs, ampMul}]，基准幅度 ea*0.42 */
function build(segs, rate) {
  const fr = rate / 60, seg = []; let t = 0;
  for (const s of segs) {
    for (let x = 0; x < s.secs; x += step, t += step) seg.push({ t, v: (P.ea * 0.42 * s.ampMul) * Math.sin(2 * Math.PI * fr * t) + 0.0006 * Math.sin(2 * Math.PI * 7 * t) });
  }
  return seg;
}
const count = (segs, F, rate) => F(build(segs, rate), 60, P.ea * .5, P.band, P.gap).reps;

console.log("=".repeat(108));
console.log("【情形① 中途短暂停】做 8 次 → 歇 P 秒 → 再做 8 次  （真值 16）");
console.log("-".repeat(108));
console.log("停顿      V1不推进    V2推进     V2不补判    备注");
for (const pause of [0.5, 1.0, 1.5, 2.0, 3.0, 5.0]) {
  const segs = [{ secs: 8, ampMul: 1 }, { secs: pause, ampMul: 0.004 }, { secs: 8, ampMul: 1 }];
  const a = count(segs, V1, 60), b = count(segs, V2, 60), c = count(segs, V2b, 60);
  const tag = pause <= 3.5 ? "停顿 < 3.5s 窗口 ★" : "停顿 > 窗口（老样本自然过期）";
  console.log(`${pause.toFixed(1)}s      ${String(a).padStart(6)}     ${String(b).padStart(6)}     ${String(c).padStart(6)}    ${tag}`);
}
console.log("\n" + "=".repeat(108));
console.log("【情形② 中途划水一次】做 6 次 → 1 次幅度只有 30%（低于门限）→ 再做 6 次  （真值 13）");
console.log("-".repeat(108));
console.log("划水时长   V1不推进    V2推进     V2不补判");
for (const weak of [1.0, 1.5, 2.5, 4.0]) {
  const segs = [{ secs: 6, ampMul: 1 }, { secs: weak, ampMul: 0.3 }, { secs: 6.5, ampMul: 1 }];
  console.log(`${weak.toFixed(1)}s      ${String(count(segs, V1, 60)).padStart(6)}     ${String(count(segs, V2, 60)).padStart(6)}     ${String(count(segs, V2b, 60)).padStart(6)}`);
}
console.log("\n" + "=".repeat(108));
console.log("【情形③ 门限边缘抖动】幅度在 0.45~0.60 倍之间来回（真是满幅动作，但幅度不稳）");
console.log("-".repeat(108));
{
  const segs = []; for (let k = 0; k < 12; k++) segs.push({ secs: 1.0, ampMul: k % 2 ? 0.5 : 0.85 });
  console.log(`V1不推进=${count(segs, V1, 60)}  V2推进=${count(segs, V2, 60)}  V2不补判=${count(segs, V2b, 60)}   （12 秒 60/分 → 真值约 12）`);
}
console.log("\n" + "=".repeat(108));
console.log("【回归确认】静止噪声 + 真实小幅（V1/V2 都必须和之前一致）");
console.log("-".repeat(108));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
for (const k of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m"]) {
  const e = EXP[k], p = e.profile;
  const s = e.series.map(x => ({ t: x.t, v: x[p.signal] }));
  console.log(`${k.padEnd(15)} V1=${V1(s,60,p.expectedAmplitude*.5,p.tempoBand,p.minRepGap).reps}  V2=${V2(s,60,p.expectedAmplitude*.5,p.tempoBand,p.minRepGap).reps}  V2b=${V2b(s,60,p.expectedAmplitude*.5,p.tempoBand,p.minRepGap).reps}`);
}
