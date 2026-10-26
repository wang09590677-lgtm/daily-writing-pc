/* 【启动瞬态 vs 稳态】把真机 6s 序列**循环拼接**成 ~42s（模拟孩子做满一组），
 * 再统计各方案的计数。这样：
 *   · 首尾各丢 1 拍 = 启动瞬态（占比 1/70，可忽略）
 *   · 稳态若有比例偏差，会在 70 拍规模上显现
 * 同时扫 delay（0 / win4 / win2）× winRule（B1/H2/B0），选出延迟最小的可行组合。
 * 只读产品文件 + _realseries.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));

function mk(scan, winRule, delayFrac) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const SCAN="${scan}", WR="${winRule}", DF=${delayFrac}, B0=band[0], B1=band[1];
    const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false,scannedT=-1; const hits=[];
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
      const h=Math.floor(win*DF);
      let lo,hi;
      if(SCAN==="prod"){ lo=0; }   // 现状：整窗重扫（复刻 tail）
      else { lo=0; }
      const start = SCAN==="prod" ? Math.max(0,d.length-tailN) : 0;
      const stop  = SCAN==="prod" ? d.length : Math.max(0,d.length-h);
      for(let i=start;i<stop;i++){
        const v=d[i], t=rawT[i];
        if(SCAN!=="prod" && t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lastAt=now; } armed=false; }
      }
      if(SCAN!=="prod" && stop>start) scannedT=Math.max(scannedT, rawT[stop-1]);
    }
    return {reps,hits};
  };`)();
}
// 循环拼接：把 series 重复 n 次，时间轴连续
function loopSeries(series, n) {
  const dur = series[series.length - 1].t + 1 / 60;
  const out = [];
  for (let k = 0; k < n; k++) for (const s of series) out.push({ t: +(s.t + k * dur).toFixed(4), v: s.v });
  return out;
}
const TRUTH_PER = { jumpingJacks: 6.5, jumpRope: 10, squat: 15, halfSquatWarm: 11, burpee: 6 };
const N = 7;
const CANDS = [
  ["现状 prod", "prod", "B1", 0],
  ["one/B1/d0", "one", "B1", 0],
  ["one/B1/d½", "one", "B1", 0.5],
  ["one/H2/d½", "one", "H2", 0.5],
  ["one/B0/d½", "one", "B0", 0.5],
  ["one/B0/d¼", "one", "B0", 0.25],
  ["one/B0/d¾", "one", "B0", 0.75],
];
console.log(`=== 循环 ${N} 次（≈${(6 * N).toFixed(0)}s，模拟做满一组）===`);
console.log("方案         开合跳(真值" + (6.5 * N).toFixed(0) + ")  跳绳(真值" + (10 * N) + ")  徒手深蹲  半蹲热身  波比跳");
for (const [lb, scan, wr, df] of CANDS) {
  const F = mk(scan, wr, df), cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const s = loopSeries(a.series.map(x => ({ t: x.t, v: x[a.signal] })), N);
    const r = F(s, 60, p.expectedAmplitude * 0.5, p.tempoBand, p.minRepGap).reps;
    const exp = TRUTH_PER[name] * N;
    const x = r / exp;
    cells.push(`${String(r).padStart(4)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.85 ? "✗" : " "}`);
  }
  console.log(`${lb.padEnd(12)} ${cells.join("  ")}`);
}
console.log("\n=== 单次 6s（看启动瞬态占比）===");
console.log("方案         开合跳  跳绳   徒手深蹲 半蹲热身 波比跳   （现状=10/12/6/6/4）");
for (const [lb, scan, wr, df] of CANDS) {
  const F = mk(scan, wr, df), cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const r = F(a.series.map(x => ({ t: x.t, v: x[a.signal] })), 60, p.expectedAmplitude * 0.5, p.tempoBand, p.minRepGap).reps;
    cells.push(String(r).padStart(6));
  }
  console.log(`${lb.padEnd(12)} ${cells.join(" ")}`);
}
