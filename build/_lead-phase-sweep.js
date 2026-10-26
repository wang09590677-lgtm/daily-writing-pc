/* 【启动相位扫描】上一脚本"无前置静止"总丢 1 次，但这可能是**相位混淆**：
 * make() 里正弦用的是全局时间 t，动作起始相位随 prefix 变化。
 * 必须把相位单独扫一遍，才能判断"丢 1 次"是真实的**起步滞后**，还是某个特定相位的巧合。
 *
 * 做法：固定 N 次、固定节奏，只把起始相位 φ 从 0 扫到 2π（12 个点），看计数分布。
 *   · 若 12 个相位全部给出 N-1 → 系统性起步滞后（≈半个周期）
 *   · 若在 N-1 与 N 之间摆动 → 只是相位巧合，实际无偏
 * 同时扫"前置静止 1s / 3s"两种，对齐真实自动开练（3-2-1 口令 ≈ 3s 静止）。
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

const PROD = new Function(`${clampSrc}${meanSrc}${smoothSrc}${STD}
function detrend(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2));
  let gs=0;for(let i=0;i<raw.length;i++)gs+=raw[i];const gm=gs/raw.length;
  let gv=0;for(let i=0;i<raw.length;i++)gv+=(raw[i]-gm)*(raw[i]-gm);
  const gstd=Math.sqrt(gv/raw.length)||1e-6;
  for(let i=0;i<raw.length;i++){const a=Math.max(0,i-half),b=Math.min(raw.length,i+half+1);let m=0;for(let j=a;j<b;j++)m+=raw[j];m/=(b-a);out[i]=(raw[i]-m)/gstd;}return out;}
return function(series,fps,gate,band,gap){
  const smoothK=Math.max(1,Math.round(fps*0.06));
  const win=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
  const tailN=Math.max(2,Math.round(fps*0.35));
  let reps=0,lastAt=-1,armed=false;
  for(let f=0;f<series.length;f++){const now=series[f].t,from=now-3.5;const raw=[];
    for(let i=f;i>=0;i--){if(series[i].t<from)break;raw.unshift(series[i].v);}
    if(raw.length<10)continue;
    const spread=Math.max(...raw)-Math.min(...raw);
    if(gate>0&&spread<gate){armed=false;continue;}
    const d=smooth(detrend(raw,win),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1,k=clamp(rms*0.85,0.45,2.2);
    for(let i=Math.max(0,d.length-tailN);i<d.length;i++){const v=d[i];
      if(v<-k)armed=true;else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}}
  return reps;};`)();

const FIX = new Function(`${clampSrc}${meanSrc}${smoothSrc}${STD}
return function(series,fps,gate,band,gap){
  const smoothK=Math.max(1,Math.round(fps*0.06));
  const win=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
  let reps=0,lastAt=-1,armed=false,scannedT=-1;
  for(let f=0;f<series.length;f++){const now=series[f].t,from=now-3.5;const raw=[],rawT=[];
    for(let i=f;i>=0;i--){if(series[i].t<from)break;raw.unshift(series[i].v);rawT.unshift(series[i].t);}
    if(raw.length<10)continue;
    const spread=Math.max(...raw)-Math.min(...raw);
    if(gate>0&&spread<gate){armed=false;continue;}
    const n=raw.length;
    let gs=0;for(let i=0;i<n;i++)gs+=raw[i];const gm=gs/n;
    let gv=0;for(let i=0;i<n;i++)gv+=(raw[i]-gm)*(raw[i]-gm);
    const gstd=Math.sqrt(gv/n)||1e-6;
    const det=new Float64Array(n);let acc=0;
    for(let i=0;i<n;i++){acc+=raw[i];if(i>=win)acc-=raw[i-win];const len=i<win?i+1:win;det[i]=(raw[i]-acc/len)/gstd;}
    const d=smooth(Array.from(det),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1;const k=clamp(rms*0.85,0.45,2.2);
    for(let i=0;i<n;i++){const t=rawT[i];if(t<=scannedT)continue;const v=d[i];
      if(v<-k)armed=true;else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}
    if(rawT.length)scannedT=Math.max(scannedT,rawT[n-1]);}
  return reps;};`)();

const CASES = [
  { cn: "半蹲热身", ea: 0.06, band: [15, 40], gap: 0.9, rate: 28 },
  { cn: "开合跳", ea: 0.18, band: [40, 90], gap: 0.45, rate: 65 },
  { cn: "跳绳", ea: 0.05, band: [60, 120], gap: 0.3, rate: 90 },
  { cn: "徒手深蹲", ea: 0.12, band: [15, 45], gap: 0.9, rate: 30 },
  { cn: "波比跳", ea: 0.16, band: [12, 35], gap: 1.4, rate: 24 }
];

function make(rate, N, prefix, ea, phase) {
  const f = rate / 60, step = 1 / 60, seg = []; let t = 0;
  for (let s = 0; s < prefix; s += step, t += step) seg.push({ t, v: 0.0006 * Math.sin(2 * Math.PI * 3 * t) });
  for (let s = 0; s < N / f; s += step, t += step) seg.push({ t, v: ea * 0.42 * Math.sin(2 * Math.PI * f * s + phase) });
  for (let s = 0; s < 2; s += step, t += step) seg.push({ t, v: 0.0006 * Math.sin(2 * Math.PI * 3 * t) });
  return seg;
}

for (const prefix of [0, 1, 3]) {
  console.log("=".repeat(104));
  console.log(`【前置静止 ${prefix}s】12 个起始相位扫描（N=6，真值 6）—— 现状 vs 修复`);
  console.log("-".repeat(104));
  console.log("动作      节奏    现状计数(12相位)                修复计数(12相位)               修复 均值/极差");
  for (const C of CASES) {
    const pp = [], ff = [];
    for (let i = 0; i < 12; i++) {
      const s = make(C.rate, 6, prefix, C.ea, (2 * Math.PI * i) / 12);
      pp.push(PROD(s, 60, C.ea * .5, C.band, C.gap));
      ff.push(FIX(s, 60, C.ea * .5, C.band, C.gap));
    }
    const fm = ff.reduce((a, b) => a + b, 0) / ff.length;
    const pm = pp.reduce((a, b) => a + b, 0) / pp.length;
    console.log(`${C.cn.padEnd(9)} ${String(C.rate).padStart(3)}/分  现状均${pm.toFixed(2)} [${Math.min(...pp)}..${Math.max(...pp)}]`.padEnd(60) + `修复均${fm.toFixed(2)} [${Math.min(...ff)}..${Math.max(...ff)}]`);
  }
}
