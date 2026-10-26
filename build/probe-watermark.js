const path=require("path"),fs=require("fs");
const puppeteer=require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules","puppeteer-core"));
(async()=>{
  const b=await puppeteer.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:"new"});
  const p=await b.newPage();
  const img=path.join(__dirname,"imgtest","model-flux.jpg").replace(/\\/g,"/");
  const r=await p.evaluate(async(src)=>{
    const im=new Image();
    await new Promise(res=>{im.onload=res;im.src=src});
    const c=document.createElement("canvas");
    c.width=im.naturalWidth;c.height=im.naturalHeight;
    const g=c.getContext("2d");g.drawImage(im,0,0);
    const W=im.naturalWidth,H=im.naturalHeight;
    const d=g.getImageData(0,0,W,H).data;
    // 扫描右下角区域，找"接近白色"的像素（水印是白色文字/图标）
    let minX=W,minY=H,maxX=0,maxY=0,count=0;
    for(let y=Math.floor(H*0.75);y<H;y++){
      for(let x=Math.floor(W*0.6);x<W;x++){
        const i=(y*W+x)*4;
        const R=d[i],G=d[i+1],B=d[i+2];
        // 白/浅灰：三通道都高且接近
        if(R>200&&G>200&&B>200&&Math.abs(R-G)<28&&Math.abs(G-B)<28){
          count++;
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
      }
    }
    return {W,H,count,minX,minY,maxX,maxY};
  },"file:///"+img);
  console.log(JSON.stringify(r,null,1));
  console.log("水印高度占比:", ((r.H-r.minY)/r.H*100).toFixed(2)+"%");
  console.log("安全裁剪建议：裁掉底部", (r.H-r.minY+6), "px，保留", (r.minY-6), "px（占", ((r.minY-6)/r.H*100).toFixed(1)+"%）");
  await b.close();
})();
