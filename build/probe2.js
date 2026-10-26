const base = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/";
const targets = [
  ["蒙学/qianjiashi.json", "千家诗"],
  ["蒙学/shenglvqimeng.json", "声律启蒙"],
  ["蒙学/youxueqionglin.json", "幼学琼林"],
  ["蒙学/zengguangxianwen.json", "增广贤文"],
  ["蒙学/zhuzijiaxun.json", "朱子家训"],
  ["蒙学/sanzijing-new.json", "三字经"],
  ["蒙学/dizigui.json", "弟子规"],
  ["蒙学/qianziwen.json", "千字文"],
  ["诗经/shijing.json", "诗经"],
  ["论语/lunyu.json", "论语"],
  ["幽梦影/youmengying.json", "幽梦影"],
  ["元曲/yuanqu.json", "元曲"]
];

(async () => {
  for (const [path, name] of targets) {
    try {
      const r = await fetch(base + encodeURI(path));
      if (!r.ok) { console.log(name + "\tHTTP " + r.status); continue; }
      const j = await r.json();
      const shape = Array.isArray(j) ? "array[" + j.length + "]" : "obj{" + Object.keys(j).join(",") + "}";
      let sample = "";
      const pick = Array.isArray(j) ? j[0] : (j.content && Array.isArray(j.content) ? j.content[0] : null);
      if (pick) sample = JSON.stringify(pick).slice(0, 260);
      console.log(name + "\t" + shape + "\t" + sample);
    } catch (e) {
      console.log(name + "\tFAIL " + e.message);
    }
  }
})();
