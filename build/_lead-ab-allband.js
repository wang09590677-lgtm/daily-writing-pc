/* 【终审 A/B】现状(prod) vs 提案(oneshot：每样本只判一次、延迟半窗)，
 * 对**每一个计次动作**在其**自己的 tempoBand 区间内**扫拍速。
 *
 * 这是决定"提案能不能上线"的关键一测，因为：
 *   · 2× 只在「周期 ≈ 2×尾部长度」时出现 → 各动作的**低速端**更危险
 *   · 而居中窗去趋势在「周期 >> 窗长」时会削平信号 → 各动作的**极低速端**有漏计风险
 *   两个效应在同一区间的两端拉扯，必须逐动作在 band 内看清。
 *
 * 动作真值配置直接读 data/fitness-plan.js（只读产品）。
 * 输出：每个动作在 band 内 5 个拍速点的 比值，★=超计>1.4，✗=欠计<0.7。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";

// 直接抠 data/fitness-plan.js 里的动作定义
const PLAN = fs.readFileSync(path.join(__dirname, "..", "data", "fitness-plan.js"), "utf8");
const ACTIONS = [];
{
  const idRe = /^\s{2}(\w+):\s*\{/gm; const ids = []; let mm;
  while ((mm = idRe.exec(PLAN))) ids.push({ id: mm[1], at: mm.index });
  for (let k = 0; k < ids.length; k++) {
    const seg = PLAN.slice(ids[k].at, k + 1 < ids.length ? ids[k + 1].at : PLAN.length);
    const mo = seg.match(/motion:\s*\{([^}]*)\}/);
    if (!mo) continue;
    const blk = mo[1];
    if (!/mode:\s*"rep"/.test(blk)) continue;
    const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || ids[k].id;
    const sig = (blk.match(/signal:\s*"(\w+)"/) || [])[1];
    const band = (blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/) || []);
    const gap = parseFloat((blk.match(/minRepGap:\s*([\d.]+)/) || [])[1]);
    const ea = parseFloat((blk.match(/expectedAmplitude:\s*([\d.]+)/) || [])[1]);
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) {
      ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea });
    }
  }
}
console.log(`从 data/fitness-plan.js 解析到 ${ACTIONS.length} 个 rep 动作\n`);

function mk(mode) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const MODE="${mode}", B1=band[1];
    const win=clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
    const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=Math.floor(win/2);
      const start = MODE==="prod" ? Math.max(0,d.length-tailN) : Math.max(0,d.length-1-h);
      const stop  = MODE==="prod" ? d.length : Math.max(0,d.length-h);
      for(let i=start;i<stop;i++){ const v=d[i];
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lastAt=now; } armed=false; }
      }
    }
    return {reps,hits};
  };`)();
}
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
const DUR = 60;
const fmt = (r, e) => { const x = r / e; return `${String(r).padStart(4)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`; };

console.log("动作           band      窗长(s)  信号      " + ["band0", "band0+¼", "中点", "band0+¾", "band1"].map(s => s.padStart(10)).join(" "));
console.log("                                              " + " prod / oneshot".padEnd(0));
console.log("=".repeat(120));
const P = mk("prod"), O = mk("oneshot");
for (const A of ACTIONS) {
  const win = Math.max(3, Math.min(Math.round(3600 / Math.max(15, A.band[1])), 90));
  const rates = [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * 0.75), A.band[1]];
  const cells = [];
  for (const rate of rates) {
    const f = rate / 60, s = sineDs(f, DUR), e = f * DUR;
    const rp = P(s, 60, A.ea * 0.5, A.band, A.gap).reps;
    const ro = O(s, 60, A.ea * 0.5, A.band, A.gap).reps;
    cells.push(`${fmt(rp, e)}|${fmt(ro, e)}`);
  }
  console.log(`${A.cn.padEnd(10)} ${String(A.band[0] + "-" + A.band[1]).padEnd(9)} ${(win / 60).toFixed(2).padStart(7)}  ${A.sig.padEnd(9)} ${cells.join(" ")}`);
}
console.log("\n格式：现状(比值) | 提案(比值)   ★=超计>1.4  ✗=欠计<0.7");
console.log("（每个动作在其 tempoBand 内 5 个拍速点；期望比值≈1.00）");
