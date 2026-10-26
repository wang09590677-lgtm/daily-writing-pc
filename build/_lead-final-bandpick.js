/* 【最后定参】causal 骨架下，窗长规则 band[0] vs band[1] 的对照。
 * 三卷：合成栅格 60 格 / 真机 5 动作 / 静止噪声。
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const PLAN = fs.readFileSync(path.join(ROOT, "data", "fitness-plan.js"), "utf8");
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
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea }); } }

const PREFIX = `function psum(a){const p=new Float64Array(a.length+1);for(let i=0;i<a.length;i++)p[i+1]=p[i]+a[i];return p;}
function rmean(p,a,b){if(b<=a)return 0;return (p[b]-p[a])/(b-a);}
function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}`;

// bandPick: "lo" → band[0]，"hi" → band[1]；两种都带 cap
function mkCausal(bandPick, cap) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${PREFIX}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06));
    const B = "${bandPick}"==="lo" ? band[0] : band[1];
    let reps=0,lastAt=-1,armed=false,scannedT=-1;
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const n=raw.length;
      const win=Math.min(clamp(Math.round(fps*60/Math.max(8,B)),3,Math.round(fps*${cap})), n);
      const g=std(raw)||1e-6, P=psum(raw);
      const det=new Float64Array(n);
      for(let i=0;i<n;i++){ const m=rmean(P,Math.max(0,i-win+1),i+1); det[i]=(raw[i]-m)/g; }
      const d=smooth(Array.from(det),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      for(let i=0;i<n;i++){ const v=d[i], t=rawT[i]; if(t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; lastAt=now; } armed=false; } }
      if(n) scannedT=Math.max(scannedT, rawT[n-1]);
    }
    return reps;
  };`)();
}
const sineDs=(f,s)=>{const a=[];for(let i=0;i<s*60;i++)a.push({t:i/60,v:.15*Math.sin(2*Math.PI*f*i/60)});return a;};
const ratesOf=A=>[A.band[0],Math.round(A.band[0]+(A.band[1]-A.band[0])*.25),Math.round((A.band[0]+A.band[1])/2),Math.round(A.band[0]+(A.band[1]-A.band[0])*.75),A.band[1]];
function grid(F){const c=[];let o=0,u=0;
  for(const A of ACTIONS)for(const r of ratesOf(A)){const f=r/60,s=sineDs(f,60),e=f*60,x=F(s,60,A.ea*.5,A.band,A.gap)/e;c.push(x);if(x>1.4)o++;if(x<.7)u++;}
  const m=c.reduce((a,b)=>a+b,0)/c.length;return{m,sd:Math.sqrt(c.reduce((a,b)=>a+(b-m)**2,0)/c.length),o,u,mn:Math.min(...c),mx:Math.max(...c)};}
function real(F){const o={};for(const k of Object.keys(R.acts)){const a=R.acts[k],p=a.profile;o[a.cn]=F(a.series.map(s=>({t:s.t,v:s[a.signal]})),60,p.expectedAmplitude*.5,p.tempoBand,p.minRepGap);}return o;}
function noise(F){let bad=0,sum=0;const det=[];
  for(const k of ["A_static_2m","B_noise06_2m","C_noise12_2m","C2_noise20_2m","G_noise12_4m"]){const e=EXP[k];if(!e)continue;const p=e.profile;const r=F(e.series.map(s=>({t:s.t,v:s[p.signal]})),60,(p.expectedAmplitude||.1)*.5,p.tempoBand,p.minRepGap);det.push(k+"="+r);if(r>0){bad++;sum+=r;}}
  return{bad,det};}

const cands=[{l:"causal band[0] cap1.5",F:mkCausal("lo",1.5)},{l:"causal band[0] cap2.0",F:mkCausal("lo",2.0)},{l:"causal band[0] cap1.2",F:mkCausal("lo",1.2)},{l:"causal band[1] cap1.5",F:mkCausal("hi",1.5)},{l:"causal band[1] cap2.0",F:mkCausal("hi",2.0)}];
console.log("=".repeat(112));
console.log("【卷1】合成栅格 60 格（12 动作 × band 内 5 点）");
console.log("-".repeat(112));
console.log("候选                     平均比值  标准差   最小   最大  超计  欠计");
for(const c of cands){const g=grid(c.F);console.log(`${c.l.padEnd(24)} ${g.m.toFixed(3).padStart(7)} ${g.sd.toFixed(3).padStart(7)} ${g.mn.toFixed(2).padStart(6)} ${g.mx.toFixed(2).padStart(6)} ${String(g.o).padStart(4)} ${String(g.u).padStart(5)}`);}
console.log("\n【卷2】真机 5 动作（真值：开合跳 6~7、跳绳 10、波比跳 2）");
console.log("-".repeat(112));
console.log("候选                     开合跳  徒手深蹲 半蹲热身  跳绳   波比跳");
for(const c of cands){const r=real(c.F);console.log(`${c.l.padEnd(24)} ${["开合跳","徒手深蹲","半蹲热身","跳绳","波比跳"].map(k=>String(r[k]).padStart(7)).join(" ")}`);}
console.log("\n【卷3】静止/噪声（必须 5 项全 0）");
console.log("-".repeat(112));
for(const c of cands){const n=noise(c.F);console.log(`${c.l.padEnd(24)} 违规 ${n.bad}/5   ${n.det.join("  ")}`);}
