/* 打印新猫模型的骨轴诊断：哪些骨骼"局部Y轴"与"第一个子骨骼方向"差异大。
 * 用法：node build/_dbg-cat-axis.js
 */
"use strict";
const path=require("path"),os=require("os"),fs=require("fs");
const puppeteer=require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules","puppeteer-core"));
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT=path.join(__dirname,"..");
const INDEX="file:///"+path.join(ROOT,"index.html").replace(/\\/g,"/");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const profileDir=path.join(os.tmpdir(),"wbc-axis-"+process.pid+"-"+Date.now());
  const browser=await puppeteer.launch({executablePath:CHROME,headless:"new",
    args:["--no-first-run","--no-default-browser-check","--no-proxy-server",
      "--allow-file-access-from-files","--user-data-dir="+profileDir]});
  const orig=browser.close.bind(browser);
  browser.close=async()=>{try{await orig();}catch(e){}
    for(let i=0;i<5;i++){try{fs.rmSync(profileDir,{recursive:true,force:true});return;}catch(e){await sleep(300);}}};
  const page=await browser.newPage();
  await page.goto(INDEX,{waitUntil:"load",timeout:40000});
  await sleep(1000);
  await page.evaluate(()=>window.MotionAvatar.show());
  for(let i=0;i<40;i++){const s=await page.evaluate(()=>window.MotionAvatar.__skeleton());
    if(s&&(s.ready||s.failed))break;await sleep(400);}
  const s=await page.evaluate(()=>window.MotionAvatar.__skeleton());
  console.log("ready="+s.ready,"bones="+s.boneCount);
  console.log("\n骨轴与「第一个子骨骼方向」夹角 > 15° 的骨骼（这些是必须用局部Y轴、不能用子骨骼方向的）：");
  if(!s.axisMismatch.length) console.log("  （无）");
  else s.axisMismatch.forEach(x=>console.log("  "+x));
  console.log("\n全部骨骼名（按自顶向下顺序）：");
  console.log("  "+s.boneNames.join(", "));
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error("FATAL",e);process.exit(2);});
