const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CAMH = Number(process.env.CAMH || 700), D = Number(process.env.D || 3600),
      WALL = Number(process.env.WALL || 4000), BOX = Number(process.env.BOX || 1);
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: false,
    args: ["--no-first-run","--no-default-browser-check","--allow-file-access-from-files",
      "--user-data-dir=" + path.join(__dirname, "probe-profile-band"), "--window-size=1200,800"] });
  const p = await b.newPage();
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto(INDEX, { waitUntil: "domcontentloaded" });
  await sleep(600);
  await p.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width=640; cv.height=480;
    const c = cv.getContext("2d"); c.fillStyle="#111"; c.fillRect(0,0,640,480);
    window.__fs = cv.captureStream(30);
    setInterval(()=>{c.fillStyle="#111";c.fillRect(0,0,640,480);c.fillRect((Date.now()/40)%640,0,2,2);},33);
    navigator.mediaDevices.getUserMedia = async () => window.__fs;
    setView("fitnessMotion"); await motionCamRefresh(); await motionCamEnsureDefault();
  });
  await p.evaluate(() => document.querySelector("[data-action='motion-camera']").click());
  await sleep(1400);
  const out = await p.evaluate((camH, D, WALL, BOX) => {
    const W=96,H=72;
    const tv2=Math.tan(45.5*Math.PI/360), th2=Math.tan(58.4*Math.PI/360);
    const ray=(x,y)=>{const u=(x+0.5)/W-0.5,v=(y+0.5)/H-0.5;return {dx:u*2*th2,dy:-v*2*tv2,dz:1};};
    const g=new Float32Array(W*H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=ray(x,y);let z=WALL/d.dz;
      if(d.dy<-1e-6){const zf=(-camH/d.dy)*d.dz; if(zf>0&&zf<z)z=zf;} g[y*W+x]=z>0?z:0;}
    const height=1350,shoulder=340,legHalf=55,legGap=75;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=ray(x,y);const t=D/d.dz;if(!(t>0))continue;
      const wx=t*d.dx,wy=camH+t*d.dy; if(wy<0||wy>height)continue; const ax=Math.abs(wx);
      let half; if(wy>height-200)half=75;
      else if(wy<height*0.42){if(Math.abs(ax-legGap)>legHalf&&Math.abs(ax+legGap)>legHalf)continue;half=9999;}
      else half=shoulder/2;
      if(half<9999&&ax>half)continue; g[y*W+x]=D;}
    if(BOX)for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=ray(x,y);const t=D/d.dz;
      const wx=t*d.dx,wy=camH+t*d.dy; if(wy<0||wy>1900)continue;
      if(wx<-1400||wx>-450)continue; g[y*W+x]=D;}
    // 复现引擎的候选带
    const t0=D, tHi=t0+Math.min(900,Math.max(450,t0*0.22));
    let cnt=0; const rows=[];
    for(let y=0;y<H;y++){let mn=-1,mx=-1,n=0;
      for(let x=0;x<W;x++){const v=g[y*W+x]; if(v>=t0&&v<=tHi){if(mn<0)mn=x;mx=x;n++;}}
      cnt+=n; rows.push({y,mn,mx,span:mn<0?0:mx-mn+1,n,wide:mn>=0&&(mx-mn+1)>=W*0.82});}
    // 复现 stripBackgroundRows（两遍）
    const mask=new Uint8Array(W*H);
    for(let i=0;i<W*H;i++){const v=g[i]; mask[i]=(v>=t0&&v<=tHi)?1:0;}
    const strip=(down)=>{let refLo=-1,refHi=-1,refD=0;
      for(let k=0;k<H;k++){const y=down?k:H-1-k, row=y*W;
        let mn=-1,mx=-1,ds=0,dn=0;
        for(let x=0;x<W;x++){if(!mask[row+x])continue;if(mn<0)mn=x;mx=x;ds+=g[row+x];dn++;}
        if(mn<0)continue; const wide=(mx-mn+1)>=W*0.82;
        if(!wide){refLo=mn;refHi=mx;refD=ds/dn;continue;}
        if(refLo<0)continue;
        const lo=Math.max(0,refLo-1),hi2=Math.min(W-1,refHi+1),tol=Math.max(140,refD*0.06);
        for(let x=0;x<W;x++){const i=row+x;if(!mask[i])continue;
          if(x<lo||x>hi2||Math.abs(g[i]-refD)>tol)mask[i]=0;}}};
    strip(true); const after1=mask.reduce((a,b)=>a+b,0); strip(false); const after2=mask.reduce((a,b)=>a+b,0);
    return { band:{t0:Math.round(t0),tHi:Math.round(tHi),cnt,ratio:(cnt/(W*H)).toFixed(3)},
      after1, after2,
      rows: rows.map(r=>`y${r.y}:${r.n}${r.wide?"W":""}[${r.mn}..${r.mx}]`).join(" ") };
  }, CAMH, D, WALL, BOX);
  console.log("band:", JSON.stringify(out.band));
  console.log("strip 一遍后:", out.after1, " 两遍后:", out.after2);
  console.log("行分布(y:像素数W=宽):");
  console.log(out.rows);
  await b.close();
})();
