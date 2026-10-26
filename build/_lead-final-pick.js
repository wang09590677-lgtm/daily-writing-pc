/* 【终选】在 F′（延迟半窗、每样本一次）基础上，用"窗长自适应"补掉慢速黑洞。
 *
 * 机制回顾（本会话已确证）：
 *   2× 根因 = 每帧重扫尾部 21 帧（motion-engine.js:2651）
 *   修法 = 每个物理样本只判定一次（F 家族）
 *   F（delay=0）右边缘偏置 → 漏拍（跳绳 6/真值10）
 *   F′（delay=win/2）居中窗完整 → 准（开合 7/真值6.5，跳绳 8/真值10）
 *     但 win 远短于动作周期时（慢动作）居中窗去趋势把信号削平 → 计 0（黑洞）
 *   → 终选 F″ = F′ + 窗长下限随实测周期自适应。
 *
 * 变体：
 *   Fp      : win = winBase(band[1])，delay = win/2
 *   Fp-w0   : win = winBand0(band[0])，delay = win/2
 *   Fp-adt  : win = max(winBase, round(fps×实测周期))，delay = win/2   ★
 *   Fp-ad0  : win = max(winBase, round(fps×max(实测周期, 60/band[0])))，delay = win/2
 * 卷：真机5 / 正弦（含极慢 15~40/分）/ 静止噪声。
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

function mk(variant) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const VAR="${variant}", B0=band[0], B1=band[1];
    let reps=0,lastAt=-1,armed=false; const hits=[], gaps=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t;
      const winBase = clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
      const winB0   = clamp(Math.round(fps*60/Math.max(15,B0)),3,Math.round(fps*3.0));
      let win = winBase;
      if(VAR==="Fp-w0"||VAR==="Fp-ad0") win = winB0;
      if(VAR==="Fp-adt"||VAR==="Fp-ad0"){
        const per = gaps.length>=2 ? gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)] : 0;   // 实测周期(s)
        const perF = per>0 ? Math.round(fps*per) : 0;
        win = Math.max(win, perF);
        win = Math.min(win, Math.round(fps*3.0));
      }
      const from=now-3.5; const raw=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=Math.floor(win/2);
      const start=Math.max(0,d.length-1-h), stop=Math.max(0,d.length-h);
      for(let i=start;i<stop;i++){ const v=d[i];
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(3)); if(lastAt>=0) gaps.push(now-lastAt); lastAt=now; } armed=false; }
      }
    }
    return {reps,hits};
  };`)();
}
const VARS = ["Fp", "Fp-w0", "Fp-adt", "Fp-ad0"];

console.log("=== 卷A：真机 5 动作 ===");
console.log("真值参考: 开合跳≈6.5  跳绳=10  徒手深蹲/半蹲热身/波比跳 真值不稳，仅看量级");
console.log("变体       开合跳  徒手深蹲 半蹲热身  跳绳   波比跳");
for (const v of VARS) {
  const cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const series = a.series.map(s => ({ t: s.t, v: s[a.signal] }));
    cells.push(String(mk(v)(series, 60, p.expectedAmplitude * 0.5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${v.padEnd(10)} ${cells.join(" ")}`);
}

console.log("\n=== 卷B：正弦拍速扫描（3 个档位，期望=Hz×30s）===");
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
for (const [band, gap, lb] of [[[40, 90], 0.45, "开合档 [40,90] gap0.45"], [[60, 120], 0.3, "跳绳档 [60,120] gap0.3"], [[15, 40], 0.9, "慢速档 [15,40] gap0.9"]]) {
  console.log(`\n-- ${lb} --`);
  console.log("变体           15/分     30/分     45/分     60/分     90/分    120/分    150/分");
  for (const v of VARS) {
    const cells = [];
    for (const rate of [15, 30, 45, 60, 90, 120, 150]) {
      const f = rate / 60, s = sineDs(f, 40), e = f * 40;
      const r = mk(v)(s, 60, 0, band, gap);
      const x = r.reps / e;
      cells.push(`${String(r.reps).padStart(3)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`);
    }
    console.log(`${v.padEnd(12)} ${cells.join(" ")}`);
  }
}

console.log("\n=== 卷C：静止/噪声/小幅（静止噪声必须 0）===");
console.log("变体        A(静)  B(抖) C(噪.12) C2(噪.20) G(噪4m) D(开合.8@2m) E(深蹲.6)");
for (const v of VARS) {
  const cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m", "D_jack08_2m", "E_squat06"]) {
    const e = EXP[key], p = e.profile;
    const series = e.series.map(s => ({ t: s.t, v: s[p.signal] }));
    cells.push(String(mk(v)(series, 60, (p.expectedAmplitude || 0.1) * 0.5, p.tempoBand, p.minRepGap).reps).padStart(5));
  }
  console.log(`${v.padEnd(10)} ${cells.join(" ")}`);
}
