// 无深度（纯彩色）路径：空房扫描必须自动跳过，且不报错
const fs=require("fs"),path=require("path");
const puppeteer=require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules","puppeteer-core"));
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX="file:///"+path.join(__dirname,"..","index.html").replace(/\\/g,"/");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const browser=await puppeteer.launch({executablePath:CHROME,headless:false,
    args:["--no-first-run","--no-default-browser-check","--allow-file-access-from-files",
      "--user-data-dir="+path.join(require("os").tmpdir(),"nd-"+Date.now()),"--window-size=1200,800"]});
  const page=await browser.newPage();
  const errs=[];page.on("pageerror",e=>errs.push(e.message));
  await page.goto(INDEX,{waitUntil:"domcontentloaded"});
  await sleep(700);
  await page.evaluate(async()=>{
    const cv=document.createElement("canvas");cv.width=640;cv.height=480;
    const c=cv.getContext("2d");c.fillStyle="#111";c.fillRect(0,0,640,480);
    window.__fakeStream=cv.captureStream(30);
    navigator.mediaDevices.getUserMedia=async()=>window.__fakeStream;
    setView("fitnessMotion");await motionCamRefresh();await motionCamEnsureDefault();
  });
  await page.evaluate(()=>document.querySelector("[data-action='motion-camera']").click());
  await sleep(2000);
  const r=await page.evaluate(()=>({
    phase:(typeof roomScan!=="undefined")?roomScan.phase:"n/a",
    cardHidden:document.getElementById("roomScan").classList.contains("hidden"),
    dimmed:!!document.querySelector(".pose-calib-panel.is-dimmed"),
    calibActive:(typeof motionCalib!=="undefined")?motionCalib.active:"n/a"
  }));
  console.log("无深度路径:",JSON.stringify(r));
  console.log(errs.length?("!! JS 报错: "+errs.join(" | ")):"✔ 无 JS 报错");
  const ok = r.cardHidden===true && !r.dimmed && errs.length===0;
  console.log(ok?"✔ 无深度时正确跳过空房扫描":"✘ 无深度路径有问题");
  await browser.close();process.exit(ok?0:1);
})().catch(e=>{console.error("FATAL",e);process.exit(1);});
