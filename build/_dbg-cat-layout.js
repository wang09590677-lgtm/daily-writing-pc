/* 量 UI 实际占位，算出"猫能用的安全区"，并给出推荐的 MODEL_H / FOOT_Y。
 * 用法：node build/_dbg-cat-layout.js [窗口宽 高]
 */
"use strict";
const path=require("path"),os=require("os"),fs=require("fs");
const puppeteer=require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules","puppeteer-core"));
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT=path.join(__dirname,"..");
const INDEX="file:///"+path.join(ROOT,"index.html").replace(/\\/g,"/");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const W=Number(process.argv[2]||1440), H=Number(process.argv[3]||900);
(async()=>{
  const profileDir=path.join(os.tmpdir(),"wbc-layout-"+process.pid+"-"+Date.now());
  const browser=await puppeteer.launch({executablePath:CHROME,headless:"new",
    defaultViewport:{width:W,height:H},
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
  // 摆成"开合跳张臂"（最占地方的状态）+ 显示进度面板
  const m=await page.evaluate(()=>{
    const o={head:{x:0.5,y:0.14},neck:{x:0.5,y:0.25},
      shoulderL:{x:0.418,y:0.29},shoulderR:{x:0.582,y:0.29},
      midL:{x:0.372,y:0.245},midR:{x:0.628,y:0.245},
      elbowL:{x:0.318,y:0.196},elbowR:{x:0.682,y:0.196},
      foreL:{x:0.268,y:0.148},foreR:{x:0.732,y:0.148},
      wristL:{x:0.228,y:0.104},wristR:{x:0.772,y:0.104},
      handL:{x:0.208,y:0.082},handR:{x:0.792,y:0.082},
      hipMid:{x:0.5,y:0.56},hipL:{x:0.45,y:0.565},hipR:{x:0.55,y:0.565},
      kneeL:{x:0.436,y:0.712},kneeR:{x:0.564,y:0.712},
      shinL:{x:0.43,y:0.8},shinR:{x:0.57,y:0.8},
      ankleL:{x:0.424,y:0.888},ankleR:{x:0.576,y:0.888},
      toeL:{x:0.42,y:0.932},toeR:{x:0.58,y:0.932}};
    for(let i=0;i<40;i++)window.MotionAvatar.updateFromSkeleton(o);
    window.MotionAvatar.setProgress({name:"开合跳",current:12,target:20,unit:"次",percent:60,seqIndex:2,seqTotal:5});
    window.MotionAvatar.__renderNow();
    const r=el=>{if(!el)return null;const b=el.getBoundingClientRect();
      return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,w:b.width,h:b.height};};
    // 相机视野：正交 [-0.9,0.9] → 世界 y 与屏幕 y 的换算
    return {winW:innerWidth,winH:innerHeight,
      progress:r(document.getElementById("motionAvatarProgress")),
      controls:r(document.querySelector(".motion-avatar-controls")),
      canvas:r(document.querySelector("#motionAvatar canvas"))};
  });
  console.log("窗口 "+m.winW+"x"+m.winH);
  console.log("进度面板 :", JSON.stringify(m.progress));
  console.log("控制栏   :", JSON.stringify(m.controls));
  const toWorld=y=>0.9-2*y/m.winH;   // 屏幕 y(px) → 世界 y
  const panelBottom=m.progress?m.progress.bottom:0;
  const ctrlTop=m.controls?m.controls.top:m.winH;
  const safeTop=toWorld(panelBottom), safeBot=toWorld(ctrlTop);
  console.log("");
  console.log("安全区（世界坐标 y）: ["+safeBot.toFixed(3)+", "+safeTop.toFixed(3)+"]  高度="+(safeTop-safeBot).toFixed(3));
  console.log("  ↑ 天花板: 面板下沿 "+panelBottom.toFixed(0)+"px → y="+safeTop.toFixed(3));
  console.log("  ↓ 地板  : 控制栏上沿 "+ctrlTop.toFixed(0)+"px → y="+safeBot.toFixed(3));
  const h=safeTop-safeBot;
  console.log("");
  console.log("推荐：MODEL_H 取 "+(h*0.95).toFixed(2)+"（安全区的 95%，留一点余量）");
  console.log("      FOOT_Y  取 "+(safeBot+(h*0.05)/2).toFixed(3)+"（底边对齐地板、留 2.5% 余量）");
  await browser.close(); process.exit(0);
})().catch(e=>{console.error("FATAL",e);process.exit(2);});
