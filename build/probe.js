const titles = [
  "春 (朱自清)", "匆匆", "綠", "槳聲燈影裏的秦淮河", "從百草園到三味書屋", "社戲", "故鄉 (魯迅)",
  "藤野先生", "雪 (魯迅)", "秋夜 (魯迅)", "一件小事", "濟南的冬天", "貓 (老舍)", "北京的春節",
  "故都的秋", "落花生", "春底林野", "烏篷船", "故鄉的野菜", "月朦朧鳥朦朧", "風箏 (魯迅)",
  "好的故事", "臘葉", "聰明人和傻子和奴才", "立論", "秋夜紀遊", "蟋蟀", "想北平",
  "濟南的秋天", "趵突泉", "大明湖之春", "我的母親 (胡適)", "差不多先生傳", "敬告青年",
  "槳聲燈影", "荷塘月色", "背影"
];

(async () => {
  for (const t of titles) {
    const url = "https://zh.wikisource.org/w/index.php?title=" + encodeURIComponent(t) + "&action=raw";
    try {
      const r = await fetch(url, { redirect: "follow" });
      const txt = await r.text();
      const transclusion = /<pages index=/.test(txt);
      const isError = /Wikimedia Error/.test(txt);
      const bodyLen = txt.replace(/\{\{[^}]*\}\}/g, "").replace(/<[^>]*>/g, "").trim().length;
      console.log(t + "\t" + r.status + "\ttrans=" + transclusion + "\terr=" + isError + "\tbody=" + bodyLen);
    } catch (e) {
      console.log(t + "\tFAIL " + e.message);
    }
  }
})();
