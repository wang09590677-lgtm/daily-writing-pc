/* 查清：喂"双臂平举"数据时，模型手臂骨链各节的真实世界坐标。 */
"use strict";
const path=require("path"),os=require("os"),fs=require("fs");
const puppeteer=require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules","puppeteer-core"));
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT=path.join(__dirname,"..");
const INDEX="file:///"+path.join(ROOT,"index.html").replace(/\\/g,"/");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ARMS_UP={head:{x:0.5,y:0.05},neck:{x:0.5,y:0.14},
  shoulderL:{x:0.44,y:0.20},shoulderR:{x:0.56,y:0.20},
  elbowL:{x:0.30,y:0.16},elbowR:{x:0.70,y:0.16},
  wristL:{x:0.17,y:0.09},wristR:{x:0.83,y:0.09},
  handL:{x:0.09,y:0.05},handR:{x:0.91,y:0.05},
  hipMid:{x:0.5,y:0.53},hipL:{x:0.46,y:0.53},hipR:{x:0.54,y:0.53},
  kneeL:{x:0.45,y:0.70},kneeR:{x:0.55,y:0.70},ankleL:{x:0.44,y:0.9},ankleR:{x:0.56,y:0.9}};
(async()=>{
  const profileDir=path.join(os.tmpdir(),"wbc-arm-" +process.pid+"-"+Date.now());
  const browser=await puppeteer.launch({executablePath:CHROME,headless:"new",
    args:["--no-first-run","--no-default-browser-check","--no-proxy-server",
      "--allow-file-access-from-files","--user-data-dir="+profileDir]});
  const orig=browser.close.bind(browser);
  browser.close=async()=>{try{await orig();}catch(e){}
    for(let i=0;i<5;i++){try{fs.rmSync(profileDir,{recursive:true,force:true});return;}catch(e){await sleep(300);}}};
  const page=await browser.newPage();
  await page.goto(INDEX,{waitUntil:"load",timeout:40000});
  await sleep(900);
  await page.evaluate(()=>window.MotionAvatar.show());
  for(let i=0;i<40;i++){const s=await page.evaluate(()=>window.MotionAvatar.__skeleton());
    if(s&&(s.ready||s.failed))break;await sleep(400);}
  const out=await page.evaluate(p=>{
    const grab=n=>{const w=window.MotionAvatar.__boneWorld(n);return w?[w.x,w.y,w.z]:null;};
    const snap=()=>({LS:grab("LeftShoulder"),LUA:grab("LeftUpperArm"),LLA:grab("LeftLowerArm"),LH:grab("LeftHand"),
      RUA:grab("RightUpperArm"),RH:grab("RightHand")});
    for(let i=0;i<50;i++)window.MotionAvatar.updateFromSkeleton(null);
    const idle=snap();
    for(let i=0;i<50;i++)window.MotionAvatar.updateFromSkeleton(p);
    const up=snap();
    return {idle,up};
  },ARMS_UP);
  const f=a=>a?a.map(v=>v.toFixed(3)).join(","):"null";
  console.log("=== 站姿 ===");
  for(const k of Object.keys(out.idle)) console.log("  "+k.padEnd(5), f(out.idle[k]));
  console.log("=== 双臂平举（含 hand）===");
  for(const k of Object.keys(out.up)) console.log("  "+k.padEnd(5), f(out.up[k]));
  console.log("\n判据：世界 y 向上为正 → 手 y 应 > 肩 y");
  console.log("  左手 y - 左肩 y =", (out.up.LH[1]-out.up.LS[1]).toFixed(4));
  console.log("  右手 y - 右肩 y =", (out.up.RH[1]-out.up.RUA[1]).toFixed(4));
  console.log("  手的 |x| 是否外展：左手|x|=", Math.abs(out.up.LH[0]).toFixed(3), " 站姿时=", Math.abs(out.idle.LH[0]).toFixed(3));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error("FATAL",e);process.exit(2);});
