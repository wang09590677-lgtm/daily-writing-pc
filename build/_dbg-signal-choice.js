/* 真机序列：同一动作换不同 signal，看哪个信号能数到真值。
 * 目的：把「计数器丢拍」和「信号选错」两笔账分开。
 * 用法：node build/_dbg-signal-choice.js
 */
"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.join(__dirname,"..");
const SRC=fs.readFileSync(path.join(ROOT,"motion-engine.js"),"utf8");
function grab(a,b){const i=SRC.indexOf(a),j=SRC.indexOf(b,i);if(i<0||j<0)throw new Error("抠取失败 "+a.slice(0,30));return SRC.slice(i,j);}
const parts={SIGNALS:grab("const SIGNALS = {","function clamp(v, a, b)"),clamp:grab("function clamp(v, a, b)","function mean(arr)"),mean:grab("function mean(arr)","function std(arr)"),std:grab("function std(arr)","// 动作参数默认值")};
parts.signalWindowTimes=grab("function signalWindowTimes(key, seconds)","function signalWindow(key, seconds)");
parts.signalWindow=grab("function signalWindow(key, seconds)","// 去趋势：");
parts.detrend=grab("function detrend(raw, win)","function smooth(raw, k)");
parts.smooth=grab("function smooth(raw, k)","// 峰值计次");
parts.detectReps=grab("function detectReps(now)","/* ---------- 保持类 ---------- */");
const F=`return function mk(profileIn,fpsInit,liveInit){let fps=fpsInit||60,profile=profileIn,live=liveInit;
let series=[],repCounters={},reps=0,repTimes=[],repGate=0,repSpread=0,repHeightBase=0;
function cfg(k){return profile&&profile[k]!==undefined?profile[k]:undefined;}
function signalList(){if(profile&&Array.isArray(profile.signals)&&profile.signals.length)return profile.signals;return [cfg("signal")||"centroidY"];}
${parts.SIGNALS}${parts.clamp}${parts.mean}${parts.std}${parts.signalWindowTimes}${parts.signalWindow}${parts.detrend}${parts.smooth}${parts.detectReps}
return {run(seq){series=[];repCounters={};reps=0;repTimes=[];repGate=0;repSpread=0;repHeightBase=0;
for(const s of seq){const d={motion:0,area:.1,centroidX:.5,centroidY:.5,width:0,height:0,bottomL:0,bottomR:0,left:0,right:0,upper:0,lower:0};
const row=Object.assign(d,liveInit,s);live=row;series.push(Object.assign({t:s.t},d,s));if(series.length>60*30)series.shift();fps=s.__fps||fpsInit||60;detectReps(s.t);}
return {reps,repGate,repSpread,series:series.slice()};}};}`;
const mk=new Function(F)();
const R=JSON.parse(fs.readFileSync(path.join(__dirname,"_tmp","_realseries.json"),"utf8"));
const TRUTH={jumpingJacks:[6,7],squat:[5,5],halfSquatWarm:null,jumpRope:[10,10],burpee:[2,2]};
const SIGS=["width","height","centroidY"];
function peaks(series,sig){ // 独立真值：去趋势后数"过零向上"次数（简单峰计数）
  const v=series.map(o=>o[sig]);
  const n=v.length,out=[];let w=Math.max(3,Math.round(0.5)); // 简化：滑动均值窗
  w=15;let acc=0;const detr=[];
  for(let i=0;i<n;i++){acc+=v[i];if(i>=w)acc-=v[i-w];const len=i<w?i+1:w;detr.push(v[i]-acc/len);}
  const sd=Math.sqrt(detr.reduce((a,b)=>a+b*b,0)/n)||1e-9;const z=detr.map(x=>x/sd);
  let armed=false,c=0;
  for(let i=0;i<n;i++){if(z[i]<-0.5)armed=true;else if(z[i]>0.5&&armed){c++;armed=false;}}
  return c;
}
console.log("动作          声明信号   " + SIGS.map(s=>("引擎@"+s).padStart(12)).join("") + "   " + SIGS.map(s=>("独立数峰@"+s).padStart(16)).join("") + "   真值");
for(const [k,e] of Object.entries(R.acts)){
  const base=e.profile;
  const cells=[],pk=[];
  for(const sig of SIGS){
    const p=Object.assign({},base,{signal:sig});
    const seq=e.series.map(s=>Object.assign({},s));
    let r;try{r=mk(p,60,{height:0.6}).run(seq).reps;}catch(err){r="E";}
    cells.push(String(r).padStart(12));
    try{pk.push(String(peaks(e.series,sig)).padStart(16));}catch(err){pk.push("".padStart(16));}
  }
  const tv=TRUTH[k];const tvs=tv?(tv[0]===tv[1]?String(tv[0]):tv.join("~")):"?";
  console.log((e.cn+"("+k+")").padEnd(24) + (e.signal||"?").padEnd(9) + cells.join("") + "   " + pk.join("") + "   " + tvs);
}
