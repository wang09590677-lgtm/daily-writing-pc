const fs=require("fs"),path=require("path");
const all=Object.assign({},JSON.parse(fs.readFileSync(path.join(__dirname,"_exp-series.json"),"utf8")),JSON.parse(fs.readFileSync(path.join(__dirname,"_exp-series-jack.json"),"utf8")));
console.log("场景".padEnd(26)+"帧数".padEnd(8)+"width>0.9帧".padEnd(12)+"width跳变>0.1帧".padEnd(16)+"width唯一值个数");
for(const k of Object.keys(all)){
  const s=all[k].series.filter(r=>isFinite(r.width)); const ws=s.map(r=>r.width);
  const hi=ws.filter(v=>v>0.9).length;
  let jump=0; for(let i=1;i<ws.length;i++) if(Math.abs(ws[i]-ws[i-1])>0.1) jump++;
  const uniq=new Set(ws.map(v=>v.toFixed(4))).size;
  console.log(k.padEnd(26)+String(s.length).padEnd(8)+String(hi).padEnd(12)+String(jump).padEnd(16)+uniq);
}
