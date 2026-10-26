/* 【终极判定】2× 到底来自「重扫尾部」还是「信号每拍有两个 +k 过零」？
 *
 * 做法：构造三个"参照计数器"，都用**完全居中的窗**（无边缘偏置），差别只在处理方式：
 *   R1 逐样本一次：对每个样本，用"以它为中心"的窗算 d，判一次过零，每样本只判一次
 *   R2 全段一次  ：整段一次性 detrend（理想离线，无窗问题）
 *   R3 峰值法    ：原始信号平滑后数显著正峰（最朴素的"一拍一峰"）
 * 再对比 prod / F / F′。
 * 若 R1≈R2≈R3 ≈ 物理真值，而 prod 明显更高 → 2× 来自重扫。
 * 若 R1/R2/R3 本身就 ≈ prod → 2× 来自信号双峰，改计数法无用，得换信号。
 *
 * 真值另给：单峰关节量极小值 + FFT。
 * 只读产品文件 + _realseries.json + _lm.json。 */
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

const S = `${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
function detrendC(raw, win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
  for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
function detrendAll(raw){const g=std(raw)||1;const m=mean(raw);return raw.map(v=>(v-m)/g);}
`;
// R1：逐样本、居中窗、每样本只判一次
function R1(win, gap) {
  return new Function(S + `return function(series,fps){
    const smoothK=Math.max(1,Math.round(fps*0.06)), winN=${win}, gapN=${gap};
    const vals=series.map(s=>s.v), times=series.map(s=>s.t);
    let reps=0,lastAt=-1,armed=false; const hits=[];
    for(let i=0;i<vals.length;i++){
      const a=Math.max(0,i-Math.floor(winN/2)), b=Math.min(vals.length-1,i+Math.floor(winN/2));
      const seg=vals.slice(a,b+1); const g=std(seg)||1;
      let ms=0; for(const x of seg) ms+=x; ms/=seg.length;
      const v=(vals[i]-ms)/g;
      const rms=Math.sqrt(mean(seg.map(x=>((x-ms)/g)*((x-ms)/g))))||1;
      const k=clamp(rms*0.85,0.45,2.2);
      if(v<-k) armed=true; else if(v>k&&armed){ if(lastAt<0||times[i]-lastAt>=gapN){reps++;hits.push(+times[i].toFixed(3));lastAt=times[i];} armed=false; }
    }
    return {reps,hits};
  };`)();
}
// R2：整段一次
function R2(gap) {
  return new Function(S + `return function(series,fps){
    const times=series.map(s=>s.t), d=detrendAll(series.map(s=>s.v));
    const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
    let reps=0,lastAt=-1,armed=false; const hits=[];
    for(let i=0;i<d.length;i++){const v=d[i];
      if(v<-k) armed=true; else if(v>k&&armed){ if(lastAt<0||times[i]-lastAt>=${gap}){reps++;hits.push(+times[i].toFixed(3));lastAt=times[i];} armed=false; }}
    return {reps,hits};
  };`)();
}
// R3：峰值法（原始信号平滑后数正峰）
function R3(gap) {
  return new Function(S + `return function(series,fps){
    const v=series.map(s=>s.v), times=series.map(s=>s.t);
    const s=smooth(v,Math.max(1,Math.round(fps*0.08)));
    const mn=Math.min(...s), mx=Math.max(...s), thr=mn+(mx-mn)*0.5;
    const md=Math.max(1,Math.round(${gap}*fps)); const peaks=[];
    for(let i=1;i<s.length-1;i++) if(s[i]>=thr&&s[i]>=s[i-1]&&s[i]>s[i+1]){
      if(!peaks.length){peaks.push(i);continue;}
      if(i-peaks[peaks.length-1]>=md) peaks.push(i); else if(s[i]>s[peaks[peaks.length-1]]) peaks[peaks.length-1]=i;
    }
    return {reps:peaks.length,hits:peaks.map(i=>+times[i].toFixed(3))};
  };`)();
}
// prod / F / F′
function raster(win, gap, mode) {
  return new Function(S + `return function(series,fps){
    const smoothK=Math.max(1,Math.round(fps*0.06)), tailN=Math.max(2,Math.round(fps*0.35)), winN=${win}, gapN=${gap}, MODE="${mode}";
    let reps=0,lastAt=-1,armed=false; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); }
      if(raw.length<10) continue;
      const d=smooth(detrendC(raw,winN),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      let start,stop;
      if(MODE==="prod"){start=Math.max(0,d.length-tailN);stop=d.length;}
      else if(MODE==="Fp"){start=Math.max(0,d.length-1-Math.floor(winN/2));stop=Math.max(0,d.length-Math.floor(winN/2));}
      else {start=Math.max(0,d.length-1);stop=d.length;}
      for(let i=start;i<stop;i++){const v=d[i];
        if(v<-k) armed=true; else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gapN){reps++;hits.push(+now.toFixed(3));lastAt=now;} armed=false; }}
    }
    return {reps,hits};
  };`)();
}
const engWin = band => Math.max(3, Math.min(Math.round(3600 / Math.max(15, band[1])), 90));
function fill(a) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { let p = i - 1; while (p >= 0 && !Number.isFinite(o[p])) p--; let n = i + 1; while (n < o.length && !Number.isFinite(o[n])) n++; o[i] = (p >= 0 && n < o.length) ? (a[p] + a[n]) / 2 : (p >= 0 ? a[p] : 0); } return o; }
function smoothArr(a, k) { if (k <= 1) return a.slice(); const o = []; for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += a[j]; n++; } o.push(s / n); } return o; }
function extremaCount(a, gapF, prom) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) { if (a[i] <= a[i - 1] && a[i] < a[i + 1]) { if (idx.length && i - idx[idx.length - 1] < gapF) { if (a[i] < a[idx[idx.length - 1]]) idx[idx.length - 1] = i; } else idx.push(i); } }
  return idx.filter(i => { const lo = Math.max(0, i - 30), hi = Math.min(a.length, i + 30); const sl = a.slice(lo, hi); return Math.max(...sl) - a[i] >= prom; });
}
function fftP(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n), m = a.reduce((s, x) => s + x, 0) / a.length;
  for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let s = 0; s < n; s += len) for (let k2 = 0; k2 < len / 2; k2++) { const wr = Math.cos(ang * k2), wi = Math.sin(ang * k2), ur = re[s + k2], ui = im[s + k2], vr = re[s + k2 + len / 2] * wr - im[s + k2 + len / 2] * wi, vi = re[s + k2 + len / 2] * wi + im[s + k2 + len / 2] * wr; re[s + k2] = ur + vr; im[s + k2] = ui + vi; re[s + k2 + len / 2] = ur - vr; im[s + k2 + len / 2] = ui - vi; } }
  let best = 1, bv = -1; for (let i = 2; i < n / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > bv) { bv = p; best = i; } }
  return best * fps / n;
}
const lmCol = (name, idxs, axis) => { const out = []; for (const f of LM.acts[name].frames) { if (!f) { out.push(NaN); continue; } const vs = idxs.map(i => (f[i] && f[i].length > 2 && f[i][2] > 0.4) ? f[i][axis] : NaN).filter(Number.isFinite); out.push(vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN); } return fill(out); };
const TM = { jumpingJacks: ["jumpingJacks", [15, 16], 1, 4, 0.02], jumpRope: ["jumpRope", [27, 28], 1, 3, 0.01], squat: ["squat", [27, 28], 1, 6, 0.02], halfSquatWarm: ["squat", [23, 24], 1, 6, 0.02], burpee: ["burpee", [27, 28], 1, 6, 0.02] };

console.log("=== 参照计数器 vs 产物引擎（真机序列）===");
console.log("动作      真值(关节/FFT) | R1逐样本 | R2全段 | R3峰值 | prod | F | F′");
console.log("-".repeat(78));
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], sig = a.signal, band = a.profile.tempoBand, gap = a.profile.minRepGap;
  const win = engWin(band);
  const series = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const [lmN, idxs, axis, tg, tp] = TM[name];
  const tv = smoothArr(lmCol(lmN, idxs, axis), 3);
  const tMin = extremaCount(tv, tg, tp).length;
  const tFft = fftP(tv, 24) * (tv.length / 24);
  const r1 = R1(win, gap)(series, 60), r2 = R2(gap)(series, 60), r3 = R3(gap)(series, 60);
  const p = raster(win, gap, "prod")(series, 60), f = raster(win, gap, "F")(series, 60), fp = raster(win, gap, "Fp")(series, 60);
  console.log(`${a.cn.padEnd(8)} ${String(tMin).padStart(3)}/${tFft.toFixed(1).padStart(5)}   |   ${String(r1.reps).padStart(4)}   |  ${String(r2.reps).padStart(3)}  |  ${String(r3.reps).padStart(3)}  |  ${String(p.reps).padStart(3)} | ${String(f.reps).padStart(2)} | ${String(fp.reps).padStart(2)}`);
}
console.log("\n=== 开合跳 detail：R1/R2/R3 的计数时刻（看是否也 2×）===");
{
  const a = R.acts.jumpingJacks, band = a.profile.tempoBand, gap = a.profile.minRepGap, win = engWin(band);
  const series = a.series.map(s => ({ t: s.t, v: s.width }));
  console.log(`开合跳真值≈6（四物理量+FFT）；width 信号范围 ${Math.min(...series.map(s=>s.v)).toFixed(4)}~${Math.max(...series.map(s=>s.v)).toFixed(4)}`);
  for (const [lb, r] of [["R1逐样本", R1(win, gap)(series, 60)], ["R2全段", R2(gap)(series, 60)], ["R3峰值", R3(gap)(series, 60)], ["prod", raster(win, gap, "prod")(series, 60)], ["F", raster(win, gap, "F")(series, 60)], ["F′", raster(win, gap, "Fp")(series, 60)]]) {
    const g = r.hits.slice(1).map((h, i) => (h - r.hits[i]).toFixed(2));
    console.log(`  ${lb.padEnd(8)} n=${String(r.reps).padStart(2)}  ${r.hits.join(", ")}`);
    if (g.length) console.log(`           间隔 ${g.join(", ")}  中位${(g.map(Number).sort((a,b)=>a-b)[Math.floor(g.length/2)]).toFixed(2)}`);
  }
}
