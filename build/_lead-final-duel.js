/* 【终决】两强对决 + 延迟代价评估。
 *   A) oneshot + 居中窗 + delay=win/2（无偏，但有出数延迟）
 *   B) oneshot + 因果滑动均值去趋势 + delay=0（无延迟，但有相位滞后）
 * 两者都用 win = B0（按最慢拍速，上限 3.5s）。
 * 三卷：全 12 动作合成 / 真机 5 动作 / 静止噪声。
 * 另外单独报告"延迟"（出数滞后秒数）与"尾部丢失"（每组末尾未处理的秒数）。
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
function mk(variant) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  function detrendL(raw,win){const out=new Array(raw.length),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-win+1);j<=i;j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const V="${variant}", B0=band[0];
    const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false,scannedT=-1,lagSum=0,nCount=0; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const win=Math.min(clamp(Math.round(fps*60/Math.max(8,B0)),3,Math.round(fps*3.5)), raw.length);
      const useL = V==="causal";
      const d=smooth(useL?detrendL(raw,win):detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=useL?0:Math.floor(win/2);
      const start=useL?0:0, stop=useL?d.length:Math.max(0,d.length-h);
      for(let i=start;i<stop;i++){
        const v=d[i], t=rawT[i];
        if(t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lagSum+=now-t; nCount++; lastAt=now; } armed=false; }
      }
      if(stop>0) scannedT=Math.max(scannedT, rawT[stop-1]);
      else if(d.length) scannedT=Math.max(scannedT, rawT[d.length-1]);
    }
    return {reps,hits,avgLag:nCount?lagSum/nCount:0};
  };`)();
}
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
const DUR = 90;
console.log("############ 卷1：全 12 动作 × band 内 5 点（合成正弦）############\n");
for (const v of ["delay", "causal"]) {
  const F = mk(v); const cells = []; let bad = [];
  for (const A of ACTIONS) {
    for (const rate of [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.75), A.band[1]]) {
      const f = rate / 60, s = sineDs(f, DUR), e = f * DUR, r = F(s, 60, A.ea * .5, A.band, A.gap).reps, x = r / e;
      cells.push(x); if (x > 1.4 || x < 0.7) bad.push(`${A.cn}@${rate}/${分 = rate}=${x.toFixed(2)}`);
    }
  }
  const m = cells.reduce((a, b) => a + b, 0) / cells.length;
  const sd = Math.sqrt(cells.reduce((a, b) => a + (b - m) ** 2, 0) / cells.length);
  console.log(`【${v}】平均=${m.toFixed(3)} 标准差=${sd.toFixed(3)} 最大=${Math.max(...cells).toFixed(2)} 最小=${Math.min(...cells).toFixed(2)}`);
  console.log(`        越界格(${bad.length}): ${bad.slice(0, 8).join("  ") || "无"}`);
}
console.log("\n############ 卷2：真机 5 动作 ############");
console.log("实现     开合跳  徒手深蹲 半蹲热身  跳绳   波比跳   | 平均出数延迟(s)");
for (const v of ["delay", "causal"]) {
  const F = mk(v), cells = []; let lag = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const r = F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap);
    cells.push(String(r.reps).padStart(6)); lag.push(r.avgLag);
  }
  const avg = lag.reduce((a, b) => a + b, 0) / lag.length;
  console.log(`${v.padEnd(9)} ${cells.join(" ")}   | ${avg.toFixed(2)}`);
}
console.log("（参考真值：开合跳 6~7、跳绳 10；现状=10/6/6/12/4）");
console.log("\n############ 卷3：静止/噪声/小幅 ############");
console.log("实现       A(静)  B(抖) C(噪.12)  C2(噪.20)  G(噪4m)  D(开合@2m) E(深蹲.6) H(深蹲4m)");
for (const v of ["delay", "causal"]) {
  const F = mk(v), cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m", "D_jack08_2m", "E_squat06", "H_squat06_4m"]) {
    const e = EXP[key], p = e.profile;
    cells.push(String(F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap).reps).padStart(6));
  }
  console.log(`${v.padEnd(9)} ${cells.join(" ")}`);
}
