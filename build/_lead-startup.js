/* 【启动瞬态量化】孩子"站定一会儿 → 开始做 N 次 → 停下"时，各实现能数出几次？
 *
 * 这是本次修复唯一还没量化的风险点：
 *   因果（后向）去趋势在**动作刚起步**时，滑动均值还在被前面的静止段拉着，
 *   det 的形状与稳态不同，可能吃掉第一次动作。
 *   而居中窗去趋势不存在这个"起点"，但代价是 2× 与慢速黑洞。
 *
 * 真值明确：做了 N 次就该数 N 次。测 N = 2/3/5/8/10/15，
 * 节奏取各动作 band 的中速（现实中最常见），前置静止 3 秒。
 * 另测"立刻开始"（无前置静止）——这是孩子点完开始就动的真实情形。
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const PLAN = fs.readFileSync(path.join(ROOT, "data", "fitness-plan.js"), "utf8");
const ACTIONS = [];
{ const idRe = /^\s{2}(\w+):\s*\{/gm; const ids = []; let mm;
  while ((mm = idRe.exec(PLAN))) ids.push({ id: mm[1], at: mm.index });
  for (let k = 0; k < ids.length; k++) { const seg = PLAN.slice(ids[k].at, k + 1 < ids.length ? ids[k + 1].at : PLAN.length);
    const mo = seg.match(/motion:\s*\{([^}]*)\}/); if (!mo) continue; const blk = mo[1];
    if (!/mode:\s*"rep"/.test(blk)) continue;
    const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || ids[k].id;
    const sig = (blk.match(/signal:\s*"(\w+)"/) || [])[1];
    const band = (blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/) || []);
    const gap = parseFloat((blk.match(/minRepGap:\s*([\d.]+)/) || [])[1]);
    const ea = parseFloat((blk.match(/expectedAmplitude:\s*([\d.]+)/) || [])[1]);
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea }); } }

const STD = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";

/* 现状：居中 detrend + 尾部重扫 */
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
  for(let f=0;f<series.length;f++){
    const now=series[f].t,from=now-3.5;const raw=[];
    for(let i=f;i>=0;i--){if(series[i].t<from)break;raw.unshift(series[i].v);}
    if(raw.length<10)continue;
    const spread=Math.max(...raw)-Math.min(...raw);
    if(gate>0&&spread<gate){armed=false;continue;}
    const d=smooth(detrend(raw,win),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1,k=clamp(rms*0.85,0.45,2.2);
    for(let i=Math.max(0,d.length-tailN);i<d.length;i++){const v=d[i];
      if(v<-k)armed=true;else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}
  }
  return reps;
};`)();

/* 修复版：因果 detrend + 水位线 oneshot */
function mkFixed(seedEdge) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${STD}
return function(series,fps,gate,band,gap){
  const smoothK=Math.max(1,Math.round(fps*0.06));
  const win=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
  const SEED=${seedEdge};
  let reps=0,lastAt=-1,armed=false,scannedT=-1;
  for(let f=0;f<series.length;f++){
    const now=series[f].t,from=now-3.5;const raw=[],rawT=[];
    for(let i=f;i>=0;i--){if(series[i].t<from)break;raw.unshift(series[i].v);rawT.unshift(series[i].t);}
    if(raw.length<10)continue;
    const spread=Math.max(...raw)-Math.min(...raw);
    if(gate>0&&spread<gate){armed=false;continue;}
    const n=raw.length;
    let gs=0;for(let i=0;i<n;i++)gs+=raw[i];const gm=gs/n;
    let gv=0;for(let i=0;i<n;i++)gv+=(raw[i]-gm)*(raw[i]-gm);
    const gstd=Math.sqrt(gv/n)||1e-6;
    const det=new Float64Array(n);
    if(SEED){
      // 边缘延拓：前 win 个样本的"窗"用 raw[0] 补足，消除起步时的均值偏差
      let acc=0;
      for(let i=0;i<n;i++){
        acc+=raw[i];
        if(i>=win)acc-=raw[i-win];
        let len, mean;
        if(i<win-1){ len=win; mean=(acc+(win-1-i)*raw[0])/win; }
        else { len=win; mean=acc/win; }
        det[i]=(raw[i]-mean)/gstd;
      }
    } else {
      let acc=0;
      for(let i=0;i<n;i++){acc+=raw[i];if(i>=win)acc-=raw[i-win];const len=i<win?i+1:win;det[i]=(raw[i]-acc/len)/gstd;}
    }
    const d=smooth(Array.from(det),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1,k=clamp(rms*0.85,0.45,2.2);
    for(let i=0;i<n;i++){const t=rawT[i];if(t<=scannedT)continue;const v=d[i];
      if(v<-k)armed=true;else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}
    if(rawT.length)scannedT=Math.max(scannedT,rawT[n-1]);
  }
  return reps;
};`)();
}
const FIX = mkFixed(false), FIXSEED = mkFixed(true);

/* 造序列：prefix 秒静止（幅度 0.0006 = 摄像头噪声地板）+ N 次正弦 + suffix 秒静止 */
function make(rate, N, prefix, ea) {
  const f = rate / 60, per = 1 / f, seg = []; let t = 0;
  const step = 1 / 60;
  for (let s = 0; s < prefix; s += step, t += step) seg.push({ t, v: 0.0006 * Math.sin(2 * Math.PI * 3 * t) });
  for (let s = 0; s < N * per; s += step, t += step) seg.push({ t, v: (ea * 0.42) * Math.sin(2 * Math.PI * f * (t)) });
  for (let s = 0; s < 2; s += step, t += step) seg.push({ t, v: 0.0006 * Math.sin(2 * Math.PI * 3 * t) });
  return seg;
}

console.log("=".repeat(112));
console.log("【启动瞬态】前置静止 3s → 做 N 次 → 停。中速节奏。单元格 = 数出次数(真值)");
console.log("-".repeat(112));
for (const A of ACTIONS) {
  if (!["jumpingJacks", "jumpRope", "squat", "halfSquatWarm", "burpee", "calfRaise", "lunge"].includes(A.id)) continue;
  const rate = Math.round((A.band[0] + A.band[1]) / 2);
  const row = [];
  for (const N of [3, 5, 10]) {
    const s = make(rate, N, 3, A.ea);
    const p = PROD(s, 60, A.ea * .5, A.band, A.gap);
    const x = FIX(s, 60, A.ea * .5, A.band, A.gap);
    const y = FIXSEED(s, 60, A.ea * .5, A.band, A.gap);
    row.push(`N=${N}: 现状${String(p).padStart(2)} 修复${String(x).padStart(2)} 修复+延拓${String(y).padStart(2)}(${N})`);
  }
  console.log(`${A.cn.padEnd(10)} ${rate}/分  ` + row.join("  "));
}
console.log("\n" + "=".repeat(112));
console.log("【立刻开始】无前置静止（孩子点完开始就动）");
console.log("-".repeat(112));
for (const A of ACTIONS) {
  if (!["jumpingJacks", "jumpRope", "squat", "halfSquatWarm", "burpee"].includes(A.id)) continue;
  const rate = Math.round((A.band[0] + A.band[1]) / 2);
  const row = [];
  for (const N of [3, 5, 10]) {
    const s = make(rate, N, 0, A.ea);
    const p = PROD(s, 60, A.ea * .5, A.band, A.gap);
    const x = FIX(s, 60, A.ea * .5, A.band, A.gap);
    const y = FIXSEED(s, 60, A.ea * .5, A.band, A.gap);
    row.push(`N=${N}: 现状${String(p).padStart(2)} 修复${String(x).padStart(2)} 修复+延拓${String(y).padStart(2)}(${N})`);
  }
  console.log(`${A.cn.padEnd(10)} ${rate}/分  ` + row.join("  "));
}
