/* 【修法矩阵】在"无重扫"前提下，找最佳组合。
 *
 * 已确证：2× 根因 = 尾部重扫（R1/R2/R3 三独立法一致给开合跳6~7，prod给10）。
 * 已确证的次级缺陷：win = fps*60/band[1]（按 band **上限**速率取一个周期），
 *   当人实际速度慢于上限 → win 短于真实周期 → 居中窗去趋势不完整 → 漏拍。
 *   跳绳：band[1]=120 → win=30帧(0.5s)，而实际周期 0.583s(35帧) → 漏。
 *
 * 变量：scan ∈ {tail(现状), new1(F), half(F′)}  ×  win ∈ {band1(现状), band0, period}
 *   period = 依据 detectReps 的实测 tempo 自适应（无 tempo 时回退 band0）
 * 三张卷：真机5 / 静止噪声 / 正弦拍速扫描。
 * 只读产品文件 + _realseries.json + _lm.json + _exp-series.json。 */
"use strict";
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const LM = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));

function mk(scan, winMode, band, gap) {
  const env = `${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate){
    const smoothK=Math.max(1,Math.round(fps*0.06)), tailN=Math.max(2,Math.round(fps*0.35));
    const SCAN="${scan}", WM="${winMode}", B0=${band[0]}, B1=${band[1]}, GAP=${gap};
    let reps=0,lastAt=-1,armed=false,gated=0; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; gated++; continue; }
      // 窗长：B1=现状(按band上限)  B0=按band下限  PER=按实测tempo自适应
      let rate = B1;
      if(WM==="B0") rate = B0;
      else if(WM==="PER"){ const t = reps>1 ? (now - (hits.length>1?hits[hits.length-2]:now-1))*0 : 0; rate = B1; }
      const winN = WM==="B0" ? clamp(Math.round(fps*60/Math.max(15,B0)),3,Math.round(fps*2.0))
                             : clamp(Math.round(fps*60/Math.max(15,B1)),3,Math.round(fps*1.5));
      const d=smooth(detrendC(raw,winN),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      let start,stop;
      if(SCAN==="tail"){start=Math.max(0,d.length-tailN);stop=d.length;}
      else if(SCAN==="half"){start=Math.max(0,d.length-1-Math.floor(winN/2));stop=Math.max(0,d.length-Math.floor(winN/2));}
      else {start=Math.max(0,d.length-1);stop=d.length;}
      for(let i=start;i<stop;i++){const v=d[i];
        if(v<-k) armed=true; else if(v>k&&armed){ if(lastAt<0||now-lastAt>=GAP){reps++;hits.push(+now.toFixed(3));lastAt=now;} armed=false; }}
    }
    return {reps,hits,gated};
  };`;
  return new Function(env)();
}
const engWin1 = band => Math.max(3, Math.min(Math.round(3600 / Math.max(15, band[1])), 90));
const engWin0 = band => Math.max(3, Math.min(Math.round(3600 / Math.max(15, band[0])), 120));
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function extremaCount(a, gapF, prom) { const idx = []; for (let i = 1; i < a.length - 1; i++) { if (a[i] <= a[i - 1] && a[i] < a[i + 1]) { if (idx.length && i - idx[idx.length - 1] < gapF) { if (a[i] < a[idx[idx.length - 1]]) idx[idx.length - 1] = i; } else idx.push(i); } } return idx.filter(i => { const lo = Math.max(0, i - 30), hi = Math.min(a.length, i + 30); return Math.max(...a.slice(lo, hi)) - a[i] >= prom; }); }
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } return fill(out); };
const TM = { jumpingJacks: ["jumpingJacks", [15, 16], 1, 4, 0.02], jumpRope: ["jumpRope", [27, 28], 1, 3, 0.01], squat: ["squat", [27, 28], 1, 6, 0.02], halfSquatWarm: ["squat", [23, 24], 1, 6, 0.02], burpee: ["burpee", [27, 28], 1, 6, 0.02] };

const COMBOS = [
  ["tail/B1 (现状)", "tail", "B1"],
  ["new1/B1 (F)", "new1", "B1"],
  ["half/B1 (F′)", "half", "B1"],
  ["half/B0 (F′+长窗)", "half", "B0"],
  ["new1/B0", "new1", "B0"],
  ["tail/B0", "tail", "B0"],
];

console.log("############ 卷1：真机 5 动作（真值=单峰关节量极小值）############");
const truths = {};
{ const names = Object.keys(R.acts); const row = names.map(n => { const [lmN, idxs, axis, tg, tp] = TM[n]; const t = extremaCount(smoothArr(lmCol(lmN, idxs, axis), 3), tg, tp).length; truths[n] = t; return `${R.acts[n].cn}=${t}`; }); console.log("真值: " + row.join("  ")); }
console.log("\n组合                   " + Object.keys(R.acts).map(n => R.acts[n].cn.padStart(5)).join(" "));
for (const [lb, scan, wm] of COMBOS) {
  const cells = [];
  for (const name of Object.keys(R.acts)) {
    const a = R.acts[name], band = a.profile.tempoBand, gap = a.profile.minRepGap, ea = a.profile.expectedAmplitude;
    const series = a.series.map(s => ({ t: s.t, v: s[a.signal] }));
    const r = mk(scan, wm, band, gap)(series, 60, ea * 0.5);
    const e = Math.abs(r.reps - truths[name]);
    cells.push(`${String(r.reps).padStart(3)}${e <= 1 ? "·" : e <= 2 ? "~" : "✗"}`);
  }
  console.log(`${lb.padEnd(22)} ${cells.join("  ")}`);
}
console.log("（· 差≤1  ~ 差2  ✗ 差>2）");

console.log("\n############ 卷2：静止/噪声/小幅 —— 误计（静止/噪声必须 0）############");
console.log("\n组合                   " + Object.keys(EXP).map(k => k.split("_")[0].padStart(5)).join(" "));
for (const [lb, scan, wm] of COMBOS) {
  const cells = [];
  for (const key of Object.keys(EXP)) {
    const e = EXP[key], p = e.profile;
    const series = e.series.map(s => ({ t: s.t, v: s[p.signal] }));
    const r = mk(scan, wm, p.tempoBand, p.minRepGap)(series, 60, (p.expectedAmplitude || 0.1) * 0.5);
    const isFalse = /static|noise/i.test(key);
    cells.push(`${String(r.reps).padStart(3)}${isFalse ? (r.reps === 0 ? "·" : "✗") : " "}`);
  }
  console.log(`${lb.padEnd(22)} ${cells.join("  ")}`);
}
console.log("列: A静 B抖 C噪.12 C2噪.20 D开合.8@2m F开合.8@4m G噪.12@4m E深蹲.6 H深蹲.6@4m");

console.log("\n############ 卷3：正弦拍速扫描（期望值 = Hz×秒）############");
const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
for (const [winBand, gap, lb] of [[[40, 90], 0.45, "开合档 band[40,90]"], [[60, 120], 0.3, "跳绳档 band[60,120]"]] ) {
  console.log(`\n-- ${lb} --`);
  console.log("组合                   " + [30, 60, 90, 120, 150, 180, 240].map(r => `${r}/分`.padStart(9)).join(" "));
  for (const [l2, scan, wm] of COMBOS) {
    const cells = [];
    for (const rate of [30, 60, 90, 120, 150, 180, 240]) {
      const f = rate / 60, s = sineDs(f, 30), e = f * 30;
      const r = mk(scan, wm, winBand, gap)(s, 60, 0);
      const x = r.reps / e;
      cells.push(`${String(r.reps).padStart(3)}(${x.toFixed(2)})${x > 1.4 ? "★" : x < 0.7 ? "✗" : " "}`);
    }
    console.log(`${l2.padEnd(22)} ${cells.join(" ")}`);
  }
}
