/* 【参数定案】2× 根因已确证 = 尾部重扫（motion-engine.js:2651）。
 * 目标：选出一个"既能消 2×、又不明显欠计、且不引入慢速黑洞"的实现。
 *
 * 候选实现（都只处理"新样本"，差别在**延迟多久**以取得完整居中窗）：
 *   F   delay=0      （右边缘截断，会因偏置漏拍）
 *   Fp  delay=win/2  （完整居中窗，但慢速黑洞）
 *   Fq  delay=win/2，但 win 自适应：win = clamp(实测周期, winBand, 1.5s)  ★候选
 *   Fq2 delay=win/2，win 取 max(winBand, 实测周期)（不设 1.5s 上限）
 *
 * 评估：
 *   卷A 真机 5 动作（真值：开合跳=6、跳绳=10；其余给区间参考）
 *   卷B 正弦 30~240/分（鲁棒性）
 *   卷3 静止/噪声（误计必须 0）
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

function mk(mode) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band){
    const smoothK=Math.max(1,Math.round(fps*0.06));
    const MODE="${mode}", B0=band[0], B1=band[1];
    const winBase = clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
    // 新样本先入队，延迟若干帧后再判定（以获得完整居中窗）
    const buf=[];                 // {t,v}
    let reps=0,lastAt=-1,armed=false,delay=0; const hits=[];
    // 周期估计：用最近两次计数间隔（稳健起见用中位）
    const gaps=[];
    function decide(sampleIdx){ return 0; }
    for(let f=0;f<series.length;f++){
      const now=series[f].t;
      let win=winBase;
      if(MODE==="Fq"||MODE==="Fq2"){
        // 用已计数的间隔估周期；样本不足时用 band 下限
        let per = gaps.length>=2 ? gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)] : (60/Math.max(15,B0));
        const winPer = Math.round(fps*per);
        win = MODE==="Fq" ? clamp(winPer, winBase, Math.round(fps*1.5)) : Math.max(winBase, winPer);
      }
      // 取窗
      const from = now-3.5; const raw=[], rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      // 处理范围
      let start,stop;
      if(MODE==="F"){ start=Math.max(0,d.length-1); stop=d.length; }
      else { const h=Math.floor(win/2); start=Math.max(0,d.length-1-h); stop=Math.max(0,d.length-h); }
      for(let i=start;i<stop;i++){
        const v=d[i];
        if(v<-k) armed=true;
        else if(v>k&&armed){
          if(lastAt<0||now-lastAt>=band[2]){ reps++; hits.push(+now.toFixed(3)); if(lastAt>=0) gaps.push(now-lastAt); lastAt=now; }
          armed=false;
        }
      }
    }
    return {reps,hits};
  };`)();
}
const T = { jumpingJacks: 6.5, jumpRope: 10 };
console.log("=== 卷A：真机 5 动作（真值 开合跳≈6.5 跳绳=10；其余仅参考）===");
console.log("实现      开合跳  徒手深蹲 半蹲热身  跳绳   波比跳");
for (const mode of ["F", "Fp", "Fq", "Fq2"]) {
  const cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const series = a.series.map(s => ({ t: s.t, v: s[a.signal] }));
    const r = mk(mode)(series, 60, p.expectedAmplitude * 0.5, [p.tempoBand[0], p.tempoBand[1], p.minRepGap]);
    cells.push(String(r.reps).padStart(6));
  }
  console.log(`${mode.padEnd(9)} ${cells.join(" ")}`);
}
console.log("\n=== 卷B：正弦拍速扫描（开合档 band[40,90] gap0.45）===");
console.log("实现        30/分     60/分     90/分    120/分    150/分    180/分    240/分");
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
for (const mode of ["F", "Fp", "Fq", "Fq2"]) {
  const cells = [];
  for (const rate of [30, 60, 90, 120, 150, 180, 240]) {
    const f = rate / 60, s = sineDs(f, 30), e = f * 30;
    const r = mk(mode)(s, 60, 0, [40, 90, 0.45]);
    const x = r.reps / e;
    cells.push(`${String(r.reps).padStart(3)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`);
  }
  console.log(`${mode.padEnd(10)} ${cells.join(" ")}`);
}
console.log("\n=== 卷C：静止/噪声（必须 0）===");
console.log("实现       A     B     C    C2     G");
for (const mode of ["F", "Fp", "Fq", "Fq2"]) {
  const cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m"]) {
    const e = EXP[key], p = e.profile;
    const series = e.series.map(s => ({ t: s.t, v: s[p.signal] }));
    const r = mk(mode)(series, 60, (p.expectedAmplitude || 0.1) * 0.5, [p.tempoBand[0], p.tempoBand[1], p.minRepGap]);
    cells.push(String(r.reps).padStart(5));
  }
  console.log(`${mode.padEnd(9)} ${cells.join(" ")}`);
}
