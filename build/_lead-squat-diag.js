/* 【深蹲专诊 + 窗规重定】squat 是唯一"两个修法都欠计"的动作，必须查清。
 * 疑点：win 取 band[0]（3.5s）时等于缓冲全长，被处理的样本其"居中窗"其实贴着
 *       缓冲左边界 → 偏置 → 漏拍。正确做法：win 必须 **显著小于缓冲长**（3.5s）。
 * 同时用**引擎自己的信号**（height）算它的物理周期，作为 squat 的可靠真值。
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

// 引擎信号自身的周期（自相关，稳健）
function periodOf(a) {
  const m = a.reduce((s, x) => s + x, 0) / a.length, x = a.map(v => v - m), n = x.length;
  let best = 1, bv = -Infinity;
  for (let lag = 5; lag < Math.floor(n / 2); lag++) {
    let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag]; s /= (n - lag);
    if (s > bv) { bv = s; best = lag; }
  }
  return best;
}
function fftP(a, fps) {
  const n = 1 << Math.floor(Math.log2(a.length));
  const re = new Float64Array(n), im = new Float64Array(n), m = a.reduce((s, x) => s + x, 0) / a.length;
  for (let i = 0; i < n; i++) re[i] = (a[i] || 0) - m;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let s = 0; s < n; s += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(ang * k), wi = Math.sin(ang * k), ur = re[s + k], ui = im[s + k], vr = re[s + k + len / 2] * wr - im[s + k + len / 2] * wi, vi = re[s + k + len / 2] * wi + im[s + k + len / 2] * wr; re[s + k] = ur + vr; im[s + k] = ui + vi; re[s + k + len / 2] = ur - vr; im[s + k + len / 2] = ui - vi; } }
  let bi = 1, bv = -1; for (let i = 2; i < n / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > bv) { bv = p; bi = i; } }
  return bi * fps / n;
}
console.log("=== 引擎信号自身周期 vs 声明 band（squat 真值口径）===");
for (const name of Object.keys(R.acts)) {
  const a = R.acts[name], p = a.profile, sig = a.signal;
  const vals = a.series.map(s => s[sig]), fps = 60;
  const lag = periodOf(vals), f0 = fftP(vals, fps);
  console.log(`${a.cn.padEnd(7)} signal=${sig.padEnd(10)} band=[${p.tempoBand}] 自相关周期=${String(lag).padStart(3)}帧(${(lag / fps).toFixed(2)}s→${(60 / (lag / fps)).toFixed(0)}/分)  FFT=${f0.toFixed(2)}Hz(${(f0 * a.secs).toFixed(1)}次)`);
}

// 窗规对决：win 上限从 3.5s 降到 1.0/1.2/1.5/1.8/2.2s，看 squat 是否恢复
function mk(maxWinSec, frac) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}
  function detrendC(raw,win){const out=new Array(raw.length),half=Math.max(1,Math.floor(win/2)),g=std(raw)||1;
    for(let i=0;i<raw.length;i++){let s=0,n=0;for(let j=Math.max(0,i-half);j<=Math.min(raw.length-1,i+half);j++){s+=raw[j];n++;}out[i]=(raw[i]-s/n)/g;}return out;}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const MW=${maxWinSec}, F=${frac}, B0=band[0], B1=band[1];
    let reps=0,lastAt=-1,armed=false,scannedT=-1; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      // 窗长：向最慢拍速要，但**不得超过缓冲的 MW 秒**（保证居中窗完整）
      const win=Math.min(clamp(Math.round(fps*60/Math.max(8,B0)),3,Math.round(fps*MW)), raw.length);
      const d=smooth(detrendC(raw,win),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=Math.floor(win*F);
      const stop=Math.max(0,d.length-h);
      for(let i=0;i<stop;i++){ const v=d[i], t=rawT[i];
        if(t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lastAt=now; } armed=false; }
      }
      if(stop>0) scannedT=Math.max(scannedT, rawT[stop-1]);
    }
    return {reps,hits};
  };`)();
}
const TRUTH = { jumpingJacks: 7, jumpRope: 10, squat: 9, halfSquatWarm: 7, burpee: 2 };
console.log("\n=== 窗上限 × delay 对 真机 5 动作的影响（真值 开7/跳10/蹲9/半7/波2）===");
console.log("win上限 delay      开合跳  徒手深蹲 半蹲热身  跳绳   波比跳   平均|偏差|");
for (const mw of [1.0, 1.2, 1.5, 1.8, 2.2, 3.5]) {
  for (const fr of [0, 0.5]) {
    const F = mk(mw, fr), cells = [], dev = [];
    for (const name of Object.keys(R.acts)) {
      const a = R.acts[name], p = a.profile;
      const r = F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap).reps;
      cells.push(String(r).padStart(6)); dev.push(Math.abs(r - TRUTH[name]));
    }
    console.log(`${mw.toFixed(1)}s   ×${String(fr).padEnd(4)}  ${cells.join(" ")}   ${(dev.reduce((a, b) => a + b, 0) / dev.length).toFixed(2)}`);
  }
}
