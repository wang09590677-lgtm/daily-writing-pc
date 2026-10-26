/* 【定参终审 v2】用前缀和把去趋势降到 O(n)，让全部候选都跑得完。
 *
 * 结论导向：把「窗长上限 cap」×「delay 策略」在**三卷**上一次性打分。
 *   卷1 合成栅格：全 12 个 rep 动作 × 各自 tempoBand 内 5 个拍速点 = 60 格（期望比值≈1.00）。
 *   卷2 真机序列：_realseries.json 的 5 个动作（引擎实吃 60fps 序列）。
 *   卷3 静止/噪声：_exp-series.json —— 静止/抖动/噪声/远距离必须全 0。
 *
 * ★ 本脚本相对上一版的关键修正：去趋势改成**前缀和**（O(n)），
 *   上一版 O(n·win) 在 cap≥2.5 时把进程拖到超时被 SIGTERM。
 *
 * 骨架（两策略共用，除注明外全部是现状原样）：
 *   raw  = signalWindow(key, 3.5)          3.5s 滑窗（现状保留）
 *   闸门 = spread(raw) >= ea*0.5*bodyScale 绝对幅度闸门（现状保留）
 *   win  = clamp(fps*60/band[0], 3, cap*fps)   ★ 从 band[1] 改为 band[0]
 *   d    = smooth(detrend(raw,win), smoothK)
 *   k    = clamp(rms(d)*0.85, 0.45, 2.2)
 *   oneshot：每个物理样本只判一次（scannedT 单调推进）—— tail 重扫彻底删除
 *      · delay  = 居中窗，判 [0, len-win/2)，出数延迟 win/2
 *      · causal = 因果窗（后向均值），判 [0, len)，零延迟
 *   prod     = 现状（居中窗 + 每帧重扫尾部 fps*0.35 帧）
 *
 * 只读产品文件。 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "motion-engine.js"), "utf8");
function grab(a, b) { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error("抠取 " + a.slice(0, 20)); return SRC.slice(i, j); }
const clampSrc = grab("function clamp(v, a, b)", "function mean(arr)");
const meanSrc = grab("function mean(arr)", "function std(arr)");
const smoothSrc = grab("function smooth(raw, k)", "// 峰值计次");
const stdSrc = "function std(a){if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}";
const R = JSON.parse(fs.readFileSync(path.join(__dirname, "_tmp", "_realseries.json"), "utf8"));
const EXP = JSON.parse(fs.readFileSync(path.join(__dirname, "_exp-series.json"), "utf8"));
const PLAN = fs.readFileSync(path.join(ROOT, "data", "fitness-plan.js"), "utf8");

const ACTIONS = [];
{
  const idRe = /^\s{2}(\w+):\s*\{/gm; const ids = []; let mm;
  while ((mm = idRe.exec(PLAN))) ids.push({ id: mm[1], at: mm.index });
  for (let k = 0; k < ids.length; k++) {
    const seg = PLAN.slice(ids[k].at, k + 1 < ids.length ? ids[k + 1].at : PLAN.length);
    const mo = seg.match(/motion:\s*\{([^}]*)\}/); if (!mo) continue; const blk = mo[1];
    if (!/mode:\s*"rep"/.test(blk)) continue;
    const nm = (seg.match(/name:\s*"([^"]+)"/) || [])[1] || ids[k].id;
    const sig = (blk.match(/signal:\s*"(\w+)"/) || [])[1];
    const band = (blk.match(/tempoBand:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/) || []);
    const gap = parseFloat((blk.match(/minRepGap:\s*([\d.]+)/) || [])[1]);
    const ea = parseFloat((blk.match(/expectedAmplitude:\s*([\d.]+)/) || [])[1]);
    if (sig && band[1] && Number.isFinite(gap) && Number.isFinite(ea)) ACTIONS.push({ id: ids[k].id, cn: nm, sig, band: [+band[1], +band[2]], gap, ea });
  }
}

/* 前缀和 → 任意区间均值 O(1) */
const PREFIX = `
function psum(a){const p=new Float64Array(a.length+1);for(let i=0;i<a.length;i++)p[i+1]=p[i]+a[i];return p;}
function rmean(p,a,b){if(b<=a)return 0;return (p[b]-p[a])/(b-a);}
`;
function mk(variant, cap) {
  return new Function(`${clampSrc}${meanSrc}${stdSrc}${smoothSrc}${PREFIX}
  return function(series,fps,gate,band,gap){
    const smoothK=Math.max(1,Math.round(fps*0.06)); const V="${variant}", B0=Math.max(8,band[0]), CAP=${cap};
    const tailN=Math.max(2,Math.round(fps*0.35));
    let reps=0,lastAt=-1,armed=false,scannedT=-1,lagSum=0,nCount=0; const hits=[];
    for(let f=0;f<series.length;f++){
      const now=series[f].t, from=now-3.5; const raw=[],rawT=[];
      for(let i=f;i>=0;i--){ if(series[i].t<from) break; raw.unshift(series[i].v); rawT.unshift(series[i].t); }
      if(raw.length<10) continue;
      const spread=Math.max(...raw)-Math.min(...raw);
      if(gate>0 && spread<gate){ armed=false; continue; }
      const n=raw.length;
      const win=Math.min(clamp(Math.round(fps*60/B0),3,Math.round(fps*CAP)), n);
      const g=std(raw)||1e-6, P=psum(raw);
      // 去趋势：causal=后向窗 [i-win+1,i]；delay/prod=居中窗 [i-half,i+half]
      const half=Math.max(1,Math.floor(win/2));
      const det=new Float64Array(n);
      for(let i=0;i<n;i++){
        let m;
        if(V==="causal") m=rmean(P,Math.max(0,i-win+1),i+1);
        else m=rmean(P,Math.max(0,i-half),Math.min(n,i+half+1));
        det[i]=(raw[i]-m)/g;
      }
      const d=smooth(Array.from(det),smoothK);
      const rms=Math.sqrt(mean(d.map(v=>v*v)))||1, k=clamp(rms*0.85,0.45,2.2);
      const h=(V==="causal")?0:half;
      const stop=Math.max(0,n-h);
      let start=0,end=stop;
      if(V==="prod"){ start=Math.max(0,n-tailN); end=n; }
      for(let i=start;i<end;i++){
        const v=d[i], t=rawT[i];
        if(V!=="prod" && t<=scannedT) continue;
        if(v<-k) armed=true;
        else if(v>k&&armed){ if(lastAt<0||now-lastAt>=gap){ reps++; hits.push(+now.toFixed(2)); lagSum+=now-t; nCount++; lastAt=now; } armed=false; }
      }
      if(V==="prod") continue;
      if(stop>0) scannedT=Math.max(scannedT, rawT[stop-1]);
      else if(n) scannedT=Math.max(scannedT, rawT[n-1]);
    }
    return {reps,hits,avgLag:nCount?lagSum/nCount:0};
  };`)();
}

const sineDs = (f, secs) => { const a = []; for (let i = 0; i < secs * 60; i++) a.push({ t: i / 60, v: 0.15 * Math.sin(2 * Math.PI * f * i / 60) }); return a; };
const DUR = 60;
const ratesOf = A => [A.band[0], Math.round(A.band[0] + (A.band[1] - A.band[0]) * .25), Math.round((A.band[0] + A.band[1]) / 2), Math.round(A.band[0] + (A.band[1] - A.band[0]) * .75), A.band[1]];

function grid(F) {
  const cells = []; let over = [], under = [];
  for (const A of ACTIONS) for (const rate of ratesOf(A)) {
    const f = rate / 60, s = sineDs(f, DUR), e = f * DUR, r = F(s, 60, A.ea * .5, A.band, A.gap).reps, x = r / e;
    cells.push(x);
    if (x > 1.4) over.push(`${A.cn}@${rate}=${r}/${e.toFixed(0)}(${x.toFixed(2)})`);
    if (x < 0.7) under.push(`${A.cn}@${rate}=${r}/${e.toFixed(0)}(${x.toFixed(2)})`);
  }
  const m = cells.reduce((a, b) => a + b, 0) / cells.length;
  const sd = Math.sqrt(cells.reduce((a, b) => a + (b - m) ** 2, 0) / cells.length);
  return { m, sd, over, under, n: cells.length, mx: Math.max(...cells), mn: Math.min(...cells) };
}
function real(F) { const o = {}; let lag = [];
  for (const k of Object.keys(R.acts)) { const a = R.acts[k], p = a.profile;
    const r = F(a.series.map(s => ({ t: s.t, v: s[a.signal] })), 60, p.expectedAmplitude * .5, p.tempoBand, p.minRepGap);
    o[a.cn] = r.reps; lag.push(r.avgLag); }
  o.__lag = lag.reduce((a, b) => a + b, 0) / lag.length; return o; }
const NOISE_KEYS = ["A_static_2m","B_noise06_2m","C_noise12_2m","C2_noise20_2m","G_noise12_4m"];
const REAL_KEYS  = ["D_jack08_2m","F_jack08_4m","E_squat06","H_squat06_4m"];
function noise(F) { const o = {};
  for (const key of NOISE_KEYS.concat(REAL_KEYS)) {
    const e = EXP[key]; if (!e) continue; const p = e.profile;
    o[key] = F(e.series.map(s => ({ t: s.t, v: s[p.signal] })), 60, (p.expectedAmplitude || .1) * .5, p.tempoBand, p.minRepGap).reps;
  } return o; }

const caps = [1.2, 1.5, 1.8, 2.0, 2.5, 3.5];
const cands = [{ v: "prod", cap: 1.5, label: "prod(现状)", F: mk("prod", 1.5) }];
for (const cap of caps) cands.push({ v: "causal", cap, label: "causal(delay0)", F: mk("causal", cap) });
for (const cap of [1.5, 2.0, 3.5]) cands.push({ v: "delay", cap, label: "delay(half)", F: mk("delay", cap) });

console.log("=".repeat(118));
console.log("【卷1】合成栅格 60 格（12 动作 × band 内 5 拍速点，各 60 秒）—— 越界 = 超计>1.4 或 欠计<0.7");
console.log("-".repeat(118));
console.log("实现                cap    平均比值  标准差   最小   最大  超计  欠计  越界明细(前3)");
const G = {};
for (const c of cands) {
  const g = grid(c.F); G[c.label + "@" + c.cap] = g;
  console.log(`${c.label.padEnd(16)} ${String(c.cap).padEnd(6)} ${g.m.toFixed(3).padStart(7)} ${g.sd.toFixed(3).padStart(7)} ${g.mn.toFixed(2).padStart(6)} ${g.mx.toFixed(2).padStart(6)} ${String(g.over.length).padStart(4)} ${String(g.under.length).padStart(5)}  ${[...g.over, ...g.under].slice(0, 3).join(" | ") || "无"}`);
}
console.log("\n" + "=".repeat(118));
console.log("【卷2】真机 5 动作（引擎实吃序列；真值参考：开合跳 6~7、跳绳 10、波比跳 2）");
console.log("-".repeat(118));
console.log("实现                cap     开合跳  徒手深蹲 半蹲热身  跳绳   波比跳  | 平均出数延迟");
for (const c of cands) { const r = real(c.F);
  console.log(`${c.label.padEnd(16)} ${String(c.cap).padEnd(6)} ${String(r["开合跳"]).padStart(5)} ${String(r["徒手深蹲"]).padStart(7)} ${String(r["半蹲热身"]).padStart(8)} ${String(r["跳绳"]).padStart(6)} ${String(r["波比跳"]).padStart(7)}  | ${r.__lag.toFixed(2)}s`); }
console.log("\n" + "=".repeat(118));
console.log("【卷3】静止/噪声（左 5 列必须全 0 = 站着不动不计数）| 右侧 4 项是真实动作在小幅/远距离下的计数");
console.log("-".repeat(118));
console.log("实现                cap      A静  B抖.06 C噪.12 C2噪.20 G噪4m | D开合2m F开合4m E深蹲 H深蹲4m");
for (const c of cands) { const n = noise(c.F);
  console.log(`${c.label.padEnd(16)} ${String(c.cap).padEnd(6)} ${NOISE_KEYS.map(k=>String(n[k]??"-").padStart(6)).join(" ")} | ${REAL_KEYS.map(k=>String(n[k]??"-").padStart(7)).join(" ")}`); }
console.log("\n（出数延迟 = 计数时刻 - 该次过零所在样本时刻的均值，由 oneshot 的 scannedT 推进模型给出）");
