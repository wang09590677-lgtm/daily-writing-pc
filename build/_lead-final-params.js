/* 【终审定参】修法定型 = 每样本只判一次 + 延迟半窗（消 2×）。
 * 剩下唯一问题：**窗长规则**（决定极慢端会不会漏计、以及 UI 延迟多少）。
 *
 * 已确认：win 由 band[1]（最快拍速）推导 → 慢速端 win << 周期 → 居中窗去趋势
 *        把信号削平 → 该点计 0（黑洞）。所以窗长必须向"最慢拍速"要。
 * 候选：
 *   B1 : win = clamp(fps*60/band[1], 3, fps*1.5)   ← 现状
 *   B0 : win = clamp(fps*60/band[0], 3, fps*3.5)   ← 按最慢拍速（=1 个最慢周期）
 *   H2 : win = clamp(fps*60/band[0], 3, fps*2.0)   ← 折中（延迟≤1s）
 *   HY : win = clamp(fps*60/band[0], 3, fps*3.5)，但再乘 0.75 系数
 *
 * 三张卷：① 全 12 动作 × band 内 5 点；② 真机 5 动作；③ 静止/噪声。
 * 只读产品文件 + _realseries.json + _exp-series.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const PLAN = fs.readFileSync(path.join(__dirname, "..", "data", "fitness-plan.js"), "utf8");
const ACTIONS = [];
{
  const idRe = /^\s{2}(\w+):\s*\{/gm; const ids = []; let mm;
  while ((mm = idRe.exec(PLAN))) ids.push({ id: mm[1], at: mm.index });
  for (let k = 0; k < ids.length; k++) {
    const seg = PLAN.slice(ids[k].at, k + 1 < ids.length ? ids[k + 1].at : PLAN.length);
    const mo = seg.match(/motion:\s*\{([^}]*)\}/); if (!mo) continue; const blk = mo[1];
    if (!/mode:\s*"rep"/.test(blk)) continue;
    const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || ids[k].id;
    const sig = (blk.match(/signal:\s*"(\w+)"/) || [])[1];
    const band = (blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/) || []);
    const gap = parseFloat((blk.match(/minRepGap:\s*([\d.]+)/) || [])[1]);
    const ea = parseFloat((blk.match(/expectedAmplitude:\s*([\d.]+)/) || [])[1]);
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea });
  }
}
// scan=prod 复刻现状；否则 oneshot，winRule 决定窗长
function mk(scan, winRule) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const SCAN="${scan}", WR="${winRule}", B0=band[0], B1=band[1];
    const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false,doneT=-1; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      let win;
      if(WR==="B1") win=clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
      else if(WR==="B0") win=clamp(Math.round(fps*60/Math.max(8,B0)),3,Math.round(fps*3.5));
      else win=clamp(Math.round(fps*60/Math.max(8,B0)),3,Math.round(fps*2.0));
      win=Math.min(win, raw.length);
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      let range;
      if(SCAN==="prod"){ range=[Math.max(0,d.length-tailN), d.length]; }
      else { const h=Math.floor(win/2); range=[Math.max(0,d.length-1-h), Math.max(0,d.length-h)]; }
      for(let i=range[0];i<range[1];i++){
        const v=d[i]; const t=rawT[i];
        if(SCAN!=="prod" && t<=doneT) continue;
        if(SCAN!=="prod") doneT=t;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(3)); lastAt=now; } armed=false; }
      }
    }
    return {reps,hits};
  };`)();
}
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
const fmt = (r, e) => { const x = r / e; return `${String(r).padStart(4)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`; };
const CANDS = [["现状 prod", "prod", "B1"], ["oneshot+B1", "one", "B1"], ["oneshot+H2", "one", "H2"], ["oneshot+B0", "one", "B0"]];
const DUR = 90;

console.log("############ 卷1：全 12 动作 × band 内 5 点（期望比值≈1.00）############\n");
for (const [lb, scan, wr] of CANDS) {
  const F = mk(scan, wr);
  let worst = 0, nOver = 0, nUnder = 0, cells = [];
  for (const A of ACTIONS) {
    const rates = [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.75), A.band[1]];
    for (const rate of rates) {
      const f = rate / 60, s = sineDs(f, DUR), e = f * DUR;
      const r = F(s, 60, A.ea * 0.5, A.band, A.gap).reps, x = r / e;
      if (x > worst) worst = x;
      if (x > 1.4) nOver++; if (x < 0.7) nUnder++;
      cells.push(x);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  const sd = Math.sqrt(cells.reduce((a, b) => a + (b - mean) * (b - mean), 0) / cells.length);
  console.log(`【${lb}】平均比值=${mean.toFixed(3)}  标准差=${sd.toFixed(3)}  最大=${worst.toFixed(2)}  超计格=${nOver}  欠计格=${nUnder}  (共 ${cells.length} 格)`);
}
console.log("\n--- 逐动作明细（oneshot+H2 vs 现状）---");
{
  const Fp = mk("prod", "B1"), Fo = mk("one", "H2");
  console.log("动作          band   " + ["b0", "b0+¼", "中", "b0+¾", "b1"].map(s => s.padStart(12)).join(""));
  for (const A of ACTIONS) {
    const rates = [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.75), A.band[1]];
    const cells = rates.map(rate => { const f = rate / 60, s = sineDs(f, DUR), e = f * DUR; return `${fmt(Fp(s, 60, A.ea * .5, A.band, A.gap).reps, e)}|${fmt(Fo(s, 60, A.ea * .5, A.band, A.gap).reps, e)}`; });
    console.log(`${A.cn.padEnd(11)} ${String(A.band[0] + "-" + A.band[1]).padEnd(7)} ${cells.join(" ")}`);
  }
}

console.log("\n############ 卷2：真机 5 动作（参考真值 开合跳6~7 跳绳10）############");
console.log("实现        开合跳  徒手深蹲 半蹲热身  跳绳   波比跳   现状=10/6/6/13/4");
for (const [lb, scan, wr] of CANDS) {
  const F = mk(scan, wr), cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    cells.push(String(F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * 0.5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${lb.padEnd(11)} ${cells.join(" ")}`);
}

console.log("\n############ 卷3：静止/噪声（必须 0）############");
console.log("实现         A(静)  B(抖) C(噪.12)  C2(噪.20)  G(噪4m)  D(开合@2m) E(深蹲.6)");
for (const [lb, scan, wr] of CANDS) {
  const F = mk(scan, wr), cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m", "D_jack08_2m", "E_squat06"]) {
    const e = EXP[key], p = e.profile;
    cells.push(String(F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || 0.1) * 0.5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${lb.padEnd(11)} ${cells.join(" ")}`);
}
