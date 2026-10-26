/* 【最小改动版验证】只改两处，其余一律保持现状：
 *   改动1  detrend()：居中均值 → **后向（因果）均值**
 *   改动2  扫描循环：每帧重扫尾部 21 帧 → **按序号水位线每样本只判一次**
 *   win 公式【不动】：win = clamp(fps*60/band[1], 3, fps*1.5)
 *
 * 为什么要改成因果均值 —— 这是本次修复的数学根据：
 *   居中窗的 det[i] 依赖 raw[i+half]，**样本 i 到达时 det[i] 还没定型**，
 *   要等半个窗之后才最终确定。所以"每帧重扫尾部"其实是在拿**已经变过的值**
 *   重新判定同一拍。更糟的是：对周期 T 的正弦，居中滑动均值与信号**同相**，
 *   当 win ≪ T 时两者几乎完全抵消 → 信号被压成一条细线 → log 出 k≈0.45 的
 *   地板，噪声级起伏就来回穿阈 → 一次动作数成两次。
 *   因果窗的均值滞后 ωW/2 相位，**永远无法完全抵消**（振幅保留约 71%），
 *   且 det[i] 只用 raw[≤i]，**样本一到就定型、永不再变**。
 *   于是"每样本只判一次"在数学上是**无损**的，不是近似。
 *
 * 三卷 + 启停瞬态，只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
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

/* ── 现状：居中 detrend + 尾部重扫 ── */
const PROD = new Function(`${clampSrc}${meanSrc}${smoothSrc}
function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}
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
    const start=Math.max(0,d.length-tailN);
    for(let i=start;i<d.length;i++){const v=d[i];
      if(v<-k)armed=true;
      else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}
  }
  return reps;
};`)();

/* ── 最小改动版：因果 detrend + 水位线 oneshot（win 公式不动） ── */
const FIXED = new Function(`${clampSrc}${meanSrc}${smoothSrc}
function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}
return function(series,fps,gate,band,gap){
  const smoothK=Math.max(1,Math.round(fps*0.06));
  const win=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
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
    // 因果（后向）均值：滚动和 O(n)，det[i] 只依赖 raw[≤i] → 一到即定型
    const det=new Float64Array(n);let acc=0;
    for(let i=0;i<n;i++){acc+=raw[i];if(i>=win)acc-=raw[i-win];const len=i<win?i+1:win;det[i]=(raw[i]-acc/len)/gstd;}
    const d=smooth(Array.from(det),smoothK);
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1,k=clamp(rms*0.85,0.45,2.2);
    // 每样本只判一次：t<=scannedT 的样本已经被判过，跳过
    for(let i=0;i<n;i++){const t=rawT[i];if(t<=scannedT)continue;const v=d[i];
      if(v<-k)armed=true;
      else if(v>k&&armed){if(lastAt<0||now-lastAt>=gap){reps++;lastAt=now;}armed=false;}}
    if(rawT.length)scannedT=Math.max(scannedT,rawT[n-1]);
  }
  return reps;
};`)();

const ratesOf=A=>[A.band[0],Math.round(A.band[0]+(A.band[1]-A.band[0])*.25),Math.round((A.band[0]+A.band[1])/2),Math.round(A.band[0]+(A.band[1]-A.band[0])*.75),A.band[1]];
const sineDs=(f,s)=>{const a=[];for(let i=0;i<s*60;i++)a.push({t:i/60,v:.15*Math.sin(2*Math.PI*f*i/60)});return a;};

console.log("=".repeat(104));
console.log("【卷1】合成栅格 60 格（12 动作 × band 内 5 拍速点，各 60 秒）");
console.log("-".repeat(104));
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const c = []; let o = [], u = [];
  for (const A of ACTIONS) for (const r of ratesOf(A)) { const f = r / 60, x = F(sineDs(f, 60), 60, A.ea * .5, A.band, A.gap) / (f * 60);
    c.push(x); if (x > 1.4) o.push(`${A.cn}@${r}=${x.toFixed(2)}`); if (x < .7) u.push(`${A.cn}@${r}=${x.toFixed(2)}`); }
  const m = c.reduce((a, b) => a + b, 0) / c.length;
  console.log(`${nm.padEnd(12)} 平均=${m.toFixed(3)} 标准差=${Math.sqrt(c.reduce((a,b)=>a+(b-m)**2,0)/c.length).toFixed(3)} 最小=${Math.min(...c).toFixed(2)} 最大=${Math.max(...c).toFixed(2)} 超计=${o.length} 欠计=${u.length}`);
  if (o.length) console.log("   超计: " + o.slice(0, 6).join("  "));
  if (u.length) console.log("   欠计: " + u.slice(0, 6).join("  "));
}
console.log("\n【卷2】真机 5 动作");
console.log("-".repeat(104));
console.log("实现            开合跳  徒手深蹲 半蹲热身  跳绳   波比跳   （真值 6~7 / 5? / ? / 10 / 2）");
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const o = [];
  for (const k of ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"]) { const a = R.acts[k], p = a.profile;
    o.push(String(F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap)).padStart(6)); }
  console.log(`${nm.padEnd(12)} ${o.join(" ")}`);
}
console.log("\n【卷3】静止/噪声（必须全 0）");
console.log("-".repeat(104));
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const o = [];
  for (const k of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m"]) { const e = EXP[k], p = e.profile;
    o.push(k.split("_")[0] + "=" + F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap)); }
  console.log(`${nm.padEnd(12)} ${o.join("  ")}`);
}
console.log("\n【卷4】真实动作小幅/远距离");
console.log("-".repeat(104));
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const o = [];
  for (const k of ["D_jack08_2m", "F_jack08_4m", "E_squat06", "H_squat06_4m"]) { const e = EXP[k]; if (!e) continue; const p = e.profile;
    o.push(k + "=" + F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap)); }
  console.log(`${nm.padEnd(12)} ${o.join("  ")}`);
}
console.log("\n【卷5】启停瞬态：做5秒 → 站定8秒 → 再做5秒 → …（共 3 段动作）");
console.log("-".repeat(104));
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const out = [];
  for (const rate of [40, 60, 90]) {
    const f = rate / 60, seg = []; let t = 0;
    const push = (secs, amp) => { for (let i = 0; i < secs * 60; i++, t++) seg.push({ t: t / 60, v: amp * Math.sin(2 * Math.PI * f * t / 60) }); };
    push(5, .15); push(8, .0008); push(5, .15); push(8, .0008); push(5, .15);
    out.push(`${rate}/分 → ${F(seg, 60, .09, [40, 90], .45)}（真值 ${Math.round(15 * rate / 60)}）`);
  }
  console.log(`${nm.padEnd(12)} ${out.join("   ")}`);
}
console.log("\n【卷6】慢速黑洞检查：周期远大于窗长（跳绳 band[0]=60 → win≈0.67s，但人做 20/分）");
console.log("-".repeat(104));
for (const [nm, F] of [["prod 现状", PROD], ["最小改动版", FIXED]]) {
  const out = [];
  for (const rate of [10, 20, 30]) { const f = rate / 60; out.push(`${rate}/分(周期${(60/rate).toFixed(1)}s) → ${F(sineDs(f, 120), 60, .09, [40, 90], .45)}（真值 ${Math.round(120 * f)}）`); }
  console.log(`${nm.padEnd(12)} ${out.join("   ")}`);
}
