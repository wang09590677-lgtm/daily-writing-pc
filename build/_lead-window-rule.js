/* 【窗口规则定案】2× 根因 = 尾部重扫（已三法交叉确证）。
 * 采用"每样本只判一次 + 延迟半窗"（F′）后，唯一剩下的问题是**窗长怎么取**：
 *   · 窗长 ≈ 1 个动作周期时，居中去趋势对该周期信号"均值恰为 0" → 保留最好
 *   · 窗长 << 周期（慢动作）→ 去趋势把信号削平 → 计 0（黑洞）
 *   · 窗长 >> 周期（快动作）→ 均值趋 0，理论上也保留，但需实测确认不复制 2×
 *
 * 候选窗规则（都配 delay=win/2、每样本一次）：
 *   B1 : win = clamp(fps*60/band[1], 3, fps*1.5)   （= 现状窗，仅按最快拍速）
 *   B0 : win = clamp(fps*60/band[0], 3, fps*3)     （按最慢拍速）
 *   MID: win = clamp(fps*120/(band[0]+band[1]), 3, fps*3)（取带中点）
 *   L90: win = fps*1.5 固定
 *   L180: win = fps*3.0 固定
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

function mk(rule) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const RULE="${rule}", B0=band[0], B1=band[1];
    let reps=0,lastAt=-1,armed=false; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t;
      let win;
      if(RULE==="B1") win = clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
      else if(RULE==="B0") win = clamp(Math.round(fps*60/Math.max(15,B0)),3,Math.round(fps*3.0));
      else if(RULE==="MID") win = clamp(Math.round(fps*120/Math.max(20,B0+B1)),3,Math.round(fps*3.0));
      else if(RULE==="L90") win = Math.round(fps*1.5);
      else win = Math.round(fps*3.0);
      if(win<3) win=3;
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
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(3)); lastAt=now; } armed=false; }
      }
    }
    return {reps,hits};
  };`)();
}
const RULES = ["B1", "B0", "MID", "L90", "L180"];

console.log("=== 卷A：真机 5 动作（参考真值 开合跳 6~7、跳绳 10）===");
console.log("窗规则   开合跳  徒手深蹲 半蹲热身  跳绳   波比跳   现况对比: 现状 10/6/6/13/4");
for (const r of RULES) {
  const cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const series = a.series.map(s => ({ t: s.t, v: s[a.signal] }));
    cells.push(String(mk(r)(series, 60, p.expectedAmplitude * 0.5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${r.padEnd(8)} ${cells.join(" ")}`);
}

console.log("\n=== 卷B：正弦拍速扫描（期望=Hz×40s）===");
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
for (const [band, gap, lb] of [[[40, 90], 0.45, "开合档 [40,90]"], [[60, 120], 0.3, "跳绳档 [60,120]"], [[15, 40], 0.9, "慢速档 [15,40]"]]) {
  console.log(`\n-- ${lb} --`);
  console.log("窗规则      15/分     30/分     45/分     60/分     90/分    120/分    150/分");
  for (const r of RULES) {
    const cells = [];
    for (const rate of [15, 30, 45, 60, 90, 120, 150]) {
      const f = rate / 60, s = sineDs(f, 40), e = f * 40;
      const res = mk(r)(s, 60, 0, band, gap);
      const x = res.reps / e;
      cells.push(`${String(res.reps).padStart(3)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`);
    }
    console.log(`${r.padEnd(10)} ${cells.join(" ")}`);
  }
}

console.log("\n=== 卷C：静止/噪声（必须 0）===");
console.log("窗规则       A(静)  B(抖) C(噪.12)  C2(噪.20)  G(噪4m)");
for (const r of RULES) {
  const cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m"]) {
    const e = EXP[key], p = e.profile;
    const series = e.series.map(s => ({ t: s.t, v: s[p.signal] }));
    cells.push(String(mk(r)(series, 60, (p.expectedAmplitude || 0.1) * 0.5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${r.padEnd(10)} ${cells.join(" ")}`);
}
