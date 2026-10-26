/* 【闸门×漏拍定位】跳绳在 F 下只计 6（真值≈10），且 gatedFrames=14。
 * 逐帧打印：spread vs gate、armed、d/±k、以及"本该计数却没计"的代价。
 * 目的：确认漏拍是否由「闸门关闭期间的样本被永久丢弃」造成，
 *       并测一个针对性修法 F3'：闸门只抑制计数、**不清 armed**（保持状态连续）。
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

function makeCounter(win, gap, opts) {
  const { gateMode, scan, gateVal } = opts;
  const env = `${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw, win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps){
    const smoothK=Math.max(1,Math.round(fps*0.06)), tailN=Math.max(2,Math.round(fps*0.35));
    const winN=${win}, gapN=${gap}, G=+${gateVal}, GM="${gateMode}", SCAN="${scan}";
    let reps=0,lastAt=-1,armed=false,gated=0; const hits=[], trace=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      const gateOk = G<=0 ? true : spread>=G;
      if(!gateOk) gated++;
      // 闸门策略：
      //  front  = 关闸即 return（现状）
      //  guard  = 照常跑，只在计数处判闸（不清 armed）
      //  reset  = 照常跑，闸关时清 armed（我上轮 F3，等价 front）
      if(GM==="front" && !gateOk){ armed=false; trace.push({f,spread,gateOk,armed,counted:false,skip:"front"}); continue; }
      const d=smooth(detrendC(raw,winN),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1; const k=clamp(rms*0.85,0.45,2.2);
      let start,stop;
      if(SCAN==="tail"){start=Math.max(0,d.length-tailN);stop=d.length;}
      else if(SCAN==="new1"){start=Math.max(0,d.length-1);stop=d.length;}
      else {start=Math.max(0,d.length-2);stop=d.length;}
      let counted=false;
      for(let i=start;i<stop;i++){
        const v=d[i];
        if(v<-k) armed=true;
        else if(v>k&&armed){
          if(gateOk && (lastAt<0||now-lastAt>=gapN)){reps++;hits.push(+now.toFixed(3));lastAt=now;counted=true;}
          armed=false;
        }
      }
      if(GM==="reset" && !gateOk) armed=false;
      trace.push({f,spread,gateOk,armed,k,counted});
    }
    return {reps,hits,gated,trace};
  };`;
  return new Function(env)();
}
const engWin = band => Math.max(3, Math.min(Math.round(3600 / Math.max(15, band[1])), 90));

const a = R.acts.jumpRope, band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
const win = engWin(band), gate = ea * 0.5;
const series = a.series.map(s => ({ t: s.t, v: s.height }));
console.log(`跳绳: win=${win}帧 band=[${band}] gap=${gap} ea=${ea} gate=${gate.toFixed(4)} 真值≈10`);
console.log(`信号高度范围 ${Math.min(...series.map(s=>s.v)).toFixed(4)} ~ ${Math.max(...series.map(s=>s.v)).toFixed(4)}`);

const variants = {
  "prod(tail,front)": { gateMode: "front", scan: "tail", gateVal: gate },
  "F(new1,front)": { gateMode: "front", scan: "new1", gateVal: gate },
  "F3'(new1,guard)": { gateMode: "guard", scan: "new1", gateVal: gate },
  "F3'b(new2,guard)": { gateMode: "guard", scan: "new2", gateVal: gate },
  "prod(guard)": { gateMode: "guard", scan: "tail", gateVal: gate },
  "F(noGate)": { gateMode: "guard", scan: "new1", gateVal: 0 },
};
console.log("\n变体                reps   闸门关帧   计数时刻");
for (const [label, o] of Object.entries(variants)) {
  const r = makeCounter(win, gap, o)(series, 60);
  console.log(`${label.padEnd(18)} ${String(r.reps).padStart(4)}   ${String(r.gated).padStart(6)}   ${r.hits.join(", ")}`);
}

// 逐帧诊断：只看 2.8~4.4s（F 的两个死区）
console.log("\n=== 逐帧诊断（prod vs F vs F3'）2.6~4.4s ===");
const tr = {};
for (const m of ["prod(tail,front)", "F(new1,front)", "F3'(new1,guard)"]) tr[m] = makeCounter(win, gap, variants[m])(series, 60).trace;
console.log("帧    t      spread   gateOk | prod: k    armed  cnt | F:  armed cnt | F3': armed cnt");
for (let f = 0; f < series.length; f++) {
  const t = series[f].t;
  if (t < 2.6 || t > 4.4) continue;
  const p = tr["prod(tail,front)"][f], q = tr["F(new1,front)"][f], h = tr["F3'(new1,guard)"][f];
  if (!p || !q || !h) continue;
  const fm = (x) => x === undefined ? "--" : (x ? "Y" : "n");
  console.log(`  ${String(f).padStart(3)} ${t.toFixed(2)}  ${p.spread.toFixed(4)}  ${p.gateOk ? "Y" : "n"}     | ${(p.k ?? 0).toFixed(2)}  ${fm(p.armed)}  ${p.counted ? "★" : " "}  |   ${fm(q.armed)}   ${q.counted ? "★" : " "}   |   ${fm(h.armed)}    ${h.counted ? "★" : " "}`);
}
