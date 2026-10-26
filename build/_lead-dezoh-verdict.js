/* 【跳绳真值 vs 重放伪影 — 判定】_realseries.json 是 24fps 视频**零阶保持(ZOH)**升到 60fps 的，
 * 每 2.5 个 60fps 帧里是同一个原值 → 阶梯平台。快动作（跳绳 103/分，周期 0.58s）在 ZOH 下
 * 平台会打断"局部极大"的判定，导致**低估**。
 *
 * 真机使用时摄像头 30fps 连续采样，不存在 ZOH。所以要判定：
 *   「causal 在跳绳上给 5」是**算法缺陷**，还是**重放伪影**？
 *
 * 做法：把同一段 24fps 原值先**线性插值**（de-ZOH，模拟连续采样），再喂给两种算法。
 *   若 causal 从 5 回到 ~10 → 重放伪影，真机不受影响
 *   若 causal 仍 ~5 → 算法对快动作确有缺陷
 * 同时对 prod 做同样处理，看它是否从 13 落到 ~10。
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
const L = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_lm.json"), "utf8"));

const PREFIX = `function psum(a){const p=new Float64Array(a.length+1);for(let i=0;i<a.length;i++)p[i+1]=p[i]+a[i];return p;}
function rmean(p,a,b){if(b<=a)return 0;return (p[b]-p[a])/(b-a);}
function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}`;

function mk(V, cap) {
  return new Function(`${clampSrc}${meanSrc}${smoothSrc}${PREFIX}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false,scannedT=-1; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const n=raw.length, B0=Math.max(8,band[0]);
      const win=Math.min(clamp(Math.round(fps*60/B0),3,Math.round(fps*${cap})), n);
      const g=std(raw)||1e-6, P=psum(raw), half=Math.max(1,Math.floor(win/2));
      const det=new Float64Array(n);
      for(let i=0;i<n;i++){ const m = "${V}"==="causal" ? rmean(P,Math.max(0,i-win+1),i+1) : rmean(P,Math.max(0,i-half),Math.min(n,i+half+1)); det[i]=(raw[i]-m)/g; }
      const d=smooth(Array.from(det),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=("${V}"==="causal")?0:half, stop=Math.max(0,n-h);
      let start=0,end=stop;
      if("${V}"==="prod"){ start=Math.max(0,n-tailN); end=n; }
      for(let i=start;i<end;i++){ const v=d[i], t=rawT[i];
        if("${V}"!=="prod" && t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lastAt=now; } armed=false; } }
      if("${V}"==="prod") continue;
      if(stop>0) scannedT=Math.max(scannedT, rawT[stop-1]); else if(n) scannedT=Math.max(scannedT, rawT[n-1]);
    }
    return {reps,hits};
  };`)();
}

/* 把 ZOH 序列还原成 24fps 原值，再线性插值到 60fps */
function deZoh(series) {
  const uniq = [];
  for (const s of series) if (!uniq.length || Math.abs(s.v - uniq[uniq.length - 1].v) > 1e-12) uniq.push({ t: s.t, v: s.v });
  const src = uniq.length >= 3 ? uniq : series;
  const t0 = src[0].t, t1 = src[src.length - 1].t, n = Math.round((t1 - t0) * 60) + 1, out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 60;
    while (j < src.length - 2 && src[j + 1].t < t) j++;
    const a = src[j], b = src[Math.min(j + 1, src.length - 1)];
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    out.push({ t, v: a.v + (b.v - a.v) * u });
  }
  return out;
}

/* 从原始关键点的踝 y 独立造一条"连续"信号（30fps 线性插值），
 * 作为跳绳真值的第三个来源（不依赖引擎输出）。 */
function kpAnkle(frames) {
  const ds = [];
  for (let i = 0; i < frames.length; i++) { const f = frames[i]; if (!f) continue;
    let s = 0, n = 0; for (const id of [27, 28]) if (f[id]) { s += f[id][1]; n++; }
    if (n) ds.push({ t: i / 24, v: s / n }); }
  return ds;
}

console.log("=".repeat(104));
console.log("【跳绳】真值 = 10 次 / 6.0s（103/分，来自原始关键点 6 个独立物理量，见上一脚本）");
console.log("-".repeat(104));
const rope = R.acts.jumpRope;
console.log("信号                    实现            cap   ZOH原样  线性插值(de-ZOH)   判定");
for (const sig of ["height", "width"]) {
  const zoh = rope.series.map(s => ({ t: s.t, v: s[sig] }));
  const lin = deZoh(rope.series.map(s => ({ t: s.t, v: s[sig] })));
  for (const V of ["prod", "causal", "delay"]) {
    const cap = V === "prod" ? 1.5 : 1.2;
    const a = mk(V, cap)(zoh, 60, rope.profile.expectedAmplitude * .5, rope.profile.tempoBand, rope.profile.minRepGap).reps;
    const b = mk(V, cap)(lin, 60, rope.profile.expectedAmplitude * .5, rope.profile.tempoBand, rope.profile.minRepGap).reps;
    const verdict = Math.abs(b - 10) <= 1 ? "线性插值后命中真值" : Math.abs(b - 10) <= 2 ? "接近真值" : (b > 12 ? "超计" : "欠计");
    console.log(`${sig.padEnd(24)}${V.padEnd(14)} ${String(cap).padEnd(5)} ${String(a).padStart(6)}  ${String(b).padStart(14)}   ${verdict}`);
  }
}

console.log("\n" + "=".repeat(104));
console.log("【全 5 动作】de-ZOH 后再比 —— 看「重放伪影」对每个动作的影响");
console.log("-".repeat(104));
console.log("动作       信号      真值     prod(cap1.5)          causal(cap1.2)        delay(cap1.2)");
console.log("                            ZOH →  插值           ZOH →  插值           ZOH →  插值");
const TRUTH = { jumpingJacks: "6~7", squat: "8~11?", halfSquatWarm: "6~7?", jumpRope: "10", burpee: "2" };
for (const k of ["jumpingJacks", "squat", "halfSquatWarm", "jumpRope", "burpee"]) {
  const a = R.acts[k]; const sig = a.signal, p = a.profile;
  const zoh = a.series.map(s => ({ t: s.t, v: s[sig] }));
  const lin = deZoh(zoh);
  const cells = [];
  for (const V of ["prod", "causal", "delay"]) {
    const cap = V === "prod" ? 1.5 : 1.2;
    const F = mk(V, cap);
    cells.push(`${String(F(zoh, 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap).reps).padStart(3)} →${String(F(lin, 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap).reps).padStart(4)}`);
  }
  console.log(`${a.cn.padEnd(10)} ${sig.padEnd(9)} ${String(TRUTH[k]).padEnd(7)} ${cells.map(c => c.padEnd(20)).join(" ")}`);
}

console.log("\n" + "=".repeat(104));
console.log("【跳绳 引擎信号 vs 真值信号】——为什么引擎信号本身就读不准");
console.log("-".repeat(104));
{
  const kp = kpAnkle(L.acts.jumpRope.kps || L.acts.jumpRope.frames);
  const kz = kp.map(s => s.v); const ksp = Math.max(...kz) - Math.min(...kz);
  const ez = rope.series.map(s => s.height); const esp = Math.max(...ez) - Math.min(...ez);
  const wz = rope.series.map(s => s.width); const wsp = Math.max(...wz) - Math.min(...wz);
  console.log(`原始关键点 踝y 峰峰 = ${ksp.toFixed(4)}  （跳绳时脚离地，真值信号）`);
  console.log(`引擎 height 峰峰   = ${esp.toFixed(4)}  ← 几乎不动（bbox 高度不含脚离地）`);
  console.log(`引擎 width  峰峰   = ${wsp.toFixed(4)}  ← 也不理想`);
  console.log(`→ 引擎的 height 顶点是"头"，跳绳时头的高度变化 << 脚的高度变化，这是信号选型的固有损失。`);
}
