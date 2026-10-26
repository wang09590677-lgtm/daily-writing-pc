/* 【闸门帧是否推进水位线 — 二选一】
 *
 * oneshot 需要一个"已判过"的水位线（scannedT）。当幅度闸门判定"这帧没在做动作"
 * 而 return 时，有两种处理：
 *   V1 冻结水位线：重新动起来时，把静止期间攒下的 3.5s 老样本一次性补判
 *   V2 推进水位线：那些样本是静止的、本就没有真动作可计，直接翻过去
 *
 * V1 的风险：孩子站定一会儿再突然开始 → 老样本一次性涌入，可能吐出一串陈旧计数。
 * V2 的风险：若闸门抖动（真实动作中短暂闭合），推进水位线会**丢掉**那半拍 → 欠计。
 *
 * 判定标准：真机 5 动作计数（真值 开合跳 6~7 / 跳绳 10 / 波比 2）+
 *           噪声场景必须全 0 + 合成 60 格 0 越界 + 启停瞬态（人为制造 gate 翻转）。
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

function mk(gateAdvance) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${PREFIX}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06));
    const win0=clamp(Math.round(fps*60/Math.max(15,band[1])),3,Math.round(fps*1.5));
    let reps=0,lastAt=-1,armed=false,scannedT=-Infinity; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){
        armed=false;
        if(${gateAdvance} && rawT.length) scannedT=Math.max(scannedT, rawT[rawT.length-1]);
        continue;
      }
      const n=raw.length, win=Math.min(win0,n);
      const g=std(raw)||1e-6;
      // 后向（因果）窗去趋势，滚动和 O(n)
      const det=new Float64Array(n); let acc=0;
      for(let i=0;i<n;i++){ acc+=raw[i]; if(i>=win) acc-=raw[i-win]; const len=i<win?i+1:win; det[i]=(raw[i]-acc/len)/g; }
      const d=smooth(Array.from(det),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      for(let i=win-1;i<n;i++){ const t=rawT[i]; if(t<=scannedT) continue; const v=d[i];
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lastAt=now; } armed=false; } }
      if(rawT.length) scannedT=Math.max(scannedT, rawT[n-1]);
    }
    return {reps,hits};
  };`)();
}

const V1 = mk(false), V2 = mk(true);
const ratesOf=A=>[A.band[0],Math.round(A.band[0]+(A.band[1]-A.band[0])*.25),Math.round((A.band[0]+A.band[1])/2),Math.round(A.band[0]+(A.band[1]-A.band[0])*.75),A.band[1]];
const sineDs=(f,s)=>{const a=[];for(let i=0;i<s*60;i++)a.push({t:i/60,v:.15*Math.sin(2*Math.PI*f*i/60)});return a;};

console.log("=".repeat(100));
console.log("【卷1】合成 60 格（每格 60 秒）");
console.log("-".repeat(100));
for (const [name, F] of [["V1 冻结水位线", V1], ["V2 推进水位线", V2]]) {
  const c = []; let o = 0, u = 0, worst = null;
  for (const A of ACTIONS) for (const r of ratesOf(A)) { const f = r / 60, x = F(sineDs(f, 60), 60, A.ea * .5, A.band, A.gap).reps / (f * 60);
    c.push(x); if (x > 1.4) o++; if (x < .7) { u++; if (!worst || x < worst.x) worst = { x, A: A.cn, r }; } }
  const m = c.reduce((a, b) => a + b, 0) / c.length;
  console.log(`${name}  平均=${m.toFixed(3)} 标准差=${Math.sqrt(c.reduce((a,b)=>a+(b-m)**2,0)/c.length).toFixed(3)} 超计=${o} 欠计=${u} ${worst ? "最差 " + worst.A + "@" + worst.r + "=" + worst.x.toFixed(2) : ""}`);
}
console.log("\n【卷2】真机 5 动作");
console.log("-".repeat(100));
console.log("实现            开合跳  徒手深蹲 半蹲热身  跳绳   波比跳");
for (const [name, F] of [["V1 冻结水位线", V1], ["V2 推进水位线", V2]]) {
  const o = [];
  for (const k of ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"]) { const a = R.acts[k], p = a.profile;
    o.push(String(F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap).reps).padStart(6)); }
  console.log(`${name}  ${o.join(" ")}`);
}
console.log("\n【卷3】静止/噪声（必须全 0）");
console.log("-".repeat(100));
for (const [name, F] of [["V1 冻结水位线", V1], ["V2 推进水位线", V2]]) {
  const o = [];
  for (const k of ["A_static_2m", "B_noise06_2m", "C_noise12_2m", "C2_noise20_2m", "G_noise12_4m"]) { const e = EXP[k]; const p = e.profile;
    o.push(k.split("_")[0] + "=" + F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap).reps); }
  console.log(`${name}  ${o.join("  ")}`);
}

console.log("\n【卷4】启停瞬态 ★关键差异★：人为制造「做 5 秒 → 站定 8 秒 → 再做 5 秒」");
console.log("-".repeat(100));
for (const [name, F] of [["V1 冻结水位线", V1], ["V2 推进水位线", V2]]) {
  const out = [];
  for (const rate of [40, 60, 90]) {
    const f = rate / 60, seg = []; let t = 0;
    const push = (secs, amp) => { for (let i = 0; i < secs * 60; i++, t++) seg.push({ t: t / 60, v: amp * Math.sin(2 * Math.PI * f * t / 60) }); };
    push(5, .15); push(8, .0008); push(5, .15); push(8, .0008); push(5, .15);
    const r = F(seg, 60, .18 * .5, [40, 90], .45).reps;
    out.push(`${rate}/分 → ${String(r).padStart(3)} 次（真值 15 次：3 段 × 5 秒 × ${rate}/60 次/秒）`);
  }
  console.log(`${name}\n    ` + out.join("\n    "));
}
