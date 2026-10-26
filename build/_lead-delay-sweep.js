/* 【延迟定参】修法定型 = 每样本只判一次（消 2×）+ win 按 band[0]（防慢动作削平）。
 * 最后只需定 **delay**（处理"多老的样本"）：delay=0 响应最快但右边缘偏置；
 * delay=win/2 居中窗最准但出数滞后。扫 0、1/8、1/4、1/3、1/2 四档。
 * 判别卷：真机 5 动作（有真实的台阶/停顿）+ 合成 60 格 + 静止噪声。 */
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
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ cn: nm, sig, band: [+band[1], +band[2]], gap, ea }); } }
function mk(frac) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const F=${frac}, B0=band[0];
    let reps=0,lastAt=-1,armed=false,scannedT=-1,lagSum=0,nC=0; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const win=Math.min(clamp(Math.round(fps*60/Math.max(8,B0)),3,Math.round(fps*3.5)), raw.length);
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=Math.floor(win*F);
      const stop=Math.max(0,d.length-h);
      for(let i=0;i<stop;i++){ const v=d[i], t=rawT[i];
        if(t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lagSum+=now-t; nC++; lastAt=now; } armed=false; }
      }
      if(stop>0) scannedT=Math.max(scannedT, rawT[stop-1]);
    }
    return {reps,hits,avgLag:nC?lagSum/nC:0};
  };`)();
}
const sineDs = (f, s2) => { const a = []; for (let i = 0; i < s2 * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
const FRACS = [0, 0.125, 0.25, 1 / 3, 0.5];
console.log("delay     合成60格(平均/sd/越界)      真机: 开合 深蹲 半蹲 跳绳 波比 | 平均延迟(s)");
for (const fr of FRACS) {
  const F = mk(fr);
  let cells = [], bad = 0;
  for (const A of ACTIONS) for (const rate of [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * .25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * .75), A.band[1]]) {
    const f = rate / 60, s2 = sineDs(f, 90), e = f * 90, r = F(s2, 60, A.ea * .5, A.band, A.gap).reps, x = r / e;
    cells.push(x); if (x > 1.4 || x < 0.7) bad++;
  }
  const m = cells.reduce((a, b) => a + b, 0) / cells.length;
  const sd = Math.sqrt(cells.reduce((a, b) => a + (b - m) ** 2, 0) / cells.length);
  const real = [], lags = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], p = a.profile;
    const r = F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap);
    real.push(String(r.reps).padStart(4)); lags.push(r.avgLag);
  }
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;
  console.log(`win×${String(fr).padEnd(5)}   ${m.toFixed(3)} / ${sd.toFixed(3)} / ${String(bad).padStart(2)}         ${real.join(" ")}  | ${avgLag.toFixed(2)}`);
}
console.log("\n（真机真值参考: 开合跳 6~7、跳绳 10；现状 10/6/6/12/4）");
console.log("\n=== 静止/噪声（各档都应 0）===");
console.log("delay      A(静) B(抖) C(噪.12) C2(噪.20) G(噪4m) E(深蹲.6) H(深蹲4m)");
for (const fr of FRACS) {
  const F = mk(fr), cells = [];
  for (const key of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m", "E_squat06", "H_squat06_4m"]) {
    const e = EXP[key], p = e.profile;
    cells.push(String(F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap).reps).padStart(5));
  }
  console.log(`win×${String(fr).padEnd(5)}   ${cells.join(" ")}`);
}
