/* 【归因】把欠计拆成三笔账：闸门 / oneshot水位线 / 因果均值。
 * 做法：2 个引擎版本 × 2 种门限(ea真实 / ea≈0放开) = 4 组合。
 * 用法：node build/_dbg-attrib-4combo.js
 */
"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.join(__dirname,"..");
function build(file){
  const SRC=fs.readFileSync(file,"utf8");
  const grab=(a,b)=>{const i=SRC.indexOf(a),j=SRC.indexOf(b,i);if(i<0||j<0)throw new Error("抠取失败 "+a.slice(0,30));return SRC.slice(i,j);};
  const parts={SIGNALS:grab("const SIGNALS = {","function clamp(v, a, b)"),clamp:grab("function clamp(v, a, b)","function mean(arr)"),mean:grab("function mean(arr)","function std(arr)"),std:grab("function std(arr)","// 动作参数默认值")};
  parts.signalWindowTimes = SRC.includes("function signalWindowTimes(")?grab("function signalWindowTimes(key, seconds)","function signalWindow(key, seconds)"):"function signalWindowTimes(){return [];}";
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
return {reps,gate:repGate,spread:repSpread};}};}`;
  return new Function(F)();
}
const AFTER=build(path.join(ROOT,"motion-engine.js"));
const BEFORE=build(path.join(__dirname,"_rollback","motion-engine.before-2xfix.js"));
const R=JSON.parse(fs.readFileSync(path.join(__dirname,"_tmp","_realseries.json"),"utf8"));
// 真实真值（人工目视计数，见记忆）
const TRUTH={jumpingJacks:7,squat:5,halfSquatWarm:null,jumpRope:10,burpee:2};
console.log("动作".padEnd(24)+"真值".padStart(6)+"  基线(ea真)".padStart(12)+"基线(ea放开)".padStart(14)+"现行(ea真)".padStart(12)+"现行(ea放开)".padStart(14));
for(const [k,e] of Object.entries(R.acts)){
  const seq=e.series.map(s=>Object.assign({},s));
  const run=(mk,ea)=>{const p=Object.assign({},e.profile,{expectedAmplitude:ea});try{return mk(p,60,{height:0.6}).run(seq).reps;}catch(err){return "E";}};
  const b1=run(BEFORE,e.profile.expectedAmplitude), b2=run(BEFORE,0.0001);
  const a1=run(AFTER,e.profile.expectedAmplitude),  a2=run(AFTER,0.0001);
  const tv=TRUTH[k]===null?"?":String(TRUTH[k]);
  console.log((e.cn+"("+k+")").padEnd(24)+tv.padStart(6)+String(b1).padStart(12)+String(b2).padStart(14)+String(a1).padStart(12)+String(a2).padStart(14));
}
